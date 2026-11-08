import { getConfig } from "./config";
import { getJobManager } from "./jobs";

export function jobs() {
  const { bin, outdir } = getConfig();
  return getJobManager({ bin, outdir });
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
