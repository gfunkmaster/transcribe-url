import Anthropic from "@anthropic-ai/sdk";
import type { Meta } from "./library";
import { INTERPRET_SYSTEM_PROMPT } from "./interpret-prompt";

export interface InterpretResult {
  markdown: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** The slice of the SDK this module needs, so tests can inject a fake. */
export interface MessageStreamer {
  beta: {
    messages: {
      stream(params: Anthropic.Beta.Messages.MessageCreateParamsStreaming | Record<string, unknown>): {
        finalMessage(): Promise<Anthropic.Beta.Messages.BetaMessage>;
      };
    };
  };
}

export class InterpretError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function buildUserMessage(meta: Meta, body: string): string {
  const header = ["title", "uploader", "upload_date", "duration", "language", "model", "source_url"]
    .filter((key) => meta[key])
    .map((key) => `${key}: ${meta[key]}`)
    .join("\n");
  return `<metadata>\n${header}\n</metadata>\n\n<transcript>\n${body}\n</transcript>\n\nInterpret this transcript.`;
}

export async function interpretTranscript(args: {
  client: MessageStreamer;
  model: string;
  meta: Meta;
  body: string;
  maxInputChars: number;
}): Promise<InterpretResult> {
  const { client, model, meta, body, maxInputChars } = args;
  if (body.length > maxInputChars) {
    throw new InterpretError(`transcript is too large (${body.length} chars, limit ${maxInputChars})`, 413);
  }

  // Streaming + finalMessage avoids HTTP timeouts on long outputs. `fallbacks: "default"`
  // lets the API re-run on a substitute model if a safety classifier declines the request.
  const message = await client.beta.messages
    .stream({
      model,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: INTERPRET_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(meta, body) }],
    })
    .finalMessage();

  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category ?? "unspecified";
    throw new InterpretError(`the model declined this transcript (category: ${category})`, 422);
  }

  const markdown = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (!markdown) {
    throw new InterpretError(`the model returned no text (stop_reason: ${String(message.stop_reason)})`, 502);
  }
  return {
    markdown,
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}
