"""PotPlayer path resolution and process launching."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from collections.abc import Mapping
from typing import Callable, Iterator, Sequence


PLAYER_FILE_NAME = "PotPlayerMini64.exe"
HOST_CONFIG_NAME = "PotPlayerBridgeHost.config.json"


def host_directory() -> Path:
    """Return the directory containing the script or frozen executable."""

    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _clean_configured_path(value: str) -> Path:
    return Path(value.strip().strip('"'))


def _sidecar_player_path(app_dir: Path) -> Path | None:
    config_path = app_dir / HOST_CONFIG_NAME
    try:
        with config_path.open("rb") as handle:
            config = json.load(handle)
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(config, Mapping):
        return None
    value = config.get("potplayer_path")
    return _clean_configured_path(value) if isinstance(value, str) and value.strip() else None


def common_player_paths(environment: Mapping[str, str] | None = None) -> Iterator[Path]:
    env = environment if environment is not None else os.environ
    roots: list[Path] = []
    for variable in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        value = env.get(variable)
        if value:
            roots.append(Path(value))
    seen: set[str] = set()
    for root in roots:
        for relative in (
            Path("DAUM") / "PotPlayer" / PLAYER_FILE_NAME,
            Path("PotPlayer") / PLAYER_FILE_NAME,
        ):
            candidate = root / relative
            key = os.path.normcase(str(candidate))
            if key not in seen:
                seen.add(key)
                yield candidate


def resolve_player_path(
    environment: Mapping[str, str] | None = None,
    app_dir: str | os.PathLike[str] | None = None,
) -> Path:
    """Resolve the player while keeping the C# host's normal lookup behavior.

    ``POTPLAYER_PATH`` remains an explicit override. With no override, the
    executable's own directory is preferred; deployed hosts can then use the
    sidecar path or a small set of common Windows install locations.
    """

    env = environment if environment is not None else os.environ
    configured = env.get("POTPLAYER_PATH")
    if configured and configured.strip():
        return _clean_configured_path(configured)

    directory = Path(app_dir) if app_dir is not None else host_directory()
    local_player = directory / PLAYER_FILE_NAME
    if local_player.is_file():
        return local_player

    sidecar = _sidecar_player_path(directory)
    if sidecar is not None and sidecar.is_file():
        return sidecar

    for candidate in common_player_paths(env):
        if candidate.is_file():
            return candidate
    return local_player


def start_potplayer(
    playlist_path: str | os.PathLike[str],
    player_path: str | os.PathLike[str],
    *,
    process_launcher: Callable[[Sequence[str]], object] | None = None,
) -> object:
    """Launch PotPlayer with the exact ``/current <playlist>`` arguments."""

    command = [str(player_path), "/current", str(playlist_path)]
    if process_launcher is not None:
        return process_launcher(command)

    kwargs: dict[str, object] = {
        "shell": False,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.Popen(command, **kwargs)
