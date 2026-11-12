"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { describeEvent, isFailure } from "@/lib/describe";
import { videoInPlaylist } from "@/lib/validate";
import type { ProgressEvent } from "@/lib/events";

interface Line {
  text: string;
  failed: boolean;
}

export default function NewJob() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [force, setForce] = useState(false);
  const [playlist, setPlaylist] = useState(false);
  const hasPlaylist = videoInPlaylist(url);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const source = useRef<EventSource | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLines([]);
    setBusy(true);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, force, playlist: hasPlaylist && playlist }),
      });
      const body = (await response.json()) as { job?: { id: string }; error?: string };
      if (!response.ok || !body.job) throw new Error(body.error ?? `request failed (${response.status})`);
      listen(body.job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  function listen(id: string) {
    source.current?.close();
    const stream = new EventSource(`/api/jobs/${id}/events`);
    source.current = stream;
    stream.onmessage = (message: MessageEvent<string>) => {
      const parsed = JSON.parse(message.data) as ProgressEvent;
      const text = describeEvent(parsed);
      if (text) setLines((current) => [...current, { text, failed: isFailure(parsed) }]);
      if (parsed.event === "job" && (parsed.status === "done" || parsed.status === "failed")) {
        stream.close();
        setBusy(false);
        router.refresh();
      }
    };
    stream.onerror = () => {
      // The server closes the stream after the terminal event; an early drop is a real error.
      if (stream.readyState === EventSource.CLOSED) return;
      stream.close();
      setError("lost connection to the server; check the library, the job may have finished");
      setBusy(false);
    };
  }

  return (
    <section>
      <form className="row" onSubmit={submit}>
        <input
          type="url"
          required
          placeholder="https://x.com/user/status/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Video or post URL"
        />
        <button type="submit" disabled={busy || url.trim() === ""}>
          {busy ? "Working…" : "Transcribe"}
        </button>
      </form>
      <label className="muted" style={{ display: "block", margin: "0.5rem 0" }}>
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Re-run even if already
        transcribed
      </label>
      {hasPlaylist && (
        <label className="muted" style={{ display: "block", margin: "0.5rem 0" }}>
          <input type="checkbox" checked={playlist} onChange={(e) => setPlaylist(e.target.checked)} /> Whole
          playlist (otherwise only this video)
        </label>
      )}
      {error && <p className="err">{error}</p>}
      {lines.length > 0 && (
        <ol className="timeline">
          {lines.map((line, i) => (
            <li key={i} className={line.failed ? "err" : undefined}>
              {line.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
