from __future__ import annotations

import unittest

from playback_monitor import milliseconds_to_ticks, select_entry_index
from playlist import PlaylistEntry


class PlaybackMonitorTests(unittest.TestCase):
    def test_milliseconds_to_ticks(self) -> None:
        self.assertEqual(milliseconds_to_ticks(1234), 12_340_000)

    def test_select_entry_index_by_window_title(self) -> None:
        entries = [
            PlaylistEntry("https://emby.moear.de/a.mp4", "第一集", item_id="item-1"),
            PlaylistEntry("https://emby.moear.de/b.mp4", "第二集", item_id="item-2"),
        ]
        self.assertEqual(select_entry_index(entries, "第二集 - PotPlayer"), 1)
        self.assertEqual(select_entry_index(entries, "PotPlayer", current_index=1), 1)


if __name__ == "__main__":
    unittest.main()
