"""Unit tests for lib/render.py and lib/merge_chunks.py (stdlib only)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

import merge_chunks  # noqa: E402
import render  # noqa: E402


def seg(start, end, text):
    return {"start": start, "end": end, "text": text}


class MergeWindows(unittest.TestCase):
    def test_no_text_is_lost_and_order_is_kept(self):
        segs = [seg(i * 3.0, i * 3.0 + 3.0, " w{}".format(i)) for i in range(40)]
        for window in (5, 20, 45, 1000):
            merged = render.merge_windows(segs, window)
            self.assertEqual(" ".join(m["text"] for m in merged),
                             " ".join("w{}".format(i) for i in range(40)))

    def test_windows_do_not_overlap_and_are_monotonic(self):
        segs = [seg(i * 3.0, i * 3.0 + 3.0, "x") for i in range(40)]
        merged = render.merge_windows(segs, 20)
        for a, b in zip(merged, merged[1:]):
            self.assertLessEqual(a["end"], b["start"])
            self.assertLess(a["start"], a["end"])

    def test_blank_and_malformed_segments_are_skipped(self):
        segs = [seg(0, 1, "  "), {"start": "bad", "end": 2, "text": "x"}, seg(2, 3, "ok")]
        self.assertEqual([m["text"] for m in render.merge_windows(segs, 45)], ["ok"])


class RepeatLoops(unittest.TestCase):
    def test_cap_is_per_consecutive_run(self):
        segs = [seg(i, i + 1, " Hi.") for i in range(5)] + [seg(5, 6, "Other")] + \
               [seg(6 + i, 7 + i, "hi.") for i in range(3)]
        kept, dropped = render.drop_repeat_loops(segs)
        self.assertEqual(dropped, 4)  # 3 of the first run, 1 of the second (case-insensitive)
        self.assertEqual(len(kept), 5 + 1 + 3 - 4)


class Dates(unittest.TestCase):
    def test_normalise(self):
        self.assertEqual(render.normalise_date("20221208"), "2022-12-08")
        self.assertEqual(render.normalise_date("2022-12-08"), "2022-12-08")
        self.assertEqual(render.normalise_date(None), "")


class DeepLinks(unittest.TestCase):
    def test_youtube_only(self):
        self.assertEqual(render.deep_link("Youtube", "https://y/watch?v=1", 46.9),
                         "https://y/watch?v=1&t=46s")
        self.assertEqual(render.deep_link("Twitter", "https://x/1", 5), "")
        self.assertEqual(render.deep_link("Youtube", "", 5), "")


class Chunks(unittest.TestCase):
    def test_offsets_apply_to_segments_and_words(self):
        chunk = {"language": "sv", "segments": [
            {"start": 1.0, "end": 2.0, "text": " a", "words": [{"start": 1.0, "end": 1.5, "word": "a"}]}]}
        merged = merge_chunks.merge([chunk, chunk], 600)
        self.assertEqual(merged["language"], "sv")
        self.assertEqual(merged["segments"][1]["start"], 601.0)
        self.assertEqual(merged["segments"][1]["words"][0]["end"], 601.5)
        self.assertEqual([s["id"] for s in merged["segments"]], [0, 1])

    def test_hour_timestamps(self):
        self.assertEqual(merge_chunks.stamp(3661.5, True, True), "01:01:01,500")
        self.assertEqual(merge_chunks.stamp(61.5, False, False), "01:01.500")


if __name__ == "__main__":
    unittest.main()
