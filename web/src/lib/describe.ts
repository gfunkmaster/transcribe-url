import type { ProgressEvent } from "./events";

/** One human-readable line per event; null means "don't show". */
export function describeEvent(e: ProgressEvent): string | null {
  switch (e.event) {
    case "job":
      return e.error ? `job ${String(e.status)}: ${String(e.error)}` : `job ${String(e.status)}`;
    case "start":
      return `start · model ${String(e.model)}`;
    case "stage":
      return `stage: ${String(e.name)}`;
    case "audio":
      return `audio extracted (${String(e.seconds)} s)`;
    case "item":
      return `transcribing: ${String(e.title)}`;
    case "wrote":
      return `wrote ${String(e.path).split("/").pop() ?? String(e.path)}`;
    case "skip":
      return `skipped (already transcribed)`;
    case "error":
      return `error${e.stage ? ` [${String(e.stage)}]` : ""}: ${String(e.message)}`;
    case "done":
      return `done · ${String(e.processed)} processed, ${String(e.skipped)} skipped (${String(e.status)})`;
    default:
      return null;
  }
}

export function isFailure(e: ProgressEvent): boolean {
  return e.event === "error" || (e.event === "job" && e.status === "failed");
}
