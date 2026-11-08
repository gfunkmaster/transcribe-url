import { INTERPRET_SYSTEM_PROMPT } from "./interpret-prompt";
import type { Meta } from "./library";
import { LlmError, type LlmProvider, type LlmResult } from "./llm/types";

export function buildUserMessage(meta: Meta, body: string): string {
  const header = ["title", "uploader", "upload_date", "duration", "language", "model", "source_url"]
    .filter((key) => meta[key])
    .map((key) => `${key}: ${meta[key]}`)
    .join("\n");
  return `<metadata>\n${header}\n</metadata>\n\n<transcript>\n${body}\n</transcript>\n\nInterpret this transcript.`;
}

export async function interpretTranscript(args: {
  provider: LlmProvider;
  meta: Meta;
  body: string;
  maxInputChars: number;
}): Promise<LlmResult> {
  const { provider, meta, body, maxInputChars } = args;
  if (body.length > maxInputChars) {
    throw new LlmError(`transcript is too large (${body.length} chars, limit ${maxInputChars})`, 413);
  }
  return provider.complete({ system: INTERPRET_SYSTEM_PROMPT, user: buildUserMessage(meta, body) });
}
