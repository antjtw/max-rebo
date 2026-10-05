import asyncio
import json

import numpy as np

from ears.grammar import initial_prompt, vosk_grammar
from ears.protocol import decode_frame, encode_frame
from ears.server import Ears, serve
from ears.vad import EnergyProb
from ears.whisper_engine import NoWhisper

from .conftest import silence, to_pcm, tone


def frames(user: str, audio: np.ndarray, chunk_s: float = 0.02, end: bool = False):
    step = int(16000 * chunk_s)
    out = []
    for i, start in enumerate(range(0, audio.size, step)):
        out.append(encode_frame(user, i, to_pcm(audio[start : start + step])))
    if end:
        out.append(encode_frame(user, len(out), b"", end=True))
    return out


def run_all(ears: Ears, bufs):
    results, jobs = [], []
    for b in bufs:
        r, j = ears.process(decode_frame(b))
        results += r
        jobs += j
    return results, jobs


def test_partials_then_whisper_final_share_utterance_id(fake_keyword, fake_whisper):
    ears = Ears(fake_keyword, fake_whisper, EnergyProb, silence_ms=200)
    audio = np.concatenate([silence(0.2), tone(0.8), silence(0.4)])
    results, jobs = run_all(ears, frames("james", audio))
    partials = [r for r in results if r.type == "partial"]
    assert [p.text for p in partials][:3] == ["i", "i ignite", "i ignite my lightsaber"]
    assert len(jobs) == 1
    final = ears.run_job(jobs[0])
    assert final is not None and final.type == "final" and final.engine == "whisper"
    assert {p.utterance_id for p in partials} == {final.utterance_id} == {"james-1"}
    assert jobs[0].audio.size == 0  # audio dropped after transcription


def test_vosk_final_when_no_whisper(fake_keyword):
    ears = Ears(fake_keyword, NoWhisper(), EnergyProb, silence_ms=200)
    results, jobs = run_all(ears, frames("u1", np.concatenate([tone(0.6), silence(0.4)])))
    assert jobs == []
    finals = [r for r in results if r.type == "final"]
    assert len(finals) == 1 and finals[0].engine == "vosk"


def test_end_flag_flushes(fake_keyword, fake_whisper):
    ears = Ears(fake_keyword, fake_whisper, EnergyProb, silence_ms=2000)
    _, jobs = run_all(ears, frames("u1", tone(0.6), end=True))
    assert len(jobs) == 1


def test_users_are_independent(fake_keyword, fake_whisper):
    ears = Ears(fake_keyword, fake_whisper, EnergyProb, silence_ms=200)
    a = frames("a", np.concatenate([tone(0.5), silence(0.4)]))
    b = frames("b", np.concatenate([tone(0.5), silence(0.4)]))
    interleaved = [x for pair in zip(a, b) for x in pair]
    _, jobs = run_all(ears, interleaved)
    assert sorted(j.utterance_id for j in jobs) == ["a-1", "b-1"]


def test_grammar_and_prompt():
    g = vosk_grammar(["[i] (ignite|activate) my lightsaber", "{character} fires"])
    assert "ignite" in g and "lightsaber" in g and "fires" in g and g[-1] == "[unk]"
    assert "character" not in g
    assert "lightsaber" in initial_prompt(["lightsaber", "Despair"])


async def test_websocket_round_trip(fake_keyword, fake_whisper):
    import websockets

    ears = Ears(fake_keyword, fake_whisper, EnergyProb, silence_ms=200)
    stop = asyncio.Event()
    task = asyncio.create_task(serve(ears, "127.0.0.1", 47243, stop))
    await asyncio.sleep(0.2)
    try:
        async with websockets.connect("ws://127.0.0.1:47243") as ws:
            assert json.loads(await ws.recv())["type"] == "ready"
            await ws.send(
                json.dumps({"type": "configure", "grammar": ["ignite"], "initialPrompt": "p"})
            )
            for f in frames("james", np.concatenate([tone(0.6), silence(0.4)])):
                await ws.send(f)
            got = []
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), 3))
                if msg["type"] in ("partial", "final"):
                    got.append(msg)
                if msg["type"] == "final":
                    break
            assert got[-1]["engine"] == "whisper"
            assert got[-1]["utteranceId"] == "james-1"
            assert fake_whisper.prompts == ["p"]
    finally:
        stop.set()
        await task
