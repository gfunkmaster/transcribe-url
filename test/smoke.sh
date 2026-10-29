#!/usr/bin/env bash
#
# smoke.sh - fast checks for transcribe-url.
#
# Default mode is fully offline: it covers the CLI contract (help, argument
# validation, dependency detection) and temp-file cleanup.
# Set SMOKE_NETWORK=1 to also exercise the real pipeline end to end with the
# small whisper-tiny model on a generated 3 second fixture (downloads ~75 MB
# on the first run).
#
# Usage: test/smoke.sh [-v]
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/transcribe-url.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

[ -f "$SCRIPT" ] || { echo "error: $SCRIPT not found" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/transcribe-smoke.XXXXXX")" || exit 1
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
FAILED=""

ok() { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }

no() {
    fail=$((fail + 1))
    FAILED="$FAILED  - $1
"
    printf '  FAIL  %s\n' "$1"
    if [ "$VERBOSE" -eq 1 ] && [ -f "$TMP/out" ]; then
        sed 's/^/        | /' "$TMP/out" | head -20
    fi
}

# case_ <expected exit> <expected output substring|""> <description> <command...>
case_() {
    want="$1"
    want_text="$2"
    desc="$3"
    shift 3
    "$@" >"$TMP/out" 2>&1
    got=$?
    if [ "$got" -ne "$want" ]; then
        no "$desc (exit $got, want $want)"
        return
    fi
    if [ -n "$want_text" ] && ! grep -qF -- "$want_text" "$TMP/out"; then
        no "$desc (output does not contain: $want_text)"
        return
    fi
    ok "$desc"
}

temp_dirs() {
    find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'transcribe.*' 2>/dev/null | wc -l | tr -d ' '
}

# --- offline: CLI contract --------------------------------------------------
printf '\nCLI contract\n'
case_ 0 "Usage:" "--help exits 0" "$SCRIPT" --help
case_ 0 "-o, --output-dir" "--help documents options" "$SCRIPT" --help
case_ 2 "" "no arguments exits 2" "$SCRIPT"
case_ 2 "unknown option" "unknown option exits 2" "$SCRIPT" -z
case_ 1 "unsupported format" "unsupported format exits 1" "$SCRIPT" -f txt,pdf https://example.com
case_ 2 "" "missing value for -o exits 2" "$SCRIPT" -o

# --- offline: dependency detection ------------------------------------------
printf '\nDependency detection\n'
case_ 1 "yt-dlp not found" "missing yt-dlp is reported" \
    env PATH=/usr/bin:/bin "$SCRIPT" https://example.com

# PATH with yt-dlp and ffmpeg but deliberately without mlx_whisper.
# Only meaningful when those two are actually installed (they are not on a bare
# CI runner), so skip rather than report a false failure.
if command -v yt-dlp >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1; then
    mkdir -p "$TMP/bin"
    for b in yt-dlp ffmpeg; do
        p="$(command -v "$b")" && ln -sf "$p" "$TMP/bin/$b"
    done
    case_ 1 "mlx_whisper not found" "missing mlx_whisper is reported" \
        env PATH="$TMP/bin:/usr/bin:/bin" "$SCRIPT" https://example.com
else
    printf '  skip  missing mlx_whisper is reported (needs yt-dlp + ffmpeg installed)\n'
fi

# --- offline: failure handling and cleanup ----------------------------------
printf '\nFailure handling\n'
before="$(temp_dirs)"
case_ 1 "" "nonexistent input exits 1" "$SCRIPT" "$TMP/does-not-exist.mp4"
after="$(temp_dirs)"
if [ "$after" -le "$before" ]; then
    ok "temp directory cleaned up after failure"
else
    no "temp directory leaked ($before -> $after)"
fi

if [ ! -f "$TMP/does-not-exist.txt" ] && [ ! -f "$TMP/does-not-exist.srt" ]; then
    ok "no output files written for a failed run"
else
    no "output files written even though the run failed"
fi

# --- offline: new CLI surface ----------------------------------------------
printf '\nmd/jsonl CLI validation\n'
case_ 1 "unsupported format" "bad format in -f is rejected" "$SCRIPT" -f md,docx https://example.com
case_ 1 "unsupported format" "bad --emit value is rejected" "$SCRIPT" --emit docx https://example.com
case_ 2 "needs a value" "--window without a value exits 2" "$SCRIPT" --window
case_ 1 "whole number" "--window rejects non-numeric values" "$SCRIPT" --window abc https://example.com
case_ 1 "greater than 0" "--window 0 is rejected" "$SCRIPT" --window 0 https://example.com
case_ 0 "0.6.1" "--version prints the version" "$SCRIPT" --version
ver="$("$SCRIPT" --version | awk '{print $2}')"
newest="$(grep -m1 -o '^## \[[0-9.]*\]' "$ROOT/CHANGELOG.md" | tr -d '#[] ')"
if [ "$ver" = "$newest" ]; then
    ok "VERSION matches the newest CHANGELOG entry ($ver)"
else
    no "VERSION is $ver but the newest CHANGELOG entry is $newest"
fi

# --- offline: output layout --------------------------------------------------
printf '\nOutput layout\n'
case_ 0 "<extractor>-<id>" "default outdir is ./transcripts with a per-source folder" \
    "$SCRIPT" --dry-run https://example.com
case_ 0 "(flat)" "--flat disables the per-source folder" \
    "$SCRIPT" --dry-run --flat https://example.com
case_ 0 "/tmp/smoke-outdir/<extractor>-<id>/" "TRANSCRIBE_OUTDIR overrides the default dir" \
    env TRANSCRIBE_OUTDIR=/tmp/smoke-outdir "$SCRIPT" --dry-run https://example.com
case_ 0 "/tmp/smoke-explicit/<extractor>-<id>/" "-o still wins over the default" \
    "$SCRIPT" --dry-run -o /tmp/smoke-explicit https://example.com

# --- offline: batch, dry-run, chunk flags -----------------------------------
printf '\nBatch / dry-run / chunk flags\n'
printf '# comment\n\nhttps://example.com/a\n  https://example.com/b  \n' >"$TMP/urls.txt"
case_ 0 "https://example.com/a" "--dry-run lists batch-file entries" "$SCRIPT" --dry-run -a "$TMP/urls.txt"
if grep -q 'example.com/b' "$TMP/out" && ! grep -q 'comment' "$TMP/out"; then
    ok "batch file trims lines and skips comments/blanks"
else
    no "batch file parsing wrong"
fi
case_ 0 "local file (no download)" "--dry-run recognises local files" "$SCRIPT" --dry-run "$ROOT/README.md"
case_ 1 "batch file not found" "missing batch file is an error" "$SCRIPT" -a "$TMP/nope.txt"
case_ 1 "whole number" "--chunk rejects non-numeric values" "$SCRIPT" --chunk abc https://example.com
case_ 2 "needs a value" "--chunk without a value exits 2" "$SCRIPT" --chunk
before="$(temp_dirs)"
case_ 0 "" "--dry-run creates no temp dir" "$SCRIPT" --dry-run https://example.com
if [ "$(temp_dirs)" = "$before" ]; then
    ok "dry run leaves nothing behind"
else
    no "dry run leaked a temp dir"
fi

# --- offline: json events ----------------------------------------------------
printf '\nJSON events (--json-events)\n'
if ! command -v python3 >/dev/null 2>&1; then
    printf '  skip  json event tests (python3 not on PATH)\n'
else
    "$SCRIPT" --json-events --dry-run https://example.com/x \
        >"$TMP/ev.json" 2>"$TMP/ev.err"
    if python3 - "$TMP/ev.json" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
names = [row["event"] for row in rows]
assert names == ["start", "dry_run", "done"], names
assert rows[0]["model"], "model missing"
assert rows[0]["formats"] == "txt,srt", rows[0]
assert "outdir" in rows[0], "outdir missing"
assert rows[2]["status"] == "dry-run", rows[2]
PY
    then
        ok "dry run emits NDJSON events on stdout"
    else
        no "dry run NDJSON events are wrong"
    fi
    if grep -qv '^{' "$TMP/ev.json" 2>/dev/null; then
        no "stdout contains non-JSON lines under --json-events"
    else
        ok "stdout is pure NDJSON under --json-events"
    fi
    if grep -q 'dry run - nothing' "$TMP/ev.err" 2>/dev/null; then
        ok "human output moved to stderr"
    else
        no "human output did not move to stderr"
    fi

    # A failed run must emit an `error` event, not just exit 1. On a bare machine
    # the failure happens at preflight (no yt-dlp), which now also emits one.
    # Retries are cut to one so this stays fast.
    env TRANSCRIBE_RETRIES=1 "$SCRIPT" --json-events "$TMP/nope.mp4" \
        >"$TMP/evfail.json" 2>/dev/null
    if python3 - "$TMP/evfail.json" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
names = [row["event"] for row in rows]
assert names and names[0] == "start", names
assert "error" in names, names
failure = next(row for row in rows if row["event"] == "error")
assert failure.get("message"), failure
PY
    then
        ok "failed run emits an error event"
    else
        no "failed run did not emit a usable error event"
    fi

    # With dependencies present the failure is a download failure and the run ends
    # with done(partial); without them it is a preflight death (no done event).
    if command -v yt-dlp >/dev/null 2>&1; then
        if python3 - "$TMP/evfail.json" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
failure = next(row for row in rows if row["event"] == "error")
assert failure.get("stage") == "download", failure
assert rows[-1]["event"] == "done", rows[-1]
assert rows[-1]["status"] == "partial", rows[-1]
PY
        then
            ok "download failure carries stage=download and ends done(partial)"
        else
            no "download failure event shape is wrong"
        fi
    else
        printf '  skip  download-failure event shape (needs yt-dlp installed)\n'
    fi
fi

# --- offline: index-only mode ------------------------------------------------
printf '\nIndex (--index)\n'
if ! command -v python3 >/dev/null 2>&1; then
    printf '  skip  index tests (python3 not on PATH)\n'
else
    IDX="$TMP/index/sources"
    mkdir -p "$IDX/twitter-42"
    cat >"$IDX/twitter-42/note.md" <<'MD'
---
source_url: "https://x.com/someone/status/42"
extractor: "Twitter"
id: "42"
title: "Indexed title"
uploader: "Someone"
upload_date: "2026-01-01"
duration: "00:10"
language: "en"
model: "test-model"
transcribed_at: "2026-01-02T03:04:05Z"
---

# Indexed title
MD
    printf 'hello\n' >"$IDX/twitter-42/note.txt"

    case_ 0 "index.html" "--index with no URL rebuilds the index" \
        "$SCRIPT" --index -o "$IDX"
    if [ -f "$IDX/index.html" ] && grep -qF 'Indexed title' "$IDX/index.html"; then
        ok "index.html lists the source title"
    else
        no "index.html missing or missing the title"
    fi
    if grep -qF 'href="twitter-42/note.md"' "$IDX/index.html"; then
        ok "index links to the transcript files"
    else
        no "index has no links to the transcript files"
    fi
    case_ 0 "" "--index accepts a missing/empty folder" \
        "$SCRIPT" --index -o "$TMP/index/empty"
fi
printf '\nRenderer (md/jsonl)\n'
if ! command -v python3 >/dev/null 2>&1; then
    printf '  skip  renderer tests (python3 not on PATH)\n'
else
    R="$TMP/render"
    FIX="$ROOT/test/fixtures"

    python3 "$ROOT/lib/render.py" --segments "$FIX/segments.json" \
        --info "$FIX/info-youtube.json" --window 45 --outdir "$R/yt" --base v \
        --formats md,jsonl --model test-model --audio-sha256 abc123 \
        --transcribed-at 2026-01-01T00:00:00Z >/dev/null 2>&1
    python3 "$ROOT/lib/render.py" --segments "$FIX/segments.json" \
        --info "$FIX/info-twitter.json" --window 45 --outdir "$R/tw" --base t \
        --formats md >/dev/null 2>&1
    python3 "$ROOT/lib/render.py" --segments "$FIX/segments.json" \
        --info "$FIX/info-youtube.json" --window 20 --outdir "$R/w20" --base w20 \
        --formats jsonl >/dev/null 2>&1

    if [ -f "$R/yt/v.md" ] && [ -f "$R/yt/v.jsonl" ]; then
        ok "renderer writes md and jsonl"
    else
        no "renderer did not write the requested files"
    fi

    n="$(wc -l <"$R/yt/v.jsonl" 2>/dev/null | tr -d ' ')"
    if [ "$n" = "2" ]; then
        ok "45 s window merges 5 segments into 2 windows"
    else
        no "expected 2 windows at --window 45, got ${n:-0}"
    fi

    if head -1 "$R/yt/v.jsonl" | grep -qF '"start": 0.0, "end": 48.0'; then
        ok "window keeps first start and last end (0.0-48.0)"
    else
        no "first window boundaries are wrong: $(head -1 "$R/yt/v.jsonl")"
    fi

    n="$(wc -l <"$R/w20/w20.jsonl" 2>/dev/null | tr -d ' ')"
    if [ "$n" = "3" ]; then
        ok "--window 20 changes the merge width"
    else
        no "expected 3 windows at --window 20, got ${n:-0}"
    fi

    missing=""
    for key in source_url extractor id uploader upload_date duration duration_seconds \
               language model audio_sha256 transcribed_at; do
        grep -q "^$key: " "$R/yt/v.md" || missing="$missing $key"
    done
    if [ -z "$missing" ]; then
        ok "frontmatter carries all provenance fields"
    else
        no "frontmatter missing:$missing"
    fi

    if grep -qF 'upload_date: "2026-01-02"' "$R/yt/v.md" &&
        grep -qF 'source_url: "https://www.youtube.com/watch?v=vid123"' "$R/yt/v.md" &&
        grep -qF 'duration_seconds: 58' "$R/yt/v.md"; then
        ok "metadata comes from the yt-dlp info JSON"
    else
        no "metadata does not match the info JSON fixture"
    fi

    if grep -qF 'watch?v=vid123&t=0s' "$R/yt/v.md" && grep -qF 'watch?v=vid123&t=48s' "$R/yt/v.md"; then
        ok "YouTube output gets timestamped deep links"
    else
        no "missing YouTube deep links"
    fi

    if grep -q 't=[0-9]*s' "$R/tw/t.md"; then
        no "X/Twitter output must not contain timestamped deep links"
    else
        ok "X/Twitter output has no deep links (none exist)"
    fi

    if python3 - "$R/yt/v.jsonl" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8")]
required = {"start", "end", "text", "source_url", "id"}
assert rows, "no rows"
assert all(required <= set(r) for r in rows), "missing keys"
assert all(r["end"] > r["start"] for r in rows), "bad windows"
PY
    then
        ok "jsonl rows are valid JSON with the required keys"
    else
        no "jsonl rows are malformed"
    fi

    if grep -q '^tool_version: ' "$R/yt/v.md" && grep -q '^schema_version: 1' "$R/yt/v.md" &&
        head -1 "$R/yt/v.jsonl" | grep -qF '"schema_version": 1'; then
        ok "md and jsonl carry tool_version/schema_version"
    else
        no "schema_version/tool_version missing from md or jsonl"
    fi

    # A Whisper decoding loop (same phrase over and over) must not reach the output.
    python3 - "$R/loop.json" <<'PY'
import json, sys
segs = [{"start": i * 3.0, "end": i * 3.0 + 3.0, "text": " Thank you."} for i in range(10)]
segs.append({"start": 30.0, "end": 33.0, "text": " Real speech."})
json.dump({"language": "en", "segments": segs}, open(sys.argv[1], "w"))
PY
    python3 "$ROOT/lib/render.py" --segments "$R/loop.json" --window 1 \
        --outdir "$R/loop" --base l --formats jsonl >/dev/null 2>&1
    n="$(wc -l <"$R/loop/l.jsonl" 2>/dev/null | tr -d ' ')"
    if [ "$n" = "3" ] && grep -qF 'Real speech.' "$R/loop/l.jsonl"; then
        ok "repeated-phrase loops are capped at 2, real speech kept"
    else
        no "loop filter wrong: expected 3 rows incl. real speech, got ${n:-0}"
    fi

    # Chunk merging: offsets are applied and every mlx-whisper format is written.
    python3 - "$R/c1.json" "$R/c2.json" <<'PY'
import json, sys
json.dump({"language": "en", "segments": [{"id": 0, "start": 0.0, "end": 2.5, "text": " Hello."}]}, open(sys.argv[1], "w"))
json.dump({"language": "en", "segments": [{"id": 0, "start": 1.0, "end": 3.0, "text": " World."}]}, open(sys.argv[2], "w"))
PY
    if python3 "$ROOT/lib/merge_chunks.py" --chunk-seconds 600 --out-base "$R/merged" \
        --formats json,txt,srt,vtt,tsv "$R/c1.json" "$R/c2.json" &&
        grep -qF '00:10:01,000 --> 00:10:03,000' "$R/merged.srt" &&
        grep -qF '10:01.000 --> 10:03.000' "$R/merged.vtt" &&
        grep -qF "$(printf '601000\t603000\tWorld.')" "$R/merged.tsv" &&
        [ "$(wc -l <"$R/merged.txt" | tr -d ' ')" = "2" ]; then
        ok "chunk merge shifts timestamps and writes txt/srt/vtt/tsv/json"
    else
        no "chunk merge output is wrong"
    fi

    # Silent / non-speech audio produces no segments: that must not fail the run.
    printf '{"language": "en", "segments": []}' >"$R/empty.json"
    if python3 "$ROOT/lib/render.py" --segments "$R/empty.json" \
        --info "$FIX/info-youtube.json" --window 45 --outdir "$R/empty" --base e \
        --formats md,jsonl >/dev/null 2>&1; then
        ok "empty transcript (silence) is not an error"
    else
        no "empty transcript should render empty outputs, not fail"
    fi
    if [ -f "$R/empty/e.md" ] && [ ! -s "$R/empty/e.jsonl" ]; then
        ok "empty transcript still writes frontmatter with no windows"
    else
        no "empty transcript should produce md with zero windows"
    fi

    # Malformed input (missing key) is a real error.
    printf '{"language": "en"}' >"$R/bad.json"
    if python3 "$ROOT/lib/render.py" --segments "$R/bad.json" --window 45 \
        --outdir "$R/bad" --base b --formats md >/dev/null 2>&1; then
        no "transcript without a segments key should fail"
    else
        ok "transcript without a segments key is rejected"
    fi
fi

# --- offline: python unit tests -----------------------------------------------
printf '\nPython unit tests\n'
if command -v python3 >/dev/null 2>&1; then
    if python3 -m unittest discover -s "$ROOT/test" -p 'test_*.py' >"$TMP/out" 2>&1; then
        ok "lib/*.py unit tests pass"
    else
        no "lib/*.py unit tests failed"
    fi
else
    printf '  skip  python unit tests (python3 not on PATH)\n'
fi

# --- optional: real pipeline ------------------------------------------------
if [ "${SMOKE_NETWORK:-0}" = "1" ]; then
    printf '\nEnd-to-end (network, whisper-tiny)\n'
    if ! command -v ffmpeg >/dev/null 2>&1; then
        no "end-to-end tests need ffmpeg on PATH"
    else
        mkdir -p "$TMP/e2e"
        ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=3" \
            -ar 16000 -ac 1 "$TMP/e2e/fixture.wav" -y || no "fixture generation"

        case_ 0 "" "transcribes a local audio file" \
            "$SCRIPT" -m mlx-community/whisper-tiny -f txt,srt \
            -o "$TMP/e2e/out" "$TMP/e2e/fixture.wav"

        # Default layout: one folder per source, named local-<base> for local files.
        if [ -f "$TMP/e2e/out/local-fixture/fixture.txt" ] \
            && [ -f "$TMP/e2e/out/local-fixture/fixture.srt" ]; then
            ok "outputs land in a per-source folder (local-fixture/)"
        else
            no "expected per-source folder out/local-fixture/"
        fi

        case_ 0 "" "--flat writes straight into the output dir" \
            "$SCRIPT" --flat -m mlx-community/whisper-tiny -f txt \
            -o "$TMP/e2e/flat" "$TMP/e2e/fixture.wav"
        if [ -f "$TMP/e2e/flat/fixture.txt" ] && [ ! -d "$TMP/e2e/flat/local-fixture" ]; then
            ok "--flat keeps the old flat layout"
        else
            no "--flat did not write directly into the output dir"
        fi

        case_ 0 "" "--no-condition is accepted" \
            "$SCRIPT" --no-condition -m mlx-community/whisper-tiny -f txt \
            -o "$TMP/e2e/out2" "$TMP/e2e/fixture.wav"

        case_ 0 "" "md + jsonl emitted alongside txt" \
            "$SCRIPT" -m mlx-community/whisper-tiny --emit md,jsonl --window 15 \
            -f txt -o "$TMP/e2e/out4" "$TMP/e2e/fixture.wav"
        if [ -f "$TMP/e2e/out4/local-fixture/fixture.md" ] \
            && [ -f "$TMP/e2e/out4/local-fixture/fixture.jsonl" ] \
            && [ -f "$TMP/e2e/out4/local-fixture/fixture.txt" ]; then
            ok "md, jsonl and txt written in one pass"
        else
            no "expected md, jsonl and txt outputs"
        fi
        if grep -q '^source_url: ' "$TMP/e2e/out4/local-fixture/fixture.md" 2>/dev/null; then
            ok "md frontmatter has source_url"
        else
            no "md frontmatter missing source_url"
        fi

        # Skip-if-done: a second run must not transcribe again; --force must.
        case_ 0 "outputs already exist" "second run skips finished work" \
            "$SCRIPT" -m mlx-community/whisper-tiny -f txt,srt \
            -o "$TMP/e2e/out" "$TMP/e2e/fixture.wav"
        case_ 0 "transcribing" "--force re-transcribes" \
            "$SCRIPT" --force -m mlx-community/whisper-tiny -f txt,srt \
            -o "$TMP/e2e/out" "$TMP/e2e/fixture.wav"

        # Chunked path: 3 s fixture, 1-minute chunk threshold is not exceeded, so
        # build a 130 s file and force 1-minute chunks (3 chunks).
        ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=130" \
            -ar 16000 -ac 1 "$TMP/e2e/long.wav" -y || no "long fixture generation"
        case_ 0 "chunk 3/3" "--chunk splits and transcribes every chunk" \
            "$SCRIPT" --chunk 1 -m mlx-community/whisper-tiny -f txt,srt,json \
            --emit md -o "$TMP/e2e/chunked" "$TMP/e2e/long.wav"
        if [ -f "$TMP/e2e/chunked/local-long/long.srt" ] \
            && [ -f "$TMP/e2e/chunked/local-long/long.json" ] \
            && [ -f "$TMP/e2e/chunked/local-long/long.md" ]; then
            ok "chunked run writes srt, json and md"
        else
            no "chunked run missing outputs"
        fi
        case_ 0 "" "-f md alone (no mlx formats) works" \
            "$SCRIPT" -m mlx-community/whisper-tiny -f md \
            -o "$TMP/e2e/mdonly" "$TMP/e2e/fixture.wav"

        # --index writes the browsable page; --reveal calls `open` (stubbed here so
        # CI does not try to launch Finder).
        mkdir -p "$TMP/e2e/bin"
        cat >"$TMP/e2e/bin/open" <<EOF
#!/bin/sh
echo "\$@" >> "$TMP/e2e/open.log"
EOF
        chmod +x "$TMP/e2e/bin/open"
        case_ 0 "" "--index and --reveal work together" \
            env PATH="$TMP/e2e/bin:$PATH" "$SCRIPT" -m mlx-community/whisper-tiny \
            -f txt --emit md --index --reveal -o "$TMP/e2e/idx" "$TMP/e2e/fixture.wav"
        if [ -f "$TMP/e2e/idx/index.html" ] && grep -qF 'fixture' "$TMP/e2e/idx/index.html"; then
            ok "--index wrote index.html for the run"
        else
            no "index.html missing after --index"
        fi
        # OUTDIR is resolved physically (macOS: /var -> /private/var), so compare
        # on the tail of the path rather than the $TMP prefix.
        if [ -s "$TMP/e2e/open.log" ] && grep -qF 'e2e/idx' "$TMP/e2e/open.log"; then
            ok "--reveal opened the output folder"
        else
            no "--reveal did not call open with the output dir"
        fi

        # --json-events: a real run must produce a parseable, ordered event stream.
        if "$SCRIPT" --json-events -m mlx-community/whisper-tiny -f txt --emit md --index \
            -o "$TMP/e2e/ev" "$TMP/e2e/fixture.wav" >"$TMP/e2e/ev.json" 2>"$TMP/e2e/ev.err" \
            && python3 - "$TMP/e2e/ev.json" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
names = [row["event"] for row in rows]
for required in ("start", "source", "item", "wrote", "index", "done"):
    assert required in names, (required, names)
assert names[0] == "start", names
assert names[-1] == "done", names
assert rows[-1]["status"] == "ok", rows[-1]
assert rows[-1]["processed"] == 1, rows[-1]
paths = [row["path"] for row in rows if row["event"] == "wrote"]
assert any(path.endswith(".md") for path in paths), paths
assert any(path.endswith(".txt") for path in paths), paths
PY
        then
            ok "--json-events yields an ordered, parseable event stream"
        else
            no "--json-events stream is wrong"
        fi

        case_ 1 "" "nonexistent model id fails with exit 1" \
            "$SCRIPT" -m mlx-community/whisper-small-does-not-exist -f txt \
            -o "$TMP/e2e/out3" "$TMP/e2e/fixture.wav"
        if [ -z "$(find "$TMP/e2e/out3" -type f 2>/dev/null | head -1)" ]; then
            ok "no files written for an invalid model"
        else
            no "files written despite an invalid model id"
        fi
    fi
else
    printf '\nSkipping end-to-end tests (set SMOKE_NETWORK=1 to enable)\n'
fi

# --- summary ----------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$pass" "$fail"
if [ "$fail" -ne 0 ]; then
    printf '\nfailures:\n%s' "$FAILED"
    exit 1
fi
exit 0
