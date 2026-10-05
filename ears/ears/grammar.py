"""Build a restricted Vosk grammar and a Whisper initial prompt from Cantina's config."""

from __future__ import annotations

import re

_TOKEN = re.compile(r"[a-z0-9']+")


def words_from_phrases(phrases: list[str]) -> list[str]:
    """Every distinct word appearing in trigger patterns, names and keywords."""
    seen: dict[str, None] = {}
    for phrase in phrases:
        cleaned = re.sub(r"\{[^}]*\}", " ", phrase.lower())
        for tok in _TOKEN.findall(cleaned):
            seen.setdefault(tok, None)
    return list(seen)


def vosk_grammar(phrases: list[str]) -> list[str]:
    """Vosk grammar: individual words (so any order is recognised) plus the unknown token."""
    return [*words_from_phrases(phrases), "[unk]"]


def initial_prompt(terms: list[str], limit_chars: int = 600) -> str:
    """Whisper initial prompt: a natural sentence listing vocabulary helps spelling."""
    out: list[str] = []
    total = 0
    for t in terms:
        if total + len(t) + 2 > limit_chars:
            break
        out.append(t)
        total += len(t) + 2
    return ("A tabletop game session. Terms: " + ", ".join(out) + ".") if out else ""
