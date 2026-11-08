import { describe, expect, it, vi } from "vitest";
import { buildUserMessage, interpretTranscript } from "@/lib/interpret";
import type { LlmProvider, LlmRequest, LlmResult } from "@/lib/llm/types";

const provider = (complete: LlmProvider["complete"]): LlmProvider => ({ id: "fake", label: "Fake", model: "m", complete });

describe("interpretTranscript", () => {
  it("sends the system prompt and a delimited transcript, returns the provider result", async () => {
    const complete = vi.fn<(r: LlmRequest) => Promise<LlmResult>>(() => Promise.resolve({ text: "brief", model: "m", inputTokens: 1, outputTokens: 2 }));
    const result = await interpretTranscript({ provider: provider(complete), meta: { title: "T" }, body: "- **00:00** hi", maxInputChars: 100 });
    expect(result.text).toBe("brief");
    const request = complete.mock.calls[0]?.[0];
    expect(request?.system).toContain("untrusted data");
    expect(request?.user).toContain("<transcript>");
    expect(request?.user).toContain("title: T");
  });

  it("rejects oversized input before calling the provider", async () => {
    const complete = vi.fn<(r: LlmRequest) => Promise<LlmResult>>();
    await expect(
      interpretTranscript({ provider: provider(complete), meta: {}, body: "x".repeat(101), maxInputChars: 100 }),
    ).rejects.toMatchObject({ status: 413 });
    expect(complete).not.toHaveBeenCalled();
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
