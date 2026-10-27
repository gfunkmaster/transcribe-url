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

# Resolve the real script directory even when invoked through the install.sh
# symlink, so lib/render.py next to the script is always found.
resolve_self_dir() {
    local target="$1" link_dir resolved
    while [ -L "$target" ]; do
        link_dir="$(cd -P "$(dirname "$target")" && pwd)"
        resolved="$(readlink "$target")"
        case "$resolved" in
            /*) target="$resolved" ;;
            *) target="$link_dir/$resolved" ;;
        esac
    done
    cd -P "$(dirname "$target")" && pwd
}

PROG="$(basename "$0")"
VERSION="0.2.0"
SELF_DIR="$(resolve_self_dir "$0")"
RENDER="$SELF_DIR/lib/render.py"
MERGE_CHUNKS="$SELF_DIR/lib/merge_chunks.py"
DEFAULT_MODEL="mlx-community/whisper-large-v3-turbo"
DEFAULT_WINDOW=45
# Written by mlx-whisper itself.
MLX_FORMATS="txt vtt srt tsv json"
# Written by lib/render.py from the transcript plus yt-dlp metadata.
EXTRA_FORMATS="md jsonl"
VALID_FORMATS="$MLX_FORMATS $EXTRA_FORMATS"

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
                             txt,vtt,srt,tsv,json,md,jsonl (default: txt,srt)
      --emit LIST            Shorthand to add agent-friendly outputs (md,jsonl)
      --window SECONDS       Window width for md/jsonl merging (default: 45)
  -l, --language LANG        Spoken language, e.g. en, sv (default: auto-detect)
      --no-condition         Disable condition_on_previous_text (prevents Whisper
                             degeneration into one-word segments; automatic for
                             audio >= 30 minutes)
      --first-only           Only transcribe the first media item (a tweet can
                             contain several videos)
      --cookies-from-browser B
                             Read cookies from browser B (safari|chrome|firefox|...)
                             for login-gated or rate-limited posts
      --word-timestamps      Ask Whisper for word-level timestamps (in the json output)
      --chunk MINUTES        Transcribe audio longer than MINUTES in fixed-length
                             chunks and merge them (bounds memory on multi-hour files).
                             Cuts are not silence-aware: a word on a boundary may be lost.
  -a, --batch-file FILE      Read URLs/paths from FILE, one per line ('-' = stdin);
                             blank lines and lines starting with # are ignored
      --force                Re-transcribe even if all requested outputs already exist
      --dry-run              Print what would be done, then exit without downloading
  -k, --keep-audio           Keep the extracted audio files (prints their path)
  -h, --help                 Show this help
      --version              Print the version and exit

Environment:
  TRANSCRIBE_MODEL           Default model when -m is not given
  TRANSCRIBE_RETRIES         Download attempts per URL (default: 3)
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
  * md/jsonl merge Whisper's very short segments into ~--window second windows
    (cutting only on segment boundaries). They need python3 and read metadata
    from the yt-dlp info JSON, never guessing values.
  * Timestamped deep links are emitted only for extractors that support them
    (currently YouTube). X/Twitter has no timestamped URL scheme, so md output
    keeps the plain [mm:ss] anchor plus the source URL.
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

# sha256_of <file> - integrity checksum, never used as a cache key
sha256_of() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        printf 'unavailable'
    fi
}

# model_revision <repo-id> - commit hash of the locally cached snapshot, or empty.
# Recorded in md frontmatter so an upstream weight update is detectable.
model_revision() {
    local hub ref
    hub="${HF_HUB_CACHE:-${HF_HOME:-$HOME/.cache/huggingface}/hub}"
    ref="$hub/models--$(printf '%s' "$1" | sed 's#/#--#g')/refs/main"
    [ -f "$ref" ] && tr -d '[:space:]' <"$ref" || true
}

MODEL="${TRANSCRIBE_MODEL:-$DEFAULT_MODEL}"
OUTDIR="."
FORMATS="txt,srt"
EMIT=""
WINDOW="$DEFAULT_WINDOW"
LANGUAGE=""
COOKIES_BROWSER=""
FIRST_ONLY=0
KEEP_AUDIO=0
NO_CONDITION=0
WORD_TIMESTAMPS=0
CHUNK_MIN=0
BATCH_FILE=""
FORCE=0
DRY_RUN=0
RETRIES="${TRANSCRIBE_RETRIES:-3}"

while [ $# -gt 0 ]; do
    case "$1" in
        -o|--output-dir)        need_value "$@"; OUTDIR="$2"; shift 2 ;;
        -m|--model)             need_value "$@"; MODEL="$2"; shift 2 ;;
        -f|--formats)           need_value "$@"; FORMATS="$2"; shift 2 ;;
        --emit)                 need_value "$@"; EMIT="$2"; shift 2 ;;
        --window)               need_value "$@"; WINDOW="$2"; shift 2 ;;
        -l|--language)          need_value "$@"; LANGUAGE="$2"; shift 2 ;;
        --cookies-from-browser) need_value "$@"; COOKIES_BROWSER="$2"; shift 2 ;;
        --first-only)           FIRST_ONLY=1; shift ;;
        --no-condition)         NO_CONDITION=1; shift ;;
        --word-timestamps)      WORD_TIMESTAMPS=1; shift ;;
        --chunk)                need_value "$@"; CHUNK_MIN="$2"; shift 2 ;;
        -a|--batch-file)        need_value "$@"; BATCH_FILE="$2"; shift 2 ;;
        --force)                FORCE=1; shift ;;
        --dry-run)              DRY_RUN=1; shift ;;
        -k|--keep-audio)        KEEP_AUDIO=1; shift ;;
        -h|--help)              usage; exit 0 ;;
        --version)              printf '%s %s\n' "$PROG" "$VERSION"; exit 0 ;;
        --)                     shift; break ;;
        -*)                     usage >&2
                                printf 'error: unknown option: %s\n' "$1" >&2
                                exit 2 ;;
        *)                      break ;;
    esac
done

# Batch file: append its entries after any positional URLs/paths.
if [ -n "$BATCH_FILE" ]; then
    if [ "$BATCH_FILE" != "-" ] && [ ! -f "$BATCH_FILE" ]; then
        die "batch file not found: $BATCH_FILE"
    fi
    while IFS= read -r line || [ -n "$line" ]; do
        line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        case "$line" in ''|'#'*) continue ;; esac
        set -- "$@" "$line"
    done < <(if [ "$BATCH_FILE" = "-" ]; then cat; else cat "$BATCH_FILE"; fi)
fi

[ $# -gt 0 ] || { usage >&2; exit 2; }

# Validate the arguments before touching the environment: a typo in -f should be
# reported as such, even on a machine that has no dependencies installed.
case "$WINDOW" in
    ''|*[!0-9]*) die "--window needs a whole number of seconds (got '$WINDOW')" ;;
esac
[ "$WINDOW" -gt 0 ] || die "--window must be greater than 0"
case "$CHUNK_MIN" in
    ''|*[!0-9]*) die "--chunk needs a whole number of minutes (got '$CHUNK_MIN')" ;;
esac
case "$RETRIES" in
    ''|*[!0-9]*|0) die "TRANSCRIBE_RETRIES must be a whole number >= 1 (got '$RETRIES')" ;;
esac

REQUESTED_MLX=()
REQUESTED_EXTRA=()
SEEN_FORMATS=" "
FORMATS_ALL="$FORMATS"
if [ -n "$EMIT" ]; then
    FORMATS_ALL="$FORMATS_ALL,$EMIT"
fi
IFS=',' read -r -a _formats <<< "$FORMATS_ALL"
for f in "${_formats[@]}"; do
    f="$(printf '%s' "$f" | tr -d '[:space:]')"
    [ -n "$f" ] || continue
    case " $VALID_FORMATS " in
        *" $f "*) ;;
        *) die "unsupported format '$f' (valid: $VALID_FORMATS)" ;;
    esac
    # Skip duplicates so "-f txt,srt,txt" writes each file once.
    case "$SEEN_FORMATS" in
        *" $f "*) continue ;;
    esac
    SEEN_FORMATS="$SEEN_FORMATS$f "
    case " $MLX_FORMATS " in
        *" $f "*) REQUESTED_MLX+=("$f") ;;
        *) REQUESTED_EXTRA+=("$f") ;;
    esac
done
if [ ${#REQUESTED_MLX[@]} -eq 0 ] && [ ${#REQUESTED_EXTRA[@]} -eq 0 ]; then
    die "no output formats requested"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    printf 'dry run - nothing will be downloaded or written\n'
    printf '  model:   %s\n  formats: %s\n  outdir:  %s\n' "$MODEL" \
        "$(printf '%s ' "${SEEN_FORMATS}" | sed -e 's/^ *//' -e 's/ *$//' -e 's/ /,/g')" "$OUTDIR"
    [ -z "$LANGUAGE" ] || printf '  language: %s\n' "$LANGUAGE"
    [ "$CHUNK_MIN" -eq 0 ] || printf '  chunking: %s min\n' "$CHUNK_MIN"
    for src in "$@"; do
        if [ -f "$src" ]; then
            printf '  local file (no download): %s\n' "$src"
        else
            printf '  download audio + transcribe: %s\n' "$src"
        fi
    done
    exit 0
fi

# --- preflight ------------------------------------------------------------
YTDLP="$(command -v yt-dlp || true)"
MLX="$(command -v mlx_whisper || true)"
PYTHON=""
[ -n "$YTDLP" ] || die "yt-dlp not found (brew install yt-dlp)"
[ -n "$MLX" ]   || die "mlx_whisper not found (uv tool install --python 3.13 mlx-whisper)"
command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg not found (brew install ffmpeg)"
if [ ${#REQUESTED_EXTRA[@]} -gt 0 ] || [ "$CHUNK_MIN" -gt 0 ]; then
    PYTHON="$(command -v python3 || true)"
    [ -n "$PYTHON" ] || die "python3 is required for md/jsonl output and --chunk (brew install python)"
    [ -f "$RENDER" ] || die "renderer missing: $RENDER (is the repo complete?)"
    [ -f "$MERGE_CHUNKS" ] || die "chunk merger missing: $MERGE_CHUNKS (is the repo complete?)"
fi

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
# Make Ctrl-C / kill run the EXIT trap so the temp dir never leaks.
trap 'exit 130' INT
trap 'exit 143' TERM

# 16 kHz mono WAV is exactly what Whisper expects; ffmpeg does the conversion.
# -f bestaudio/best downloads only the audio stream: for a 68-minute video that
# is ~62 MiB instead of ~290 MiB for video+audio. Progress stays visible (no
# --quiet) so long downloads do not look frozen.
dl_args=(-f bestaudio/best -x --audio-format wav
         --postprocessor-args "-ar 16000 -ac 1" --no-warnings)

# md/jsonl frontmatter comes from yt-dlp's own info JSON (same request, no extra
# network call). Only requested when those formats are actually needed.
if [ ${#REQUESTED_EXTRA[@]} -gt 0 ]; then
    dl_args+=(--write-info-json)
fi

exit_status=0
processed=0
skipped=0

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

        attempt=1
        downloaded=0
        while :; do
            if "$YTDLP" "${args[@]}" "$src"; then
                downloaded=1
                break
            fi
            [ "$attempt" -lt "$RETRIES" ] || break
            printf 'warning: download attempt %d/%d failed, retrying in %ds\n' \
                "$attempt" "$RETRIES" "$((attempt * 3))" >&2
            sleep "$((attempt * 3))"
            attempt=$((attempt + 1))
        done
        if [ "$downloaded" -eq 0 ]; then
            printf 'error: download failed for %s (after %d attempt(s))\n' "$src" "$attempt" >&2
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

        if [ "$FORCE" -eq 0 ]; then
            all_present=1
            for f in $SEEN_FORMATS; do
                [ -f "$OUTDIR/$out_base.$f" ] || { all_present=0; break; }
            done
            if [ "$all_present" -eq 1 ]; then
                printf -- '--> skipping %s: outputs already exist (use --force to redo)\n' "$out_base"
                skipped=$((skipped + 1))
                continue
            fi
        fi

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

        # Options shared by the single pass and by every chunk.
        common_args=(--model "$MODEL")
        if [ -n "$LANGUAGE" ]; then
            common_args+=(--language "$LANGUAGE")
        fi
        if [ "$WORD_TIMESTAMPS" -eq 1 ]; then
            common_args+=(--word-timestamps True)
        fi
        chunked=0
        if [ "$CHUNK_MIN" -gt 0 ] && [ "$dur" -gt "$((CHUNK_MIN * 60))" ]; then
            chunked=1
        fi
        # Long recordings: conditioning each window on the previous output makes
        # Whisper degenerate over time (segments shrink to one word with ~0.1 s
        # timestamps; measured 445 of 729 segments affected in the 60-70 min
        # range of a 68 min lecture). Turning it off keeps that from compounding.
        # Chunks restart the context anyway, so only --no-condition applies there.
        if [ "$NO_CONDITION" -eq 1 ] || { [ "$chunked" -eq 0 ] && [ "$dur" -ge 1800 ]; }; then
            common_args+=(--condition-on-previous-text False)
        fi
        if [ "$NO_CONDITION" -eq 1 ]; then
            printf -- '    condition_on_previous_text disabled (--no-condition)\n'
        elif [ "$chunked" -eq 0 ] && [ "$dur" -ge 1800 ]; then
            printf -- '    long audio: disabling condition_on_previous_text (prevents degeneration)\n'
        fi

        printf -- '--> transcribing %s (model: %s)\n' "$out_base" "$MODEL"
        item_failed=0
        if [ "$chunked" -eq 0 ]; then
            # One transcription pass, all formats written, then copy what was asked
            # for - avoids re-running the model once per format.
            if ! "$MLX" "$audio" "${common_args[@]}" --output-dir "$WORK" \
                    --output-name "$out_base" --output-format all --verbose False; then
                printf 'error: transcription failed for %s\n' "$out_base" >&2
                printf '       (unknown model id? mlx-community models use -mlx/-fp16 suffixes)\n' >&2
                exit_status=1
                continue
            fi
        else
            chunk_secs=$((CHUNK_MIN * 60))
            chunk_dir="$WORK/chunks"
            rm -rf "$chunk_dir"
            mkdir -p "$chunk_dir/in" "$chunk_dir/out"
            printf -- '    long audio: transcribing in %d-minute chunks\n' "$CHUNK_MIN"
            if ! ffmpeg -v error -i "$audio" -f segment -segment_time "$chunk_secs" \
                    -ar 16000 -ac 1 -c:a pcm_s16le "$chunk_dir/in/%05d.wav"; then
                printf 'error: could not split %s into chunks\n' "$out_base" >&2
                exit_status=1
                continue
            fi
            chunk_json=()
            chunk_failed=0
            chunk_lang="$LANGUAGE"
            n_chunks=$(find "$chunk_dir/in" -type f -name '*.wav' | wc -l | tr -d ' ')
            i=0
            for chunk in "$chunk_dir"/in/*.wav; do
                i=$((i + 1))
                cname="$(basename "$chunk" .wav)"
                printf -- '    chunk %d/%d\n' "$i" "$n_chunks"
                chunk_args=("${common_args[@]}")
                # Detect the language once, on the first chunk, and reuse it so a
                # music-heavy later chunk cannot flip the language mid-file.
                if [ -z "$chunk_lang" ]; then
                    :
                else
                    case " ${chunk_args[*]} " in
                        *" --language "*) ;;
                        *) chunk_args+=(--language "$chunk_lang") ;;
                    esac
                fi
                if ! "$MLX" "$chunk" "${chunk_args[@]}" --output-dir "$chunk_dir/out" \
                        --output-name "$cname" --output-format json --verbose False; then
                    chunk_failed=1
                    break
                fi
                chunk_json+=("$chunk_dir/out/$cname.json")
                if [ -z "$chunk_lang" ]; then
                    chunk_lang="$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("language") or "")' "$chunk_dir/out/$cname.json" 2>/dev/null || true)"
                fi
            done
            if [ "$chunk_failed" -ne 0 ]; then
                printf 'error: transcription failed for %s (chunk %d)\n' "$out_base" "$i" >&2
                printf '       (unknown model id? mlx-community models use -mlx/-fp16 suffixes)\n' >&2
                exit_status=1
                continue
            fi
            merge_formats="json"
            for f in ${REQUESTED_MLX[@]+"${REQUESTED_MLX[@]}"}; do
                [ "$f" = "json" ] || merge_formats="$merge_formats,$f"
            done
            if ! "$PYTHON" "$MERGE_CHUNKS" --chunk-seconds "$chunk_secs" \
                    --out-base "$WORK/$out_base" --formats "$merge_formats" "${chunk_json[@]}"; then
                printf 'error: could not merge chunks for %s\n' "$out_base" >&2
                exit_status=1
                continue
            fi
            rm -rf "$chunk_dir"
        fi

        for f in ${REQUESTED_MLX[@]+"${REQUESTED_MLX[@]}"}; do
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

        # md/jsonl: merged windows + provenance, rendered from the transcript and
        # the info JSON that yt-dlp wrote during the download.
        if [ ${#REQUESTED_EXTRA[@]} -gt 0 ] && [ "$item_failed" -eq 0 ]; then
            info_json="${audio%.*}.info.json"
            if [ ! -f "$info_json" ]; then
                info_json="-"
            fi
            extra_list="$(printf '%s,' "${REQUESTED_EXTRA[@]}")"
            extra_list="${extra_list%,}"
            source_for_render="$src"
            if ! "$PYTHON" "$RENDER" --segments "$WORK/$out_base.json" \
                    --info "$info_json" --window "$WINDOW" \
                    --outdir "$OUTDIR" --base "$out_base" --formats "$extra_list" \
                    --model "$MODEL" --model-revision "$(model_revision "$MODEL")" --tool-version "$VERSION" --audio-sha256 "$(sha256_of "$audio")" \
                    --transcribed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                    --source "$source_for_render" \
                    >"$WORK/render.out" 2>"$WORK/render.err"; then
                printf 'error: could not render %s for %s\n' "$extra_list" "$out_base" >&2
                sed 's/^/       /' "$WORK/render.out" "$WORK/render.err" >&2
                item_failed=1
            else
                # stdout is the list of written files; stderr carries notices.
                while IFS= read -r written; do
                    printf -- '    wrote %s\n' "$written"
                done <"$WORK/render.out"
                if [ -s "$WORK/render.err" ]; then
                    sed 's/^/    /' "$WORK/render.err"
                fi
            fi
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

printf '\ntranscribed %d item(s) into %s' "$processed" "$OUTDIR"
if [ "$skipped" -gt 0 ]; then
    printf ' (%d skipped, already done)' "$skipped"
fi
printf '\n'
if [ "$exit_status" -ne 0 ]; then
    printf 'some items failed (see errors above)\n' >&2
fi
exit "$exit_status"
