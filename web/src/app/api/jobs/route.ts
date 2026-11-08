import { checkLocalRequest } from "@/lib/guard";
import { json, jobs } from "@/lib/server";
import { validateUrl } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = checkLocalRequest(request.headers);
  if (!guard.ok) return json({ error: guard.error }, guard.status);
  return json({ jobs: jobs().list() });
}

export async function POST(request: Request) {
  const guard = checkLocalRequest(request.headers);
  if (!guard.ok) return json({ error: guard.error }, guard.status);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  const check = validateUrl((payload as { url?: unknown } | null)?.url);
  if (!check.ok) return json({ error: check.error }, 400);

  return json({ job: jobs().enqueue(check.url) }, 202);
}
