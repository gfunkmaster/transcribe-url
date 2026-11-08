import { createAnthropicProvider } from "./anthropic";
import { createOpenAiCompatibleProvider } from "./openai-compatible";
import { LlmError, type LlmProvider } from "./types";

export type ProviderId = "anthropic" | "deepseek" | "openai" | "openrouter" | "ollama" | "openai-compatible";

interface Preset {
  id: ProviderId;
  label: string;
  /** Env var holding this provider's key; also what auto-detection looks for. */
  keyEnv?: string;
  baseUrl?: string;
  defaultModel?: string;
  keyOptional?: boolean;
  /** Pick this provider automatically when its key is the only one set. */
  autodetect: boolean;
}

export const PRESETS: readonly Preset[] = [
  { id: "anthropic", label: "Anthropic Claude", keyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-opus-5-5", autodetect: true },
  // DeepSeek's current model name comes from its docs (api-docs.deepseek.com); override with LLM_MODEL.
  { id: "deepseek", label: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-flash", autodetect: true },
  { id: "openai", label: "OpenAI", keyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", autodetect: true },
  { id: "openrouter", label: "OpenRouter", keyEnv: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1", autodetect: true },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", keyOptional: true, autodetect: false },
  { id: "openai-compatible", label: "OpenAI-compatible server", keyEnv: "LLM_API_KEY", keyOptional: true, autodetect: false },
];

export interface Selection {
  id: ProviderId;
  label: string;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

const clean = (value: string | undefined) => value?.trim() || undefined;

/**
 * Decide which provider to use from the environment. Pure, so it is easy to test.
 *
 *  - `LLM_PROVIDER` picks explicitly.
 *  - Otherwise exactly one of the known key variables must be set; several keys at once is
 *    an error (silently choosing could bill the wrong account).
 *  - `LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL` override any provider's own settings.
 */
export function selectProvider(env: NodeJS.ProcessEnv): Selection {
  const requested = clean(env.LLM_PROVIDER)?.toLowerCase();
  let preset: Preset | undefined;

  if (requested) {
    preset = PRESETS.find((p) => p.id === requested);
    if (!preset) {
      throw new LlmError(`unknown LLM_PROVIDER "${requested}" (use one of: ${PRESETS.map((p) => p.id).join(", ")})`, 503);
    }
  } else {
    const withKey = PRESETS.filter((p) => p.autodetect && p.keyEnv && clean(env[p.keyEnv]));
    if (withKey.length === 0) {
      const names = PRESETS.filter((p) => p.autodetect && p.keyEnv)
        .map((p) => p.keyEnv)
        .join(", ");
      throw new LlmError(`no LLM configured: set one of ${names} in web/.env.local (or LLM_PROVIDER for Ollama / a custom server)`, 503);
    }
    if (withKey.length > 1) {
      const names = withKey.map((p) => p.keyEnv).join(", ");
      throw new LlmError(`several LLM keys are set (${names}); set LLM_PROVIDER to choose one`, 503);
    }
    preset = withKey[0];
  }
  if (!preset) throw new LlmError("no LLM provider selected", 503);

  const apiKey = clean(env.LLM_API_KEY) ?? (preset.keyEnv ? clean(env[preset.keyEnv]) : undefined);
  if (!apiKey && !preset.keyOptional) {
    throw new LlmError(`${preset.label} needs an API key: set ${preset.keyEnv ?? "LLM_API_KEY"}`, 503);
  }

  const baseUrl = clean(env.LLM_BASE_URL) ?? preset.baseUrl;
  if (preset.id !== "anthropic") {
    if (!baseUrl) throw new LlmError(`${preset.label} needs LLM_BASE_URL (for example http://localhost:1234/v1)`, 503);
    if (!/^https?:\/\//i.test(baseUrl)) throw new LlmError("LLM_BASE_URL must start with http:// or https://", 503);
  }

  const model = clean(env.LLM_MODEL) ?? (preset.id === "anthropic" ? clean(env.ANTHROPIC_MODEL) : undefined) ?? preset.defaultModel;
  if (!model) throw new LlmError(`${preset.label} needs LLM_MODEL (no default is built in)`, 503);

  return { id: preset.id, label: preset.label, apiKey, baseUrl, model };
}

export function createProvider(selection: Selection): LlmProvider {
  if (selection.id === "anthropic") {
    return createAnthropicProvider({ apiKey: selection.apiKey ?? "", model: selection.model });
  }
  return createOpenAiCompatibleProvider({
    id: selection.id,
    label: selection.label,
    baseUrl: selection.baseUrl ?? "",
    model: selection.model,
    apiKey: selection.apiKey,
  });
}

export type ProviderStatus =
  | { ok: true; id: ProviderId; label: string; model: string; local: boolean }
  | { ok: false; message: string };

/** For the UI: what Interpret will use, or why it cannot run. Never includes the key. */
export function describeProvider(env: NodeJS.ProcessEnv = process.env): ProviderStatus {
  try {
    const s = selectProvider(env);
    const local = s.id === "ollama" || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(s.baseUrl ?? "");
    return { ok: true, id: s.id, label: s.label, model: s.model, local };
  } catch (error) {
    if (error instanceof LlmError) return { ok: false, message: error.message };
    throw error;
  }
}
