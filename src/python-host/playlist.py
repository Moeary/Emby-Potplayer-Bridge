"""Playlist validation and temporary M3U8 generation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
import os
from pathlib import Path
import tempfile
from typing import Any, Iterable, Mapping
from urllib.parse import urlsplit
from uuid import uuid4


PLAYER_PLAYLIST_DIRECTORY = "PotPlayerPlaylists"
PLAYLIST_PREFIX = "emby-jellyfin-"
MAX_PLAYLIST_ITEMS = 4096
DEFAULT_ALLOWED_ORIGINS = (
    "https://emby.moear.de",
    "https://jellyfin.moear.de",
)


@dataclass(frozen=True)
class PlaylistEntry:
    url: str
    title: str
    item_id: str = ""
    media_source_id: str = ""
    start_position_ticks: int = 0
    runtime_ticks: int = 0


def _origin_parts(value: str) -> tuple[str, str, int] | None:
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            return None
        port = parsed.port
    except (TypeError, ValueError):
        return None
    if port is None:
        port = 80 if parsed.scheme.lower() == "http" else 443
    return parsed.scheme.lower(), parsed.hostname.lower(), port


def _absolute_http_url(value: str) -> tuple[str, str, int] | None:
    """Return URL origin parts when a value is an absolute HTTP(S) URL."""

    parts = _origin_parts(value)
    if parts is None:
        return None
    return parts


def is_allowed_url(url: str, allowed_origins: Iterable[str] | None) -> bool:
    parsed_origin = _absolute_http_url(url)
    if parsed_origin is None:
        return False

    requested = list(allowed_origins or ())
    for raw_origin in (*requested, *DEFAULT_ALLOWED_ORIGINS):
        allowed = _origin_parts(raw_origin)
        if allowed is not None and parsed_origin == allowed:
            return True
    return False


def _value(mapping: Mapping[str, Any], name: str) -> Any:
    """Read a JSON property case-insensitively like System.Text.Json."""

    if name in mapping:
        return mapping[name]
    wanted = name.lower()
    for key, value in mapping.items():
        if isinstance(key, str) and key.lower() == wanted:
            return value
    return None


def _fallback_title(url: str) -> str:
    try:
        path = urlsplit(url).path
    except (TypeError, ValueError):
        path = ""
    if not path:
        return "Emby/Jellyfin video"
    segments = path.split("/")
    return segments[-1].strip("/") if segments else "Emby/Jellyfin video"


def _safe_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _safe_ticks(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    if number != number or number in (float("inf"), float("-inf")):
        return 0
    return max(0, int(number))


def validate_entries(
    raw_entries: Any,
    allowed_origins: Iterable[str] | None,
    *,
    max_items: int = MAX_PLAYLIST_ITEMS,
) -> list[PlaylistEntry]:
    """Apply the same filtering and hard limit as the C# host."""

    if raw_entries is None:
        raw_entries = []
    if not isinstance(raw_entries, list):
        raise ValueError("items 必须是数组")

    entries: list[PlaylistEntry] = []
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, Mapping):
            raise ValueError("播放列表项目格式无效")
        raw_url = _value(raw_entry, "url")
        if not isinstance(raw_url, str) or not raw_url.strip():
            continue
        if _absolute_http_url(raw_url) is None or not is_allowed_url(raw_url, allowed_origins):
            continue

        raw_title = _value(raw_entry, "title")
        if raw_title is None:
            raw_title = ""
        if not isinstance(raw_title, str):
            raise ValueError("播放列表标题格式无效")
        title = raw_title.replace("\r", " ").replace("\n", " ").strip()
        if not title:
            title = _fallback_title(raw_url)
        item_id = _safe_text(_value(raw_entry, "itemId"))
        media_source_id = _safe_text(_value(raw_entry, "mediaSourceId"))
        start_position_ticks = _safe_ticks(_value(raw_entry, "startPositionTicks"))
        runtime_ticks = _safe_ticks(_value(raw_entry, "runtimeTicks"))
        entries.append(PlaylistEntry(
            raw_url,
            title,
            item_id,
            media_source_id,
            start_position_ticks,
            runtime_ticks,
        ))
        if len(entries) > max_items:
            raise ValueError(f"播放列表项目超过 {max_items} 项")
    return entries


def playlist_directory(temp_dir: str | os.PathLike[str] | None = None) -> Path:
    root = Path(temp_dir) if temp_dir is not None else Path(tempfile.gettempdir())
    return root / PLAYER_PLAYLIST_DIRECTORY


def cleanup_old_playlists(
    temp_dir: str | os.PathLike[str] | None = None,
    *,
    now: datetime | None = None,
    max_age: timedelta = timedelta(minutes=10),
) -> None:
    """Remove old bridge playlists without blocking the current request."""

    try:
        directory = playlist_directory(temp_dir)
        if not directory.exists():
            return
        threshold = (now or datetime.now()) - max_age
        for path in directory.glob(f"{PLAYLIST_PREFIX}*.m3u8"):
            try:
                modified = datetime.fromtimestamp(path.stat().st_mtime)
                if modified < threshold:
                    path.unlink()
            except OSError:
                continue
    except OSError:
        return


def write_playlist(
    entries: Iterable[PlaylistEntry],
    temp_dir: str | os.PathLike[str] | None = None,
) -> Path:
    """Write a UTF-8-without-BOM, CRLF M3U8 matching the C# host."""

    directory = playlist_directory(temp_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{PLAYLIST_PREFIX}{uuid4().hex}.m3u8"

    lines = ["#EXTM3U\r\n"]
    for entry in entries:
        lines.append(f"#EXTINF:-1,{entry.title}\r\n")
        lines.append(f"{entry.url}\r\n")
    path.write_text("".join(lines), encoding="utf-8", newline="")
    return path
