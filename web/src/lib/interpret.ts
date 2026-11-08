import { systemPromptFor } from "./interpret-prompt";
import type { Meta } from "./library";
import { LlmError, type LlmImage, type LlmProvider, type LlmResult } from "./llm/types";

export type SourceKind = "video" | "post";

export function buildUserMessage(meta: Meta, body: string, kind: SourceKind = "video"): string {
  const header = ["title", "uploader", "upload_date", "duration", "language", "model", "source_url"]
    .filter((key) => meta[key])
    .map((key) => `${key}: ${meta[key]}`)
    .join("\n");
  const tag = kind === "post" ? "post" : "transcript";
  return `<metadata>\n${header}\n</metadata>\n\n<${tag}>\n${body}\n</${tag}>\n\nInterpret this ${tag}.`;
}

export async function interpretTranscript(args: {
  provider: LlmProvider;
  meta: Meta;
  body: string;
  maxInputChars: number;
  kind?: SourceKind;
  images?: LlmImage[];
}): Promise<LlmResult> {
  const { provider, meta, body, maxInputChars, kind = "video", images } = args;
  if (body.length > maxInputChars) {
    throw new LlmError(`transcript is too large (${body.length} chars, limit ${maxInputChars})`, 413);
  }
  return provider.complete({
    system: systemPromptFor(kind),
    user: buildUserMessage(meta, body, kind),
    ...(images && images.length > 0 ? { images } : {}),
  });
}
