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
if [ "$after" -eq "$before" ]; then
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

# --- offline: renderer unit tests (segment merging, metadata, deep links) ----
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

        if [ -f "$TMP/e2e/out/fixture.txt" ] && [ -f "$TMP/e2e/out/fixture.srt" ]; then
            ok "txt and srt produced for the local file"
        else
            no "expected transcript files missing"
        fi

        case_ 0 "" "--no-condition is accepted" \
            "$SCRIPT" --no-condition -m mlx-community/whisper-tiny -f txt \
            -o "$TMP/e2e/out2" "$TMP/e2e/fixture.wav"

        case_ 0 "" "md + jsonl emitted alongside txt" \
            "$SCRIPT" -m mlx-community/whisper-tiny --emit md,jsonl --window 15 \
            -f txt -o "$TMP/e2e/out4" "$TMP/e2e/fixture.wav"
        if [ -f "$TMP/e2e/out4/fixture.md" ] && [ -f "$TMP/e2e/out4/fixture.jsonl" ] \
            && [ -f "$TMP/e2e/out4/fixture.txt" ]; then
            ok "md, jsonl and txt written in one pass"
        else
            no "expected md, jsonl and txt outputs"
        fi
        if grep -q '^source_url: ' "$TMP/e2e/out4/fixture.md" 2>/dev/null; then
            ok "md frontmatter has source_url"
        else
            no "md frontmatter missing source_url"
        fi

        case_ 1 "" "nonexistent model id fails with exit 1" \
            "$SCRIPT" -m mlx-community/whisper-small-does-not-exist -f txt \
            -o "$TMP/e2e/out3" "$TMP/e2e/fixture.wav"
        if [ -z "$(ls -A "$TMP/e2e/out3" 2>/dev/null)" ]; then
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
