/**
 * A meeting session: the transcript as it arrives, the batcher that decides when
 * to call the agent, the doc state, the event log and the rendered outputs.
 *
 * The agent runs serially (state is a fold over operations). While it is busy,
 * new lines accumulate and are processed together in the next batch, so a slow
 * model call never drops input; it only makes the next batch bigger.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { ScribeAgent, emptyUsage, mergeUsage, type Usage } from "./agent/agent.js";
import type { Op } from "./core/ops.js";
import { applyOp } from "./core/reducer.js";
import { toMarkdown, toMermaid } from "./core/render.js";
import { emptyState, formatTs, type ChangeEvent, type DocState, type Utterance } from "./core/types.js";

export interface BatchPolicy {
  /** Flush when this many unprocessed lines are waiting. */
  minLines: number;
  /** Flush when the oldest unprocessed line is this old (meeting seconds). */
  maxWaitSec: number;
  /** Flush immediately when a line sounds like a decision or a reversal. */
  cueFlush: boolean;
}

export const DEFAULT_BATCH: BatchPolicy = { minLines: 4, maxWaitSec: 45, cueFlush: true };

/** Generic phrases that usually close a discussion. Used only to flush sooner, never to decide anything. */
const CUES =
  /\b(let'?s go with|we'?re going with|agreed|decided|decision|changing that|let'?s drop|let'?s not|instead|fine,|ok(ay)?,? (so|let'?s)|i'?ll (take|own|write|check|do)|can you own|action item|not deciding|revisit)\b/i;

export type SessionStatus = "idle" | "running" | "paused" | "done";

export interface SessionLogEntry {
  at: string;
  ts: string;
  kind: "batch" | "error" | "info";
  message: string;
}

export interface Snapshot {
  id: string;
  title: string;
  status: SessionStatus;
  agentBusy: boolean;
  meetingTime: string;
  transcript: Utterance[];
  processedCount: number;
  state: DocState;
  events: ChangeEvent[];
  markdown: string;
  mermaid: string;
  mermaidDraft: string;
  usage: Usage;
  model: string;
  log: SessionLogEntry[];
}

export interface SessionOptions {
  id?: string;
  agent?: ScribeAgent;
  batch?: Partial<BatchPolicy>;
  outDir?: string;
  title?: string;
  /** Run the end-of-meeting consistency review when the meeting finishes (default true). */
  reviewOnFinish?: boolean;
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
  agentBusy = false;

  private processed = 0;
  private agent: ScribeAgent;
  private policy: BatchPolicy;
  private outDir: string | null;
  private forceFlush = false;
  private drainWaiters: (() => void)[] = [];
  private idleWaiters: (() => void)[] = [];
  private failures = 0;
  private finishing = false;
  private finished: Promise<void> = Promise.resolve();
  reviewOnFinish = true;

  // Meeting clock: meetingTime = clockBase + (now - clockStart) * speed, while running.
  private clockBase = 0;
  private clockStart = 0;
  private speed = 1;
  private timers: NodeJS.Timeout[] = [];
  private ticker: NodeJS.Timeout | null = null;
  private replayQueue: Utterance[] = [];

  constructor(opts: SessionOptions = {}) {
    super();
    this.id = opts.id ?? new Date().toISOString().replace(/[:.]/g, "-");
    this.title = opts.title ?? "Untitled meeting";
    this.agent = opts.agent ?? new ScribeAgent();
    this.policy = { ...DEFAULT_BATCH, ...opts.batch };
    this.outDir = opts.outDir ? join(opts.outDir, this.id) : null;
    this.reviewOnFinish = opts.reviewOnFinish ?? true;
    if (this.outDir) mkdirSync(this.outDir, { recursive: true });
  }

  // ---------- clock ----------

  meetingTime(): number {
    if (this.status !== "running") return this.clockBase;
    return this.clockBase + ((Date.now() - this.clockStart) / 1000) * this.speed;
  }

  private startClock() {
    this.clockStart = Date.now();
    this.status = "running";
    if (!this.ticker) this.ticker = setInterval(() => this.schedule(), 1000);
  }

  // ---------- input ----------

  /** Add one utterance (live input or replay). */
  addUtterance(u: { speaker: string; text: string; t?: number }): Utterance {
    const t = u.t ?? Math.max(this.meetingTime(), this.transcript.at(-1)?.t ?? 0);
    const utt: Utterance = { t, ts: formatTs(t), speaker: u.speaker, text: u.text, idx: this.transcript.length };
    this.transcript.push(utt);
    if (CUES.test(utt.text) && this.policy.cueFlush) this.forceFlush = true;
    this.emit("utterance", utt);
    this.changed();
    this.schedule();
    return utt;
  }

  /** Start a live session (no replay): the clock runs in real time from 0. */
  startLive() {
    this.speed = 1;
    this.startClock();
    this.changed();
  }

  /** Replay a transcript against the meeting clock at `speed`x real time. */
  replay(utterances: Utterance[], speed = 1) {
    this.stopTimers();
    this.replayQueue = [...utterances];
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

  /** End of meeting: flush everything that is left, then run the review pass. */
  finish(): Promise<void> {
    if (this.finishing) return this.finished;
    this.finishing = true;
    let resolveFinished!: () => void;
    this.finished = new Promise((r) => (resolveFinished = r));
    this.forceFlush = true;
    this.schedule();
    void this.drained().then(async () => {
      if (this.reviewOnFinish && this.transcript.length > 0) await this.runReview();
      this.clockBase = this.meetingTime();
      this.status = "done";
      this.stopTimers();
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      this.changed();
      resolveFinished();
    });
    return this.finished;
  }

  private stopTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  dispose() {
    this.stopTimers();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.removeAllListeners();
  }

  // ---------- batching ----------

  private shouldFlush(): boolean {
    const pending = this.transcript.length - this.processed;
    if (pending <= 0) return false;
    if (this.forceFlush) return true;
    if (pending >= this.policy.minLines) return true;
    const oldest = this.transcript[this.processed]!;
    return this.meetingTime() - oldest.t >= this.policy.maxWaitSec;
  }

  private schedule() {
    if (this.agentBusy) return;
    if (!this.shouldFlush()) {
      if (this.transcript.length === this.processed) this.resolveDrain();
      this.resolveIdle();
      return;
    }
    void this.runBatch();
  }

  /** Resolves when the agent is not running and nothing is due to be flushed. */
  idle(): Promise<void> {
    if (!this.agentBusy && !this.shouldFlush()) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private resolveIdle() {
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const r of w) r();
  }

  /** Resolves when every utterance received so far has been processed. */
  drained(): Promise<void> {
    if (!this.agentBusy && this.processed >= this.transcript.length) return Promise.resolve();
    return new Promise((r) => this.drainWaiters.push(r));
  }

  private resolveDrain() {
    const w = this.drainWaiters;
    this.drainWaiters = [];
    for (const r of w) r();
  }

  private async runBatch() {
    this.agentBusy = true;
    this.forceFlush = false;
    const fresh = this.transcript.slice(this.processed);
    const upTo = this.transcript.length;
    this.changed();
    try {
      const result = await this.agent.step({
        state: this.state,
        transcript: this.transcript.slice(0, upTo),
        fresh,
        nextSeq: this.events.length + 1,
        meetingTime: fresh.at(-1)!.t,
      });
      this.state = result.state;
      this.events.push(...result.events);
      this.usage = mergeUsage(this.usage, result.usage);
      this.processed = upTo;
      this.addLog(
        "batch",
        `${fresh[0]!.ts}–${fresh.at(-1)!.ts}: ${result.events.length} change(s). ${result.note}`.trim(),
      );
      for (const e of result.errors) this.addLog("error", e);
      this.persist(result.events);
      this.failures = 0;
    } catch (err) {
      // Leave the lines unprocessed so they are retried with the next batch;
      // after repeated failures skip them rather than stall the meeting.
      this.failures++;
      this.addLog("error", `agent call failed (${this.failures}x): ${(err as Error).message}`);
      if (this.failures >= 3) {
        this.addLog("error", `skipping ${fresh.length} line(s) after repeated failures`);
        this.processed = upTo;
        this.failures = 0;
      } else {
        await new Promise((r) => setTimeout(r, 2000 * this.failures));
      }
    } finally {
      this.agentBusy = false;
      this.changed();
      this.schedule();
    }
  }

  private async runReview() {
    this.agentBusy = true;
    this.changed();
    try {
      const result = await this.agent.step({
        state: this.state,
        transcript: this.transcript,
        fresh: [],
        nextSeq: this.events.length + 1,
        meetingTime: this.transcript.at(-1)!.t,
        mode: "review",
      });
      this.state = result.state;
      this.events.push(...result.events);
      this.usage = mergeUsage(this.usage, result.usage);
      this.addLog("batch", `End-of-meeting review: ${result.events.length} change(s). ${result.note}`.trim());
      for (const e of result.errors) this.addLog("error", e);
      this.persist(result.events);
    } catch (err) {
      this.addLog("error", `review failed: ${(err as Error).message}`);
    } finally {
      this.agentBusy = false;
      this.changed();
    }
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
    this.persist([r.event]);
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
      meetingTime: formatTs(this.meetingTime()),
      transcript: this.transcript,
      processedCount: this.processed,
      state: this.state,
      events: this.events,
      markdown: this.markdown(),
      mermaid: toMermaid(this.state),
      mermaidDraft: toMermaid(this.state, { includeProposed: true }),
      usage: this.usage,
      model: this.agent.config.model,
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
 * Headless run for the CLI and evals: feed a transcript through the batcher
 * using meeting time only (no wall-clock waits), then flush.
 */
export async function runHeadless(
  utterances: Utterance[],
  opts: SessionOptions & { onBatch?: (s: MeetingSession) => void } = {},
): Promise<MeetingSession> {
  const s = new MeetingSession(opts);
  // Drive the clock manually: status stays "idle" so meetingTime() == clockBase.
  const internal = s as unknown as { clockBase: number };
  for (const u of utterances) {
    internal.clockBase = u.t;
    s.addUtterance({ speaker: u.speaker, text: u.text, t: u.t });
    await s.idle();
    opts.onBatch?.(s);
  }
  await s.finish();
  return s;
}
