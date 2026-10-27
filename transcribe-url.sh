#!/usr/bin/env bash
#
# transcribe-url.sh - download the audio of a video/audio URL and transcribe it
# with Whisper (MLX, Apple Silicon).
#
# Works for anything yt-dlp supports: YouTube, X/Twitter posts, X/Twitter
# Spaces, Instagram, TikTok, podcasts, ... X/Twitter videos carry no caption
# tracks, so this always runs local speech recognition instead of reading
# existing subtitles.
#
# Dependencies (already installed on this machine):
#   yt-dlp       - brew install yt-dlp
#   ffmpeg       - brew install ffmpeg
#   mlx_whisper  - uv tool install --python 3.13 mlx-whisper
#
# Usage:
#   transcribe-url.sh [-o DIR] [-m MODEL] [-f FORMATS] [-l LANG] [options] URL|FILE...
#
set -euo pipefail

PROG="$(basename "$0")"
DEFAULT_MODEL="mlx-community/whisper-large-v3-turbo"
VALID_FORMATS="txt vtt srt tsv json"

# Measured on this machine: Hugging Face's Xet backend stalls mid-download for
# multi-GB weight files (0 B/s at ~88 MB), while the plain HTTP path sustains
# several MB/s. Default to HTTP; override with HF_HUB_DISABLE_XET=0 to re-enable.
: "${HF_HUB_DISABLE_XET:=1}"
export HF_HUB_DISABLE_XET

usage() {
    cat <<EOF
Usage: $PROG [options] URL|FILE...

Download audio from URL(s) with yt-dlp and transcribe it locally with Whisper.
Existing local audio/video files are transcribed directly (no download).

Options:
  -o, --output-dir DIR       Where to write transcripts (default: .)
  -m, --model MODEL          Whisper model/repo (default: \$TRANSCRIBE_MODEL
                             or $DEFAULT_MODEL)
  -f, --formats LIST         Comma-separated output formats, any of:
                             txt,vtt,srt,tsv,json (default: txt,srt)
  -l, --language LANG        Spoken language, e.g. en, sv (default: auto-detect)
      --no-condition         Disable condition_on_previous_text (prevents Whisper
                             degeneration into one-word segments; automatic for
                             audio >= 30 minutes)
      --first-only           Only transcribe the first media item (a tweet can
                             contain several videos)
      --cookies-from-browser B
                             Read cookies from browser B (safari|chrome|firefox|...)
                             for login-gated or rate-limited posts
  -k, --keep-audio           Keep the extracted audio files (prints their path)
  -h, --help                 Show this help

Environment:
  TRANSCRIBE_MODEL           Default model when -m is not given
  HF_HUB_DISABLE_XET         Set to 0 to re-enable Hugging Face's Xet transfer
                             backend (default here: 1, because Xet stalls)

Examples:
  $PROG https://x.com/user/status/1234567890
  $PROG -o ~/transcripts -l en -f txt,srt,json https://x.com/user/status/123
  $PROG -m mlx-community/whisper-small-mlx ./interview.mp4

Notes:
  * Auto language detection can misfire on very short clips (< ~30 s). Pass
    -l en (or sv, ...) when you know the spoken language.
  * Audio longer than 30 minutes automatically disables
    condition_on_previous_text, which otherwise makes Whisper degenerate into
    one-word segments (~0.1 s each) over long files.
  * The default model (large-v3-turbo) is downloaded from Hugging Face on first
    use (~1.6 GB) and cached in ~/.cache/huggingface. Smaller/faster options:
    mlx-community/whisper-small-mlx, mlx-community/whisper-base-mlx,
    mlx-community/whisper-tiny (note the -mlx / -fp16 suffixes; plain
    "whisper-small" does not exist in the mlx-community org).
EOF
}

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

# need_value <option> [args...] - clean error instead of bash's ${2:?} message
need_value() {
    [ $# -ge 2 ] || {
        printf 'error: %s needs a value\n' "$1" >&2
        usage >&2
        exit 2
    }
}

MODEL="${TRANSCRIBE_MODEL:-$DEFAULT_MODEL}"
OUTDIR="."
FORMATS="txt,srt"
LANGUAGE=""
COOKIES_BROWSER=""
FIRST_ONLY=0
KEEP_AUDIO=0
NO_CONDITION=0

while [ $# -gt 0 ]; do
    case "$1" in
        -o|--output-dir)        need_value "$@"; OUTDIR="$2"; shift 2 ;;
        -m|--model)             need_value "$@"; MODEL="$2"; shift 2 ;;
        -f|--formats)           need_value "$@"; FORMATS="$2"; shift 2 ;;
        -l|--language)          need_value "$@"; LANGUAGE="$2"; shift 2 ;;
        --cookies-from-browser) need_value "$@"; COOKIES_BROWSER="$2"; shift 2 ;;
        --first-only)           FIRST_ONLY=1; shift ;;
        --no-condition)         NO_CONDITION=1; shift ;;
        -k|--keep-audio)        KEEP_AUDIO=1; shift ;;
        -h|--help)              usage; exit 0 ;;
        --)                     shift; break ;;
        -*)                     usage >&2
                                printf 'error: unknown option: %s\n' "$1" >&2
                                exit 2 ;;
        *)                      break ;;
    esac
done

[ $# -gt 0 ] || { usage >&2; exit 2; }

# --- preflight ------------------------------------------------------------
YTDLP="$(command -v yt-dlp || true)"
MLX="$(command -v mlx_whisper || true)"
[ -n "$YTDLP" ] || die "yt-dlp not found (brew install yt-dlp)"
[ -n "$MLX" ]   || die "mlx_whisper not found (uv tool install --python 3.13 mlx-whisper)"
command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg not found (brew install ffmpeg)"

# Validate requested formats against the formats mlx_whisper can write.
REQUESTED=()
SEEN_FORMATS=" "
IFS=',' read -r -a _formats <<< "$FORMATS"
for f in "${_formats[@]}"; do
    f="$(printf '%s' "$f" | tr -d '[:space:]')"
    [ -n "$f" ] || continue
    case " $VALID_FORMATS " in
        *" $f "*) ;;
        *) die "unsupported format '$f' (valid: $VALID_FORMATS)" ;;
    esac
    # Skip duplicates so "-f txt,srt,txt" writes each file once.
    case "$SEEN_FORMATS" in
        *" $f "*) ;;
        *) SEEN_FORMATS="$SEEN_FORMATS$f "; REQUESTED+=("$f") ;;
    esac
done
[ ${#REQUESTED[@]} -gt 0 ] || die "no output formats requested"

mkdir -p "$OUTDIR"
OUTDIR="$(cd "$OUTDIR" && pwd)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/transcribe.XXXXXX")"
# Invoked indirectly through the EXIT trap below.
# shellcheck disable=SC2329
cleanup() {
    if [ "$KEEP_AUDIO" -eq 1 ]; then
        printf '\nkept audio in: %s\n' "$WORK"
    else
        rm -rf "$WORK"
    fi
}
trap cleanup EXIT

# 16 kHz mono WAV is exactly what Whisper expects; ffmpeg does the conversion.
# -f bestaudio/best downloads only the audio stream: for a 68-minute video that
# is ~62 MiB instead of ~290 MiB for video+audio. Progress stays visible (no
# --quiet) so long downloads do not look frozen.
dl_args=(-f bestaudio/best -x --audio-format wav
         --postprocessor-args "-ar 16000 -ac 1" --no-warnings)

exit_status=0
processed=0

for src in "$@"; do
    printf '\n==> %s\n' "$src"
    audio_files=()

    if [ -f "$src" ]; then
        # Local media file: hand it straight to Whisper, no download.
        audio_files=("$src")
    else
        # Reset per-URL intermediates so find() below only sees this URL's audio.
        find "$WORK" -maxdepth 1 -type f -name '*.wav' -delete

        printf -- '--> fetching audio (audio stream only)\n'

        args=("${dl_args[@]}" -o "$WORK/%(title).60s [%(id)s].%(ext)s")
        if [ -n "$COOKIES_BROWSER" ]; then
            args+=(--cookies-from-browser "$COOKIES_BROWSER")
        fi
        if [ "$FIRST_ONLY" -eq 1 ]; then
            args+=(--playlist-items 1)
        fi

        if ! "$YTDLP" "${args[@]}" "$src"; then
            printf 'error: download failed for %s\n' "$src" >&2
            exit_status=1
            continue
        fi

        while IFS= read -r f; do
            audio_files+=("$f")
        done < <(find "$WORK" -maxdepth 1 -type f -name '*.wav' | sort)

        if [ ${#audio_files[@]} -eq 0 ]; then
            printf 'error: no audio extracted from %s\n' "$src" >&2
            exit_status=1
            continue
        fi

        printf -- '--> extracted %d audio item(s)\n' "${#audio_files[@]}"
    fi

    for audio in "${audio_files[@]}"; do
        base="$(basename "$audio")"
        base="${base%.*}"
        # yt-dlp truncation can leave runs of spaces / a trailing space; collapse
        # them so the transcript filename stays shell-friendly.
        out_base="$(printf '%s' "$base" | sed -e 's/[[:space:]][[:space:]]*/ /g' -e 's/ $//')"

        # Local ffprobe call: tells the user how long the audio is, which predicts
        # how long transcription will take (~10-20x realtime on this machine).
        dur=0
        if command -v ffprobe >/dev/null 2>&1; then
            dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$audio" 2>/dev/null | cut -d. -f1)"
            case "$dur" in ''|*[!0-9]*) dur=0 ;; esac
        fi
        if [ "$dur" -gt 0 ]; then
            printf -- '    audio length: %d:%02d\n' "$((dur / 60))" "$((dur % 60))"
        fi

        # One transcription pass, all formats written, then copy what was asked
        # for - avoids re-running the model once per format.
        wh_args=("$audio" --model "$MODEL" --output-dir "$WORK"
                 --output-name "$out_base" --output-format all --verbose False)
        if [ -n "$LANGUAGE" ]; then
            wh_args+=(--language "$LANGUAGE")
        fi
        # Long recordings: conditioning each window on the previous output makes
        # Whisper degenerate over time (segments shrink to one word with ~0.1 s
        # timestamps; measured 445 of 729 segments affected in the 60-70 min
        # range of a 68 min lecture). Turning it off keeps that from compounding.
        if [ "$NO_CONDITION" -eq 1 ] || [ "$dur" -ge 1800 ]; then
            wh_args+=(--condition-on-previous-text False)
        fi
        if [ "$NO_CONDITION" -eq 1 ]; then
            printf -- '    condition_on_previous_text disabled (--no-condition)\n'
        elif [ "$dur" -ge 1800 ]; then
            printf -- '    long audio: disabling condition_on_previous_text (prevents degeneration)\n'
        fi

        printf -- '--> transcribing %s (model: %s)\n' "$out_base" "$MODEL"
        item_failed=0
        if ! "$MLX" "${wh_args[@]}"; then
            printf 'error: transcription failed for %s\n' "$out_base" >&2
            printf '       (unknown model id? mlx-community models use -mlx/-fp16 suffixes)\n' >&2
            exit_status=1
            continue
        fi

        for f in "${REQUESTED[@]}"; do
            if [ -f "$WORK/$out_base.$f" ]; then
                cp "$WORK/$out_base.$f" "$OUTDIR/"
                printf -- '    wrote %s\n' "$OUTDIR/$out_base.$f"
            else
                printf 'error: expected %s was not produced\n' "$WORK/$out_base.$f" >&2
                item_failed=1
            fi
        done

        if [ "$item_failed" -ne 0 ]; then
            printf '       (check that the model id exists: mlx-community repos use\n' >&2
            printf '        -mlx/-fp16 suffixes, e.g. whisper-small-mlx)\n' >&2
        fi

        # Drop intermediates for this item before moving on.
        rm -f "$WORK/$out_base".txt "$WORK/$out_base".vtt "$WORK/$out_base".srt \
              "$WORK/$out_base".tsv "$WORK/$out_base".json
        if [ ! -f "$src" ]; then
            rm -f "$audio"
        fi

        if [ "$item_failed" -eq 0 ]; then
            processed=$((processed + 1))
        else
            exit_status=1
        fi
    done
done

printf '\ntranscribed %d item(s) into %s\n' "$processed" "$OUTDIR"
if [ "$exit_status" -ne 0 ]; then
    printf 'some items failed (see errors above)\n' >&2
fi
exit "$exit_status"
