"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProviderStatus } from "@/lib/llm/registry";

export default function InterpretButton({
  slug,
  hasBrief,
  provider,
  imageCount = 0,
}: {
  slug: string;
  hasBrief: boolean;
  provider: ProviderStatus;
  /** Number of saved images (posts only); 0 hides the checkbox. */
  imageCount?: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [includeImages, setIncludeImages] = useState(false);

  async function run() {
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(slug)}/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeImages }),
      });
      const body = (await response.json()) as {
        error?: string;
        provider?: string;
        model?: string;
        inputTokens?: number | null;
        outputTokens?: number | null;
      };
      if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
      const usage =
        body.inputTokens == null || body.outputTokens == null
          ? ""
          : ` · ${body.inputTokens} in / ${body.outputTokens} out tokens`;
      setMessage(`Saved. ${body.provider ?? ""} ${body.model ?? ""}${usage}`);
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
      <button type="button" onClick={run} disabled={busy || !provider.ok}>
        {busy ? "Interpreting… (can take a minute)" : hasBrief ? "Re-interpret" : "Interpret"}
      </button>
      {imageCount > 0 && (
        <label className="muted" style={{ display: "block", margin: "0.5rem 0" }}>
          <input type="checkbox" checked={includeImages} onChange={(e) => setIncludeImages(e.target.checked)} /> Include{" "}
          {imageCount} image{imageCount === 1 ? "" : "s"} (needs a model that can read images; if it fails, untick)
        </label>
      )}
      {provider.ok ? (
        <p className="muted">
          {provider.local
            ? `Runs on ${provider.label} (${provider.model}); the transcript stays on this machine.`
            : `Sends this transcript to ${provider.label} (${provider.model}). Billed to your key.`}
        </p>
      ) : (
        <p className="err">Interpret is not configured: {provider.message}</p>
      )}
      {message && <p className={failed ? "err" : "ok"}>{message}</p>}
    </div>
  );
}
