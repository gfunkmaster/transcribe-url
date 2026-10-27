# transcribe-url

[![test](https://github.com/gfunkmaster/transcribe-url/actions/workflows/test.yml/badge.svg)](https://github.com/gfunkmaster/transcribe-url/actions/workflows/test.yml)

Download the audio of a video/audio URL and transcribe it locally with Whisper on
Apple Silicon. One command, no cloud, no API keys.

```bash
transcribe-url https://x.com/user/status/1234567890
```

Works for anything [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports — **X/Twitter
posts, X/Twitter Spaces**, YouTube, TikTok, Instagram, podcast pages, or a local file.

## Why this exists

YouTube videos have caption tracks, so a transcript can just be *fetched*. X/Twitter
posts have **no caption tracks at all** — `yt-dlp --list-subs` reports
`has no subtitles` for every tweet video. There is nothing to download, so the audio
must be run through speech recognition. This tool does that, locally:

```
yt-dlp (audio only) → ffmpeg (16 kHz mono WAV) → mlx-whisper (Apple GPU) → .txt / .srt
```

## Platform support

| Platform | Status |
|---|---|
| macOS 13+ on **Apple Silicon** (M1/M2/M3/M4) | ✅ tested — the supported target |
| macOS on Intel | ❌ no MLX wheels for x86 macOS |
| Linux x86_64 / arm64 | ⚠️ untested. MLX publishes CPU wheels for Linux and may work, but it is not verified here |
| Windows | ❌ bash script; needs WSL, and MLX has no Windows wheels |

## Requirements

- macOS on Apple Silicon
- [Homebrew](https://brew.sh)
- `yt-dlp`, `ffmpeg` — `brew install yt-dlp ffmpeg`
- [`mlx-whisper`](https://pypi.org/project/mlx-whisper/) — `uv tool install --python 3.13 mlx-whisper`
  (or `pipx install mlx-whisper`)
- `python3` — only needed for the `md` / `jsonl` outputs
- ~1.6 GB free disk for the default model (downloaded once, cached in `~/.cache/huggingface`)

## Install

```bash
git clone https://github.com/gfunkmaster/transcribe-url.git
cd transcribe-url
./install.sh
```

`install.sh` checks your platform, installs the missing dependencies with Homebrew,
installs `mlx-whisper` with `uv`, and links `transcribe-url` into `~/.local/bin`.

Then, from anywhere:

```bash
transcribe-url <URL>
```

Prefer no installer? The script is self-contained — run `./transcribe-url.sh <URL>`
directly; it only needs the three dependencies on your `PATH`.

## Usage

```bash
transcribe-url <URL>                                # .txt + .srt in the current dir
transcribe-url -o ~/transcripts <URL>                # choose the output directory
transcribe-url -l en <URL>                           # fix the spoken language
transcribe-url -f txt,srt,json <URL>                 # pick output formats
transcribe-url --first-only <URL>                    # tweet with several videos: take the first
transcribe-url --cookies-from-browser safari <URL>   # login-gated / rate-limited post
transcribe-url -k <URL>                              # keep the extracted audio
transcribe-url ./interview.mp4                       # local file, no download
```

```
  -o, --output-dir DIR       Where to write transcripts (default: .)
  -m, --model MODEL          Whisper model/repo (default: mlx-community/whisper-large-v3-turbo)
  -f, --formats LIST         Comma-separated: txt,vtt,srt,tsv,json,md,jsonl (default: txt,srt)
      --emit LIST            Shorthand to add agent-friendly outputs: md,jsonl
      --window SECONDS       Window width for md/jsonl merging (default: 45)
  -l, --language LANG        Spoken language, e.g. en, sv (default: auto-detect)
      --first-only           Only the first media item of a multi-video post
      --no-condition         Disable condition_on_previous_text (auto for audio ≥ 30 min)
      --cookies-from-browser B   Read cookies from browser B (safari|chrome|firefox|...)
  -k, --keep-audio           Keep extracted audio (prints the path)
  -h, --help                 Show help
```

Environment:

| Variable | Purpose |
|---|---|
| `TRANSCRIBE_MODEL` | Default model when `-m` is not given |
| `HF_HUB_DISABLE_XET` | Set to `0` to re-enable Hugging Face's Xet transfer backend |

### Transcribe from X/Twitter at all?

Yes. Public video posts work **without logging in** (yt-dlp uses the guest-token API).
If a post is protected, age-restricted, or you hit a rate limit, pass
`--cookies-from-browser safari` (or `chrome`, `firefox`, …).

## Agent-friendly outputs: `md` and `jsonl`

`txt`/`srt` are for humans. For pipelines there are two more formats, rendered by
`lib/render.py` from the transcript **plus yt-dlp's own info JSON** (nothing is
guessed):

```bash
transcribe-url --emit md,jsonl --window 45 <URL>
transcribe-url -f txt,srt,md,jsonl <URL>        # same thing, explicit
```

**Why windows.** mlx-whisper segments are ~3 s / ~10 words — too short to embed
well. Consecutive segments are merged into ~30–60 s windows (default 45 s via
`--window`, cutting only on segment boundaries, keeping the first `start` and the
last `end` of each window).

**`<name>.md`** — YAML frontmatter + anchored transcript:

```markdown
---
source_url: "https://x.com/CTVJLaidlaw/status/1600649710662213632/video/2"
extractor: "Twitter"
id: "1600649511827013632"
title: "Jocelyn Laidlaw - How Kirstie Alley's tragic death inspired me to share…"
uploader: "Jocelyn Laidlaw"
upload_date: "2022-12-08"
duration: "01:42"
duration_seconds: 102
language: "en"
model: "mlx-community/whisper-large-v3-turbo"
audio_sha256: "17fc41bf21a0ece92593795b68585a96dff55bd921d09e253e4259c52afadf5c"
transcribed_at: "2026-10-27T20:14:36Z"
---

- **00:00** And even though multiple tests showed there was nothing wrong…
- **00:46** and unfortunately could not survive it and I realized…
- **01:37** and I hope that somebody out there will act on it.
```

**`<name>.jsonl`** — one merged window per line, ready for embedding:

```json
{"start": 0.0, "end": 46.08, "text": "And even though multiple tests showed…", "source_url": "https://x.com/…/status/…", "id": "1600649511827013632"}
```

**Deep links are conditional.** Only extractors with a timestamped URL scheme get
one — currently YouTube (`…&t=46s`). X/Twitter has no such scheme, so its markdown
keeps the plain `[mm:ss]` anchor plus `source_url`.

### Using it inside an agent pipeline

- **Chunk on these windows, not on raw Whisper segments** (3 s is too short) and
  not on character counts (that loses timestamps).
- **Whole-video summaries fit in context.** ~20k tokens for a 68-minute lecture is
  fine and beats chunk-and-summarise; a 3-hour podcast lands around 35–47k tokens.
  Use retrieval for querying *across* many transcripts, not for reading one.
- **Cache on identity, not bytes**: `extractor + id + model + language`. Re-downloads
  are not byte-stable. `audio_sha256` is an integrity field only.
- **Live with ASR error**: names, numbers and acronyms are the failure modes
  (`Kirstie → Kersi` at tiny quality). Attribute claims to the speaker and check
  anything you intend to publish.
- **No diarization.** This tool does not identify speakers; that is a separate ML
  step, deliberately out of scope.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `No video could be found in this tweet` | The post is text/image-only, or your URL points at a photo (`/photo/1`) |
| `HTTP Error 403`, `login required`, `Sign in` | Protected/age-restricted/rate-limited post → `--cookies-from-browser safari` (macOS: the terminal needs *Full Disk Access* in System Settings → Privacy & Security) |
| Garbled text on a very short clip (< ~30 s) | Auto language detection misfires → pass `-l en` (or `-l sv`, …) |
| Wrong language detected repeatedly | Fix it with `-l`, or switch to a larger model |
| Transcript degrades into one word per line | Fixed for audio ≥ 30 min (conditioning is disabled automatically). For shorter degenerate files pass `--no-condition` |
| Model download hangs at 0 B/s | Hugging Face's Xet backend stalling → `HF_HUB_DISABLE_XET=1` (this is also the project default) |
| `Invalid username or password` / 401 from Hugging Face | The model id does not exist. `mlx-community` ids use `-mlx`/`-fp16` suffixes: `whisper-small-mlx`, not `whisper-small` |
| `mlx_whisper not found` | `uv tool install --python 3.13 mlx-whisper`, then ensure `~/.local/bin` is on your `PATH` |
| Output looks frozen | Downloads print a live progress bar; check that your terminal is not buffering. Ctrl-C is always safe — temp files are cleaned up |

## Privacy and safety

- Everything runs locally: audio never leaves your machine, no API keys, no telemetry.
- `--cookies-from-browser` reads your browser's cookie jar so yt-dlp can act as your
  logged-in session. It does **not** print or upload them, but treat any command that
  touches cookies with care: never paste cookie values into an issue or a chat.
- Only transcribe content you have the right to use. yt-dlp and this tool do not grant
  you any rights to third-party media; X's terms of service and copyright still apply.

## Roadmap

- [x] Agent-friendly `md` / `jsonl` outputs with provenance and window merging
- [x] GitHub Actions: shellcheck, offline suite, end-to-end on a macOS arm64 runner
- [ ] `--version`, `--dry-run`, `--quiet`, `--force`, `-a urls.txt` (batch file input)
- [ ] Optional `faster-whisper` / `whisper.cpp` backend for Linux and Intel Macs
- [ ] Chunked processing for very long audio
- [ ] Homebrew tap: `brew install gfunkmaster/tap/transcribe-url`

## Development

```bash
./test/smoke.sh                 # offline: CLI contract, dependency detection, cleanup,
                                # renderer merging/metadata/deep links (28 checks)
SMOKE_NETWORK=1 ./test/smoke.sh # + real pipeline with whisper-tiny (36 checks)
shellcheck -x transcribe-url.sh install.sh test/smoke.sh
./install.sh --check            # report missing dependencies, change nothing
```

The suite runs on bash 3.2 (macOS default) and sets its exit code from the results;
CI runs it on ubuntu (lint) and macos-14 arm64 (tests).

## Performance

Measured on an M-series MacBook Pro with the default `large-v3-turbo` model:

| Input | Result |
|---|---|
| 1:42 + 1:53 tweet videos | 27 s wall clock incl. download |
| 68:30 lecture | ~1.5 min download + ~7 min transcription (≈ 12× realtime) |
| Output size | 68 min lecture → 75 KB `.txt`, 122 KB `.srt` (13,963 words, 1,350 cues) |

Smaller models trade accuracy for speed: `mlx-community/whisper-small-mlx`,
`mlx-community/whisper-base-mlx`, `mlx-community/whisper-tiny`.

## License

[MIT](LICENSE).

## Acknowledgments

Standing on three excellent projects: [yt-dlp](https://github.com/yt-dlp/yt-dlp)
(Unlicense), [FFmpeg](https://ffmpeg.org) (GPL-3.0-or-later as built by Homebrew),
[mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) (MIT),
with Whisper model weights from OpenAI (MIT).
