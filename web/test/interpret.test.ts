import { describe, expect, it, vi } from "vitest";
import { buildUserMessage, InterpretError, interpretTranscript, type MessageStreamer } from "@/lib/interpret";

type Final = Awaited<ReturnType<ReturnType<MessageStreamer["beta"]["messages"]["stream"]>["finalMessage"]>>;

function fakeClient(final: Partial<Final>) {
  const stream = vi.fn((params: Record<string, unknown>) => ({ finalMessage: () => Promise.resolve(final as Final), params }));
  return { client: { beta: { messages: { stream } } } as unknown as MessageStreamer, stream };
}

const args = { model: "claude-opus-5-5", meta: { title: "T", uploader: "U" }, body: "- **00:00** hi", maxInputChars: 1000 };

describe("interpretTranscript", () => {
  it("joins text blocks, ignores thinking, and reports usage", async () => {
    const { client, stream } = fakeClient({
      stop_reason: "end_turn",
      model: "claude-opus-5-5",
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "**What this is** a test" },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    } as unknown as Partial<Final>);
    const result = await interpretTranscript({ client, ...args });
    expect(result).toEqual({ markdown: "**What this is** a test", model: "claude-opus-5-5", inputTokens: 10, outputTokens: 20 });
    const params = stream.mock.calls[0]?.[0] ?? {};
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params).not.toHaveProperty("temperature");
    expect(String((params.messages as { content: string }[])[0]?.content)).toContain("<transcript>");
  });

  it("surfaces a refusal as a 422 with the category", async () => {
    const { client } = fakeClient({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: null },
      content: [],
    } as unknown as Partial<Final>);
    await expect(interpretTranscript({ client, ...args })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("cyber") });
  });

  it("fails on an empty answer and on oversized input (before any API call)", async () => {
    const empty = fakeClient({ stop_reason: "max_tokens", content: [], usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Partial<Final>);
    await expect(interpretTranscript({ client: empty.client, ...args })).rejects.toBeInstanceOf(InterpretError);

    const big = fakeClient({});
    await expect(interpretTranscript({ client: big.client, ...args, body: "x".repeat(1001) })).rejects.toMatchObject({ status: 413 });
    expect(big.stream).not.toHaveBeenCalled();
  });
});

describe("buildUserMessage", () => {
  it("includes only the metadata that exists", () => {
    const text = buildUserMessage({ title: "T", language: "en" }, "body");
    expect(text).toContain("title: T");
    expect(text).toContain("language: en");
    expect(text).not.toContain("uploader");
  });
});
