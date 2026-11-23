import { describe, expect, it } from "vitest";
import type { ScribeAgent, StepInput, StepResult } from "../src/agent/agent.js";
import { emptyUsage } from "../src/agent/agent.js";
import { applyOp } from "../src/core/reducer.js";
import type { Utterance } from "../src/core/types.js";
import { runHeadless } from "../src/session.js";
import { utt } from "./helpers.js";

/** Records every step() call and returns the state unchanged. */
class FakeAgent {
  config = { model: "fake", effort: "low" as const, maxRounds: 1, contextLines: 0 };
  /** Batch calls (mode "batch"). */
  calls: { fresh: number[]; transcriptLen: number; nextSeq: number; meetingTime: number }[] = [];
  /** End-of-meeting review calls: transcript length seen. */
  reviews: number[] = [];
  constructor(private onStep?: (input: StepInput) => Partial<StepResult>) {}
  async step(input: StepInput): Promise<StepResult> {
    if (input.mode === "review") {
      this.reviews.push(input.transcript.length);
      return { state: input.state, events: [], errors: [], note: "review", usage: emptyUsage() };
    }
    this.calls.push({
      fresh: input.fresh.map((u) => u.idx),
      transcriptLen: input.transcript.length,
      nextSeq: input.nextSeq,
      meetingTime: input.meetingTime,
    });
    await Promise.resolve();
    return { state: input.state, events: [], errors: [], note: "fake", usage: { ...emptyUsage(), calls: 1, costUsd: 0.01 }, ...this.onStep?.(input) };
  }
}

function meeting(n: number, gap = 10, text = (i: number) => `point number ${i}`): Utterance[] {
  return Array.from({ length: n }, (_, i) => utt(i * gap, i % 2 ? "Ben" : "Ana", text(i), i));
}

function asAgent(f: FakeAgent): ScribeAgent {
  return f as unknown as ScribeAgent;
}

describe("runHeadless batching", () => {
  it("processes every utterance exactly once, in order, and flushes the tail at the end", async () => {
    const fake = new FakeAgent();
    const lines = meeting(23);
    const s = await runHeadless(lines, { agent: asAgent(fake), batch: { minLines: 4, maxWaitSec: 1000, cueFlush: false } });
    const seen = fake.calls.flatMap((c) => c.fresh);
    expect(seen).toEqual(lines.map((u) => u.idx));
    // 5 full batches of 4, then the remaining 3 flushed by finish().
    expect(fake.calls.map((c) => c.fresh.length)).toEqual([4, 4, 4, 4, 4, 3]);
    // Each call sees the transcript up to the end of its batch, never beyond.
    for (const c of fake.calls) expect(c.transcriptLen).toBe(c.fresh.at(-1)! + 1);
    expect(s.status).toBe("done");
    expect(s.snapshot().processedCount).toBe(23);
    // One end-of-meeting review over the whole transcript, after the last batch.
    expect(fake.reviews).toEqual([23]);
    expect(s.usage.calls).toBe(6);
    expect(s.usage.costUsd).toBeCloseTo(0.06);
  });

  it("flushes a short meeting below minLines once, at the end", async () => {
    const fake = new FakeAgent();
    await runHeadless(meeting(2), { agent: asAgent(fake), batch: { minLines: 4, maxWaitSec: 1000, cueFlush: false } });
    expect(fake.calls.map((c) => c.fresh)).toEqual([[0, 1]]);
  });

  it("flushes on meeting-time max wait and on cue phrases", async () => {
    const slow = new FakeAgent();
    // 60s apart with a 45s max wait. Headless, the clock only advances when a line
    // arrives, so a waiting line is flushed together with the next one.
    await runHeadless(meeting(4, 60), { agent: asAgent(slow), batch: { minLines: 10, maxWaitSec: 45, cueFlush: false } });
    expect(slow.calls.map((c) => c.fresh)).toEqual([[0, 1], [2, 3]]);

    const cue = new FakeAgent();
    const lines = meeting(6, 5, (i) => (i === 1 ? "OK, we're going with Postgres." : `point ${i}`));
    await runHeadless(lines, { agent: asAgent(cue), batch: { minLines: 10, maxWaitSec: 1000, cueFlush: true } });
    expect(cue.calls.map((c) => c.fresh)).toEqual([[0, 1], [2, 3, 4, 5]]);
  });

  it("does nothing for an empty transcript", async () => {
    const fake = new FakeAgent();
    const s = await runHeadless([], { agent: asAgent(fake) });
    expect(fake.calls).toHaveLength(0);
    expect(fake.reviews).toHaveLength(0);
    expect(s.status).toBe("done");
  });

  it("skips the review pass when reviewOnFinish is false", async () => {
    const fake = new FakeAgent();
    await runHeadless(meeting(5), { agent: asAgent(fake), reviewOnFinish: false, batch: { minLines: 4, maxWaitSec: 1000, cueFlush: false } });
    expect(fake.calls.map((c) => c.fresh.length)).toEqual([4, 1]);
    expect(fake.reviews).toHaveLength(0);
  });

  it("threads state and event sequence numbers through batches", async () => {
    const fake = new FakeAgent((input) => {
      const u = input.fresh.at(-1)!;
      const r = applyOp(
        input.state,
        { name: "record_item", input: { id: `fact-line-${u.idx}`, kind: "fact", title: `Line ${u.idx}`, detail: u.text, status: "accepted", ts: u.ts, quote: u.text } },
        { source: "agent", transcript: input.transcript, meetingTime: input.meetingTime, seq: input.nextSeq },
      );
      if (!r.ok) throw new Error(r.error);
      return { state: r.state, events: [r.event] };
    });
    const s = await runHeadless(meeting(8), { agent: asAgent(fake), batch: { minLines: 4, maxWaitSec: 1000, cueFlush: false } });
    expect(Object.keys(s.state.items)).toEqual(["fact-line-3", "fact-line-7"]);
    expect(s.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(fake.calls.map((c) => c.nextSeq)).toEqual([1, 2]);
    expect(s.markdown()).toContain("point number 7");
  });
});
