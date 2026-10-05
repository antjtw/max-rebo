"""Wire protocol between core and ears (mirrors packages/shared/src/ears-protocol.ts).

Binary audio frame: 32-byte header + s16le mono 16 kHz PCM.
  0..3   magic b"CAF1"
  4..7   uint32 LE sequence number
  8..9   uint16 LE flags (bit 0 = end of utterance)
  10..11 uint16 LE userId length (max 20)
  12..31 userId, ASCII, zero padded
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field
from typing import Any, Literal

MAGIC = b"CAF1"
HEADER_BYTES = 32
SAMPLE_RATE = 16000
FLAG_END = 1


@dataclass(slots=True)
class AudioFrame:
    user_id: str
    seq: int
    end: bool
    pcm: bytes


def decode_frame(buf: bytes) -> AudioFrame | None:
    if len(buf) < HEADER_BYTES or buf[:4] != MAGIC:
        return None
    seq, flags, length = struct.unpack_from("<IHH", buf, 4)
    length = min(length, 20)
    user_id = buf[12 : 12 + length].decode("ascii", errors="replace")
    return AudioFrame(
        user_id=user_id, seq=seq, end=bool(flags & FLAG_END), pcm=bytes(buf[HEADER_BYTES:])
    )


def encode_frame(user_id: str, seq: int, pcm: bytes, end: bool = False) -> bytes:
    uid = user_id[:20].encode("ascii", errors="replace")
    header = MAGIC + struct.pack("<IHH", seq & 0xFFFFFFFF, FLAG_END if end else 0, len(uid))
    header += uid.ljust(20, b"\0")
    return header + pcm


@dataclass(slots=True)
class Word:
    w: str
    start: float
    end: float
    conf: float

    def to_json(self) -> dict[str, Any]:
        return {"w": self.w, "start": self.start, "end": self.end, "conf": self.conf}


@dataclass(slots=True)
class Result:
    type: Literal["partial", "final"]
    engine: Literal["vosk", "whisper"]
    user_id: str
    utterance_id: str
    text: str
    confidence: float
    words: list[Word] = field(default_factory=list)
    latency_ms: float | None = None

    def to_message(self) -> str:
        msg: dict[str, Any] = {
            "type": self.type,
            "engine": self.engine,
            "userId": self.user_id,
            "utteranceId": self.utterance_id,
            "text": self.text,
            "confidence": round(float(self.confidence), 4),
            "words": [w.to_json() for w in self.words],
        }
        if self.latency_ms is not None:
            msg["latencyMs"] = round(self.latency_ms, 1)
        return json.dumps(msg)


def heartbeat(ts_ms: float, vosk: bool, whisper: bool, vad: bool) -> str:
    return json.dumps(
        {
            "type": "heartbeat",
            "ts": ts_ms,
            "engines": {"vosk": vosk, "whisper": whisper, "vad": vad},
        }
    )


def ready(version: str) -> str:
    return json.dumps({"type": "ready", "version": version})


def error(message: str) -> str:
    return json.dumps({"type": "error", "message": message})
