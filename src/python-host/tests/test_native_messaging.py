from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
import struct
import sys
import unittest

HOST_DIR = Path(__file__).resolve().parents[1]
if str(HOST_DIR) not in sys.path:
    sys.path.insert(0, str(HOST_DIR))

from native_messaging import (  # noqa: E402
    MAX_MESSAGE_BYTES,
    NativeMessagingError,
    read_message,
    write_json_message,
)


def frame(payload: bytes) -> bytes:
    return struct.pack("<i", len(payload)) + payload


class ChunkedStream(BytesIO):
    def __init__(self, value: bytes, chunk_size: int = 3) -> None:
        super().__init__(value)
        self.chunk_size = chunk_size

    def read(self, size: int = -1) -> bytes:
        return super().read(min(size, self.chunk_size))


class NativeMessagingTests(unittest.TestCase):
    def test_unicode_and_partial_reads_round_trip(self) -> None:
        value = {"title": "中文电影 🎬", "url": "https://emby.moear.de/视频/片名.mkv"}
        output = BytesIO()
        write_json_message(output, value)

        decoded = json.loads(read_message(ChunkedStream(output.getvalue())))
        self.assertEqual(decoded, value)

    def test_large_message(self) -> None:
        value = {"text": "中" * 200_000}
        output = BytesIO()
        write_json_message(output, value)
        self.assertEqual(json.loads(read_message(BytesIO(output.getvalue()))), value)

    def test_clean_eof(self) -> None:
        self.assertIsNone(read_message(BytesIO()))

    def test_invalid_length(self) -> None:
        for length in (0, -1, MAX_MESSAGE_BYTES + 1):
            with self.subTest(length=length):
                with self.assertRaises(NativeMessagingError):
                    read_message(BytesIO(struct.pack("<i", length)))

    def test_truncated_frame(self) -> None:
        with self.assertRaises(NativeMessagingError):
            read_message(BytesIO(struct.pack("<i", 4) + b"{}"))

    def test_invalid_utf8(self) -> None:
        with self.assertRaises(NativeMessagingError):
            read_message(BytesIO(frame(b"\xff")))
