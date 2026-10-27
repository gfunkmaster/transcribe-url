#!/usr/bin/env bash
#
# install.sh - install transcribe-url on Apple Silicon macOS.
#
# Installs the missing dependencies (yt-dlp, ffmpeg, mlx-whisper), then links
# `transcribe-url` into ~/.local/bin. Re-running is safe: existing pieces are
# left alone and only what is missing gets installed.
#
# Usage: ./install.sh [--check] [--prefix DIR]
#   --check        Only report what is missing, change nothing (exit 1 if missing)
#   --prefix DIR   Where to link the command (default: ~/.local/bin)
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$REPO_DIR/transcribe-url.sh"
PREFIX="$HOME/.local/bin"
CHECK_ONLY=0

info() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<EOF
Usage: ./install.sh [--check] [--prefix DIR]

  --check        Report missing dependencies and exit (no changes, exit 1 if missing)
  --prefix DIR   Directory to link the command into (default: \$HOME/.local/bin)
  -h, --help     Show this help
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --check) CHECK_ONLY=1; shift ;;
        --prefix) PREFIX="${2:?missing value for --prefix}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "unknown option: $1" ;;
    esac
done

[ -f "$SCRIPT" ] || die "transcribe-url.sh not found next to install.sh ($SCRIPT)"

# --- platform ---------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "macOS only (mlx-whisper requires Apple Silicon)"
[ "$(uname -m)" = "arm64" ] || die "Apple Silicon required (this Mac reports $(uname -m))"

MISSING=0

need_brew_formula() {
    # $1 = formula name, $2 = binary name on PATH
    if command -v "$2" >/dev/null 2>&1; then
        info "$2 found: $(command -v "$2")"
        return 0
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
        printf 'missing: %s (brew install %s)\n' "$2" "$1" >&2
        MISSING=1
        return 0
    fi
    command -v brew >/dev/null 2>&1 || die "Homebrew is required to install $1 - https://brew.sh"
    info "installing $1"
    brew install "$1"
}

need_brew_formula yt-dlp yt-dlp
need_brew_formula ffmpeg ffmpeg

if command -v mlx_whisper >/dev/null 2>&1; then
    info "mlx_whisper found: $(command -v mlx_whisper)"
elif [ "$CHECK_ONLY" -eq 1 ]; then
    printf 'missing: mlx_whisper (uv tool install --python 3.13 mlx-whisper)\n' >&2
    MISSING=1
else
    if ! command -v uv >/dev/null 2>&1; then
        command -v brew >/dev/null 2>&1 || die "Homebrew or uv is required - https://brew.sh"
        info "installing uv"
        brew install uv
    fi
    info "installing mlx-whisper with uv (isolated tool environment)"
    uv tool install --python 3.13 mlx-whisper
    # uv installs into ~/.local/bin; make it visible for the rest of this run.
    PATH="$HOME/.local/bin:$PATH"
    export PATH
    command -v mlx_whisper >/dev/null 2>&1 \
        || die "mlx_whisper still not on PATH - add \$HOME/.local/bin to your PATH"
fi

# --- link the command -------------------------------------------------------
if [ "$CHECK_ONLY" -eq 1 ]; then
    if [ "$MISSING" -ne 0 ]; then
        die "dependencies missing (see above)"
    fi
    info "all dependencies present"
    exit 0
fi

mkdir -p "$PREFIX"
chmod +x "$SCRIPT"
ln -sf "$SCRIPT" "$PREFIX/transcribe-url"
info "linked $PREFIX/transcribe-url -> $SCRIPT"

case ":$PATH:" in
    *":$PREFIX:"*) ;;
    *) warn "$PREFIX is not on your PATH. Add this to ~/.zshrc:
    export PATH=\"$PREFIX:\$PATH\"" ;;
esac

# --- verify -----------------------------------------------------------------
"$SCRIPT" --help >/dev/null || die "installed, but --help failed - run $SCRIPT --help to see why"

info "done. Try: transcribe-url --help"
info "first run downloads the default model (~1.6 GB) into ~/.cache/huggingface"
