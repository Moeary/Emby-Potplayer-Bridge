"""Windows-only PotPlayer progress monitor for the Native Messaging host."""

from __future__ import annotations

from dataclasses import dataclass
import ctypes
import os
import threading
import time
from collections.abc import Callable, Sequence
from urllib.parse import unquote, urlsplit

from playlist import PlaylistEntry


WM_USER = 0x0400
POSITION_COMMAND = 0x5004
DURATION_COMMAND = 0x5002
WINDOW_CLASSES = ("PotPlayer64", "PotPlayer", "PotPlayerMini64")


if os.name == "nt":
    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _find_window = _user32.FindWindowW
    _find_window.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
    _find_window.restype = ctypes.c_void_p
    _send_message = _user32.SendMessageW
    _send_message.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_longlong]
    _send_message.restype = ctypes.c_longlong
    _get_window_text = _user32.GetWindowTextW
    _get_window_text.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
    _get_window_text.restype = ctypes.c_int
else:
    _user32 = None
    _find_window = None
    _send_message = None
    _get_window_text = None


@dataclass(frozen=True)
class PlaybackSnapshot:
    position_milliseconds: int
    duration_milliseconds: int
    window_title: str


def find_potplayer_window() -> int | None:
    if _find_window is None:
        return None
    for class_name in WINDOW_CLASSES:
        hwnd = _find_window(class_name, None)
        if hwnd:
            return int(hwnd)
    return None


def window_title(hwnd: int) -> str:
    if _get_window_text is None:
        return ""
    buffer = ctypes.create_unicode_buffer(512)
    length = _get_window_text(hwnd, buffer, len(buffer))
    return buffer.value[:length]


def query_player() -> PlaybackSnapshot | None:
    hwnd = find_potplayer_window()
    if hwnd is None or _send_message is None:
        return None
    try:
        position = int(_send_message(hwnd, WM_USER, POSITION_COMMAND, 0))
        duration = int(_send_message(hwnd, WM_USER, DURATION_COMMAND, 0))
    except (OSError, OverflowError, ValueError):
        return None
    if position < 0:
        return None
    return PlaybackSnapshot(
        position_milliseconds=max(0, position),
        duration_milliseconds=max(0, duration),
        window_title=window_title(hwnd),
    )


def _normalise(value: str) -> str:
    return " ".join(str(value or "").lower().split())


def _title_candidates(entry: PlaylistEntry) -> tuple[str, ...]:
    values = [entry.title]
    try:
        path = unquote(urlsplit(entry.url).path)
    except (TypeError, ValueError):
        path = ""
    if path:
        values.append(path.rsplit("/", 1)[-1])
    return tuple(_normalise(value) for value in values if value)


def select_entry_index(
    entries: Sequence[PlaylistEntry],
    window_title_value: str,
    current_index: int = 0,
) -> int:
    if not entries:
        return 0
    title = _normalise(window_title_value)
    if title:
        for index, entry in enumerate(entries):
            if any(candidate and candidate in title for candidate in _title_candidates(entry)):
                return index
    return current_index if 0 <= current_index < len(entries) else 0


def milliseconds_to_ticks(value: int | float) -> int:
    return max(0, int(round(float(value) * 10_000)))


def _event_payload(
    session_id: str,
    entry: PlaylistEntry,
    index: int,
    snapshot: PlaybackSnapshot | None,
    event_type: str,
) -> dict[str, object]:
    position = snapshot.position_milliseconds if snapshot is not None else 0
    duration = snapshot.duration_milliseconds if snapshot is not None else entry.runtime_ticks // 10_000
    return {
        "type": event_type,
        "sessionId": session_id,
        "itemId": entry.item_id,
        "title": entry.title,
        "playlistIndex": index,
        "positionTicks": milliseconds_to_ticks(position),
        "runtimeTicks": milliseconds_to_ticks(duration),
    }


def monitor_playback(
    session_id: str,
    entries: Sequence[PlaylistEntry],
    emit: Callable[[dict[str, object]], None],
    *,
    stop_event: threading.Event | None = None,
    poll_interval: float = 10.0,
    initial_wait: float = 45.0,
    max_missing_polls: int = 3,
) -> None:
    """Emit PotPlayer progress events until the player window disappears."""

    if not entries:
        return
    stop_event = stop_event or threading.Event()
    deadline = time.monotonic() + max(0.0, initial_wait)
    current_index = 0
    last_snapshot: PlaybackSnapshot | None = None
    missing_polls = 0

    while not stop_event.is_set():
        snapshot = query_player()
        if snapshot is not None:
            missing_polls = 0
            current_index = select_entry_index(entries, snapshot.window_title, current_index)
            last_snapshot = snapshot
            emit(_event_payload(session_id, entries[current_index], current_index, snapshot, "playback-progress"))
            if stop_event.wait(max(0.1, poll_interval)):
                break
            continue

        if last_snapshot is None and time.monotonic() < deadline:
            if stop_event.wait(min(max(0.1, poll_interval), max(0.1, deadline - time.monotonic()))):
                break
            continue

        missing_polls += 1
        if missing_polls >= max(1, max_missing_polls):
            break
        if stop_event.wait(max(0.1, poll_interval)):
            break

    entry = entries[current_index]
    emit(_event_payload(session_id, entry, current_index, last_snapshot, "playback-stopped"))
