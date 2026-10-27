# Changelog

All notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-27

### Added

- `--version`.
- `tool_version` and `schema_version` in md frontmatter; `schema_version` on every
  jsonl row, so consumers can detect format changes.
- `-a/--batch-file` (one URL/path per line, `#` comments), `--dry-run`, `--force`.
- Skip-if-done: a URL/file whose requested outputs already exist is not
  transcribed again (saves the expensive step; the download still happens for URLs).
- `--chunk MINUTES`: fixed-length chunking for very long audio, merged by
  `lib/merge_chunks.py` with shifted timestamps; language is detected once.
- `--word-timestamps`; `model_revision` (cached HF commit) in the frontmatter.
- Download retries with backoff (`TRANSCRIBE_RETRIES`, default 3).
- Python unit tests (`test/test_render.py`), run by `test/smoke.sh`; nightly CI run.
- Renderer drops Whisper repetition loops (same phrase more than twice in a row)
  and says how many it dropped.

### Fixed

- `-f md` / `-f jsonl` without any mlx format crashed on bash 3.2 (`REQUESTED_MLX:
  unbound variable`).
- Ctrl-C / SIGTERM now always run the temp-dir cleanup.

## [0.2.0] - 2026-10-27

Agent-friendly outputs. `txt`/`srt` remain human-facing; the new formats are meant
for retrieval, citation and clip-finding pipelines.

### Added

- `--emit md[,jsonl]` (and `-f md` / `-f jsonl`): rendered by `lib/render.py`.
- Markdown output: YAML frontmatter followed by the transcript with a `[mm:ss]`
  anchor per window.
- JSONL output: one merged window per line as
  `{"start","end","text","source_url","id"}`.
- `--window SECONDS` (default 45): merges mlx-whisper's ~3 s segments into
  ~30-60 s windows, cutting only on segment boundaries and keeping the first
  `start` and last `end` of each window.
- Provenance in the frontmatter, read from yt-dlp's info JSON (never guessed):
  `source_url`, `extractor`, `id`, `title`, `uploader`, `upload_date`,
  `duration`/`duration_seconds`, `language`, plus `model`, `audio_sha256`
  (integrity only) and `transcribed_at`.
- Deep links are emitted only for extractors with a timestamped URL scheme
  (currently YouTube). X/Twitter output keeps the plain anchor plus `source_url`.
- 17 more offline checks: argument validation for the new flags, window merging
  boundaries, frontmatter fields, deep-link behaviour per extractor, JSONL shape,
  empty (silent) transcripts and malformed input.

### Fixed

- Silent or non-speech audio (no Whisper segments) no longer aborts the run; empty
  outputs are written with a notice instead.
- Renderer notices go to stderr, so they are no longer reported as written files.

## [0.1.1] - 2026-10-27

### Fixed

- Arguments are validated before dependency checks, so a bad `-f` value is
  reported as such instead of "yt-dlp not found".
- The `mlx_whisper` dependency test skips (rather than fails) when `yt-dlp`/`ffmpeg`
  are absent, e.g. on a bare CI runner.

## [0.1.0] - 2026-10-27

### Added

- `transcribe-url.sh`: yt-dlp (audio stream only) → ffmpeg (16 kHz mono WAV) →
  mlx-whisper, for any yt-dlp-supported source including X/Twitter posts and
  Spaces, or local files.
- Automatic `condition_on_previous_text` disabling for audio ≥ 30 minutes, which
  prevents Whisper degeneration into one-word segments on long recordings;
  `--no-condition` to force it.
- `install.sh` with platform and dependency guards plus `--check` mode.
- `test/smoke.sh`: offline CLI contract and dependency-detection checks, plus an
  opt-in end-to-end run (`SMOKE_NETWORK=1`).
- GitHub Actions: shellcheck, offline tests and an end-to-end job on macOS arm64.
