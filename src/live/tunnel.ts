/**
 * The public URL Recall.ai posts webhooks to.
 *
 * PUBLIC_URL wins when set (any tunnel or deployment). Otherwise, if `cloudflared` is on the PATH,
 * a Cloudflare quick tunnel (`cloudflared tunnel --url http://localhost:PORT`) is started on first
 * use and its https://*.trycloudflare.com URL is used. Requests arriving through the tunnel can only
 * reach the Recall webhook (see guard.ts). Set AUTO_TUNNEL=0 to disable.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

let child: ChildProcess | null = null;
let pending: Promise<string> | null = null;
let tunnelUrl: string | null = null;

export function cloudflaredInstalled(): boolean {
  try {
    return spawnSync("cloudflared", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

export function configuredPublicUrl(): string | null {
  const u = process.env.PUBLIC_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

export function currentPublicUrl(): string | null {
  return configuredPublicUrl() ?? tunnelUrl;
}

export async function ensurePublicUrl(port: number): Promise<string> {
  const configured = configuredPublicUrl();
  if (configured) return configured;
  if (tunnelUrl && child && child.exitCode === null && !pending) return tunnelUrl;
  if (process.env.AUTO_TUNNEL === "0" || !cloudflaredInstalled()) {
    throw new Error(
      "Recall needs a public URL to send the transcript to. Run `cloudflared tunnel --url http://localhost:" +
        port +
        "` and set PUBLIC_URL to the https://….trycloudflare.com address it prints (install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).",
    );
  }
  // Not probed for reachability here: probing a brand-new hostname makes the local resolver cache
  // NXDOMAIN. Recall retries each delivery for ~60 s, and the server pre-warms the tunnel at boot.
  pending ??= startTunnel(port).finally(() => (pending = null));
  return pending;
}

function startTunnel(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    let log = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`cloudflared did not report a tunnel URL within 30 s:\n${log.slice(-800)}`));
    }, 30_000);
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
      if (m && !tunnelUrl) {
        tunnelUrl = m[0];
        clearTimeout(timer);
        console.log(`public tunnel for Recall webhooks: ${tunnelUrl}`);
        resolve(tunnelUrl);
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (!tunnelUrl) reject(new Error(`cloudflared exited (${code}):\n${log.slice(-800)}`));
      tunnelUrl = null;
      child = null;
    });
  });
}

export function stopTunnel() {
  child?.kill();
  child = null;
  tunnelUrl = null;
}
