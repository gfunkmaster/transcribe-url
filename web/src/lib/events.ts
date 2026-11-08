/** One NDJSON object from `transcribe-url --json-events` (stdout). */
export type ProgressEvent = { event: string } & Record<string, unknown>;

/** Parse a single line; returns null for blank/invalid/non-event lines. */
export function parseEventLine(line: string): ProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { event?: unknown }).event === "string"
    ) {
      return value as ProgressEvent;
    }
  } catch {
    // not JSON: ignore, the CLI contract says stdout is NDJSON but be tolerant
  }
  return null;
}

/** Incremental splitter: feed arbitrary chunks, get whole-line events. */
export function createEventParser(onEvent: (event: ProgressEvent) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const event = parseEventLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (event) onEvent(event);
      }
    },
    end() {
      const event = parseEventLine(buffer);
      buffer = "";
      if (event) onEvent(event);
    },
  };
}

export function isDoneEvent(event: ProgressEvent): boolean {
  return event.event === "done";
}
