import type { Op, OpName, OpInput } from "../src/core/ops.js";
import { applyOp, type ApplyContext } from "../src/core/reducer.js";
import { emptyState, formatTs, type ChangeEvent, type DocState, type Utterance } from "../src/core/types.js";

export function utt(t: number, speaker: string, text: string, idx: number): Utterance {
  return { t, ts: formatTs(t), speaker, text, idx };
}

/** A small meeting used across reducer and render tests. */
export const TRANSCRIPT: Utterance[] = [
  utt(10, "Ana", "Did everyone have a good weekend?", 0),
  utt(30, "Ben", "What if we used Redis for the session cache?", 1),
  utt(60, "Cara", "Redis works for me, we already run it.", 2),
  utt(90, "Ana", "OK, we're going with Redis. Sessions expire after 7 days.", 3),
  utt(200, "Ben", "Customers asked for longer sessions, can we make it 14 days?", 4),
  utt(215, "Ana", "Fine, 14 days.", 5),
  utt(300, "Cara", "Actually, let's drop Redis and keep sessions in Postgres instead, one less system.", 6),
  utt(330, "Ana", "Agreed, Postgres for sessions.", 7),
  utt(400, "Ben", "Which region do we deploy to first? Not deciding that today.", 8),
  utt(500, "Cara", "I'll write the migration plan by Friday.", 9),
];

/** Applies ops in order as the agent (or human), throwing on the first failure. */
export class Harness {
  state: DocState = emptyState();
  events: ChangeEvent[] = [];
  constructor(public transcript: Utterance[] = TRANSCRIPT) {}

  ctx(source: "agent" | "human" = "agent", meetingTime = 600): ApplyContext {
    return { source, transcript: this.transcript, meetingTime, seq: this.events.length + 1, now: () => "2026-01-01T00:00:00Z" };
  }

  try<N extends OpName>(name: N, input: OpInput<N>, source: "agent" | "human" = "agent", meetingTime = 600) {
    return applyOp(this.state, { name, input } as Op, this.ctx(source, meetingTime));
  }

  apply<N extends OpName>(name: N, input: OpInput<N>, source: "agent" | "human" = "agent", meetingTime = 600): this {
    const r = this.try(name, input, source, meetingTime);
    if (!r.ok) throw new Error(`${name} failed: ${r.error}`);
    this.state = r.state;
    this.events.push(r.event);
    return this;
  }
}

export function decision(id: string, status: OpInput<"record_item">["status"], ts: string, quote: string, extra: Partial<OpInput<"record_item">> = {}): OpInput<"record_item"> {
  return { id, kind: "decision", title: id.replace(/^dec-/, "").replace(/-/g, " "), detail: `Detail of ${id}.`, status, ts, quote, ...extra };
}
