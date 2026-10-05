"""Ears WebSocket server (ws://127.0.0.1:4243).

Receives per-user 16 kHz PCM frames from core, segments them with VAD, runs the keyword engine
(Vosk) for fast partials and the transcript engine (Whisper) for finals, and returns JSON results.

Privacy (SPEC §7.4): audio and text are held in memory only and dropped after processing.
Nothing here writes audio or transcripts to disk or to the log.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import numpy as np

from . import __version__
from .protocol import AudioFrame, Result, decode_frame, error, heartbeat, ready
from .vad import Segmenter, SpeechProb, make_prob, pcm16_to_float
from .vosk_engine import KeywordEngine, KeywordStream, VoskEngine, models_dir
from .whisper_engine import NoWhisper, TranscriptEngine, load_whisper

log = logging.getLogger("ears")


@dataclass
class WhisperJob:
    user_id: str
    utterance_id: str
    audio: np.ndarray
    ended_at: float


@dataclass
class UserStream:
    segmenter: Segmenter
    keyword: KeywordStream | None = None
    counter: int = 0
    utterance_id: str | None = None
    last_seq: int = -1
    dropped: int = 0
    extra: dict[str, float] = field(default_factory=dict)


class Ears:
    """Synchronous core of the server: frame in, results and Whisper jobs out. Easy to test."""

    def __init__(
        self,
        keyword: KeywordEngine | None,
        transcript: TranscriptEngine,
        prob_factory: Callable[[], SpeechProb],
        silence_ms: int = 800,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self.keyword = keyword
        self.transcript = transcript
        self.prob_factory = prob_factory
        self.silence_ms = silence_ms
        self.now = now
        self.streams: dict[str, UserStream] = {}
        self.initial_prompt = ""

    @property
    def keyword_ok(self) -> bool:
        return bool(self.keyword and self.keyword.available)

    def configure(self, grammar: list[str], initial_prompt: str) -> None:
        if self.keyword and self.keyword.available:
            self.keyword.configure(grammar)
        self.initial_prompt = initial_prompt
        # New grammar applies from the next utterance.
        for s in self.streams.values():
            if s.utterance_id is None:
                s.keyword = None

    def drop_user(self, user_id: str) -> None:
        self.streams.pop(user_id, None)

    def _stream(self, user_id: str) -> UserStream:
        s = self.streams.get(user_id)
        if s is None:
            s = UserStream(segmenter=Segmenter(self.prob_factory(), silence_ms=self.silence_ms))
            self.streams[user_id] = s
        return s

    def process(self, frame: AudioFrame) -> tuple[list[Result], list[WhisperJob]]:
        s = self._stream(frame.user_id)
        if s.last_seq >= 0 and frame.seq != (s.last_seq + 1) & 0xFFFFFFFF:
            s.dropped += 1
        s.last_seq = frame.seq
        events = s.segmenter.feed(pcm16_to_float(frame.pcm)) if frame.pcm else []
        if frame.end:
            events.extend(s.segmenter.flush())
        results: list[Result] = []
        jobs: list[WhisperJob] = []
        for ev in events:
            if ev.kind == "start":
                s.counter += 1
                s.utterance_id = f"{frame.user_id}-{s.counter}"
                s.keyword = self.keyword.new_stream() if self.keyword_ok else None  # type: ignore[union-attr]
            elif ev.kind == "audio" and s.keyword is not None and ev.audio is not None:
                partial = s.keyword.accept(ev.audio)
                if partial and s.utterance_id:
                    text, conf = partial
                    results.append(
                        Result("partial", "vosk", frame.user_id, s.utterance_id, text, conf)
                    )
            elif ev.kind == "end" and s.utterance_id:
                uid = s.utterance_id
                if s.keyword is not None:
                    text, conf, words = s.keyword.finish()
                    if text and not self.transcript.available:
                        results.append(
                            Result("final", "vosk", frame.user_id, uid, text, conf, words)
                        )
                    elif text:
                        # Deliver the keyword final as a partial; Whisper's final follows.
                        results.append(
                            Result("partial", "vosk", frame.user_id, uid, text, conf, words)
                        )
                if self.transcript.available and ev.audio is not None and ev.audio.size > 1600:
                    jobs.append(WhisperJob(frame.user_id, uid, ev.audio, self.now()))
                s.keyword = None
                s.utterance_id = None
        return results, jobs

    def run_job(self, job: WhisperJob) -> Result | None:
        text, conf, words = self.transcript.transcribe(job.audio, self.initial_prompt)
        job.audio = np.zeros(0, dtype=np.float32)  # drop audio promptly
        if not text:
            return None
        latency = (self.now() - job.ended_at) * 1000
        return Result("final", "whisper", job.user_id, job.utterance_id, text, conf, words, latency)


async def serve(ears: Ears, host: str, port: int, stop: asyncio.Event) -> None:
    import websockets

    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")
    loop = asyncio.get_running_loop()

    async def handler(ws) -> None:  # type: ignore[no-untyped-def]
        log.info("core connected")
        await ws.send(ready(__version__))

        async def beat() -> None:
            while True:
                await ws.send(
                    heartbeat(time.time() * 1000, ears.keyword_ok, ears.transcript.available, True)
                )
                await asyncio.sleep(1.0)

        hb = asyncio.create_task(beat())

        async def run_whisper(job: WhisperJob) -> None:
            try:
                res = await loop.run_in_executor(executor, ears.run_job, job)
                if res:
                    await ws.send(res.to_message())
            except Exception as exc:  # noqa: BLE001
                log.error("transcription failed: %s", exc.__class__.__name__)
                await ws.send(error(f"transcription failed: {exc.__class__.__name__}"))

        try:
            async for msg in ws:
                if isinstance(msg, (bytes, bytearray)):
                    frame = decode_frame(bytes(msg))
                    if frame is None:
                        continue
                    results, jobs = ears.process(frame)
                    for r in results:
                        await ws.send(r.to_message())
                    for j in jobs:
                        asyncio.create_task(run_whisper(j))
                else:
                    await handle_control(ears, ws, msg)
        except websockets.ConnectionClosed:
            pass
        finally:
            hb.cancel()
            ears.streams.clear()
            log.info("core disconnected")

    async with websockets.serve(handler, host, port, max_size=2**20):
        log.info("ears listening on ws://%s:%d", host, port)
        await stop.wait()
    executor.shutdown(wait=False, cancel_futures=True)


async def handle_control(ears: Ears, ws, msg: str) -> None:  # type: ignore[no-untyped-def]
    try:
        data = json.loads(msg)
    except json.JSONDecodeError:
        return
    kind = data.get("type")
    if kind == "configure":
        ears.configure(list(data.get("grammar", [])), str(data.get("initialPrompt", "")))
        log.info("configured grammar (%d words)", len(data.get("grammar", [])))
    elif kind == "drop_user":
        ears.drop_user(str(data.get("userId", "")))
    elif kind == "ping":
        await ws.send(
            json.dumps(
                {
                    "type": "heartbeat",
                    "ts": data.get("ts", 0),
                    "engines": {
                        "vosk": ears.keyword_ok,
                        "whisper": ears.transcript.available,
                        "vad": True,
                    },
                }
            )
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Cantina ears (local speech sidecar)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4243)
    parser.add_argument("--vosk-model", default="vosk-model-small-en-us-0.15")
    parser.add_argument("--whisper-model", default="small.en")
    parser.add_argument("--silence-ms", type=int, default=800)
    parser.add_argument("--no-whisper", action="store_true")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(level=args.log_level.upper(), format="[ears] %(levelname)s %(message)s")
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        parser.error("ears only binds to localhost")

    mdir = models_dir()
    keyword = VoskEngine(mdir, args.vosk_model)
    transcript: TranscriptEngine = (
        NoWhisper() if args.no_whisper else load_whisper(args.whisper_model, mdir)
    )
    ears = Ears(keyword, transcript, make_prob, silence_ms=args.silence_ms)
    log.info("engines: vosk=%s whisper=%s", keyword.available, transcript.available)

    async def runner() -> None:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        await serve(ears, args.host, args.port, stop)

    asyncio.run(runner())


if __name__ == "__main__":
    main()
