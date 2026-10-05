"""Transcript engine (Whisper): accurate finals for scene scoring and the transcript panel.

Apple Silicon uses mlx-whisper (Metal); elsewhere pywhispercpp on CPU (SPEC §7.3).
"""

from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Protocol

import numpy as np

from .protocol import Word

log = logging.getLogger("ears.whisper")


class TranscriptEngine(Protocol):
    available: bool

    def transcribe(
        self, audio: np.ndarray, initial_prompt: str
    ) -> tuple[str, float, list[Word]]: ...


class MlxWhisper:
    def __init__(self, model: str, models_dir: Path) -> None:
        import mlx_whisper  # type: ignore[import-not-found]

        self._mlx = mlx_whisper
        local = models_dir / f"whisper-{model}-mlx"
        self.repo = str(local) if local.exists() else f"mlx-community/whisper-{model}-mlx"
        self.available = True

    def transcribe(self, audio: np.ndarray, initial_prompt: str) -> tuple[str, float, list[Word]]:
        out = self._mlx.transcribe(
            audio.astype(np.float32),
            path_or_hf_repo=self.repo,
            initial_prompt=initial_prompt or None,
            language="en",
            condition_on_previous_text=False,
            verbose=None,
        )
        segs = out.get("segments", [])
        conf = float(np.mean([math.exp(s.get("avg_logprob", -1.0)) for s in segs])) if segs else 0.0
        return out.get("text", "").strip(), conf, []


class WhisperCpp:
    def __init__(self, model: str, models_dir: Path) -> None:
        from pywhispercpp.model import Model  # type: ignore[import-not-found]

        self.model = Model(
            model, models_dir=str(models_dir), print_progress=False, print_realtime=False
        )
        self.available = True

    def transcribe(self, audio: np.ndarray, initial_prompt: str) -> tuple[str, float, list[Word]]:
        segs = self.model.transcribe(audio.astype(np.float32), initial_prompt=initial_prompt or "")
        text = " ".join(s.text.strip() for s in segs).strip()
        return text, 0.75 if text else 0.0, []


class NoWhisper:
    available = False

    def transcribe(self, audio: np.ndarray, initial_prompt: str) -> tuple[str, float, list[Word]]:
        return "", 0.0, []


def load_whisper(model: str, models_dir: Path) -> TranscriptEngine:
    for cls in (MlxWhisper, WhisperCpp):
        try:
            return cls(model, models_dir)
        except Exception as exc:  # noqa: BLE001 - optional backends
            log.debug("%s unavailable: %s", cls.__name__, exc)
    log.warning("No Whisper backend available; transcripts will come from Vosk only")
    return NoWhisper()
