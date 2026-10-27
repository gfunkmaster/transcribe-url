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

# PATH with yt-dlp and ffmpeg but deliberately without mlx_whisper
mkdir -p "$TMP/bin"
for b in yt-dlp ffmpeg; do
    p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$TMP/bin/$b"
done
case_ 1 "mlx_whisper not found" "missing mlx_whisper is reported" \
    env PATH="$TMP/bin:/usr/bin:/bin" "$SCRIPT" https://example.com

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
