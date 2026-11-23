import { describe, expect, it } from "vitest";
import type { AgentRuntime, EditInput, StepInput, StepResult } from "../src/agent/index.js";
import { emptyUsage } from "../src/agent/index.js";
import type { Utterance } from "../src/core/types.js";
import { runHeadless } from "../src/session.js";
import { utt } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records every step() call; optionally takes `delayMs` of wall time per turn and has an editor. */
class FakeAgent {
  config = { model: "fake" };
  /** Batch calls (mode "batch"). */
  calls: { fresh: number[]; transcriptLen: number }[] = [];
  /** End-of-meeting review calls: transcript length seen. */
  reviews: number[] = [];
  edits = 0;
  edit?: (input: EditInput) => Promise<StepResult>;
  constructor(
    private onStep?: (input: StepInput) => Partial<StepResult>,
    private delayMs = 0,
    withEditor = false,
  ) {
    if (withEditor) {
      this.edit = async () => {
        this.edits++;
        return { applied: 0, errors: [], note: "edit", usage: emptyUsage() };
      };
    }
  }
  async step(input: StepInput): Promise<StepResult> {
    if (input.mode === "review") {
      this.reviews.push(input.transcript.length);
      return { applied: 0, errors: [], note: "review", usage: emptyUsage() };
    }
    this.calls.push({ fresh: input.fresh.map((u) => u.idx), transcriptLen: input.transcript.length });
    if (this.delayMs) await sleep(this.delayMs);
    else await Promise.resolve();
    return { applied: 0, errors: [], note: "fake", usage: { ...emptyUsage(), calls: 1, costUsd: 0.01 }, ...this.onStep?.(input) };
  }
}

function meeting(n: number, gap = 10, text = (i: number) => `point number ${i}`): Utterance[] {
  return Array.from({ length: n }, (_, i) => utt(i * gap, i % 2 ? "Ben" : "Ana", text(i), i));
}

function asAgent(f: FakeAgent): AgentRuntime {
  return f as unknown as AgentRuntime;
}

const recordLine = (input: StepInput) => {
  const u = input.fresh.at(-1)!;
  const r = input.apply({
    name: "record_item",
    input: { id: `fact-line-${u.idx}`, kind: "fact", title: `Line ${u.idx}`, detail: u.text, status: "accepted", ts: u.ts, quote: u.text },
  });
  if (!r.ok) throw new Error(r.error);
  return { applied: 1 };
};

describe("runHeadless (simulated live meeting)", () => {
  it("processes every utterance exactly once, in order, then reviews once", async () => {
    const fake = new FakeAgent();
    const lines = meeting(23);
    const s = await runHeadless(lines, { agent: asAgent(fake) });
    expect(fake.calls.flatMap((c) => c.fresh)).toEqual(lines.map((u) => u.idx));
    // A fast agent keeps up: one turn per line, each seeing the transcript up to that line.
    expect(fake.calls).toHaveLength(23);
    for (const c of fake.calls) expect(c.transcriptLen).toBe(c.fresh.at(-1)! + 1);
    expect(s.status).toBe("done");
    expect(s.snapshot().processedCount).toBe(23);
    expect(fake.reviews).toEqual([23]);
    expect(s.usage.calls).toBe(23);
    expect(s.metrics.lineLatency).toHaveLength(23);
    for (const l of s.metrics.lineLatency) expect(l).toBeLessThan(1);
  });

  it("hands lines spoken while the scribe is busy to its next turn", async () => {
    // Turns take ~40 ms of (simulated) meeting time; lines arrive every 10 ms.
    const fake = new FakeAgent(undefined, 40);
    const lines = Array.from({ length: 20 }, (_, i) => utt(i * 0.01, "Ana", `line ${i}`, i));
    const s = await runHeadless(lines, { agent: asAgent(fake) });
    expect(fake.calls.flatMap((c) => c.fresh)).toEqual(lines.map((u) => u.idx));
    expect(fake.calls.length).toBeLessThan(10);
    expect(Math.max(...fake.calls.map((c) => c.fresh.length))).toBeGreaterThan(1);
    expect(s.metrics.lineLatency).toHaveLength(20);
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
    await runHeadless(meeting(5), { agent: asAgent(fake), reviewOnFinish: false });
    expect(fake.calls).toHaveLength(5);
    expect(fake.reviews).toHaveLength(0);
  });

  it("runs the editor after architecture changes (debounced) and once at the end, not after other turns", async () => {
    const recordDecision = (input: StepInput) => {
      const u = input.fresh.at(-1)!;
      input.apply({
        name: "record_item",
        input: { id: `dec-line-${u.idx}`, kind: "decision", title: `Decision ${u.idx}`, detail: u.text, status: "accepted", ts: u.ts, quote: u.text },
      });
      return { applied: 1 };
    };
    // Lines 10 s apart: longer than the editor debounce, so it runs after each change.
    const changes = new FakeAgent(recordDecision, 0, true);
    await runHeadless(meeting(3), { agent: asAgent(changes) });
    expect(changes.edits).toBe(3 + 1);

    // Lines 1 s apart: changes are coalesced into fewer editor runs.
    const burst = new FakeAgent(recordDecision, 0, true);
    await runHeadless(meeting(6, 1), { agent: asAgent(burst) });
    expect(burst.edits).toBeLessThan(6);

    // Facts and action items never affect the diagram.
    const facts = new FakeAgent((input) => recordLine(input), 0, true);
    await runHeadless(meeting(3), { agent: asAgent(facts) });
    expect(facts.edits).toBe(1);

    const quiet = new FakeAgent(undefined, 0, true);
    await runHeadless(meeting(3), { agent: asAgent(quiet) });
    expect(quiet.edits).toBe(1); // final pass only
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
    const s = await runHeadless(meeting(3), { agent: asAgent(fake) });
    expect(Object.keys(s.state.items)).toEqual(["fact-line-0", "fact-line-1", "fact-line-2"]);
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.markdown()).toContain("point number 2");
  });

  it("tells the scribe about human edits on its next turn", async () => {
    let session: import("../src/session.js").MeetingSession | null = null;
    const seen: string[][] = [];
    const fake = new FakeAgent((input) => {
      seen.push(input.notices ?? []);
      if (input.fresh[0]!.idx === 0) {
        session!.humanEdit({
          name: "record_item",
          input: { id: "dec-human", kind: "decision", title: "Human decision", detail: "Set in the UI.", status: "accepted", ts: "00:00:00", quote: "edited in UI" },
        });
      }
      return {};
    });
    const { MeetingSession } = await import("../src/session.js");
    session = new MeetingSession({ agent: asAgent(fake), reviewOnFinish: false, manual: true });
    session.addUtterance({ speaker: "Ana", text: "first line", t: 0 });
    await session.runTurn();
    session.addUtterance({ speaker: "Ben", text: "second line", t: 5 });
    await session.runTurn();
    expect(seen[0]).toEqual([]);
    expect(seen[1]!.join(" ")).toMatch(/human edit.*Human decision/);
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
    session = new MeetingSession({ agent: asAgent(fake), reviewOnFinish: false });
    session.addUtterance({ speaker: "Ana", text: "point number zero here", t: 0 });
    await session.finish();
    expect(Object.keys(session.state.items).sort()).toEqual(["dec-human", "fact-line-0"]);
    expect(session.events.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe("consolidation", () => {
  it("runs a consolidation pass every few minutes of meeting time, beside the normal turns", async () => {
    const modes: string[] = [];
    const fake = new FakeAgent((input) => {
      modes.push(input.mode ?? "batch");
      return {};
    });
    const origStep = fake.step.bind(fake);
    fake.step = async (input: StepInput) => {
      if (input.mode === "consolidate") {
        modes.push("consolidate");
        return { applied: 0, errors: [], note: "", usage: emptyUsage() };
      }
      return origStep(input);
    };
    // 13 lines, 60 s apart: 12 minutes of meeting, so two consolidations (at ~5 and ~10 min).
    await runHeadless(meeting(13, 60), { agent: asAgent(fake), reviewOnFinish: false });
    expect(modes.filter((m) => m === "consolidate")).toHaveLength(2);
  });
});
