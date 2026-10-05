import numpy as np

from ears.vad import EnergyProb, Segmenter

from .conftest import silence, tone


def kinds(events):
    return [e.kind for e in events]


def test_detects_one_utterance_with_preroll_and_hangover():
    seg = Segmenter(EnergyProb(), silence_ms=300, preroll_ms=100)
    audio = np.concatenate([silence(0.5), tone(1.0), silence(0.6)])
    events = seg.feed(audio)
    ks = kinds(events)
    assert ks.count("start") == 1
    assert ks.count("end") == 1
    end = next(e for e in events if e.kind == "end")
    # Utterance holds the speech plus pre-roll and the trailing silence before cut-off.
    assert 1.0 <= end.audio.size / 16000 <= 1.6


def test_two_utterances():
    seg = Segmenter(EnergyProb(), silence_ms=200)
    audio = np.concatenate([tone(0.5), silence(0.5), tone(0.5), silence(0.5)])
    ks = kinds(seg.feed(audio))
    assert ks.count("start") == 2
    assert ks.count("end") == 2


def test_flush_ends_open_utterance():
    seg = Segmenter(EnergyProb(), silence_ms=800)
    ks = kinds(seg.feed(tone(0.5)))
    assert "start" in ks and "end" not in ks
    assert kinds(seg.flush()) == ["end"]
    assert seg.flush() == []


def test_silence_only_produces_nothing():
    seg = Segmenter(EnergyProb())
    assert seg.feed(silence(2.0)) == []
