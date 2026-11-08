import { getConfig } from "@/lib/config";
import { checkLocalRequest } from "@/lib/guard";
import { interpretTranscript } from "@/lib/interpret";
import { readSource, writeBrief } from "@/lib/library";
import { createProvider, selectProvider } from "@/lib/llm/registry";
import { LlmError } from "@/lib/llm/types";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = checkLocalRequest(request.headers);
  if (!guard.ok) return json({ error: guard.error }, guard.status);

  const config = getConfig();
  const { slug } = await params;
  const source = await readSource(config.outdir, slug);
  if (!source) return json({ error: "unknown source (no .md transcript found)" }, 404);

  try {
    const provider = createProvider(selectProvider(process.env));
    const result = await interpretTranscript({
      provider,
      meta: source.meta,
      body: source.body,
      maxInputChars: config.maxInputChars,
    });
    await writeBrief(source.mdFile, result.text + "\n");
    return json({
      provider: provider.label,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
  } catch (error) {
    if (error instanceof LlmError) return json({ error: error.message }, error.status);
    throw error;
  }
}
