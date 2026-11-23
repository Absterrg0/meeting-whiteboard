/**
 * What the server streams to the web UI over SSE (types only; shared by server and web).
 *
 *   event "full"   -> LiveSnapshot   (on connect and on every reconnect)
 *   event "delta"  -> LiveDelta      (after that; only what changed)
 *
 * Transcript lines, change events and log entries are append-only, so a delta carries the
 * new tail plus the index it starts at. The client checks the index against what it has and
 * reconnects (getting a fresh "full") if they ever disagree. The doc state is sent whole, and
 * only when it changed (the reducer replaces the state object on every applied operation).
 */
import type { ChangeEvent, DocState, Utterance } from "./core/types.js";

export interface LiveUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  costUsd: number;
  unpriced?: boolean;
}

export interface LiveLogEntry {
  at: string;
  ts: string;
  kind: "batch" | "editor" | "error" | "info";
  message: string;
}

/** Fields sent in every message (small). */
export interface LiveHeader {
  id: string;
  title: string;
  status: "idle" | "running" | "paused" | "done";
  agentBusy: boolean;
  editorBusy: boolean;
  /** Meeting clock at send time, "HH:MM:SS". */
  meetingTime: string;
  mode: "live" | "replay" | "headless";
  speed: number;
  processedCount: number;
  usage: LiveUsage;
  model: string;
  editorModel: string;
  latency: { p50: number | null; p90: number | null };
  /** Opened from out/ for viewing: no agent runs, edits still apply locally. */
  readOnly: boolean;
  /** Wall-clock ms when the session was created (for the doc's date). */
  createdAt: number;
}

export interface LiveSnapshot extends LiveHeader {
  transcript: Utterance[];
  state: DocState;
  events: ChangeEvent[];
  log: LiveLogEntry[];
}

export interface LiveDelta extends LiveHeader {
  /** Present only when the doc state changed. */
  state?: DocState;
  /** Index of the first line in `transcript` (equals the client's current line count). */
  transcriptFrom: number;
  transcript: Utterance[];
  eventsFrom: number;
  events: ChangeEvent[];
  logFrom: number;
  log: LiveLogEntry[];
}

export interface SavedSessionInfo {
  name: string;
  title: string;
  items: number;
  topics: number;
  components: number;
  lines: number;
  modifiedAt: string;
}
