export interface LlmRequest {
  system: string;
  user: string;
}

export interface LlmResult {
  text: string;
  /** The model that actually answered (may differ from the configured one after a fallback). */
  model: string;
  /** null when the provider does not report usage. */
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmProvider {
  readonly id: string;
  /** Human-readable name shown in the UI, e.g. "DeepSeek". */
  readonly label: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResult>;
}

/** An error with an HTTP status the API route can return as-is. Messages never contain keys. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
