import { parseTs } from "../../src/core/types.js";

/** "00:14:45" -> "14:45"; "01:02:03" -> "1:02:03". */
export function shortTs(ts: string | null | undefined): string {
  if (!ts) return "";
  const n = parseTs(ts);
  if (Number.isNaN(n)) return ts;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0]! + parts.at(-1)![0]!).toUpperCase();
}

export function hue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** "webhooks-design-review.jsonl" -> "Webhooks design review". */
export function prettyName(file: string): string {
  const base = file.replace(/\.(jsonl|json|txt|md|vtt|srt)$/i, "").replace(/[-_]+/g, " ").trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Split "Delivery queue: SQS with DLQ" into a subject and the choice. */
export function splitTitle(title: string): { subject: string | null; choice: string } {
  const i = title.indexOf(": ");
  if (i > 0 && i < 48) return { subject: title.slice(0, i).trim(), choice: title.slice(i + 2).trim() };
  return { subject: null, choice: title };
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function money(usd: number): string {
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`;
}

/** A display name for the doc: the agent's title, else the session's. */
export function docTitle(metaTitle: string, sessionTitle: string): string {
  return metaTitle?.trim() || prettyName(sessionTitle || "Untitled meeting");
}
