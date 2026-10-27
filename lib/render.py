#!/usr/bin/env python3
"""Render agent-friendly outputs from an mlx-whisper transcript.

mlx-whisper emits very short segments (~3 s / ~10 words). Embedding those
directly is poor, so consecutive segments are merged into windows of roughly
--window seconds, cutting only on segment boundaries and keeping the first
start and the last end of each window.

Outputs
  <base>.md     YAML frontmatter from yt-dlp's info JSON + anchored transcript
  <base>.jsonl  one merged window per line, for embedding/retrieval pipelines

Timestamped ("deep") links are only emitted for extractors that support them
(currently YouTube). Everything else keeps start/end plus the source URL,
because e.g. X/Twitter has no timestamped URL scheme.
"""

import argparse
import json
import os
import sys

# Extractors whose URLs accept a timestamp parameter, lowercased prefixes.
DEEP_LINK_PREFIXES = ("youtube",)

# Bump when md frontmatter or jsonl record keys change incompatibly.
SCHEMA_VERSION = 1


def mmss(seconds):
    total = int(seconds)
    return "{:02d}:{:02d}".format(total // 60, total % 60)


def yaml_scalar(value):
    """A JSON string is a valid YAML double-quoted scalar."""
    if value is None:
        value = ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return json.dumps(str(value), ensure_ascii=False)


def load_json(path):
    if not path or path == "-":
        return {}
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


# Whisper hallucinates on silence/music by repeating one phrase. Keep a phrase
# at most this many times in a row; the rest is a decoding loop, not speech.
MAX_CONSECUTIVE_REPEATS = 2


def drop_repeat_loops(segments):
    """Drop segments past MAX_CONSECUTIVE_REPEATS identical texts in a row."""
    kept = []
    previous = None
    run = 0
    dropped = 0
    for segment in segments:
        key = (segment.get("text") or "").strip().lower()
        run = run + 1 if key and key == previous else 1
        previous = key
        if key and run > MAX_CONSECUTIVE_REPEATS:
            dropped += 1
            continue
        kept.append(segment)
    return kept, dropped


def merge_windows(segments, window):
    """Merge segments into ~window-second windows on segment boundaries."""
    merged = []
    current = None
    for segment in segments:
        text = (segment.get("text") or "").strip()
        if not text:
            continue
        try:
            start = float(segment.get("start") or 0.0)
            end = float(segment.get("end") if segment.get("end") is not None else start)
        except (TypeError, ValueError):
            continue
        if current is None:
            current = {"start": round(start, 3), "end": round(end, 3), "parts": [text]}
        else:
            current["parts"].append(text)
            current["end"] = round(end, 3)
        if current["end"] - current["start"] >= window:
            merged.append(current)
            current = None
    if current is not None:
        merged.append(current)
    return [
        {"start": item["start"], "end": item["end"], "text": " ".join(item["parts"])}
        for item in merged
    ]


def deep_link(extractor, url, start):
    name = (extractor or "").lower()
    if not url or not name.startswith(DEEP_LINK_PREFIXES):
        return ""
    separator = "&" if "?" in url else "?"
    return "{}{}t={}s".format(url, separator, int(start))


def normalise_date(value):
    text = str(value or "")
    if len(text) == 8 and text.isdigit():
        return "{}-{}-{}".format(text[0:4], text[4:6], text[6:8])
    return text


def build_metadata(args, info, transcript):
    source_url = info.get("webpage_url") or info.get("original_url") or args.source
    extractor = info.get("extractor_key") or info.get("extractor") or "local"
    language = transcript.get("language") or info.get("language") or ""
    duration = info.get("duration")
    try:
        duration_seconds = int(float(duration)) if duration not in (None, "") else ""
    except (TypeError, ValueError):
        duration_seconds = ""
    return {
        "source_url": source_url,
        "extractor": extractor,
        "id": info.get("id") or args.base,
        "title": info.get("title") or "",
        "uploader": info.get("uploader") or info.get("channel") or "",
        "upload_date": normalise_date(info.get("upload_date")),
        "duration": mmss(duration_seconds) if duration_seconds != "" else "",
        "duration_seconds": duration_seconds,
        "language": language,
        "model": args.model,
        "model_revision": args.model_revision,
        "tool_version": args.tool_version,
        "schema_version": SCHEMA_VERSION,
        "audio_sha256": args.audio_sha256,
        "transcribed_at": args.transcribed_at,
    }


FRONTMATTER_KEYS = ("source_url", "extractor", "id", "title", "uploader", "upload_date",
                    "duration", "duration_seconds", "language", "model", "model_revision", "tool_version",
                    "schema_version", "audio_sha256",
                    "transcribed_at")


def write_markdown(path, meta, windows):
    lines = ["---"]
    for key in FRONTMATTER_KEYS:
        lines.append("{}: {}".format(key, yaml_scalar(meta[key])))
    lines.append("---")
    lines.append("")
    lines.append("# {}".format(meta["title"] or meta["id"] or "Transcript"))
    lines.append("")

    detail = []
    if meta["uploader"]:
        detail.append("uploaded by {}".format(meta["uploader"]))
    if meta["upload_date"]:
        detail.append(meta["upload_date"])
    if meta["source_url"] and detail:
        lines.append("{} — {}".format(meta["source_url"], ", ".join(detail)))
    elif meta["source_url"]:
        lines.append(meta["source_url"])
    elif detail:
        lines.append(", ".join(detail))
    lines.append("")

    for window in windows:
        stamp = mmss(window["start"])
        link = deep_link(meta["extractor"], meta["source_url"], window["start"])
        anchor = "[{}]({})".format(stamp, link) if link else stamp
        lines.append("- **{}** {}".format(anchor, window["text"]))
    lines.append("")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))


def write_jsonl(path, meta, windows):
    with open(path, "w", encoding="utf-8") as handle:
        for window in windows:
            record = {
                "start": window["start"],
                "end": window["end"],
                "text": window["text"],
                "source_url": meta["source_url"],
                "id": meta["id"],
                "schema_version": SCHEMA_VERSION,
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--segments", required=True, help="mlx-whisper JSON output")
    parser.add_argument("--info", default="-", help="yt-dlp info JSON ('-' if unavailable)")
    parser.add_argument("--window", type=float, default=45.0, help="merge window (seconds)")
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--base", required=True, help="output file basename")
    parser.add_argument("--formats", default="md", help="comma separated md,jsonl")
    parser.add_argument("--model", default="")
    parser.add_argument("--model-revision", default="")
    parser.add_argument("--tool-version", default="")
    parser.add_argument("--audio-sha256", default="")
    parser.add_argument("--transcribed-at", default="")
    parser.add_argument("--source", default="", help="fallback source URL or path")
    args = parser.parse_args()

    if args.window <= 0:
        print("error: --window must be greater than 0", file=sys.stderr)
        return 2

    transcript = load_json(args.segments)
    if "segments" not in transcript:
        print("error: {} has no 'segments' key".format(args.segments), file=sys.stderr)
        return 1
    segments = transcript.get("segments") or []
    if not segments:
        # Legitimate for silent or non-speech audio: write empty outputs rather
        # than failing the run.
        print("note: no speech segments found (silence or non-speech audio)",
              file=sys.stderr)

    info = load_json(args.info)
    segments, dropped = drop_repeat_loops(segments)
    if dropped:
        print("note: dropped {} repeated segment(s) (likely a Whisper loop)".format(dropped),
              file=sys.stderr)
    windows = merge_windows(segments, args.window)
    meta = build_metadata(args, info, transcript)
    os.makedirs(args.outdir, exist_ok=True)

    written = []
    for fmt in [f.strip() for f in args.formats.split(",") if f.strip()]:
        if fmt == "md":
            path = os.path.join(args.outdir, args.base + ".md")
            write_markdown(path, meta, windows)
        elif fmt == "jsonl":
            path = os.path.join(args.outdir, args.base + ".jsonl")
            write_jsonl(path, meta, windows)
        else:
            print("error: renderer does not support format '{}'".format(fmt), file=sys.stderr)
            return 2
        written.append(path)

    for path in written:
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
