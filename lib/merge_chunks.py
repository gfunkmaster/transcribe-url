#!/usr/bin/env python3
"""Merge per-chunk mlx-whisper JSON files into one transcript.

Long audio is split into fixed-length chunks and transcribed one at a time, which
bounds memory use and stops Whisper's decoding from degenerating over hours. This
shifts every chunk's timestamps by its offset and writes the formats mlx-whisper
would have produced for a single run (json, txt, srt, vtt, tsv).
"""

import argparse
import json
import sys

WRITERS = ("json", "txt", "srt", "vtt", "tsv")


def shift(segment, offset):
    out = dict(segment)
    for key in ("start", "end"):
        if out.get(key) is not None:
            out[key] = round(float(out[key]) + offset, 3)
    if isinstance(out.get("words"), list):
        out["words"] = [shift(word, offset) for word in out["words"]]
    return out


def merge(chunks, chunk_seconds):
    """chunks: list of parsed mlx-whisper JSON dicts, in order."""
    segments = []
    language = ""
    for index, chunk in enumerate(chunks):
        language = language or chunk.get("language") or ""
        for segment in chunk.get("segments") or []:
            segments.append(shift(segment, index * chunk_seconds))
    for number, segment in enumerate(segments):
        segment["id"] = number
    text = "".join(segment.get("text") or "" for segment in segments)
    return {"text": text, "segments": segments, "language": language}


def stamp(seconds, comma, force_hours):
    ms = int(round(float(seconds) * 1000))
    hours, ms = divmod(ms, 3600000)
    minutes, ms = divmod(ms, 60000)
    secs, ms = divmod(ms, 1000)
    sep = "," if comma else "."
    if hours or force_hours:
        return "{:02d}:{:02d}:{:02d}{}{:03d}".format(hours, minutes, secs, sep, ms)
    return "{:02d}:{:02d}{}{:03d}".format(minutes, secs, sep, ms)


def render(fmt, merged):
    segments = merged["segments"]
    if fmt == "json":
        return json.dumps(merged, ensure_ascii=False)
    if fmt == "txt":
        return "".join("{}\n".format((s.get("text") or "").strip()) for s in segments)
    if fmt == "tsv":
        rows = ["start\tend\ttext"]
        for s in segments:
            rows.append("{}\t{}\t{}".format(
                int(round(float(s["start"]) * 1000)),
                int(round(float(s["end"]) * 1000)),
                (s.get("text") or "").strip().replace("\t", " ")))
        return "\n".join(rows) + "\n"
    if fmt == "srt":
        blocks = []
        for number, s in enumerate(segments, 1):
            blocks.append("{}\n{} --> {}\n{}\n".format(
                number, stamp(s["start"], True, True), stamp(s["end"], True, True),
                (s.get("text") or "").strip()))
        return "\n".join(blocks) + ("\n" if blocks else "")
    if fmt == "vtt":
        blocks = ["WEBVTT\n"]
        for s in segments:
            blocks.append("{} --> {}\n{}\n".format(
                stamp(s["start"], False, False), stamp(s["end"], False, False),
                (s.get("text") or "").strip()))
        return "\n".join(blocks) + "\n"
    raise ValueError(fmt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chunk-seconds", type=float, required=True)
    parser.add_argument("--out-base", required=True, help="path prefix, e.g. /tmp/x/name")
    parser.add_argument("--formats", default="json", help="comma separated subset of " + ",".join(WRITERS))
    parser.add_argument("chunks", nargs="+", help="chunk JSON files, in order")
    args = parser.parse_args()

    loaded = []
    for path in args.chunks:
        try:
            with open(path, encoding="utf-8") as handle:
                loaded.append(json.load(handle))
        except (OSError, ValueError) as error:
            print("error: cannot read {}: {}".format(path, error), file=sys.stderr)
            return 1
    merged = merge(loaded, args.chunk_seconds)
    for fmt in [f.strip() for f in args.formats.split(",") if f.strip()]:
        if fmt not in WRITERS:
            print("error: unsupported format '{}'".format(fmt), file=sys.stderr)
            return 2
        with open("{}.{}".format(args.out_base, fmt), "w", encoding="utf-8") as handle:
            handle.write(render(fmt, merged))
    return 0


if __name__ == "__main__":
    sys.exit(main())
