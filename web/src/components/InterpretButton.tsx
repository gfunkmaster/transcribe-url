"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProviderStatus } from "@/lib/llm/registry";

export default function InterpretButton({
  slug,
  hasBrief,
  provider,
}: {
  slug: string;
  hasBrief: boolean;
  provider: ProviderStatus;
}) {
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
