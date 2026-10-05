from ears.protocol import Result, decode_frame, encode_frame


def test_round_trip():
    buf = encode_frame("123456789012345678", 42, b"\x01\x02\x03\x04", end=True)
    f = decode_frame(buf)
    assert f is not None
    assert f.user_id == "123456789012345678"
    assert f.seq == 42
    assert f.end is True
    assert f.pcm == b"\x01\x02\x03\x04"


def test_rejects_bad_magic():
    assert decode_frame(b"NOPE" + b"\0" * 40) is None
    assert decode_frame(b"CAF1") is None


def test_ts_compatible_header():
    # Matches packages/shared/src/ears-protocol.ts: magic, u32 seq, u16 flags, u16 len, 20-byte id.
    buf = encode_frame("james", 1, b"")
    assert buf[:4] == b"CAF1"
    assert len(buf) == 32
    assert buf[12:17] == b"james"


def test_result_json_has_camel_case_keys():
    msg = Result("partial", "vosk", "u1", "u1-1", "hello", 0.8).to_message()
    assert '"userId": "u1"' in msg
    assert '"utteranceId": "u1-1"' in msg
