/**
 * Transcript parsing. Accepts the formats a meeting is likely to arrive in:
 *  - JSONL, one utterance per line: {"time"|"ts"|"timestamp"|"start": "00:01:10" | 70, "speaker", "text"}
 *  - a JSON array of the same objects
 *  - plain text lines: "[00:01:10] Tomás: text" or "00:01:10 Tomás: text"
 *  - markdown table rows: "| 00:01:10 | Tomás | text |"
 */
import { formatTs, parseTs, type Utterance } from "../core/types.js";

type Raw = { t: number; speaker: string; text: string };

function toSeconds(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return parseTs(trimmed);
  }
  return NaN;
}

function fromObject(o: Record<string, unknown>): Raw | null {
  const time = o.time ?? o.ts ?? o.timestamp ?? o.start ?? o.t;
  const speaker = o.speaker ?? o.name ?? o.who;
  const text = o.text ?? o.utterance ?? o.content ?? o.message;
  if (typeof speaker !== "string" || typeof text !== "string") return null;
  return { t: toSeconds(time), speaker: speaker.trim(), text: text.trim() };
}

const LINE_RE = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*([^:|]{1,40}?):\s*(.+)$/;
const TABLE_RE = /^\|\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/;

export function parseTranscript(content: string): Utterance[] {
  const raws: Raw[] = [];
  const trimmed = content.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      for (const o of arr) {
        const r = o && typeof o === "object" ? fromObject(o as Record<string, unknown>) : null;
        if (r) raws.push(r);
      }
    } catch {
      /* fall through to line parsing */
    }
  }
  if (raws.length === 0) {
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      if (l.startsWith("{")) {
        try {
          const r = fromObject(JSON.parse(l) as Record<string, unknown>);
          if (r) raws.push(r);
          continue;
        } catch {
          /* not JSON */
        }
      }
      const m = TABLE_RE.exec(l) ?? LINE_RE.exec(l);
      if (m) raws.push({ t: parseTs(m[1]!), speaker: m[2]!.trim(), text: m[3]!.replace(/\\_/g, "_").trim() });
    }
  }
  // Fill missing times monotonically so ordering still works.
  let last = 0;
  return raws.map((r, idx) => {
    const t = Number.isNaN(r.t) ? last + 5 : r.t;
    last = t;
    return { t, ts: formatTs(t), speaker: r.speaker, text: r.text, idx };
  });
}
