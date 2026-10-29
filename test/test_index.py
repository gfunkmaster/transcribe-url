"""Unit tests for lib/index.py (stdlib only)."""

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

import index  # noqa: E402

FRONTMATTER = """---
source_url: "https://x.com/someone/status/{id}"
extractor: "Twitter"
id: "{id}"
title: "{title}"
uploader: "Jocelyn Laidlaw"
upload_date: "2022-12-08"
duration: "01:42"
duration_seconds: 102
language: "en"
model: "mlx-community/whisper-large-v3-turbo"
audio_sha256: "abc123"
transcribed_at: "{when}"
---

# {title}

- **00:00** text
"""


class ParseFrontmatter(unittest.TestCase):
    def test_reads_json_quoted_scalars(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "note.md")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(FRONTMATTER.format(id="42", title="Hello: world", when="2026-01-02T03:04:05Z"))
            meta = index.parse_frontmatter(path)
        self.assertEqual(meta["id"], "42")
        self.assertEqual(meta["title"], "Hello: world")
        self.assertEqual(meta["transcribed_at"], "2026-01-02T03:04:05Z")

    def test_tolerates_plain_and_missing_frontmatter(self):
        with tempfile.TemporaryDirectory() as tmp:
            plain = os.path.join(tmp, "a.md")
            with open(plain, "w", encoding="utf-8") as handle:
                handle.write("---\ntitle: No quotes here\n---\n\nbody\n")
            bare = os.path.join(tmp, "b.md")
            with open(bare, "w", encoding="utf-8") as handle:
                handle.write("# just a heading\n")
            self.assertEqual(index.parse_frontmatter(plain)["title"], "No quotes here")
            self.assertEqual(index.parse_frontmatter(bare), {})
            self.assertEqual(index.parse_frontmatter(os.path.join(tmp, "missing.md")), {})


class Collect(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.out = os.path.join(self.root, "transcripts")
        os.makedirs(os.path.join(self.out, "twitter-1600649511827013632"))
        os.makedirs(os.path.join(self.out, "local-interview"))
        os.makedirs(os.path.join(self.out, ".hidden"))
        os.makedirs(os.path.join(self.out, "empty-folder"))

        folder = os.path.join(self.out, "twitter-1600649511827013632")
        with open(os.path.join(folder, "note.md"), "w", encoding="utf-8") as handle:
            handle.write(FRONTMATTER.format(id="1600649511827013632", title="A tweet",
                                            when="2026-10-27T20:14:36Z"))
        with open(os.path.join(folder, "note.srt"), "w", encoding="utf-8") as handle:
            handle.write("1\n00:00:00,000 --> 00:00:01,000\nhi\n")
        with open(os.path.join(self.out, "local-interview", "interview.txt"), "w",
                  encoding="utf-8") as handle:
            handle.write("no metadata here\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_collects_only_non_empty_visible_folders(self):
        entries = index.collect(self.out)
        self.assertEqual([entry["folder"] for entry in entries],
                         ["twitter-1600649511827013632", "local-interview"])

    def test_metadata_and_fallback(self):
        by_name = {entry["folder"]: entry for entry in index.collect(self.out)}
        rich = by_name["twitter-1600649511827013632"]
        self.assertTrue(rich["has_metadata"])
        self.assertEqual(rich["title"], "A tweet")
        self.assertEqual(rich["extractor"], "Twitter")
        self.assertEqual(rich["duration"], "01:42")

        plain = by_name["local-interview"]
        self.assertFalse(plain["has_metadata"])
        self.assertEqual(plain["title"], "local-interview")
        self.assertEqual(plain["extractor"], "local")
        self.assertEqual(plain["id"], "interview")

    def test_sorted_newest_first(self):
        with open(os.path.join(self.out, "local-interview", "note.md"), "w",
                  encoding="utf-8") as handle:
            handle.write(FRONTMATTER.format(id="x", title="Newer note",
                                            when="2027-01-01T00:00:00Z"))
        entries = index.collect(self.out)
        self.assertEqual(entries[0]["folder"], "local-interview")


class Render(unittest.TestCase):
    def _entry(self, **overrides):
        entry = {
            "folder": "twitter-1", "title": "A tweet", "extractor": "Twitter",
            "id": "1", "uploader": "Someone", "upload_date": "2022-12-08",
            "duration": "01:42", "language": "en", "model": "m",
            "source_url": "https://x.com/someone/status/1",
            "transcribed_at": "2026-10-27T20:14:36Z", "has_metadata": True,
            "files": [("note.md", 10), ("note.srt", 20)], "bytes": 30,
        }
        entry.update(overrides)
        return entry

    def test_renders_links_and_metadata(self):
        page = index.render([self._entry()], "Transcripts", "2026-10-27 21:00 UTC", "0.5.0")
        self.assertIn("A tweet", page)
        self.assertIn('href="twitter-1/note.md"', page)
        self.assertIn("https://x.com/someone/status/1", page)
        self.assertIn("0.5.0", page)
        self.assertIn('class="chip agent"', page)

    def test_escapes_untrusted_titles(self):
        page = index.render([self._entry(title='<script>alert("x")</script>')],
                            "T", "now", "0.5.0")
        self.assertNotIn("<script>alert", page)
        self.assertIn("&lt;script&gt;", page)

    def test_warns_when_metadata_missing(self):
        page = index.render([self._entry(has_metadata=False)], "T", "now", "0.5.0")
        self.assertIn('class="warn"', page)

    def test_empty_folder_message(self):
        page = index.render([], "T", "now", "0.5.0")
        self.assertIn("No transcripts found", page)


if __name__ == "__main__":
    unittest.main()
