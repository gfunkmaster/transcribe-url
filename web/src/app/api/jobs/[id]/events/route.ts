import { checkLocalRequest } from "@/lib/guard";
import { json, jobs } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL = new Set(["done", "failed"]);

/** Server-Sent Events: replays the job's events so far, then streams live until it ends. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = checkLocalRequest(request.headers);
  if (!guard.ok) return json({ error: guard.error }, guard.status);

  const { id } = await params;
  const manager = jobs();
  if (!manager.get(id)) return json({ error: "unknown job" }, 404);

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        controller.close();
      };
      unsubscribe = manager.subscribe(id, (message) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
        if (message.event === "job" && TERMINAL.has(String(message.status))) close();
      });
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
