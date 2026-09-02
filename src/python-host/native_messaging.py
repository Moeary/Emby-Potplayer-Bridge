"""Chrome Native Messaging framing helpers.

The protocol is deliberately kept independent from the bridge business logic so
it can be exercised without starting Chrome or PotPlayer.
"""

from __future__ import annotations

import json
import struct
from typing import Any, BinaryIO, Mapping


MAX_MESSAGE_BYTES = 16 * 1024 * 1024


class NativeMessagingError(ValueError):
    """Raised when a Native Messaging frame is malformed."""


def _read_exact(stream: BinaryIO, size: int, *, allow_clean_eof: bool = False) -> bytes | None:
    data = bytearray()
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            if allow_clean_eof and not data:
                return None
            raise NativeMessagingError("Native Messaging 消息不完整")
        data.extend(chunk)
    return bytes(data)


def read_message(stream: BinaryIO, *, max_message_bytes: int = MAX_MESSAGE_BYTES) -> str | None:
    """Read one framed UTF-8 payload, or return ``None`` on clean EOF."""

    header = _read_exact(stream, 4, allow_clean_eof=True)
    if header is None:
        return None

    length = struct.unpack("<i", header)[0]
    if length <= 0 or length > max_message_bytes:
        raise NativeMessagingError("Native Messaging 消息长度无效")

    payload = _read_exact(stream, length)
    assert payload is not None
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise NativeMessagingError("Native Messaging 消息不是有效的 UTF-8") from error


def write_message(stream: BinaryIO, payload: str | bytes, *, max_message_bytes: int = MAX_MESSAGE_BYTES) -> None:
    """Write one framed UTF-8 payload and flush it immediately."""

    encoded = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)
    if not encoded or len(encoded) > max_message_bytes:
        raise NativeMessagingError("Native Messaging 消息长度无效")
    stream.write(struct.pack("<i", len(encoded)))
    stream.write(encoded)
    stream.flush()


def write_json_message(
    stream: BinaryIO,
    payload: Mapping[str, Any],
    *,
    max_message_bytes: int = MAX_MESSAGE_BYTES,
) -> None:
    """Serialize a response/request mapping and write it as one frame."""

    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    write_message(stream, text, max_message_bytes=max_message_bytes)
