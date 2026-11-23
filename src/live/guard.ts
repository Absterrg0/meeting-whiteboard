/**
 * Request guards shared by the HTTP API and the audio WebSocket.
 *
 * The server is a local tool that spends API budget. When a tunnel (cloudflared) is running
 * so Recall.ai can deliver webhooks, anyone who learns the tunnel URL can reach the server,
 * so requests that arrived through a proxy may only hit the Recall webhook.
 */
import type { MiddlewareHandler } from "hono";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

type HeaderGetter = (name: string) => string | undefined;

/** True when the request came through a reverse proxy / tunnel rather than straight from this machine. */
export function isForwarded(header: HeaderGetter): boolean {
  if (process.env.ALLOW_REMOTE_UI === "1") return false;
  if (header("cf-connecting-ip") || header("cf-ray") || header("x-forwarded-for") || header("forwarded")) return true;
  const host = header("host");
  if (!host) return false;
  // Bound to loopback (the default) but addressed by another name: came through a tunnel.
  const bindHost = process.env.HOST ?? "127.0.0.1";
  return LOOPBACK.has(bindHost) && !LOOPBACK.has(hostnameOf(host));
}

function hostnameOf(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0]!.toLowerCase();
}

/** Same-origin (or a local dev origin such as the Vite server). */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  try {
    const o = new URL(origin);
    return o.host === host || LOOPBACK.has(o.hostname);
  } catch {
    return false;
  }
}

/**
 * Hono middleware (mount on "*"):
 *  - requests that came through a tunnel may only reach `publicPaths` (the Recall webhook);
 *  - state-changing requests must be same-origin when an Origin is sent, and POSTs must be JSON
 *    (which forces a CORS preflight cross-origin). `publicPaths` skip these checks and protect
 *    themselves (Recall token + signature).
 */
export function apiGuard(publicPaths: string[]) {
  const isPublic = (path: string) => publicPaths.some((p) => path === p || path === p.replace(/\/$/, ""));
  const mw: MiddlewareHandler = async (c, next) => {
    const header = (n: string) => c.req.header(n);
    if (isPublic(c.req.path)) return next();
    if (isForwarded(header)) return c.json({ error: "this endpoint is only available locally" }, 403);
    if (!c.req.path.startsWith("/api/")) return next();
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      if (method === "POST" && !(header("content-type") ?? "").includes("application/json")) {
        return c.json({ error: "expected application/json" }, 415);
      }
      const origin = header("origin");
      if (origin && !originAllowed(origin, header("host"))) return c.json({ error: "cross-origin request refused" }, 403);
    }
    await next();
  };
  return mw;
}
