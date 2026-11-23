/**
 * A meeting session: the transcript as it arrives, the doc state, the event log, the
 * two agents that maintain it, and the rendered outputs.
 *
 * Scheduling, from first principles:
 *  - The scribe runs as soon as a speaker turn arrives (after a short debounce that
 *    catches lines arriving together). It is serial: lines that arrive while it is
 *    busy are handed over together in its next turn, so a slow call never drops input
 *    and never queues a backlog of tiny calls; it only makes the next turn bigger.
 *  - The editor (diagram + overview) runs off that hot path: when the scribe changes
 *    items, it is marked dirty and runs after a debounce (with a max wait so it cannot
 *    starve during a busy stretch). It may run while the scribe is busy; both apply
 *    their operations to the live state through the reducer, one at a time.
 *  - At the end: remaining lines, then the scribe's review pass, then a final editor pass.
 *
 * Latency is measured per line: meeting time when its turn finished minus when it was said.
 */
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MeetingAgent, emptyUsage, mergeUsage, type AgentRuntime, type ApplyFn, type Usage } from "./agent/index.js";
import type { Op } from "./core/ops.js";
import { applyOp } from "./core/reducer.js";
import { toMarkdown, toMermaid } from "./core/render.js";
import { emptyState, formatTs, type ChangeEvent, type DocState, type Source, type Utterance } from "./core/types.js";

export interface SchedulePolicy {
  /** Wait this long after a line arrives before starting a scribe turn (wall ms). */
  debounceMs: number;
  /** Run the editor this long after the last item change... (wall ms) */
  editorDebounceMs: number;
  /** ...but no later than this after the first unhandled change (wall ms). */
  editorMaxWaitMs: number;
}

export const DEFAULT_SCHEDULE: SchedulePolicy = { debounceMs: 600, editorDebounceMs: 4000, editorMaxWaitMs: 15000 };

/** Item changes that can affect the diagram or overview (action items and facts cannot). */
function affectsArchitecture(e: ChangeEvent, state: DocState): boolean {
  if (e.op === "set_meeting_info") return true;
  return e.targets.some((id) => {
    const kind = state.items[id]?.kind;
    return kind !== undefined && kind !== "action_item" && kind !== "fact";
  });
}

export type SessionStatus = "idle" | "running" | "paused" | "done";

export interface SessionLogEntry {
  at: string;
  ts: string;
  kind: "batch" | "editor" | "error" | "info";
  message: string;
}

export interface Metrics {
  /** Per processed line: meeting seconds from when it was said to when its turn finished. */
  lineLatency: number[];
  /** Per editor run: meeting seconds from the earliest line behind the change to the diagram update. */
  diagramLag: number[];
  /** Wall seconds per scribe turn / editor run. */
  turnSeconds: number[];
  editorSeconds: number[];
  /** Lines per scribe turn. */
  turnLines: number[];
}

export interface Snapshot {
  id: string;
  title: string;
  status: SessionStatus;
  agentBusy: boolean;
  editorBusy: boolean;
  meetingTime: string;
  mode: "live" | "replay" | "headless";
  speed: number;
  transcript: Utterance[];
  processedCount: number;
  state: DocState;
  events: ChangeEvent[];
  markdown: string;
  mermaid: string;
  mermaidDraft: string;
  usage: Usage;
  model: string;
  editorModel: string;
  latency: { p50: number | null; p90: number | null };
  log: SessionLogEntry[];
}

export interface SessionOptions {
  id?: string;
  agent?: AgentRuntime;
  schedule?: Partial<SchedulePolicy>;
  outDir?: string;
  title?: string;
  /** Run the end-of-meeting review pass when the meeting finishes (default true). */
  reviewOnFinish?: boolean;
  /**
   * Manual mode: nothing runs on timers; the caller drives turns and the clock
   * (used by runHeadless to simulate a live meeting without waiting).
   */
  manual?: boolean;
}

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export class MeetingSession extends EventEmitter {
  readonly id: string;
  title: string;
  transcript: Utterance[] = [];
  state: DocState = emptyState();
  events: ChangeEvent[] = [];
  usage: Usage = emptyUsage();
  log: SessionLogEntry[] = [];
  status: SessionStatus = "idle";
  mode: "live" | "replay" | "headless" = "headless";
  agentBusy = false;
  editorBusy = false;
  metrics: Metrics = { lineLatency: [], diagramLag: [], turnSeconds: [], editorSeconds: [], turnLines: [] };
  reviewOnFinish: boolean;

  readonly agent: AgentRuntime;
  private processed = 0;
  private policy: SchedulePolicy;
  private outDir: string | null;
  private manual: boolean;
  private disposed = false;
  private failures = 0;
  private finishing: Promise<void> | null = null;
  private internal = new EventEmitter();
  private abort = new AbortController();

  /** Changes the scribe has not seen (human edits, review): told to it on its next turn. */
  private notices: string[] = [];
  editorDirty = false;
  /** Meeting time of the earliest line behind the editor's pending work. */
  private editorDirtySince: number | null = null;
  private editorFirstDirtyWall = 0;

  // Meeting clock: meetingTime = clockBase + (now - clockStart) * speed while running.
  private clockBase = 0;
  private clockStart = 0;
  speed = 1;
  private timers: NodeJS.Timeout[] = [];
  private turnTimer: NodeJS.Timeout | null = null;
  private editorTimer: NodeJS.Timeout | null = null;
  private replayQueue: Utterance[] = [];

  constructor(opts: SessionOptions = {}) {
    super();
    this.id = opts.id ?? new Date().toISOString().replace(/[:.]/g, "-");
    this.title = opts.title ?? "Untitled meeting";
    this.agent = opts.agent ?? new MeetingAgent();
    this.policy = { ...DEFAULT_SCHEDULE, ...opts.schedule };
    this.outDir = opts.outDir ? join(opts.outDir, this.id) : null;
    this.reviewOnFinish = opts.reviewOnFinish ?? true;
    this.manual = opts.manual ?? false;
    this.internal.setMaxListeners(100);
    if (this.outDir) mkdirSync(this.outDir, { recursive: true });
  }

  // ---------- clock ----------

  meetingTime(): number {
    if (this.status !== "running" || this.manual) return this.clockBase;
    return this.clockBase + ((Date.now() - this.clockStart) / 1000) * this.speed;
  }

  /** Manual mode only: set the meeting clock. */
  setClock(t: number) {
    this.clockBase = t;
  }

  private startClock() {
    this.clockStart = Date.now();
    this.status = "running";
  }

  // ---------- input ----------

  /** Add one utterance (live input, replay or injection). Every input source goes through here. */
  addUtterance(u: { speaker: string; text: string; t?: number }): Utterance {
    const t = u.t ?? Math.max(this.meetingTime(), this.transcript.at(-1)?.t ?? 0);
    const utt: Utterance = { t, ts: formatTs(t), speaker: u.speaker, text: u.text, idx: this.transcript.length };
    this.transcript.push(utt);
    this.emit("utterance", utt);
    this.changed();
    this.schedule();
    return utt;
  }

  pendingCount(): number {
    return this.transcript.length - this.processed;
  }

  /** Start a live session (no replay): the clock runs in real time from 0. */
  startLive() {
    this.mode = "live";
    this.speed = 1;
    this.startClock();
    this.changed();
  }

  /** Replay a transcript against the meeting clock at `speed`x real time. */
  replay(utterances: Utterance[], speed = 1) {
    this.stopTimers();
    this.replayQueue = [...utterances];
    this.mode = "replay";
    this.speed = speed;
    this.startClock();
    this.scheduleReplay();
    this.changed();
  }

  private scheduleReplay() {
    const now = this.meetingTime();
    for (const u of this.replayQueue) {
      const delayMs = Math.max(0, ((u.t - now) / this.speed) * 1000);
      this.timers.push(
        setTimeout(() => {
          this.replayQueue = this.replayQueue.filter((x) => x !== u);
          this.addUtterance({ speaker: u.speaker, text: u.text, t: u.t });
          if (this.replayQueue.length === 0) void this.finish();
        }, delayMs),
      );
    }
  }

  pause() {
    if (this.status !== "running") return;
    this.clockBase = this.meetingTime();
    this.status = "paused";
    this.stopTimers();
    this.changed();
  }

  resume() {
    if (this.status !== "paused") return;
    this.startClock();
    this.scheduleReplay();
    this.changed();
  }

  setSpeed(speed: number) {
    const wasRunning = this.status === "running";
    if (wasRunning) this.pause();
    this.speed = speed;
    if (wasRunning) this.resume();
  }

  /** Process pending lines now (skips the debounce). */
  flush() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    if (!this.agentBusy && this.pendingCount() > 0) void this.runTurn();
  }

  /**
   * End of meeting: stop any replay, freeze the clock, process what is left, run the
   * review pass and a final editor pass. Lines injected afterwards are still processed.
   */
  finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.clockBase = Math.max(this.meetingTime(), this.transcript.at(-1)?.t ?? 0);
    this.status = "done";
    this.stopTimers();
    this.replayQueue = [];
    this.changed();
    this.finishing = (async () => {
      await this.drain();
      if (this.reviewOnFinish && this.transcript.length > 0 && !this.disposed) {
        await this.whenIdle("agent");
        await this.runAgent("review");
      }
      if (this.agent.edit && !this.disposed) {
        await this.whenIdle("editor");
        await this.runEditor();
      }
      this.changed();
    })();
    return this.finishing;
  }

  /** Processes every pending line (used by finish and headless runs). */
  async drain() {
    for (;;) {
      if (this.disposed) return;
      await this.whenIdle("agent");
      if (this.pendingCount() === 0) return;
      if (this.turnTimer) clearTimeout(this.turnTimer);
      this.turnTimer = null;
      await this.runTurn();
    }
  }

  private whenIdle(which: "agent" | "editor"): Promise<void> {
    const busy = () => (which === "agent" ? this.agentBusy : this.editorBusy);
    if (!busy()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (!busy()) {
          this.internal.off("idle", check);
          resolve();
        }
      };
      this.internal.on("idle", check);
    });
  }

  private stopTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  dispose() {
    this.disposed = true;
    this.abort.abort();
    this.stopTimers();
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.editorTimer) clearTimeout(this.editorTimer);
    this.internal.emit("idle");
    this.removeAllListeners();
  }

  // ---------- scheduling ----------

  private schedule() {
    if (this.disposed || this.manual || this.agentBusy || this.turnTimer || this.pendingCount() === 0) return;
    const wait = this.status === "running" ? this.policy.debounceMs : 0;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      if (!this.agentBusy) void this.runTurn();
    }, wait);
  }

  private markEditorDirty(sinceT: number) {
    if (!this.agent.edit) return;
    if (!this.editorDirty) this.editorFirstDirtyWall = Date.now();
    this.editorDirty = true;
    this.editorDirtySince = Math.min(this.editorDirtySince ?? sinceT, sinceT);
    if (this.manual || this.disposed) return;
    if (this.editorTimer) clearTimeout(this.editorTimer);
    const maxWaitLeft = this.editorFirstDirtyWall + this.policy.editorMaxWaitMs - Date.now();
    const delay = Math.max(0, Math.min(this.policy.editorDebounceMs, maxWaitLeft));
    this.editorTimer = setTimeout(() => {
      this.editorTimer = null;
      void this.runEditor();
    }, delay);
  }

  /** The apply function the agents use: one operation, validated by the reducer, on the live state. */
  private applier(source: Source, transcript: Utterance[], meetingTime: number, onApplied?: (e: ChangeEvent) => void): ApplyFn {
    return (op) => {
      if (this.disposed) return { ok: false, error: "session closed" };
      const r = applyOp(this.state, op, { source, transcript, meetingTime, seq: this.events.length + 1 });
      if (!r.ok) return r;
      this.state = r.state;
      this.events.push(r.event);
      onApplied?.(r.event);
      this.persist([r.event]);
      this.changed();
      return { ok: true, summary: r.event.summary };
    };
  }

  /** One scribe turn over every pending line. Returns the lines it covered. */
  async runTurn(): Promise<Utterance[]> {
    if (this.disposed || this.agentBusy || this.pendingCount() === 0) return [];
    return this.runAgent("batch");
  }

  private async runAgent(mode: "batch" | "review"): Promise<Utterance[]> {
    if (this.disposed) return [];
    this.agentBusy = true;
    const fresh = mode === "batch" ? this.transcript.slice(this.processed) : [];
    const upTo = this.transcript.length;
    const transcript = this.transcript.slice(0, upTo);
    const meetingTime = transcript.at(-1)?.t ?? 0;
    const label = mode === "batch" ? `${fresh[0]?.ts}–${fresh.at(-1)?.ts}` : "End-of-meeting review";
    const notices = mode === "batch" ? this.notices.splice(0) : [];
    let itemsChanged = false;
    this.changed();
    const started = performance.now();
    try {
      const result = await this.agent.step({
        state: this.state,
        transcript,
        fresh,
        mode,
        notices,
        signal: this.abort.signal,
        apply: this.applier("agent", transcript, meetingTime, (e) => {
          if (affectsArchitecture(e, this.state)) itemsChanged = true;
          if (mode === "review") this.notices.push(`[review] ${e.summary}`);
        }),
      });
      this.usage = mergeUsage(this.usage, result.usage);
      if (mode === "batch") {
        this.processed = upTo;
        this.metrics.turnSeconds.push((performance.now() - started) / 1000);
        this.metrics.turnLines.push(fresh.length);
        if (!this.manual) for (const u of fresh) this.metrics.lineLatency.push(Math.max(0, this.meetingTime() - u.t));
      }
      this.addLog("batch", `${label}: ${result.applied} change(s). ${result.note}`.trim());
      for (const e of result.errors) this.addLog("error", e);
      this.failures = 0;
      if (itemsChanged) this.markEditorDirty(fresh[0]?.t ?? meetingTime);
      return fresh;
    } catch (err) {
      if (this.disposed) return [];
      this.notices.unshift(...notices);
      this.addLog("error", `${label}: agent call failed: ${(err as Error).message}`);
      if (itemsChanged) this.markEditorDirty(fresh[0]?.t ?? meetingTime);
      if (mode === "batch") {
        // Leave the lines pending and retry; after repeated failures skip them (logged)
        // rather than stall the meeting.
        this.failures++;
        if (this.failures >= 3) {
          this.addLog("error", `skipping ${fresh.length} line(s) after ${this.failures} failed attempts`);
          this.processed = upTo;
          this.failures = 0;
        } else {
          await new Promise((r) => setTimeout(r, 1500 * this.failures));
        }
      }
      return [];
    } finally {
      this.agentBusy = false;
      this.internal.emit("idle");
      this.changed();
      this.schedule();
    }
  }

  /** One editor run: diagram and overview from the current items. */
  async runEditor(): Promise<void> {
    if (!this.agent.edit || this.disposed) return;
    if (this.editorBusy) {
      this.editorDirty = true;
      return;
    }
    this.editorBusy = true;
    this.editorDirty = false;
    const since = this.editorDirtySince;
    this.editorDirtySince = null;
    this.changed();
    const started = performance.now();
    try {
      const result = await this.agent.edit({
        state: this.state,
        signal: this.abort.signal,
        apply: this.applier("editor", this.transcript, this.meetingTime()),
      });
      this.usage = mergeUsage(this.usage, result.usage);
      this.metrics.editorSeconds.push((performance.now() - started) / 1000);
      if (since !== null && !this.manual) this.metrics.diagramLag.push(Math.max(0, this.meetingTime() - since));
      this.addLog("editor", `${result.applied} diagram/overview change(s). ${result.note}`.trim());
      for (const e of result.errors) this.addLog("error", `editor: ${e}`);
    } catch (err) {
      if (!this.disposed) this.addLog("error", `editor failed: ${(err as Error).message}`);
    } finally {
      this.editorBusy = false;
      this.internal.emit("idle");
      this.changed();
      // Items changed while it ran: go again (debounced).
      if (this.editorDirty && !this.manual && !this.disposed) this.markEditorDirty(this.editorDirtySince ?? this.meetingTime());
    }
  }

  /** Manual mode: the meeting time of the earliest line behind pending editor work. */
  editorPendingSince(): number | null {
    return this.editorDirtySince;
  }

  // ---------- human edits ----------

  /** Apply an operation from the UI. Human edits pin the item against agent overwrites. */
  humanEdit(op: Op): { ok: true } | { ok: false; error: string } {
    const r = applyOp(this.state, op, {
      source: "human",
      transcript: this.transcript,
      meetingTime: this.meetingTime(),
      seq: this.events.length + 1,
    });
    if (!r.ok) return r;
    this.state = r.state;
    this.events.push(r.event);
    this.notices.push(`[human edit] ${r.event.summary}`);
    this.persist([r.event]);
    if (affectsArchitecture(r.event, this.state)) this.markEditorDirty(this.meetingTime());
    this.changed();
    return { ok: true };
  }

  // ---------- output ----------

  markdown(): string {
    return toMarkdown(this.state, { events: this.events });
  }

  snapshot(): Snapshot {
    return {
      id: this.id,
      title: this.title,
      status: this.status,
      agentBusy: this.agentBusy,
      editorBusy: this.editorBusy,
      meetingTime: formatTs(this.meetingTime()),
      mode: this.mode,
      speed: this.speed,
      transcript: this.transcript,
      processedCount: this.processed,
      state: this.state,
      events: this.events,
      markdown: this.markdown(),
      mermaid: toMermaid(this.state),
      mermaidDraft: toMermaid(this.state, { includeProposed: true }),
      usage: this.usage,
      model: this.agent.config.model,
      editorModel: this.agent.config.editorModel ?? this.agent.config.model,
      latency: { p50: percentile(this.metrics.lineLatency, 50), p90: percentile(this.metrics.lineLatency, 90) },
      log: this.log.slice(-200),
    };
  }

  private addLog(kind: SessionLogEntry["kind"], message: string) {
    this.log.push({ at: new Date().toISOString(), ts: formatTs(this.meetingTime()), kind, message });
  }

  private persist(newEvents: ChangeEvent[]) {
    if (!this.outDir) return;
    writeFileSync(join(this.outDir, "design-doc.md"), this.markdown());
    writeFileSync(join(this.outDir, "state.json"), JSON.stringify(this.state, null, 2));
    for (const e of newEvents) appendFileSync(join(this.outDir, "events.jsonl"), JSON.stringify(e) + "\n");
  }

  private changed() {
    this.emit("change");
  }
}

/**
 * Headless run for the CLI, evals and benchmarks: a discrete-event simulation of a live
 * meeting. Lines "arrive" at their transcript times; each scribe turn takes as much
 * meeting time as the real model call took, and lines spoken meanwhile go into the next
 * turn, exactly as they would live. The editor runs on its own timeline. So batch sizes
 * and latency numbers match a real-time run, without waiting in real time.
 */
export async function runHeadless(
  utterances: Utterance[],
  opts: Omit<SessionOptions, "manual"> & { onBatch?: (s: MeetingSession) => void } = {},
): Promise<MeetingSession> {
  const s = new MeetingSession({ ...opts, manual: true });
  const policy = { ...DEFAULT_SCHEDULE, ...opts.schedule };
  let clock = 0;
  let editorFree = 0;
  let i = 0;
  const n = utterances.length;
  while (i < n || s.pendingCount() > 0) {
    if (s.pendingCount() === 0 && i < n) clock = Math.max(clock, utterances[i]!.t);
    while (i < n && utterances[i]!.t <= clock) {
      const u = utterances[i++]!;
      s.setClock(Math.max(clock, u.t));
      s.addUtterance({ speaker: u.speaker, text: u.text, t: u.t });
    }
    s.setClock(clock);
    const t0 = performance.now();
    const lines = await s.runTurn();
    clock += (performance.now() - t0) / 1000;
    s.setClock(clock);
    for (const u of lines) s.metrics.lineLatency.push(Math.max(0, clock - u.t));
    // The editor runs on its own timeline, debounced as in live mode: once it is free and
    // either no line is due within the debounce window or the max wait has passed.
    const since = s.editorPendingSince();
    if (s.editorDirty && since !== null && clock >= editorFree) {
      const nextLine = i < n ? utterances[i]!.t : Infinity;
      const quietSoon = nextLine - clock >= policy.editorDebounceMs / 1000;
      const waitedLong = clock - since >= policy.editorMaxWaitMs / 1000;
      if (quietSoon || waitedLong) {
        const e0 = performance.now();
        await s.runEditor();
        editorFree = clock + (performance.now() - e0) / 1000;
        s.metrics.diagramLag.push(Math.max(0, editorFree - since));
      }
    }
    opts.onBatch?.(s);
  }
  await s.finish();
  return s;
}
