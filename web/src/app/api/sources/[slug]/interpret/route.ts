import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "@/lib/config";
import { checkLocalRequest } from "@/lib/guard";
import { InterpretError, interpretTranscript } from "@/lib/interpret";
import { readSource, writeBrief } from "@/lib/library";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = checkLocalRequest(request.headers);
  if (!guard.ok) return json({ error: guard.error }, guard.status);

  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY is not set (add it to web/.env.local and restart)" }, 503);
  }

  const config = getConfig();
  const { slug } = await params;
  const source = await readSource(config.outdir, slug);
  if (!source) return json({ error: "unknown source (no .md transcript found)" }, 404);

  try {
    const result = await interpretTranscript({
      client: new Anthropic() as unknown as Parameters<typeof interpretTranscript>[0]["client"],
      model: config.model,
      meta: source.meta,
      body: source.body,
      maxInputChars: config.maxInputChars,
    });
    await writeBrief(source.mdFile, result.markdown + "\n");
    return json({
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
  } catch (error) {
    if (error instanceof InterpretError) return json({ error: error.message }, error.status);
    if (error instanceof Anthropic.APIError) {
      return json({ error: `Anthropic API error ${String(error.status)}: ${error.message}` }, 502);
    }
    throw error;
  }
}
