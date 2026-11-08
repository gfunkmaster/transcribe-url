export type GuardResult = { ok: true } | { ok: false; status: number; error: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostnameOf(hostHeader: string): string {
  // "[::1]:3000" -> "[::1]"; "localhost:3000" -> "localhost"
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0] ?? "";
}

/**
 * The server spawns processes and spends API credit, so state-changing routes must only
 * answer the local browser: Host must be loopback (blocks DNS rebinding) and, when the
 * browser sends an Origin, it must be this same host (blocks cross-site requests).
 */
export function checkLocalRequest(headers: Headers): GuardResult {
  const host = headers.get("host") ?? "";
  if (!LOCAL_HOSTS.has(hostnameOf(host))) {
    return { ok: false, status: 403, error: "this server only answers on localhost" };
  }
  const origin = headers.get("origin");
  if (origin !== null) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, status: 403, error: "invalid Origin" };
    }
    if (originHost !== host) return { ok: false, status: 403, error: "cross-origin request rejected" };
  }
  return { ok: true };
}
