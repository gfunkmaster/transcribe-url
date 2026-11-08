import { LlmError, type LlmProvider, type LlmRequest, type LlmResult } from "./types";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 8000;

/**
 * Any server that speaks the OpenAI Chat Completions wire format: DeepSeek, OpenAI,
 * OpenRouter, Ollama, LM Studio, vLLM, ... Plain `fetch`, no SDK.
 */
export function createOpenAiCompatibleProvider(options: {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
}): LlmProvider {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    id: options.id,
    label: options.label,
    model: options.model,
    async complete({ system, user, images = [] }: LlmRequest): Promise<LlmResult> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: options.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            stream: false,
            messages: [
              { role: "system", content: system },
              {
                role: "user",
                content:
                  images.length === 0
                    ? user
                    : [
                        { type: "text", text: user },
                        ...images.map((image) => ({
                          type: "image_url",
                          image_url: { url: `data:${image.mediaType};base64,${image.data}` },
                        })),
                      ],
              },
            ],
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new LlmError(`could not reach ${options.label}: ${reason}`, 502);
      }

      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        throw new LlmError(`${options.label} API error ${response.status}: ${errorMessage(raw)}`, 502);
      }

      let body: ChatCompletion;
      try {
        body = (await response.json()) as ChatCompletion;
      } catch {
        throw new LlmError(`${options.label} returned a response that is not JSON`, 502);
      }

      const choice = body.choices?.[0];
      if (choice?.finish_reason === "content_filter") {
        throw new LlmError(`${options.label} declined this transcript (content filter)`, 422);
      }
      const text = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
      if (!text) {
        throw new LlmError(`${options.label} returned no text (finish_reason: ${String(choice?.finish_reason)})`, 502);
      }
      return {
        text,
        model: body.model ?? options.model,
        inputTokens: numberOrNull(body.usage?.prompt_tokens),
        outputTokens: numberOrNull(body.usage?.completion_tokens),
      };
    },
  };
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: unknown }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (typeof message === "string" && message) return message.slice(0, 300);
  } catch {
    // not JSON
  }
  return raw.trim().slice(0, 300) || "no details";
}
