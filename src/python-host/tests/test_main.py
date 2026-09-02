from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

HOST_DIR = Path(__file__).resolve().parents[1]
if str(HOST_DIR) not in sys.path:
    sys.path.insert(0, str(HOST_DIR))

import main as host_main  # noqa: E402
from native_messaging import write_json_message  # noqa: E402


class MainTests(unittest.TestCase):
    def test_missing_player_returns_a_clear_error(self) -> None:
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaisesRegex(FileNotFoundError, "找不到 PotPlayer"):
                host_main.handle_request(
                    {"type": "play", "items": [], "allowedOrigins": []},
                    app_dir=root,
                    temp_dir=temp_dir,
                    environment={"POTPLAYER_PATH": str(Path(root) / "missing.exe")},
                    process_launcher=lambda command: None,
                )

    def test_handle_request_writes_playlist_and_launches_player(self) -> None:
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as temp_dir:
            app_dir = Path(root)
            player = app_dir / "PotPlayerMini64.exe"
            player.write_bytes(b"fake exe")
            calls: list[list[str]] = []
            response = host_main.handle_request(
                {
                    "type": "play",
                    "mode": "all",
                    "items": [
                        {"url": "https://emby.moear.de/a.mp4", "title": "第一集"},
                        {"url": "https://emby.moear.de/b.mp4", "title": "第二集"},
                    ],
                    "allowedOrigins": [],
                },
                app_dir=app_dir,
                temp_dir=temp_dir,
                environment={},
                process_launcher=lambda command: calls.append(list(command)),
            )
            self.assertEqual(response, {"ok": True, "count": 2, "error": None})
            self.assertEqual(calls[0][0], str(player))
            self.assertEqual(calls[0][1], "/current")
            playlist_path = Path(calls[0][2])
            self.assertTrue(playlist_path.is_file())
            self.assertIn("#EXTINF:-1,第一集\r\n", playlist_path.read_bytes().decode("utf-8"))

    def test_invalid_json_returns_error_frame_and_safe_log(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            incoming = BytesIO()
            incoming.write(struct.pack("<i", len(b'{"type":"play",')))
            incoming.write(b'{"type":"play",')
            incoming.seek(0)
            outgoing = BytesIO()
            self.assertEqual(host_main.run(incoming, outgoing, temp_dir=temp_dir), 0)
            outgoing.seek(0)
            length = struct.unpack("<i", outgoing.read(4))[0]
            response = json.loads(outgoing.read(length))
            self.assertFalse(response["ok"])
            log = (Path(temp_dir) / "PotPlayerPlaylists" / "native-host-error.txt").read_text(encoding="utf-8")
            self.assertNotIn("api_key=secret", log)

    def test_sensitive_error_message_is_redacted(self) -> None:
        message = "url=https://x.test/a?api_key=secret-token&X-MediaBrowser-Token=another-secret"
        sanitized = host_main.sanitize_error_message(message)
        self.assertNotIn("secret-token", sanitized)
        self.assertNotIn("another-secret", sanitized)
