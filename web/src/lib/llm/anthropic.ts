import Anthropic from "@anthropic-ai/sdk";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResult } from "./types";

/** The slice of the SDK this module needs, so tests can inject a fake. */
export interface MessageStreamer {
  beta: {
    messages: {
      stream(params: Record<string, unknown>): {
        finalMessage(): Promise<Anthropic.Beta.Messages.BetaMessage>;
      };
    };
  };
}

export function createAnthropicProvider(options: {
  apiKey: string;
  model: string;
  client?: MessageStreamer;
}): LlmProvider {
  const client = options.client ?? (new Anthropic({ apiKey: options.apiKey }) as unknown as MessageStreamer);
  return {
    id: "anthropic",
    label: "Anthropic Claude",
    model: options.model,
    async complete({ system, user }: LlmRequest): Promise<LlmResult> {
      let message: Anthropic.Beta.Messages.BetaMessage;
      try {
        // Streaming + finalMessage avoids HTTP timeouts on long outputs. `fallbacks: "default"`
        // lets the API re-run on a substitute model if a safety classifier declines the request.
        message = await client.beta.messages
          .stream({
            model: options.model,
            max_tokens: 32000,
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            system,
            messages: [{ role: "user", content: user }],
          })
          .finalMessage();
      } catch (error) {
        if (error instanceof Anthropic.APIError) {
          throw new LlmError(`Anthropic API error ${String(error.status)}: ${error.message}`, 502);
        }
        throw error;
      }

      if (message.stop_reason === "refusal") {
        const category = message.stop_details?.category ?? "unspecified";
        throw new LlmError(`the model declined this transcript (category: ${category})`, 422);
      }
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim();
      if (!text) {
        throw new LlmError(`the model returned no text (stop_reason: ${String(message.stop_reason)})`, 502);
      }
      return {
        text,
        model: message.model,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      };
    },
  };
}
