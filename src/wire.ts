/**
 * What the server streams to the web UI over SSE (types and pure helpers; shared by server and web).
 *
 *   event "full"   -> LiveSnapshot   (on connect and on every reconnect)
 *   event "delta"  -> LiveDelta      (after that; only what changed)
 *
 * Transcript lines, change events and log entries are append-only, so a delta carries the
 * new tail plus the index it starts at. The client checks the index against what it has and
 * reconnects (getting a fresh "full") if they ever disagree. The doc state goes as a patch:
 * only the topics, items, components and edges whose content changed (nothing is ever
 * deleted from the state; removals are status changes), plus meeting info and order when
 * they changed.
 */
import type { ChangeEvent, Component, DocState, Edge, Item, MeetingInfo, Topic, Utterance } from "./core/types.js";

export interface StatePatch {
  meeting?: MeetingInfo;
  order?: DocState["order"];
  topics?: Record<string, Topic>;
  items?: Record<string, Item>;
  components?: Record<string, Component>;
  edges?: Record<string, Edge>;
}

/**
 * What changed in the state since the client last saw it, by entity content (the reducer
 * clones the whole state on every operation, so object identity says nothing).
 */
export function statePatch(state: DocState, seen: Map<string, string>): StatePatch | undefined {
  const patch: StatePatch = {};
  let any = false;
  const check = (key: string, value: unknown): boolean => {
    const json = JSON.stringify(value);
    if (seen.get(key) === json) return false;
    seen.set(key, json);
    return true;
  };
  if (check("meeting", state.meeting)) (patch.meeting = state.meeting), (any = true);
  if (check("order", state.order)) (patch.order = state.order), (any = true);
  for (const kind of ["topics", "items", "components", "edges"] as const) {
    const table = state[kind] as Record<string, unknown>;
    for (const [id, v] of Object.entries(table)) {
      if (!check(`${kind}:${id}`, v)) continue;
      ((patch[kind] ??= {}) as Record<string, unknown>)[id] = v;
      any = true;
    }
  }
  return any ? patch : undefined;
}

/** Apply a patch to the state the client has (pure). */
export function applyStatePatch(state: DocState, p: StatePatch): DocState {
  return {
    meeting: p.meeting ?? state.meeting,
    order: p.order ?? state.order,
    topics: p.topics ? { ...state.topics, ...p.topics } : state.topics,
    items: p.items ? { ...state.items, ...p.items } : state.items,
    components: p.components ? { ...state.components, ...p.components } : state.components,
    edges: p.edges ? { ...state.edges, ...p.edges } : state.edges,
  };
}

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
  patch?: StatePatch;
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
