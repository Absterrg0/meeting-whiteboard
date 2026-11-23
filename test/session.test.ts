import { describe, expect, it } from "vitest";
import type { ScribeAgent, StepInput, StepResult } from "../src/agent/agent.js";
import { emptyUsage } from "../src/agent/agent.js";
import type { Utterance } from "../src/core/types.js";
import { runHeadless } from "../src/session.js";
import { utt } from "./helpers.js";

/** Records every step() call and returns the state unchanged. */
class FakeAgent {
  config = { model: "fake", effort: "low" as const, maxRounds: 1, contextLines: 0 };
  /** Batch calls (mode "batch"). */
  calls: { fresh: number[]; transcriptLen: number }[] = [];
  /** End-of-meeting review calls: transcript length seen. */
  reviews: number[] = [];
  constructor(private onStep?: (input: StepInput) => Partial<StepResult>) {}
  async step(input: StepInput): Promise<StepResult> {
    if (input.mode === "review") {
      this.reviews.push(input.transcript.length);
      return { applied: 0, errors: [], note: "review", usage: emptyUsage() };
    }
    this.calls.push({
      fresh: input.fresh.map((u) => u.idx),
      transcriptLen: input.transcript.length,
    });
    await Promise.resolve();
    return { applied: 0, errors: [], note: "fake", usage: { ...emptyUsage(), calls: 1, costUsd: 0.01 }, ...this.onStep?.(input) };
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

  it("applies agent operations to the live state with increasing sequence numbers", async () => {
    const fake = new FakeAgent((input) => {
      const u = input.fresh.at(-1)!;
      const r = input.apply({
        name: "record_item",
        input: { id: `fact-line-${u.idx}`, kind: "fact", title: `Line ${u.idx}`, detail: u.text, status: "accepted", ts: u.ts, quote: u.text },
      });
      if (!r.ok) throw new Error(r.error);
      return { applied: 1 };
    });
    const s = await runHeadless(meeting(8), { agent: asAgent(fake), batch: { minLines: 4, maxWaitSec: 1000, cueFlush: false } });
    expect(Object.keys(s.state.items)).toEqual(["fact-line-3", "fact-line-7"]);
    expect(s.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(s.markdown()).toContain("point number 7");
  });

  it("keeps a human edit made while the agent is thinking", async () => {
    let session: import("../src/session.js").MeetingSession | null = null;
    const fake = new FakeAgent((input) => {
      // A human adds an item mid-step; the agent's later operation must not erase it.
      session!.humanEdit({
        name: "record_item",
        input: { id: "dec-human", kind: "decision", title: "Human decision", detail: "Set in the UI.", status: "accepted", ts: "00:00:00", quote: "edited in UI" },
      });
      const u = input.fresh.at(-1)!;
      input.apply({
        name: "record_item",
        input: { id: `fact-line-${u.idx}`, kind: "fact", title: `Line ${u.idx}`, detail: u.text, status: "accepted", ts: u.ts, quote: u.text },
      });
      return { applied: 1 };
    });
    const { MeetingSession } = await import("../src/session.js");
    session = new MeetingSession({ agent: asAgent(fake), reviewOnFinish: false, batch: { minLines: 1, maxWaitSec: 1000, cueFlush: false } });
    session.addUtterance({ speaker: "Ana", text: "point number zero here", t: 0 });
    await session.finish();
    expect(Object.keys(session.state.items).sort()).toEqual(["dec-human", "fact-line-0"]);
    expect(session.events.map((e) => e.seq)).toEqual([1, 2]);
  });
});
