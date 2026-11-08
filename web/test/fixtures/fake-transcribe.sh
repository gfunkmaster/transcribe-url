#!/usr/bin/env bash
# Stand-in for transcribe-url.sh in tests: emits the same NDJSON contract, no network.
# Records its argv (one per line) to $FAKE_ARGS_FILE when set.
[ -n "${FAKE_ARGS_FILE:-}" ] && printf '%s\n' "$@" > "$FAKE_ARGS_FILE"
url="${*: -1}"
echo '{"event":"start","tool":"transcribe-url","version":"0.6.1","model":"fake","outdir":"/x","formats":"txt,srt,md"}'
# Split a line across two writes to exercise the chunk-reassembly path.
printf '{"event":"stage","name":'
sleep 0.05
echo '"download","input":"'"$url"'"}'
case "$url" in
  *fail*)
    echo '{"event":"error","stage":"download","item":"x","message":"boom"}'
    echo '{"event":"done","processed":0,"skipped":0,"outdir":"/x","status":"partial"}'
    exit 1 ;;
  *silent-crash*)
    echo "fatal: something broke" >&2
    exit 3 ;;
esac
echo '{"event":"item","title":"Some title","dest":"/x/twitter-1","model":"fake"}'
echo '{"event":"done","processed":1,"skipped":0,"outdir":"/x","status":"ok"}'
