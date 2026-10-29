# Changelog

All notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.6.1] - 2026-10-29

### Fixed

- **`error` events are actually emitted.** `--json-events` documented an `error`
  event but no failure path produced one, so a consumer only saw `done(partial)`.
  Download, no-audio, transcribe, chunk-split, chunk-transcribe and render failures
  now emit `{"event":"error","stage":…,"item":…,"message":…}`.
  Found by field-testing the `youtube-ingest` adapter against the real binary: its
  error message fell back to the CLI's generic summary line.
- Offline test asserts a failed run emits `error` before `done(partial)`.

## [0.6.0] - 2026-10-29

A machine-readable progress stream, so a GUI or agent never has to scrape text.

### Added

- `--json-events` — emits NDJSON events on **stdout**, one object per line, and moves
  all human-readable output to stderr (where mlx-whisper's progress bars already go).
  In this mode stdout is pure JSON: `json.loads()` line by line, nothing to filter.
  Events: `start`, `source`, `stage`, `audio`, `item`, `wrote`, `skip`, `index`,
  `dry_run`, `done` (with `processed`/`skipped`/`status`), plus `error` on failures.
  Numbers are unquoted (`{"seconds":102}`), everything else is spelled out.
- Offline test for the dry-run stream (parseable, ordered, human text on stderr) and
  an end-to-end test asserting `start → … → wrote(.md/.txt) → index → done(ok)`.

### Changed

- Anything a UI needs is now expressible without parsing prose: this was the missing
  half of the contract behind `--index` and the md/jsonl outputs.


A browsable UI for the output folder, without building an app.

### Added

- `--index` — writes `index.html` into the output directory: one self-contained page
  listing every source with title, extractor/uploader/date, duration, language,
  model and per-format links. Search box in plain JS, no server, no external assets,
  so it opens from Finder or can be dropped on a static host.
  With **no URL** (`transcribe-url --index -o DIR`) it only rebuilds the page, which
  is useful after moving or deleting transcripts.
  Metadata comes from the `md` frontmatter of each folder; sources without it are
  listed from the folder name and marked with `*`.
- `--reveal` — opens the output directory in Finder when the run finishes (macOS,
  best effort; a failure to open never fails the run).
- `lib/index.py` with unit tests (`test/test_index.py`): frontmatter parsing,
  folder/metadata fallback, newest-first ordering, HTML escaping of untrusted
  titles, empty-folder message.

### Changed

- Smoke suite: 51 offline checks (was 46) and 69 with `SMOKE_NETWORK=1` (was 61);
  the version test now cross-checks `--version` against the newest CHANGELOG entry,
  so the two cannot drift.


### Changed

- **Default output layout.** Transcripts no longer land in the current directory.
  The new default is `./transcripts/<extractor>-<id>/`, i.e. one folder per source,
  so batches, multi-video posts and chunked runs stay separable. Folder names come
  from yt-dlp's `extractor_key` + media `id` (`youtube-…`, `twitter-…`,
  `twitter:spaces-…`), or `local-<filename>` for files passed in directly.
  This is a breaking change for scripts that read files from the old location.
- `-o DIR` now means `DIR/<extractor>-<id>/`; the per-source folder is created only
  when there is something to write, so a failed run leaves no empty directory.
- `--dry-run` prints the resolved layout (`outdir:  …/<extractor>-<id>/`).

### Added

- `--flat` — keep the pre-0.4 behaviour and write directly into the output dir.
- `TRANSCRIBE_OUTDIR` — override the default output directory per environment.
- Offline tests for the layout: dry-run paths, `--flat`, `TRANSCRIBE_OUTDIR`,
  `-o` precedence, and `--version`; end-to-end assertions for the per-source folder.
- Smoke-test robustness: the temp-dir leak check tolerates a concurrent run cleaning
  up its own directory (it now fails only when the count grows).

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
