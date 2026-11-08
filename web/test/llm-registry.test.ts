import { describe, expect, it } from "vitest";
import { describeProvider, selectProvider } from "@/lib/llm/registry";

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

describe("selectProvider", () => {
  it("auto-detects the single configured key (switching key switches provider)", () => {
    expect(selectProvider(env({ ANTHROPIC_API_KEY: "a" }))).toMatchObject({ id: "anthropic", model: "claude-opus-5-5", apiKey: "a" });
    expect(selectProvider(env({ DEEPSEEK_API_KEY: "d" }))).toMatchObject({ id: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" });
  });

  it("refuses to guess when several keys are set, and LLM_PROVIDER resolves it", () => {
    const both = { ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d" };
    expect(() => selectProvider(env(both))).toThrow(/several LLM keys.*LLM_PROVIDER/);
    expect(selectProvider(env({ ...both, LLM_PROVIDER: "deepseek" })).id).toBe("deepseek");
  });

  it("explains what to set when nothing is configured", () => {
    expect(() => selectProvider(env({}))).toThrow(/ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY/);
    expect(() => selectProvider(env({ LLM_PROVIDER: "nope" }))).toThrow(/unknown LLM_PROVIDER/);
  });

  it("requires a model where no default exists, and honours overrides", () => {
    expect(() => selectProvider(env({ OPENAI_API_KEY: "o" }))).toThrow(/LLM_MODEL/);
    expect(selectProvider(env({ OPENAI_API_KEY: "o", LLM_MODEL: "gpt-x" }))).toMatchObject({ id: "openai", model: "gpt-x", baseUrl: "https://api.openai.com/v1" });
    expect(selectProvider(env({ DEEPSEEK_API_KEY: "d", LLM_MODEL: "deepseek-v4-pro" })).model).toBe("deepseek-v4-pro");
    expect(selectProvider(env({ ANTHROPIC_API_KEY: "a", ANTHROPIC_MODEL: "claude-sonnet-5-5" })).model).toBe("claude-sonnet-5-5");
    expect(selectProvider(env({ DEEPSEEK_API_KEY: "d", LLM_API_KEY: "override", LLM_BASE_URL: "https://proxy.example/v1" }))).toMatchObject({ apiKey: "override", baseUrl: "https://proxy.example/v1" });
  });

  it("supports keyless local servers only when asked for explicitly", () => {
    expect(selectProvider(env({ LLM_PROVIDER: "ollama", LLM_MODEL: "llama3.3" }))).toMatchObject({ id: "ollama", baseUrl: "http://localhost:11434/v1", apiKey: undefined });
    expect(() => selectProvider(env({ LLM_PROVIDER: "openai-compatible", LLM_MODEL: "m" }))).toThrow(/LLM_BASE_URL/);
    expect(() => selectProvider(env({ LLM_PROVIDER: "openai-compatible", LLM_MODEL: "m", LLM_BASE_URL: "ftp://x" }))).toThrow(/http/);
    expect(() => selectProvider(env({ LLM_PROVIDER: "deepseek" }))).toThrow(/needs an API key/);
  });
});

describe("describeProvider", () => {
  it("reports status without ever including the key", () => {
    const ok = describeProvider(env({ DEEPSEEK_API_KEY: "sk-very-secret" }));
    expect(ok).toEqual({ ok: true, id: "deepseek", label: "DeepSeek", model: "deepseek-flash", local: false });
    expect(JSON.stringify(ok)).not.toContain("sk-very-secret");
    expect(describeProvider(env({ LLM_PROVIDER: "ollama", LLM_MODEL: "m" }))).toMatchObject({ ok: true, local: true });
    expect(describeProvider(env({}))).toMatchObject({ ok: false });
  });
});
