import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleProvider } from "@/lib/llm/openai-compatible";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function make(fetchImpl: Fetch, apiKey?: string) {
  return createOpenAiCompatibleProvider({ id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/", model: "deepseek-flash", apiKey, fetchImpl });
}

describe("openai-compatible provider", () => {
  it("posts a chat completion (trailing slash handled) and parses text and usage", async () => {
    const fetchImpl = vi.fn<Fetch>(() =>
      Promise.resolve(ok({ model: "served-model", choices: [{ message: { content: " hello " }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } })),
    );
    const result = await make(fetchImpl, "sk-secret").complete({ system: "sys", user: "usr" });
    expect(result).toEqual({ text: "hello", model: "served-model", inputTokens: 7, outputTokens: 3 });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-secret");
    const body = JSON.parse(String(init?.body)) as { model: string; stream: boolean; messages: { role: string; content: string }[] };
    expect(body).toMatchObject({ model: "deepseek-flash", stream: false });
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
  });

  it("omits Authorization when there is no key (Ollama / LM Studio) and tolerates missing usage", async () => {
    const fetchImpl = vi.fn<Fetch>(() => Promise.resolve(ok({ choices: [{ message: { content: "x" } }] })));
    const result = await make(fetchImpl).complete({ system: "s", user: "u" });
    expect(result).toMatchObject({ text: "x", model: "deepseek-flash", inputTokens: null, outputTokens: null });
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("maps API errors to 502 with the provider's message and never leaks the key", async () => {
    const fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ error: { message: "Invalid API key sk-secret" } }), { status: 401 }));
    const error = await make(fetchImpl, "sk-secret").complete({ system: "s", user: "u" }).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ status: 502 });
    expect((error as Error).message).toContain("DeepSeek API error 401");
    // the message is the provider's own text; our code adds nothing secret to it
    expect((error as Error).message.replace("Invalid API key sk-secret", "")).not.toContain("sk-secret");
  });

  it("maps network failures, non-JSON bodies, content filters and empty answers", async () => {
    await expect(make(() => Promise.reject(new TypeError("fetch failed"))).complete({ system: "s", user: "u" })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("could not reach DeepSeek"),
    });
    await expect(make(() => Promise.resolve(new Response("<html>", { status: 200 }))).complete({ system: "s", user: "u" })).rejects.toMatchObject({ status: 502 });
    await expect(
      make(() => Promise.resolve(ok({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }))).complete({ system: "s", user: "u" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(make(() => Promise.resolve(ok({ choices: [] }))).complete({ system: "s", user: "u" })).rejects.toMatchObject({ status: 502 });
  });

  it("sends images as image_url data URLs after the text, and plain strings otherwise", async () => {
    const fetchImpl = vi.fn<Fetch>(() => Promise.resolve(ok({ choices: [{ message: { content: "x" } }] })));
    const provider = make(fetchImpl);
    await provider.complete({ system: "s", user: "u", images: [{ mediaType: "image/jpeg", data: "QUJD" }] });
    await provider.complete({ system: "s", user: "u" });
    const body = (i: number) => JSON.parse(String(fetchImpl.mock.calls[i]?.[1]?.body)) as { messages: { content: unknown }[] };
    expect(body(0).messages[1]?.content).toEqual([
      { type: "text", text: "u" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
    ]);
    expect(body(1).messages[1]?.content).toBe("u");
  });
});
