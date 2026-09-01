from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest

HOST_DIR = Path(__file__).resolve().parents[1]
if str(HOST_DIR) not in sys.path:
    sys.path.insert(0, str(HOST_DIR))

from playlist import (  # noqa: E402
    MAX_PLAYLIST_ITEMS,
    PlaylistEntry,
    is_allowed_url,
    validate_entries,
    write_playlist,
)


class PlaylistTests(unittest.TestCase):
    def test_single_and_multiple_entries_preserve_urls_and_titles(self) -> None:
        entries = validate_entries(
            [
                {"url": "https://emby.moear.de/videos/a%20b.mkv?x=1&y=2#片段", "title": "中文\r\n标题"},
                {"url": "https://jellyfin.moear.de/videos/b.mp4", "title": ""},
            ],
            ["https://emby.moear.de", "https://jellyfin.moear.de"],
        )
        self.assertEqual(entries[0], PlaylistEntry("https://emby.moear.de/videos/a%20b.mkv?x=1&y=2#片段", "中文  标题"))
        self.assertEqual(entries[1].title, "b.mp4")

        with tempfile.TemporaryDirectory() as directory:
            path = write_playlist(entries, directory)
            raw = path.read_bytes()
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
            self.assertEqual(
                raw.decode("utf-8"),
                "#EXTM3U\r\n"
                "#EXTINF:-1,中文  标题\r\n"
                "https://emby.moear.de/videos/a%20b.mkv?x=1&y=2#片段\r\n"
                "#EXTINF:-1,b.mp4\r\n"
                "https://jellyfin.moear.de/videos/b.mp4\r\n",
            )

    def test_origins_and_limits(self) -> None:
        self.assertTrue(is_allowed_url("https://media.example.test/video.mp4", ["https://media.example.test"]))
        self.assertFalse(is_allowed_url("https://evil.example/video.mp4", ["https://media.example.test"]))

        one_thousand_twenty_four = [
            {"url": f"https://emby.moear.de/videos/{index}.mp4", "title": str(index)}
            for index in range(1024)
        ]
        self.assertEqual(len(validate_entries(one_thousand_twenty_four, [])), 1024)

        max_entries = [
            {"url": f"https://emby.moear.de/videos/{index}.mp4", "title": str(index)}
            for index in range(MAX_PLAYLIST_ITEMS)
        ]
        self.assertEqual(len(validate_entries(max_entries, [])), MAX_PLAYLIST_ITEMS)
        with self.assertRaisesRegex(ValueError, "4096"):
            validate_entries(max_entries + max_entries[:1], [])

    def test_invalid_entries_are_skipped_like_csharp_host(self) -> None:
        entries = validate_entries(
            [
                {"url": "not a URL", "title": "bad"},
                {"url": "https://untrusted.example/video.mp4", "title": "bad"},
                {"url": "https://emby.moear.de/video.mp4", "title": "ok"},
            ],
            [],
        )
        self.assertEqual([entry.title for entry in entries], ["ok"])
