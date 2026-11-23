/**
 * The fast decision layer ("System 1" in front of the scribe).
 *
 * One decision-model call (TypeSafe AI's Jev, or another provider's decision model via the
 * AI SDK's experimental_decide) per batch of new lines, typically well under a second:
 *
 *  1. Gate: "do these lines change the design record?" When confidently no, the scribe
 *     (the LLM) is not called; the lines stay pending and go to the scribe with the next
 *     lines that matter, so nothing is lost and chatter costs almost nothing.
 *  2. Status flips: one question per open proposal, "accepted / turned down / neither".
 *     A confident answer is applied at once through the reducer (same validation and
 *     grounding as any change), so "Agreed." shows in the doc in under a second. The scribe
 *     still runs afterwards and writes details and reasons; it is told what was applied.
 *
 * Everything the layer does goes through the same reducer as the scribe, so a wrong flip
 * is still bounded by the invariants (one live answer per topic, grounding, pinning).
 */
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { openai } from "@ai-sdk/openai";
import { experimental_decide, type Experimental_DecisionModel } from "ai";
import type { Op } from "../core/ops.js";
import type { DocState, Item, Utterance } from "../core/types.js";
import { emptyUsage, type Usage } from "./llm.js";

export interface DeciderConfig {
  /** "typesafe-ai/jev-latest", "openai/gpt-6-luna", ... */
  model: string;
  /** Skip the scribe when P(the lines change the record) is below this. */
  gateBelow: number;
  /** Apply an accept/reject immediately when its probability is at least this. */
  flipAtLeast: number;
  /** At most this many open proposals are asked about (most recent first). */
  maxProposals: number;
}

export function deciderFromEnv(): DeciderConfig | null {
  const model = process.env.DECISION_MODEL;
  if (!model || model === "off") return null;
  return {
    model,
    gateBelow: Number(process.env.DECISION_GATE ?? 0.1),
    flipAtLeast: Number(process.env.DECISION_FLIP ?? 0.85),
    maxProposals: 8,
  };
}

function decisionModel(spec: string): Experimental_DecisionModel {
  const [provider, ...rest] = spec.split("/");
  const id = rest.join("/");
  if (provider === "typesafe-ai") return typeSafeAi.decisionModel(id as never);
  if (provider === "openai") return openai.decisionModel(id as never) as unknown as Experimental_DecisionModel;
  throw new Error(`unknown decision model provider '${provider}' (use typesafe-ai/... or openai/...)`);
}

/** $ per million input tokens (output is free on Jev). */
const DECISION_PRICES: Record<string, number> = {
  "typesafe-ai/jev-latest": 0.042,
  "openai/gpt-6-luna": 0.1,
};

export interface Triage {
  /** P(the new lines change the design record). */
  changes: number;
  /** Status flips the layer is confident about, ready to apply. */
  flips: { item: Item; to: "accepted" | "tentative" | "rejected"; p: number; op: Op }[];
  usage: Usage;
  ms: number;
}

function line(u: Utterance): string {
  return `[${u.ts}] ${u.speaker}: ${u.text}`;
}

export class Decider {
  private model: Experimental_DecisionModel;
  constructor(public config: DeciderConfig) {
    this.model = decisionModel(config.model);
  }

  async triage(state: DocState, transcript: Utterance[], fresh: Utterance[], signal?: AbortSignal): Promise<Triage> {
    const t0 = Date.now();
    const proposals = Object.values(state.items)
      .filter((i) => i.kind === "decision" && i.status === "proposed")
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, this.config.maxProposals);
    const live = Object.values(state.items)
      .filter((i) => i.kind === "decision" && ["accepted", "tentative"].includes(i.status))
      .map((i) => `${state.topics[i.topic ?? ""]?.title ?? "—"}: ${i.title}`);
    const firstFresh = fresh[0]?.idx ?? transcript.length;
    const context = transcript.filter((u) => u.idx < firstFresh).slice(-6);

    // Context the way the model reads best: what is decided, what is on the table, what
    // was just said before, and the new lines to judge.
    const stateForModel = {
      decided: live,
      on_the_table: proposals.map((p) => `${p.title}: ${p.detail}`),
      earlier_lines: context.map(line),
      new_lines: fresh.map(line),
    };
    const questions: Record<string, Parameters<typeof experimental_decide>[0]["questions"][string]> = {
      changes: {
        type: "boolean",
        instructions:
          "Do the NEW lines change the design record? Yes if they propose, agree to, turn down, revise or replace a design choice; raise, defer or answer an open question; commit someone to an action; or state a requirement, constraint or number. No for small talk, acknowledgements that settle nothing, scheduling chatter, or repeating what is already recorded.",
      },
    };
    proposals.forEach((p, n) => {
      questions[`p${n}`] = {
        type: "choice",
        instructions: `Do the NEW lines settle this proposal: "${p.title}"? Only count explicit agreement or an explicit turn-down by the group; a single person's opinion, a question or a hypothetical settles nothing.`,
        criteria: {
          accepted: `The group explicitly agrees to it, or says they are going with it, with no condition ("${p.title}").`,
          tentative: "The group agrees to it only for now, for v1, until something is checked, or says it will revisit it.",
          rejected: `The group explicitly turns it down or rules it out.`,
          neither: "Not settled by these lines.",
        },
      };
    });

    const res = await experimental_decide({ model: this.model, state: stateForModel, questions, abortSignal: signal });
    const usage = emptyUsage();
    const u = (res as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
    usage.inputTokens = u?.inputTokens ?? 0;
    usage.outputTokens = u?.outputTokens ?? 0;
    usage.calls = 1;
    usage.costUsd = (usage.inputTokens * (DECISION_PRICES[this.config.model] ?? 0)) / 1e6;

    const answers = res.answers as Record<string, { type: string; probability?: number; choice?: string; probabilities?: Record<string, number> }>;
    const changes = answers.changes?.probability ?? 1;
    // The quote for a fast-path change is the newest line: it is what tipped the decision.
    const anchor = fresh.at(-1)!;
    const flips: Triage["flips"] = [];
    proposals.forEach((p, n) => {
      const a = answers[`p${n}`];
      if (!a || a.choice === "neither" || !a.choice) return;
      const prob = a.probabilities?.[a.choice] ?? 0;
      if (prob < this.config.flipAtLeast) return;
      const to = a.choice === "accepted" ? "accepted" : a.choice === "tentative" ? "tentative" : "rejected";
      flips.push({
        item: p,
        to,
        p: prob,
        op: {
          name: "update_item",
          input: {
            id: p.id,
            status: to,
            reason: to === "rejected" ? "turned down in the meeting (fast path)" : to === "tentative" ? "agreed for now (fast path)" : "agreed in the meeting (fast path)",
            ts: anchor.ts,
            quote: anchor.text,
          },
        } as Op,
      });
    });
    return { changes, flips, usage, ms: Date.now() - t0 };
  }
}
