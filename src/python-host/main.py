"""Python Chrome Native Messaging host for the PotPlayer bridge."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any, BinaryIO, Callable, Sequence

from native_messaging import NativeMessagingError, read_message, write_json_message
from playlist import (
    MAX_PLAYLIST_ITEMS,
    cleanup_old_playlists,
    validate_entries,
    write_playlist,
)
from potplayer import resolve_player_path, start_potplayer


ERROR_LOG_NAME = "native-host-error.txt"
SENSITIVE_QUERY_RE = re.compile(
    r"(?i)([?&](?:api_key|access_token|auth_token|token|authorization|user_token|"
    r"x-mediabrowser-token|x-emby-token|x-jellyfin-token)=)[^&#\s]*"
)
SENSITIVE_ASSIGNMENT_RE = re.compile(
    r"(?i)(\b(?:api_key|access_token|auth_token|token|authorization|user_token|"
    r"x-mediabrowser-token|x-emby-token|x-jellyfin-token)\s*[=:]\s*)[^,\s]+"
)


def error_log_path(temp_dir: str | os.PathLike[str] | None = None) -> Path:
    root = Path(temp_dir) if temp_dir is not None else Path(tempfile.gettempdir())
    return root / "PotPlayerPlaylists" / ERROR_LOG_NAME


def sanitize_error_message(message: str) -> str:
    sanitized = SENSITIVE_QUERY_RE.sub(r"\1<redacted>", str(message))
    return SENSITIVE_ASSIGNMENT_RE.sub(r"\1<redacted>", sanitized)


def write_error(message: object, temp_dir: str | os.PathLike[str] | None = None) -> None:
    """Append a safe diagnostic without ever writing a request payload."""

    try:
        path = error_log_path(temp_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        text = f"{datetime.now().astimezone().isoformat()}\r\n{sanitize_error_message(str(message))}\r\n"
        with path.open("a", encoding="utf-8", newline="") as handle:
            handle.write(text)
    except OSError:
        # Diagnostics must never interfere with Native Messaging stdout.
        return


def _value(mapping: Mapping[str, Any], name: str) -> Any:
    if name in mapping:
        return mapping[name]
    wanted = name.lower()
    for key, value in mapping.items():
        if isinstance(key, str) and key.lower() == wanted:
            return value
    return None


def handle_request(
    request: Any,
    *,
    app_dir: str | os.PathLike[str] | None = None,
    temp_dir: str | os.PathLike[str] | None = None,
    environment: Mapping[str, str] | None = None,
    process_launcher: Callable[[Sequence[str]], object] | None = None,
) -> dict[str, Any]:
    """Handle one already-decoded request and return the wire response."""

    if not isinstance(request, Mapping) or str(_value(request, "type") or "").lower() != "play":
        raise ValueError("未知的桥接请求类型")

    player_path = resolve_player_path(environment, app_dir)
    if not player_path.is_file():
        raise FileNotFoundError(
            "找不到 PotPlayer；请把 PotPlayerBridgeHost.exe 放在 PotPlayerMini64.exe 旁边，"
            "或设置 POTPLAYER_PATH",
            str(player_path),
        )

    entries = validate_entries(
        _value(request, "items"),
        _value(request, "allowedOrigins"),
        max_items=MAX_PLAYLIST_ITEMS,
    )
    if not entries:
        raise ValueError("没有可播放的视频地址")

    cleanup_old_playlists(temp_dir)
    playlist_path = write_playlist(entries, temp_dir)
    start_potplayer(playlist_path, player_path, process_launcher=process_launcher)
    return {"ok": True, "count": len(entries), "error": None}


def run(
    input_stream: BinaryIO,
    output_stream: BinaryIO,
    *,
    app_dir: str | os.PathLike[str] | None = None,
    temp_dir: str | os.PathLike[str] | None = None,
    environment: Mapping[str, str] | None = None,
    process_launcher: Callable[[Sequence[str]], object] | None = None,
) -> int:
    """Run the framing loop. stdout receives only framed JSON responses."""

    while True:
        try:
            raw = read_message(input_stream)
        except NativeMessagingError as error:
            write_error(error, temp_dir)
            return 1
        if raw is None:
            return 0

        try:
            request = json.loads(raw)
            response = handle_request(
                request,
                app_dir=app_dir,
                temp_dir=temp_dir,
                environment=environment,
                process_launcher=process_launcher,
            )
        except Exception as error:  # One bad request must produce a protocol response.
            write_error(error, temp_dir)
            response = {"ok": False, "count": 0, "error": sanitize_error_message(str(error))}

        try:
            write_json_message(output_stream, response)
        except (BrokenPipeError, OSError, NativeMessagingError) as error:
            write_error(error, temp_dir)
            return 1


def main() -> int:
    try:
        return run(sys.stdin.buffer, sys.stdout.buffer)
    except Exception as error:  # Keep tracebacks and diagnostics out of stdout.
        write_error(error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
