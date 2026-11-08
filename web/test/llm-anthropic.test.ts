import { describe, expect, it, vi } from "vitest";
import { createAnthropicProvider, type MessageStreamer } from "@/lib/llm/anthropic";

type Final = Awaited<ReturnType<ReturnType<MessageStreamer["beta"]["messages"]["stream"]>["finalMessage"]>>;

function fake(final: unknown) {
  const stream = vi.fn((params: Record<string, unknown>) => ({ finalMessage: () => Promise.resolve(final as Final), params }));
  const client = { beta: { messages: { stream } } } as unknown as MessageStreamer;
  return { provider: createAnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", client }), stream };
}

describe("anthropic provider", () => {
  it("joins text blocks, ignores thinking, reports usage, and sends the expected request", async () => {
    const { provider, stream } = fake({
      stop_reason: "end_turn",
      model: "claude-opus-5-5",
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "**What this is** a test" },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(await provider.complete({ system: "sys", user: "usr" })).toEqual({
      text: "**What this is** a test",
      model: "claude-opus-5-5",
      inputTokens: 10,
      outputTokens: 20,
    });
    const params = stream.mock.calls[0]?.[0] ?? {};
    expect(params).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", system: "sys", betas: ["server-side-fallback-2026-07-01"] });
    expect(params).not.toHaveProperty("temperature");
  });

  it("surfaces a refusal as a 422 with the category", async () => {
    const { provider } = fake({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, content: [] });
    await expect(provider.complete({ system: "s", user: "u" })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("cyber") });
  });

  it("fails on an empty answer", async () => {
    const { provider } = fake({ stop_reason: "max_tokens", content: [], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(provider.complete({ system: "s", user: "u" })).rejects.toMatchObject({ status: 502 });
  });
});
