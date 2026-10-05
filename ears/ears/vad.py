"""Voice activity detection: segments a user's stream into utterances.

Silero VAD is used when installed (the `speech` extra); otherwise an adaptive energy VAD keeps
things working for tests and on machines without torch. Audio lives in memory only.
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .protocol import SAMPLE_RATE

log = logging.getLogger("ears.vad")

FRAME_SAMPLES = 512  # 32 ms at 16 kHz (what Silero expects)


class SpeechProb(Protocol):
    name: str

    def prob(self, frame: np.ndarray) -> float: ...


class EnergyProb:
    """Adaptive energy detector. Noise floor tracks quiet frames; speech is well above it."""

    name = "energy"

    def __init__(self, min_rms: float = 0.01) -> None:
        self.floor = 0.005
        self.min_rms = min_rms

    def prob(self, frame: np.ndarray) -> float:
        rms = float(np.sqrt(np.mean(frame * frame))) if frame.size else 0.0
        threshold = max(self.min_rms, self.floor * 3.0)
        if rms < threshold:
            self.floor = 0.95 * self.floor + 0.05 * rms
        return float(min(1.0, rms / (threshold * 2.0)))


class SileroProb:
    name = "silero"

    def __init__(self) -> None:
        import torch
        from silero_vad import load_silero_vad

        self._torch = torch
        self.model = load_silero_vad()

    def prob(self, frame: np.ndarray) -> float:
        t = self._torch.from_numpy(frame.astype(np.float32))
        return float(self.model(t, SAMPLE_RATE).item())


def make_prob() -> SpeechProb:
    try:
        return SileroProb()
    except Exception as exc:  # noqa: BLE001  # pragma: no cover - optional deps
        log.info("Silero VAD unavailable (%s); using energy VAD", exc.__class__.__name__)
        return EnergyProb()


@dataclass(slots=True)
class VadEvent:
    kind: str  # "start" | "audio" | "end"
    audio: np.ndarray | None = (
        None  # float32, for "audio" (speech chunk) and "end" (whole utterance)
    )


class Segmenter:
    """Feeds 16 kHz float32 audio; yields start/audio/end events per utterance."""

    def __init__(
        self,
        prob: SpeechProb,
        threshold: float = 0.5,
        silence_ms: int = 800,
        preroll_ms: int = 200,
        max_utterance_s: float = 20.0,
    ) -> None:
        self.prob = prob
        self.threshold = threshold
        self.silence_frames = max(1, int(silence_ms / 1000 * SAMPLE_RATE / FRAME_SAMPLES))
        self.preroll: deque[np.ndarray] = deque(
            maxlen=max(1, int(preroll_ms / 1000 * SAMPLE_RATE / FRAME_SAMPLES))
        )
        self.max_frames = int(max_utterance_s * SAMPLE_RATE / FRAME_SAMPLES)
        self.pending = np.zeros(0, dtype=np.float32)
        self.in_speech = False
        self.silent_run = 0
        self.utterance: list[np.ndarray] = []

    def feed(self, audio: np.ndarray) -> list[VadEvent]:
        events: list[VadEvent] = []
        self.pending = np.concatenate([self.pending, audio])
        while self.pending.size >= FRAME_SAMPLES:
            frame = self.pending[:FRAME_SAMPLES]
            self.pending = self.pending[FRAME_SAMPLES:]
            events.extend(self._frame(frame))
        return events

    def flush(self) -> list[VadEvent]:
        """Force the end of any utterance in progress (e.g. the user stopped transmitting)."""
        if not self.in_speech:
            self.pending = np.zeros(0, dtype=np.float32)
            return []
        if self.pending.size:
            self.utterance.append(self.pending)
            self.pending = np.zeros(0, dtype=np.float32)
        return [self._end()]

    def _frame(self, frame: np.ndarray) -> list[VadEvent]:
        p = self.prob.prob(frame)
        speech = p >= self.threshold
        if not self.in_speech:
            if speech:
                self.in_speech = True
                self.silent_run = 0
                pre = list(self.preroll)
                self.preroll.clear()
                self.utterance = [*pre, frame]
                chunk = np.concatenate(self.utterance)
                return [VadEvent("start"), VadEvent("audio", chunk)]
            self.preroll.append(frame)
            return []
        self.utterance.append(frame)
        self.silent_run = 0 if speech else self.silent_run + 1
        out = [VadEvent("audio", frame)]
        if self.silent_run >= self.silence_frames or len(self.utterance) >= self.max_frames:
            out.append(self._end())
        return out

    def _end(self) -> VadEvent:
        audio = np.concatenate(self.utterance) if self.utterance else np.zeros(0, dtype=np.float32)
        self.utterance = []
        self.in_speech = False
        self.silent_run = 0
        return VadEvent("end", audio)


def pcm16_to_float(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
