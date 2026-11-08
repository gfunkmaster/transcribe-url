import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { checkLocalRequest } from "@/lib/guard";
import { isSafeMediaName, MEDIA_TYPES, resolveSourceDir } from "@/lib/library";
import { json } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves only image-N.<ext> files that the post reader saved inside a source folder. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string; file: string }> }) {
  const guard = checkLocalRequest(request.headers);
  if (!guard.ok) return json({ error: guard.error }, guard.status);

  const { slug, file } = await params;
  const dir = resolveSourceDir(getConfig().outdir, slug);
  if (!dir || !isSafeMediaName(file)) return json({ error: "not found" }, 404);
  const bytes = await fs.readFile(path.join(/* turbopackIgnore: true */ dir, file)).catch(() => null);
  if (!bytes) return json({ error: "not found" }, 404);

  const ext = file.split(".").pop() ?? "";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": MEDIA_TYPES[ext] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
