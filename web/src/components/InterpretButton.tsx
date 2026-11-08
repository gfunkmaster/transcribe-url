"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function InterpretButton({ slug, hasBrief }: { slug: string; hasBrief: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function run() {
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(slug)}/interpret`, { method: "POST" });
      const body = (await response.json()) as {
        error?: string;
        model?: string;
        inputTokens?: number;
        outputTokens?: number;
      };
      if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
      setMessage(
        `Saved. ${body.model ?? ""} · ${body.inputTokens ?? "?"} in / ${body.outputTokens ?? "?"} out tokens`,
      );
      router.refresh();
    } catch (err) {
      setFailed(true);
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={run} disabled={busy}>
        {busy ? "Interpreting… (can take a minute)" : hasBrief ? "Re-interpret" : "Interpret"}
      </button>
      <p className="muted">Sends this transcript to the Claude API. It is billed to your API key.</p>
      {message && <p className={failed ? "err" : "ok"}>{message}</p>}
    </div>
  );
}
