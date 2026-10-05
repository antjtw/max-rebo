from __future__ import annotations

import numpy as np
import pytest

from ears.protocol import SAMPLE_RATE, Word


def tone(seconds: float, amp: float = 0.3, freq: float = 220.0) -> np.ndarray:
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32)


def to_pcm(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


class FakeKeywordStream:
    def __init__(self, script: list[str]) -> None:
        self.script = list(script)
        self.heard = 0

    def accept(self, audio):
        self.heard += 1
        if self.script:
            return self.script.pop(0), 0.8
        return None

    def finish(self):
        return "i ignite my lightsaber", 0.9, [Word("ignite", 0.1, 0.4, 0.9)]


class FakeKeywordEngine:
    available = True

    def __init__(self) -> None:
        self.grammar: list[str] = []

    def configure(self, grammar):
        self.grammar = grammar

    def new_stream(self):
        return FakeKeywordStream(["i", "i ignite", "i ignite my lightsaber"])


class FakeWhisper:
    available = True

    def __init__(self) -> None:
        self.prompts: list[str] = []

    def transcribe(self, audio, initial_prompt):
        self.prompts.append(initial_prompt)
        return "Right, I ignite my lightsaber.", 0.88, []


@pytest.fixture
def fake_keyword() -> FakeKeywordEngine:
    return FakeKeywordEngine()


@pytest.fixture
def fake_whisper() -> FakeWhisper:
    return FakeWhisper()
