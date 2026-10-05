"""Keyword engine (Vosk, grammar mode): fast partials for SFX triggers (SPEC §7.2)."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Protocol

import numpy as np

from .protocol import SAMPLE_RATE, Word

log = logging.getLogger("ears.vosk")


class KeywordStream(Protocol):
    def accept(self, audio: np.ndarray) -> tuple[str, float] | None:
        """Feed audio; return (partial text, confidence) when the partial changed."""

    def finish(self) -> tuple[str, float, list[Word]]:
        """End the utterance and return the final keyword result."""


class KeywordEngine(Protocol):
    available: bool

    def configure(self, grammar: list[str]) -> None: ...

    def new_stream(self) -> KeywordStream: ...


class VoskStream:
    def __init__(self, rec) -> None:  # type: ignore[no-untyped-def]
        self.rec = rec
        self.last = ""

    def accept(self, audio: np.ndarray) -> tuple[str, float] | None:
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        self.rec.AcceptWaveform(pcm)
        partial = json.loads(self.rec.PartialResult()).get("partial", "")
        partial = partial.replace("[unk]", "").strip()
        if partial and partial != self.last:
            self.last = partial
            return partial, 0.8  # Vosk partials carry no confidence; grammar mode is precise
        return None

    def finish(self) -> tuple[str, float, list[Word]]:
        res = json.loads(self.rec.FinalResult())
        words = [
            Word(w=r["word"], start=r["start"], end=r["end"], conf=r.get("conf", 1.0))
            for r in res.get("result", [])
            if r.get("word") != "[unk]"
        ]
        text = " ".join(w.w for w in words) or res.get("text", "").replace("[unk]", "").strip()
        conf = float(np.mean([w.conf for w in words])) if words else 0.0
        return text, conf, words


class VoskEngine:
    def __init__(self, models_dir: Path, model_name: str) -> None:
        self.available = False
        self.grammar: list[str] | None = None
        self.model = None
        try:
            from vosk import KaldiRecognizer, Model, SetLogLevel

            SetLogLevel(-1)
            path = models_dir / model_name
            if not path.exists():
                log.warning("Vosk model not found at %s (run npm run setup)", path)
                return
            self.model = Model(str(path))
            self._Recognizer = KaldiRecognizer
            self.available = True
        except ImportError:
            log.warning("vosk is not installed; keyword engine disabled")

    def configure(self, grammar: list[str]) -> None:
        self.grammar = grammar or None

    def new_stream(self) -> KeywordStream:
        if not self.available:
            raise RuntimeError("Vosk unavailable")
        if self.grammar:
            rec = self._Recognizer(self.model, SAMPLE_RATE, json.dumps(self.grammar))
        else:
            rec = self._Recognizer(self.model, SAMPLE_RATE)
        rec.SetWords(True)
        return VoskStream(rec)


def models_dir() -> Path:
    env = os.environ.get("CANTINA_MODELS_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[2] / "data" / "models"
