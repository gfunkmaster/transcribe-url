#!/usr/bin/env python3
"""Render a static index.html for a folder of transcripts.

transcribe-url writes one subfolder per source; this module turns that folder
into a browsable page: a searchable table linking to every transcript file. No
server, no external assets, no JavaScript framework - one file you can open in a
browser or drop into a vault/static host.

Metadata comes from the markdown frontmatter when a source has a `.md` file
(written by `--emit md`), otherwise it is derived from the folder name, which
transcribe-url names `<extractor>-<id>` (or `local-<name>`).
"""

import argparse
import datetime
import html
import json
import os
import sys
import urllib.parse

TEXT_SUFFIXES = (".txt", ".srt", ".vtt", ".tsv")
AGENT_SUFFIXES = (".md", ".jsonl", ".json")


def parse_frontmatter(path):
    """Read the small YAML subset we write: `key: "json string"` or bare values."""
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return {}
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    meta = {}
    for line in text[3:end].splitlines():
        if not line.strip() or line.lstrip().startswith("#") or ":" not in line:
            continue
        key, _, raw = line.partition(":")
        raw = raw.strip()
        if raw.startswith('"'):
            try:
                raw = json.loads(raw)
            except ValueError:
                raw = raw.strip('"')
        meta[key.strip()] = raw
    return meta


def human_size(num_bytes):
    value = float(num_bytes)
    for unit in ("B", "KB", "MB"):
        if value < 1024 or unit == "MB":
            return "{:.0f} {}".format(value, unit) if unit == "B" else "{:.1f} {}".format(value, unit)
        value /= 1024
    return "{} B".format(num_bytes)


def split_folder_name(name):
    """`twitter-1600649511827013632` -> ('twitter', '1600649511827013632')."""
    stem = name
    if "-" in stem:
        head, _, tail = stem.rpartition("-")
        return head, tail
    return stem, ""


def collect(outdir):
    entries = []
    try:
        names = sorted(os.listdir(outdir))
    except OSError as error:
        print("error: cannot read {}: {}".format(outdir, error), file=sys.stderr)
        return entries

    for name in names:
        if name.startswith("."):
            continue
        folder = os.path.join(outdir, name)
        if not os.path.isdir(folder):
            continue
        files = []
        md_path = None
        for file_name in sorted(os.listdir(folder)):
            path = os.path.join(folder, file_name)
            if not os.path.isfile(path):
                continue
            files.append((file_name, os.path.getsize(path)))
            if md_path is None and file_name.endswith(".md"):
                md_path = path
        if not files:
            continue

        meta = parse_frontmatter(md_path) if md_path else {}
        extractor, identifier = split_folder_name(name)
        entries.append({
            "folder": name,
            "title": meta.get("title") or name,
            "extractor": meta.get("extractor") or extractor,
            "id": meta.get("id") or identifier,
            "uploader": meta.get("uploader") or "",
            "upload_date": meta.get("upload_date") or "",
            "duration": meta.get("duration") or "",
            "language": meta.get("language") or "",
            "model": meta.get("model") or "",
            "source_url": meta.get("source_url") or "",
            "transcribed_at": meta.get("transcribed_at") or "",
            "has_metadata": bool(meta),
            "files": files,
            "bytes": sum(size for _, size in files),
        })

    # Newest first; sources without frontmatter fall back to the folder name.
    entries.sort(key=lambda item: (item["transcribed_at"], item["folder"]), reverse=True)
    return entries

FILE_LABELS = {".txt": "txt", ".srt": "srt", ".vtt": "vtt", ".tsv": "tsv",
               ".md": "md", ".jsonl": "jsonl", ".json": "json"}


def file_chips(folder, files):
    chips = []
    for file_name, size in files:
        suffix = os.path.splitext(file_name)[1].lower()
        label = FILE_LABELS.get(suffix, suffix.lstrip(".") or "file")
        href = urllib.parse.quote(folder + "/" + file_name)
        kind = "agent" if suffix in AGENT_SUFFIXES else "text"
        chips.append(
            '<a class="chip {kind}" href="{href}" title="{title}">{label}</a>'.format(
                kind=kind, href=html.escape(href, quote=True),
                title=html.escape("{} ({})".format(file_name, human_size(size)), quote=True),
                label=html.escape(label)))
    return "".join(chips)


def primary_link(entry):
    """Prefer the markdown note, then any text file, then the folder itself."""
    by_suffix = {os.path.splitext(name)[1].lower(): name for name, _ in entry["files"]}
    for suffix in (".md", ".txt", ".srt"):
        if suffix in by_suffix:
            return urllib.parse.quote(entry["folder"] + "/" + by_suffix[suffix])
    if entry["files"]:
        return urllib.parse.quote(entry["folder"] + "/" + entry["files"][0][0])
    return urllib.parse.quote(entry["folder"] + "/")


def render_rows(entries):
    rows = []
    for entry in entries:
        source_bits = [part for part in (entry["extractor"], entry["uploader"],
                                         entry["upload_date"]) if part]
        source = " · ".join(source_bits) if source_bits else "—"
        if entry["source_url"]:
            source = '<a href="{}">{}</a>'.format(
                html.escape(entry["source_url"], quote=True), html.escape(source))
        note = "" if entry["has_metadata"] else ' <span class="warn" title="no md frontmatter">*</span>'
        rows.append(
            '        <tr>\n'
            '          <td class="title"><a href="{href}">{title}</a>{note}</td>\n'
            '          <td class="source">{source}</td>\n'
            '          <td class="num">{duration}</td>\n'
            '          <td>{language}</td>\n'
            '          <td class="files">{chips}</td>\n'
            '          <td class="num when">{when}</td>\n'
            '        </tr>'.format(
                href=html.escape(primary_link(entry), quote=True),
                title=html.escape(entry["title"]),
                note=note,
                source=source,
                duration=html.escape(entry["duration"] or "—"),
                language=html.escape(entry["language"] or "—"),
                chips=file_chips(entry["folder"], entry["files"]),
                when=html.escape(entry["transcribed_at"][:10] or "—")))
    if not rows:
        return ('        <tr><td colspan="6" class="empty">'
                'No transcripts found in this folder yet.</td></tr>')
    return "\n".join(rows)



CSS = """
  :root { color-scheme: light dark; --fg:#1c1c1e; --dim:#6b6b70; --line:#e3e3e6;
          --bg:#fff; --hover:#f7f7f9; --accent:#0b6bcb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#ececf0; --dim:#9a9aa1; --line:#2e2e33; --bg:#151517;
            --hover:#1d1d21; --accent:#6fb0ff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2.5rem 1.5rem; background:var(--bg); color:var(--fg);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width:1100px; margin:0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; letter-spacing:-.01em; }
  .sub { color:var(--dim); margin:0 0 1.25rem; font-size:.9rem; }
  input[type=search] { width:100%; padding:.6rem .8rem; font-size:.95rem;
         border:1px solid var(--line); border-radius:8px; background:var(--bg);
         color:var(--fg); margin-bottom:1rem; }
  table { width:100%; border-collapse:collapse; font-size:.92rem; }
  th { text-align:left; font-weight:600; font-size:.78rem; text-transform:uppercase;
       letter-spacing:.04em; color:var(--dim); border-bottom:1px solid var(--line);
       padding:.5rem .6rem; }
  td { border-bottom:1px solid var(--line); padding:.6rem; vertical-align:top; }
  tbody tr:hover { background:var(--hover); }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .title a { font-weight:600; }
  .source { color:var(--dim); }
  .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .when { color:var(--dim); }
  .chip { display:inline-block; padding:.05rem .4rem; margin:0 .2rem .2rem 0;
          border-radius:5px; border:1px solid var(--line); font-size:.75rem;
          color:var(--dim); }
  .chip.agent { border-color:var(--accent); color:var(--accent); }
  .warn { color:#c98a00; cursor:help; }
  .empty { color:var(--dim); text-align:center; padding:2rem; }
  footer { margin-top:1.5rem; color:var(--dim); font-size:.8rem; }
"""

SCRIPT = """
  const q = document.getElementById('q');
  const rows = Array.from(document.querySelectorAll('#rows tr'));
  const sub = document.querySelector('.sub');
  q.addEventListener('input', () => {
    const needle = q.value.trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const hit = !needle || row.textContent.toLowerCase().includes(needle);
      row.style.display = hit ? '' : 'none';
      if (hit) shown++;
    }
    sub.textContent = needle
      ? shown + ' of ' + rows.length + ' matching \\u201c' + q.value.trim() + '\\u201d'
      : rows.length + ' source(s)';
  });
"""



def render(entries, title, generated_at, tool_version):
    total_bytes = sum(entry["bytes"] for entry in entries)
    subtitle = "{count} source(s) · {size} · generated {generated} by transcribe-url {version}".format(
        count=len(entries), size=human_size(total_bytes),
        generated=html.escape(generated_at), version=html.escape(tool_version))
    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{css}</style>
</head>
<body>
<main>
  <h1>{title}</h1>
  <p class="sub">{subtitle}</p>
  <input id="q" type="search" autofocus
         placeholder="Filter by title, uploader, language, model, id…">
  <table>
    <thead>
      <tr>
        <th>Title</th><th>Source</th><th class="num">Length</th><th>Lang</th>
        <th>Files</th><th class="num">Transcribed</th>
      </tr>
    </thead>
    <tbody id="rows">
{rows}
    </tbody>
  </table>
  <footer>* no markdown frontmatter in that folder — run again with
  <code>--emit md</code> for full metadata.</footer>
</main>
<script>{script}</script>
</body>
</html>
""".format(title=html.escape(title), css=CSS, subtitle=subtitle,
           rows=render_rows(entries), script=SCRIPT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outdir", required=True, help="folder holding one subfolder per source")
    parser.add_argument("--title", default="Transcripts", help="page heading")
    parser.add_argument("--tool-version", default="", help="transcribe-url version shown in the footer")
    parser.add_argument("--output-name", default="index.html", help="file name to write")
    args = parser.parse_args()

    outdir = os.path.abspath(args.outdir)
    if not os.path.isdir(outdir):
        print("error: not a directory: {}".format(outdir), file=sys.stderr)
        return 1

    entries = collect(outdir)
    generated = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    page = render(entries, args.title or os.path.basename(outdir), generated,
                  args.tool_version)
    target = os.path.join(outdir, args.output_name)
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(page)
    print(target)
    print("{} source(s) indexed".format(len(entries)), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

