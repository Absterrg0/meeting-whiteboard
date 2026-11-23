/**
 * Transcript parsing with format auto-detection.
 *
 * Accepted inputs (detected from the content, not the file name):
 *  - JSONL, one utterance per line, and JSON arrays of the same objects
 *    ({"time"|"ts"|"timestamp"|"start"|"start_time"|"offset", "speaker"|"name"|..., "text"|...}),
 *    including wrapped exports ({"utterances": [...]}, {"segments": [...]}, Recall.ai word lists)
 *  - WebVTT: Zoom ("Name: text" cues), Microsoft Teams ("<v Name>text</v>"), plain captions
 *  - SRT subtitles
 *  - Zoom chat export ("10:02:33 From Alice to Everyone: text", old and new layouts)
 *  - Header + paragraph exports: Otter.ai ("Alice Smith  0:03" then text),
 *    Fireflies/Rev/Teams-docx style ("Alice - 00:00", "Alice (00:01:10):", "00:00 Alice")
 *  - Google Meet transcript (Docs export): "00:05:00" marker lines + "Name: text" lines
 *  - "[00:01:10] Name: text" / "00:01:10 Name: text" / "Name (00:01:10): text" lines
 *  - Markdown tables "| time | speaker | text |"
 *  - Plain "Name: text" lines with no timestamps at all
 *
 * When a source has no (or only coarse) timestamps, times are synthesized from the
 * length of each utterance (about 2.5 words per second) and flagged `synthetic: true`.
 * Caption cues (VTT/SRT) from the same speaker less than 2 s apart are merged into one
 * utterance, because captioners split sentences.
 *
 * If nothing can be parsed, `TranscriptParseError` is thrown with the supported formats.
 */
import { formatTs, type Utterance } from "../core/types.js";

export interface ParsedUtterance extends Utterance {
  /** Present (true) when the time was estimated rather than read from the source. */
  synthetic?: true;
}

export type TranscriptFormat =
  | "jsonl"
  | "json"
  | "vtt"
  | "srt"
  | "zoom-chat"
  | "speaker-blocks"
  | "google-meet"
  | "timestamped-lines"
  | "markdown-table"
  | "speaker-lines";

export const FORMAT_LABELS: Record<TranscriptFormat, string> = {
  jsonl: "JSONL",
  json: "JSON",
  vtt: "WebVTT captions (Zoom / Teams)",
  srt: "SRT subtitles",
  "zoom-chat": "Zoom chat export",
  "speaker-blocks": "Speaker + time header blocks (Otter / Fireflies / Rev)",
  "google-meet": "Google Meet transcript",
  "timestamped-lines": "Timestamped lines",
  "markdown-table": "Markdown table",
  "speaker-lines": "Name: text lines (no timestamps)",
};

export interface ParseResult {
  format: TranscriptFormat;
  formatLabel: string;
  utterances: ParsedUtterance[];
  /** given: every time came from the source; partial: some were estimated; synthetic: all were. */
  timing: "given" | "partial" | "synthetic";
  warnings: string[];
}

export const SUPPORTED_FORMATS_HELP = [
  'JSONL / JSON array: {"time": "00:01:10", "speaker": "Ana", "text": "..."}',
  "WebVTT (.vtt) from Zoom, Teams or other captioners",
  "SRT subtitles (.srt)",
  'Zoom chat (.txt): "10:02:33 From Ana to Everyone: ..."',
  'Otter.ai (.txt): "Ana Lima  0:03" followed by the paragraph',
  'Fireflies / Rev style: "Ana - 00:03" or "Ana (00:00:03):" followed by the paragraph',
  'Google Meet transcript: "00:05:00" marker lines and "Ana: ..." lines',
  '"[00:01:10] Ana: ..." lines',
  "Markdown table | time | speaker | text |",
  '"Ana: ..." lines without timestamps',
].join("\n  - ");

export class TranscriptParseError extends Error {
  constructor(detail: string) {
    super(`Could not read a transcript: ${detail}. Supported formats:\n  - ${SUPPORTED_FORMATS_HELP}`);
    this.name = "TranscriptParseError";
  }
}

/** Seconds of speech per word used to estimate missing times (≈ 2.5 words/s). */
const SEC_PER_WORD = 1 / 2.5;
const MIN_UTTERANCE_SEC = 1.5;
const TURN_GAP_SEC = 0.5;
/** Merge caption cues from the same speaker when the gap is below this. */
const MERGE_GAP_SEC = 2;
/** ...but never grow a merged utterance beyond this span. */
const MERGE_MAX_SPAN_SEC = 45;

interface Raw {
  /** Start in seconds; NaN when unknown. */
  t: number;
  /** End in seconds when the source has it (captions). */
  end?: number;
  speaker: string;
  text: string;
}

// ---------------------------------------------------------------------------------
// Public API

export function parseTranscript(content: string): ParsedUtterance[] {
  return parseTranscriptDetailed(content).utterances;
}

export function parseTranscriptDetailed(content: string): ParseResult {
  const text = normalize(content);
  if (!text.trim()) throw new TranscriptParseError("the input is empty");

  const candidates: { format: TranscriptFormat; raws: Raw[]; warnings?: string[]; merge?: boolean }[] = [];
  const trimmed = text.trim();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const json = parseJson(trimmed);
    if (json) candidates.push(json);
  }
  if (/^WEBVTT/.test(trimmed)) {
    candidates.push({ format: "vtt", raws: parseCues(trimmed), merge: true });
  } else if (CUE_TIMING_RE.test(trimmed)) {
    candidates.push({ format: CUE_TIMING_RE.exec(trimmed)![0].includes(",") ? "srt" : "vtt", raws: parseCues(trimmed), merge: true });
  }
  if (candidates.every((c) => c.raws.length === 0)) {
    const lines = trimmed.split("\n");
    const chat = parseZoomChat(lines);
    if (chat.raws.length) candidates.push(chat);
  }
  if (candidates.every((c) => c.raws.length === 0)) {
    const lines = trimmed.split("\n");
    const table = parseTable(lines);
    if (table.length) candidates.push({ format: "markdown-table", raws: table });
    const blocks = parseSpeakerBlocks(lines);
    if (blocks.length) candidates.push({ format: "speaker-blocks", raws: blocks });
    const plain = parsePlainLines(lines);
    if (plain.raws.length) candidates.push(plain);
  }

  // Pick the reading that explains most of the text.
  // Most utterances wins (a stray "Note: ..." line must not beat a block transcript); ties go to coverage.
  const best = candidates
    .filter((c) => c.raws.length > 0)
    .sort((a, b) => b.raws.length - a.raws.length || coverage(b.raws) - coverage(a.raws))[0];
  if (!best) {
    const first = trimmed.split("\n").find((l) => l.trim())!.slice(0, 80);
    throw new TranscriptParseError(`no utterances found (first line: "${first}")`);
  }
  const warnings = [...(best.warnings ?? [])];
  let raws = best.raws.filter((r) => r.text.trim());
  if (best.merge) raws = mergeCues(raws);
  const { utterances, timing } = finalize(raws, warnings);
  return { format: best.format, formatLabel: FORMAT_LABELS[best.format], utterances, timing, warnings };
}

// ---------------------------------------------------------------------------------
// Helpers

function normalize(content: string): string {
  return content.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/ /g, " ");
}

function coverage(raws: Raw[]): number {
  return raws.reduce((n, r) => n + r.text.length, 0);
}

/** "01:02:03", "1:02:03.450", "02:03", "2:03,450", "00:00:16.239" → seconds; NaN if not a time. */
export function parseTime(v: string): number {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(v.trim());
  if (!m) return NaN;
  const h = m[1] ? Number(m[1]) : 0;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

// The lookahead stops "00:00:04" from being read as "00:00" followed by ":04".
const TIME = String.raw`\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?(?![\d:])`;

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function estDuration(text: string): number {
  return Math.max(MIN_UTTERANCE_SEC, wordCount(text) * SEC_PER_WORD);
}

/** Words that look like "Label:" but are document metadata, not speakers. */
const META_LABELS = new Set(
  [
    "attendees", "participants", "transcript", "summary", "notes", "date", "time", "meeting", "title",
    "agenda", "duration", "recording", "location", "subject", "organizer", "invitees", "created",
    "language", "keywords", "action items", "next steps", "note", "speakers", "meeting title",
    "meeting date", "transcription", "http", "https", "url", "link", "source",
  ].map((s) => s.toLowerCase()),
);

/** A plausible speaker name: 1-6 words, no sentence punctuation, not a time. */
function isName(s: string): boolean {
  const n = s.trim();
  if (!n || n.length > 48) return false;
  if (META_LABELS.has(n.toLowerCase())) return false;
  if (/[.!?;"“”]$/.test(n) || /[{}[\]<>|=:]/.test(n)) return false;
  if (/^\d+$/.test(n) || new RegExp(`^${TIME}$`).test(n)) return false;
  if (!/\p{L}/u.test(n)) return false;
  const words = n.split(/\s+/);
  if (words.length > 6) return false;
  // Lowercase-led multi-word phrases ("so the plan is") are sentences, not names.
  if (words.length > 2 && /^\p{Ll}/u.test(n)) return false;
  return true;
}

function cleanSpeaker(s: string): string {
  return s
    .replace(/^[>\-–—*\s]+/, "")
    .replace(/[\s\-–—|·]+$/, "")
    .replace(/[*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Footer / boilerplate lines that export tools append; never part of a turn. */
const BOILERPLATE_RE =
  /^(transcribed by|transcription ended|this editable transcript|meeting ended|recording (stopped|started)|generated by|powered by)\b/i;

function cleanText(s: string): string {
  return s
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}>/g, "") // VTT inline timestamps
    .replace(/<\/?[a-z][^>]*>/gi, "") // VTT / HTML tags (<c>, <b>, <i>, <v ...>, <font>)
    .replace(/\{\\[^}]*\}/g, "") // SSA-style {\an8}
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\\_/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split "Name: text" (name must look like a name). */
function splitSpeaker(line: string): { speaker: string; text: string } | null {
  const m = /^(?:>>\s*|-\s+)?([^:]{1,48}?)\s*:\s+(\S.*)$/.exec(line);
  if (!m) return null;
  const speaker = cleanSpeaker(m[1]!);
  if (!isName(speaker) || /^https?$/i.test(speaker)) return null;
  return { speaker, text: m[2]! };
}

// ---------------------------------------------------------------------------------
// JSON / JSONL

const TIME_KEYS = ["time", "ts", "timestamp", "start", "start_time", "startTime", "start_ms", "startMs", "offset", "begin", "t"];
const SPEAKER_KEYS = ["speaker", "speaker_name", "speakerName", "name", "who", "participant", "user", "author", "from", "sender"];
const TEXT_KEYS = ["text", "utterance", "content", "message", "transcript", "sentence", "body"];
const ARRAY_KEYS = ["utterances", "transcript", "segments", "entries", "messages", "items", "results", "lines", "data", "captions"];

function pick(o: Record<string, unknown>, keys: string[]): [string, unknown] | undefined {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return [k, o[k]];
  return undefined;
}

function speakerOf(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return `Speaker ${v}`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const n = o.name ?? o.display_name ?? o.displayName ?? o.id;
    if (typeof n === "string" && n.trim()) return n.trim();
    if (typeof n === "number") return `Speaker ${n}`;
  }
  return null;
}

function timeOf(key: string | undefined, v: unknown): number {
  let t: number;
  if (typeof v === "number") t = v;
  else if (typeof v === "string") t = /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : parseTime(v);
  else if (v && typeof v === "object" && typeof (v as { relative?: unknown }).relative === "number")
    t = (v as { relative: number }).relative; // Recall.ai {relative, absolute}
  else return NaN;
  if (key && /ms$/i.test(key)) t /= 1000;
  return t;
}

function fromObject(o: Record<string, unknown>): Raw | null {
  // Recall.ai / word-level exports: {participant: {name}, words: [{text, start_timestamp}]}
  if (Array.isArray(o.words) && !pick(o, TEXT_KEYS)) {
    const words = o.words as Record<string, unknown>[];
    const text = words.map((w) => (typeof w?.text === "string" ? w.text : typeof w?.word === "string" ? w.word : "")).join(" ");
    const w0 = words[0] ?? {};
    const speaker = speakerOf(pick(o, SPEAKER_KEYS)?.[1]) ?? "Unknown speaker";
    const tk = pick(w0, ["start_timestamp", ...TIME_KEYS]);
    return { t: timeOf(tk?.[0], tk?.[1]), speaker, text: cleanText(text) };
  }
  const textEntry = pick(o, TEXT_KEYS);
  if (!textEntry || typeof textEntry[1] !== "string") return null;
  const speaker = speakerOf(pick(o, SPEAKER_KEYS)?.[1]);
  const tk = pick(o, TIME_KEYS);
  return { t: timeOf(tk?.[0], tk?.[1]), speaker: speaker ?? "Unknown speaker", text: cleanText(textEntry[1]) };
}

function rawsFromArray(arr: unknown[]): Raw[] {
  const out: Raw[] = [];
  for (const o of arr) {
    const r = o && typeof o === "object" ? fromObject(o as Record<string, unknown>) : null;
    if (r && r.text) out.push(r);
  }
  // Bare numbers with no unit: if the values look like milliseconds, scale them.
  const ts = out.map((r) => r.t).filter((t) => !Number.isNaN(t));
  if (ts.length > 1 && Math.max(...ts) > 36_000 && Math.max(...ts) / Math.max(1, ts.length) > 1000) {
    for (const r of out) r.t /= 1000;
  }
  return out;
}

function parseJson(text: string): { format: TranscriptFormat; raws: Raw[] } | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (Array.isArray(v)) return { format: "json", raws: rawsFromArray(v) };
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of ARRAY_KEYS) if (Array.isArray(o[k])) return { format: "json", raws: rawsFromArray(o[k] as unknown[]) };
      const single = fromObject(o);
      if (single) return { format: "jsonl", raws: [single] };
    }
  } catch {
    /* not one JSON document; try JSONL */
  }
  const lines = text.split("\n").filter((l) => l.trim());
  const objs: unknown[] = [];
  for (const l of lines) {
    try {
      objs.push(JSON.parse(l));
    } catch {
      /* skip non-JSON lines */
    }
  }
  if (objs.length === 0) return null;
  return { format: "jsonl", raws: rawsFromArray(objs) };
}

// ---------------------------------------------------------------------------------
// VTT / SRT

const CUE_TIMING_RE = new RegExp(`^\\s*(${TIME})\\s*-->\\s*(${TIME})`, "m");

function parseCues(text: string): Raw[] {
  const raws: Raw[] = [];
  const blocks = text.split(/\n\s*\n/);
  let prevLastLine = "";
  for (const block of blocks) {
    const lines = block.split("\n");
    const ti = lines.findIndex((l) => CUE_TIMING_RE.test(l));
    if (ti < 0) continue; // header, NOTE, STYLE, REGION blocks
    const m = CUE_TIMING_RE.exec(lines[ti]!)!;
    const t = parseTime(m[1]!);
    const end = parseTime(m[2]!);
    let body = lines.slice(ti + 1).map((l) => l.trim()).filter(Boolean);
    if (body.length === 0) continue;

    // Rolling captions repeat the previous cue's last line first.
    if (body.length > 1 && cleanText(body[0]!) === prevLastLine) body = body.slice(1);
    prevLastLine = cleanText(body.at(-1)!);

    let speaker: string | null = null;
    const joined = body.join(" ");
    const voice = /<v(?:\.[^\s>]+)*\s+([^>]+)>/.exec(joined);
    if (voice) speaker = cleanSpeaker(voice[1]!);
    let textOut = cleanText(joined);
    if (!speaker) {
      const bracket = /^\s*[[(]([^\])]{1,40})[\])]\s*:?\s*(.+)$/.exec(textOut);
      const sp = splitSpeaker(textOut);
      if (sp) {
        speaker = sp.speaker;
        textOut = sp.text;
      } else if (bracket && isName(bracket[1]!) && !/^(music|applause|laughter|inaudible|crosstalk|silence|noise)/i.test(bracket[1]!)) {
        speaker = cleanSpeaker(bracket[1]!);
        textOut = bracket[2]!;
      }
    }
    textOut = textOut.replace(/^\s*[[(](music|applause|laughter|inaudible|crosstalk|silence|noise)[^\])]*[\])]\s*/i, "").trim();
    if (!textOut) continue;
    const last = raws.at(-1);
    // Exact repeats (rolling captions) carry no new text.
    if (last && last.text === textOut && (speaker ?? last.speaker) === last.speaker) {
      last.end = end;
      continue;
    }
    raws.push({ t, end, speaker: speaker ?? "", text: textOut });
  }
  // Cues without a label continue the previous speaker; with no labels at all, one generic speaker.
  let current = "";
  for (const r of raws) {
    if (r.speaker) current = r.speaker;
    else r.speaker = current || "Unknown speaker";
  }
  return raws;
}

/** Merge consecutive caption cues from the same speaker that are less than 2 s apart. */
export function mergeCues(raws: Raw[]): Raw[] {
  const out: Raw[] = [];
  for (const r of raws) {
    const prev = out.at(-1);
    const prevEnd = prev ? (prev.end ?? prev.t) : NaN;
    if (
      prev &&
      prev.speaker === r.speaker &&
      r.t - prevEnd < MERGE_GAP_SEC &&
      (r.end ?? r.t) - prev.t <= MERGE_MAX_SPAN_SEC
    ) {
      prev.text = `${prev.text} ${r.text}`.replace(/\s+/g, " ");
      prev.end = r.end ?? r.t;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------
// Zoom chat

const ZOOM_CHAT_RE = new RegExp(`^(${TIME})\\s+From\\s+(.+?)(?:\\s+to\\s+(.+?))?\\s*:\\s*(.*)$`, "i");

function parseZoomChat(lines: string[]): { format: TranscriptFormat; raws: Raw[]; warnings: string[] } {
  const raws: Raw[] = [];
  let skipped = 0;
  let current: (Raw & { private?: boolean }) | null = null;
  const push = () => {
    if (current && current.text.trim() && !current.private) raws.push(current);
    else if (current?.private) skipped++;
    current = null;
  };
  for (const line of lines) {
    const m = ZOOM_CHAT_RE.exec(line.trim());
    if (m) {
      push();
      const to = (m[3] ?? "").trim();
      const isPrivate = /direct message|privately/i.test(to) || (!!to && !/^(everyone|all)/i.test(to));
      current = { t: parseTime(m[1]!), speaker: cleanSpeaker(m[2]!), text: cleanText(m[4] ?? ""), private: isPrivate };
    } else if (current && line.trim()) {
      // New Zoom layout puts the message on the following tab-indented line(s).
      current.text = `${current.text} ${cleanText(line)}`.trim();
    }
  }
  push();
  const warnings: string[] = [];
  if (skipped) warnings.push(`skipped ${skipped} private chat message(s)`);
  // Saved chats use wall-clock times; make them meeting-relative.
  const first = raws[0]?.t ?? 0;
  if (first >= 3600) {
    for (const r of raws) r.t -= first;
    warnings.push("chat times were wall-clock; rebased to the first message");
  }
  return { format: "zoom-chat", raws, warnings };
}

// ---------------------------------------------------------------------------------
// Markdown table

const TABLE_RE = new RegExp(`^\\|\\s*\\[?(${TIME})\\]?\\s*\\|\\s*([^|]+?)\\s*\\|\\s*(.+?)\\s*\\|\\s*$`);

function parseTable(lines: string[]): Raw[] {
  const raws: Raw[] = [];
  for (const line of lines) {
    const m = TABLE_RE.exec(line.trim());
    if (m) raws.push({ t: parseTime(m[1]!), speaker: cleanSpeaker(m[2]!), text: cleanText(m[3]!) });
  }
  return raws;
}

// ---------------------------------------------------------------------------------
// Header + paragraph blocks (Otter, Fireflies, Rev, Teams docx copy-paste)

const HEADER_RES: RegExp[] = [
  // Fireflies / generic: "Alice - 00:03", "Alice | 00:03", "Alice · 00:03"
  new RegExp(`^(.{1,48}?)\\s*[-–—|·]\\s*\\[?(${TIME})\\]?\\s*$`),
  // Rev: "Alice (00:00:03):" or "Alice [00:03]"
  new RegExp(`^(.{1,48}?)\\s*[[(](${TIME})[\\])]\\s*:?\\s*$`),
  // Otter: "Alice Smith  0:03" (two+ spaces or a tab), also "Alice Smith 0:03"
  new RegExp(`^(.{1,48}?)\\s+(${TIME})\\s*$`),
];
// Time first: "00:03 Alice", "[00:03] Alice:", "00:03 - Alice"
const HEADER_TIME_FIRST = new RegExp(`^\\[?(${TIME})\\]?\\s*[-–—|·]?\\s*(.{1,48}?):?\\s*$`);

function matchHeader(line: string): { speaker: string; t: number } | null {
  const l = line.trim();
  for (const re of HEADER_RES) {
    const m = re.exec(l);
    if (m && isName(cleanSpeaker(m[1]!))) return { speaker: cleanSpeaker(m[1]!), t: parseTime(m[2]!) };
  }
  const m = HEADER_TIME_FIRST.exec(l);
  if (m && isName(cleanSpeaker(m[2]!))) return { speaker: cleanSpeaker(m[2]!), t: parseTime(m[1]!) };
  return null;
}

const BARE_TIME_RE = new RegExp(`^[[(]?(${TIME})[\\])]?$`);

function parseSpeakerBlocks(lines: string[]): Raw[] {
  const raws: Raw[] = [];
  let current: Raw | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let h = matchHeader(line);
    // Name and time on separate lines: "Alice Smith" / "00:03" / paragraph.
    if (!h && isName(cleanSpeaker(line)) && !/[,]/.test(line)) {
      const tm = BARE_TIME_RE.exec((lines[i + 1] ?? "").trim());
      if (tm) {
        h = { speaker: cleanSpeaker(line), t: parseTime(tm[1]!) };
        i++;
      }
    }
    if (h) {
      if (current?.text) raws.push(current);
      current = { t: h.t, speaker: h.speaker, text: "" };
      continue;
    }
    if (current && line.trim() && !BOILERPLATE_RE.test(line.trim())) current.text = `${current.text} ${cleanText(line)}`.trim();
  }
  if (current?.text) raws.push(current);
  // A single header-looking line is not a block transcript.
  return raws.length >= 1 && raws.some((r) => r.text) ? raws : [];
}

// ---------------------------------------------------------------------------------
// Line formats: timestamped lines, Google Meet markers, plain "Name: text"

const LINE_RES: RegExp[] = [
  // "[00:01:10] Name: text", "00:01:10 Name: text", "(00:01:10) - Name: text"
  new RegExp(`^[[(]?(${TIME})[\\])]?\\s*[-–—]?\\s*([^:|]{1,48}?):\\s+(.+)$`),
  // "Name [00:01:10]: text", "Name (00:01:10): text", "Name 00:01:10: text"
  new RegExp(`^([^:[(|]{1,48}?)\\s*[[(]?(${TIME})[\\])]?\\s*:\\s+(.+)$`),
];
const MARKER_RE = new RegExp(`^[#*\\s]*[[(]?(${TIME})[\\])]?[*\\s]*$`);

function parsePlainLines(lines: string[]): { format: TranscriptFormat; raws: Raw[] } {
  const raws: Raw[] = [];
  let stamped = 0;
  let markers = 0;
  let anchor = NaN; // last standalone time marker (Google Meet)
  let anchorUsed = false;
  for (const line of lines) {
    const l = line.trim();
    if (!l || BOILERPLATE_RE.test(l)) continue;
    const marker = MARKER_RE.exec(l);
    if (marker) {
      anchor = parseTime(marker[1]!);
      anchorUsed = false;
      markers++;
      continue;
    }
    let matched = false;
    for (const [i, re] of LINE_RES.entries()) {
      const m = re.exec(l);
      if (!m) continue;
      const [ts, name] = i === 0 ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
      const speaker = cleanSpeaker(name);
      if (!isName(speaker)) continue;
      raws.push({ t: parseTime(ts), speaker, text: cleanText(m[3]!) });
      stamped++;
      matched = true;
      break;
    }
    if (matched) continue;
    const sp = splitSpeaker(l);
    if (sp) {
      // The first line after a marker starts at the marker; the rest are estimated.
      const t = !Number.isNaN(anchor) && !anchorUsed ? anchor : NaN;
      anchorUsed = true;
      raws.push({ t, speaker: sp.speaker, text: cleanText(sp.text) });
    } else if (raws.length) {
      // Continuation of the previous speaker's turn (wrapped paragraph).
      const prev = raws.at(-1)!;
      prev.text = `${prev.text} ${cleanText(l)}`.trim();
    }
  }
  const format: TranscriptFormat = stamped > 0 ? "timestamped-lines" : markers > 0 ? "google-meet" : "speaker-lines";
  return { format, raws };
}

// ---------------------------------------------------------------------------------
// Times: fill gaps, order, index

function finalize(raws: Raw[], warnings: string[]): { utterances: ParsedUtterance[]; timing: ParseResult["timing"] } {
  const known = raws.map((r) => Number.isFinite(r.t) && r.t >= 0);
  const nKnown = known.filter(Boolean).length;
  const times: number[] = raws.map((r) => r.t);

  // Fill each run of unknown times: start after the previous utterance (its end, or its
  // start + estimated duration), and if a later known time exists, squeeze the run to fit.
  let i = 0;
  while (i < raws.length) {
    if (known[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < raws.length && !known[j]) j++;
    const prev = i > 0 ? raws[i - 1]! : null;
    let cursor = prev ? Math.max(prev.end ?? 0, times[i - 1]! + estDuration(prev.text) + TURN_GAP_SEC) : 0;
    const starts: number[] = [];
    for (let k = i; k < j; k++) {
      starts.push(cursor);
      cursor += estDuration(raws[k]!.text) + TURN_GAP_SEC;
    }
    const next = j < raws.length ? times[j]! : Infinity;
    const runStart = starts[0]!;
    if (cursor > next && next > runStart) {
      // Scale the run into the gap before the next known time.
      const scale = (next - runStart) / (cursor - runStart);
      for (let k = 0; k < starts.length; k++) starts[k] = runStart + (starts[k]! - runStart) * scale;
    } else if (next <= runStart) {
      for (let k = 0; k < starts.length; k++) starts[k] = Math.min(starts[k]!, next);
    }
    for (let k = i; k < j; k++) times[k] = Math.round(starts[k - i]! * 10) / 10;
    i = j;
  }

  let order = raws.map((_, k) => k);
  const monotonic = times.every((t, k) => k === 0 || t >= times[k - 1]!);
  if (!monotonic) {
    order = [...order].sort((a, b) => times[a]! - times[b]! || a - b);
    warnings.push("lines were not in time order; sorted by time");
  }
  const utterances = order.map((k, idx) => {
    const r = raws[k]!;
    const t = times[k]!;
    const u: ParsedUtterance = { t, ts: formatTs(t), speaker: r.speaker, text: r.text, idx };
    if (!known[k]) u.synthetic = true;
    return u;
  });
  const timing: ParseResult["timing"] = nKnown === raws.length ? "given" : nKnown === 0 ? "synthetic" : "partial";
  if (timing === "synthetic") warnings.push("no timestamps in the source; times are estimated from utterance length");
  else if (timing === "partial") warnings.push(`${raws.length - nKnown} of ${raws.length} times were estimated`);
  return { utterances, timing };
}
