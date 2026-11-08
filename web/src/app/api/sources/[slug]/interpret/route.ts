import { getConfig } from "@/lib/config";
import { checkLocalRequest } from "@/lib/guard";
import { interpretTranscript } from "@/lib/interpret";
import { loadImages, readSource, writeBrief } from "@/lib/library";
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
  if (!source) return json({ error: "unknown source (no .md found)" }, 404);

  const payload = (await request.json().catch(() => null)) as { includeImages?: unknown } | null;
  const includeImages = payload?.includeImages === true && source.kind === "post" && source.images.length > 0;

  try {
    const provider = createProvider(selectProvider(process.env));
    const images = includeImages ? await loadImages(config.outdir, slug, source.images) : [];
    const result = await interpretTranscript({
      provider,
      meta: source.meta,
      body: source.body,
      maxInputChars: config.maxInputChars,
      kind: source.kind === "post" ? "post" : "video",
      images,
    });
    await writeBrief(source.mdFile, result.text + "\n");
    return json({
      provider: provider.label,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      images: images.length,
    });
  } catch (error) {
    if (error instanceof LlmError) {
      const hint = includeImages ? " (if this model cannot read images, untick “Include images” and try again)" : "";
      return json({ error: error.message + hint }, error.status);
    }
    if (error instanceof Error && error.message.startsWith("images are too large")) {
      return json({ error: error.message }, 413);
    }
    throw error;
  }
}
