from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest

HOST_DIR = Path(__file__).resolve().parents[1]
if str(HOST_DIR) not in sys.path:
    sys.path.insert(0, str(HOST_DIR))

from potplayer import PLAYER_FILE_NAME, resolve_player_path, start_potplayer  # noqa: E402


class PotPlayerTests(unittest.TestCase):
    def test_default_same_directory_lookup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            player = Path(directory) / PLAYER_FILE_NAME
            player.write_bytes(b"fake exe")
            self.assertEqual(resolve_player_path({}, directory), player)

    def test_environment_override(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            configured = Path(directory) / "custom" / PLAYER_FILE_NAME
            self.assertEqual(resolve_player_path({"POTPLAYER_PATH": f'"{configured}"'}, directory), configured)

    def test_missing_executable_keeps_explicit_path_for_clear_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            configured = Path(directory) / "missing" / PLAYER_FILE_NAME
            self.assertEqual(resolve_player_path({"POTPLAYER_PATH": str(configured)}, directory), configured)

    def test_process_command_line(self) -> None:
        calls: list[list[str]] = []
        start_potplayer(
            r"C:\临时播放列表\list.m3u8",
            r"D:\PotPlayer\PotPlayerMini64.exe",
            process_launcher=lambda command: calls.append(list(command)),
        )
        self.assertEqual(calls, [[r"D:\PotPlayer\PotPlayerMini64.exe", "/current", r"C:\临时播放列表\list.m3u8"]])
