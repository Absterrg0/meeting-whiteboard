/**
 * The scribe: turns what is said into item operations (decisions, questions, actions...).
 *
 * It keeps ONE append-only conversation per meeting: the system prompt and tools, then
 * for each turn the new transcript lines and the tool calls the model made in reply.
 * Each turn therefore sends only the new lines; the rest of the conversation is served
 * from the prompt cache, which keeps latency and cost flat as the meeting goes on.
 * When the conversation grows past a budget it is restarted from a snapshot of the
 * current state (a checkpoint), so long meetings stay bounded.
 *
 * Tool calls are applied to the live session state as they stream in. The model only
 * gets a second round when one of its calls failed validation.
 */
import { performance } from "node:perf_hooks";
import { streamText, tool, type ModelMessage, type ToolSet } from "ai";
import { OPS } from "../core/ops.js";
import type { Op } from "../core/ops.js";
import type { DocState, Utterance } from "../core/types.js";
import {
  CACHE_BREAKPOINT,
  addUsage,
  emptyUsage,
  languageModel,
  parseModel,
  providerOptions,
  type Effort,
  type ModelRef,
  type Usage,
} from "./llm.js";
import { CONSOLIDATE_INSTRUCTIONS, REVIEW_INSTRUCTIONS, SCRIBE_PROMPT } from "./prompt.js";

/** Applies one operation to the live session state; returns its summary or the validation error. */
export type ApplyFn = (op: Op) => { ok: true; summary: string } | { ok: false; error: string };

export interface StepInput {
  /** State at the start of the step (used when the conversation starts or restarts). */
  state: DocState;
  /** Full transcript so far. */
  transcript: Utterance[];
  /** New lines to process now (a suffix of transcript). Empty for a review. */
  fresh: Utterance[];
  /**
   * "batch": process new lines. "consolidate": periodic consistency pass over the recent
   * part of the meeting. "review": end-of-meeting pass over the whole meeting.
   */
  mode?: "batch" | "consolidate" | "review";
  /** For "consolidate": how far back to look (meeting seconds). */
  windowSec?: number;
  /** Changes made outside this conversation since its last turn (human edits, review), one line each. */
  notices?: string[];
  apply: ApplyFn;
  signal?: AbortSignal;
}

export interface StepResult {
  applied: number;
  errors: string[];
  note: string;
  usage: Usage;
  /** Where the time went (ms from the start of the call). */
  timing?: { firstTokenMs: number | null; firstChangeMs: number | null; totalMs: number; rounds: number };
}

export interface ScribeConfig {
  model: string;
  effort: Effort;
  /** Model for consolidation/review passes (defaults to model). */
  reviewModel?: string;
  /** Effort for consolidation/review passes (defaults to effort). */
  reviewEffort?: Effort;
  /** Hot path without upfront thinking where the model supports it (Sonnet 5.5 between_tools). */
  fastThinking?: boolean;
  /** Max model rounds per turn (1 + correction rounds after validation errors). */
  maxSteps: number;
  /** Restart the conversation from a state snapshot after this many turns... */
  checkpointTurns: number;
  /** ...or when a request's input grows past this many tokens. */
  checkpointTokens: number;
  /** Transcript lines carried into a restarted conversation for context. */
  contextLines: number;
}

const SCRIBE_TOOLS = ["set_meeting_info", "upsert_topic", "record_item", "update_item", "supersede_item", "confirm_item"] as const;

const TOOL_DESCRIPTIONS: Record<(typeof SCRIBE_TOOLS)[number], string> = {
  set_meeting_info: "Set the design doc's title and a one-sentence context (what is being designed and why).",
  upsert_topic: "Create a topic (one question the meeting works on) or rename it. Items are filed under topics.",
  confirm_item: "Mark a low-confidence item as confirmed, when later discussion makes it clear.",
  record_item:
    "Create an item: requirement, non_goal, fact, decision (including proposals and turned-down options), open_question or action_item.",
  update_item:
    "Change an existing item: status (accept, reject, resolve, drop, mark tentative), detail (revised values, narrowed scope), title, owner or due. Always give the reason.",
  supersede_item:
    "Replace a topic's current answer: the old item becomes superseded and the replacement (recorded first, usually as proposed) becomes the live answer. Use when the team reverses or replaces an earlier choice.",
};

function line(u: Utterance): string {
  return `[${u.ts}] ${u.speaker}: ${u.text}`;
}

function itemLine(i: DocState["items"][string]): string {
  const extra = [
    i.owner ? `owner=${i.owner}` : "",
    i.due ? `due=${i.due}` : "",
    i.supersededBy ? `superseded_by=${i.supersededBy}` : "",
    i.reason ? `rationale=${i.reason}` : "",
    i.confidence === "low" ? "LOW-CONFIDENCE" : "",
    i.pinned ? "HUMAN-EDITED" : "",
    `since=${i.evidence[0]?.ts ?? "?"}`,
  ]
    .filter(Boolean)
    .join(", ");
  return `  - ${i.id} | ${i.kind} | ${i.status} | ${i.title} — ${i.detail} (${extra})`;
}

/** Compact, model-readable view of topics and items (the scribe does not see the diagram). */
export function describeItems(state: DocState): string {
  const out: string[] = [];
  out.push(`Title: ${state.meeting.title || "(not set)"}`);
  if (state.meeting.context) out.push(`Context: ${state.meeting.context}`);
  const items = state.order.items.map((id) => state.items[id]!);
  out.push("TOPICS (id — title: question), with their items (id | kind | status | title — detail):");
  if (state.order.topics.length === 0) out.push("(none yet)");
  for (const tid of state.order.topics) {
    const t = state.topics[tid]!;
    out.push(`- ${t.id} — ${t.title}: ${t.question}`);
    for (const i of items.filter((x) => x.topic === tid)) out.push(itemLine(i));
  }
  const loose = items.filter((i) => !i.topic || !state.topics[i.topic]);
  out.push("MEETING-WIDE ITEMS (no topic):");
  if (loose.length === 0) out.push("(none)");
  for (const i of loose) out.push(itemLine(i));
  return out.join("\n");
}

export class Scribe {
  readonly ref: ModelRef;
  readonly reviewRef: ModelRef;
  private history: ModelMessage[] = [];
  private turnsSinceCheckpoint = 0;
  private lastInputTokens = 0;
  private tools: ToolSet | null = null;
  private currentApply: ApplyFn | null = null;
  private stepErrors: string[] = [];

  constructor(public config: ScribeConfig) {
    this.ref = parseModel(config.model);
    this.reviewRef = parseModel(config.reviewModel ?? config.model);
  }

  /** Tool set is built once so its definitions (and the cached prefix) never change. */
  private toolSet(): ToolSet {
    if (this.tools) return this.tools;
    const tools: ToolSet = {};
    for (const name of SCRIBE_TOOLS) {
      tools[name] = tool({
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: OPS[name],
        execute: async (input: unknown) => {
          const apply = this.currentApply;
          if (!apply) throw new Error("no active turn");
          const r = apply({ name, input } as Op);
          if (!r.ok) {
            this.stepErrors.push(`${name}: ${r.error}`);
            throw new Error(r.error);
          }
          return `ok: ${r.summary}`;
        },
      });
    }
    this.tools = tools;
    return tools;
  }

  private needsCheckpoint(): boolean {
    return (
      this.history.length === 0 ||
      this.turnsSinceCheckpoint >= this.config.checkpointTurns ||
      this.lastInputTokens >= this.config.checkpointTokens
    );
  }

  /** Forget the conversation; the next turn restarts from a state snapshot. */
  reset() {
    this.history = [];
    this.turnsSinceCheckpoint = 0;
    this.lastInputTokens = 0;
  }

  async step(input: StepInput): Promise<StepResult> {
    if (input.mode === "review" || input.mode === "consolidate") return this.review(input);

    const restart = this.needsCheckpoint();
    if (restart) this.reset();
    let text: string;
    const notices = input.notices?.length
      ? `<changes_outside_this_conversation>\n${input.notices.join("\n")}\n</changes_outside_this_conversation>\n\n`
      : "";
    if (restart) {
      const firstFresh = input.fresh[0]?.idx ?? input.transcript.length;
      const context = input.transcript.filter((u) => u.idx < firstFresh).slice(-this.config.contextLines);
      text = notices + [
        "<doc_state>",
        describeItems(input.state),
        "</doc_state>",
        "",
        '<earlier_transcript note="already recorded; context only">',
        context.length ? context.map(line).join("\n") : "(start of meeting)",
        "</earlier_transcript>",
        "",
        "<new_transcript>",
        input.fresh.map(line).join("\n"),
        "</new_transcript>",
      ].join("\n");
    } else {
      text = `${notices}<new_transcript>\n${input.fresh.map(line).join("\n")}\n</new_transcript>`;
    }

    let result: Awaited<ReturnType<Scribe["run"]>>;
    try {
      result = await this.run(this.history, text, input);
    } catch (err) {
      // Some calls may have been applied before the failure; restart from a fresh
      // snapshot next time so the conversation and the state cannot disagree.
      this.reset();
      throw err;
    }
    this.history.push({ role: "user", content: text }, ...result.messages);
    this.turnsSinceCheckpoint++;
    return result.step;
  }

  /**
   * Review passes run as separate one-off conversations (the main conversation stays
   * append-only): "review" over the whole meeting at the end, "consolidate" over the
   * last few minutes while the meeting is going.
   */
  private async review(input: StepInput): Promise<StepResult> {
    const consolidate = input.mode === "consolidate";
    const end = input.transcript.at(-1)?.t ?? 0;
    const lines = consolidate ? input.transcript.filter((u) => u.t >= end - (input.windowSec ?? 480)) : input.transcript;
    const notices = input.notices?.length ? ["<notices>", ...input.notices, "</notices>", ""] : [];
    const text = [
      ...notices,
      "<doc_state>",
      describeItems(input.state),
      "</doc_state>",
      "",
      consolidate ? "<recent_transcript>" : "<full_transcript>",
      lines.map(line).join("\n"),
      consolidate ? "</recent_transcript>" : "</full_transcript>",
      "",
      consolidate ? CONSOLIDATE_INSTRUCTIONS : REVIEW_INSTRUCTIONS,
    ].join("\n");
    const keepTokens = this.lastInputTokens;
    const result = await this.run([], text, input);
    // A one-off pass must not make the main conversation think it has grown.
    this.lastInputTokens = keepTokens;
    return result.step;
  }

  private async run(
    history: ModelMessage[],
    text: string,
    input: StepInput,
  ): Promise<{ step: StepResult; messages: ModelMessage[] }> {
    const usage = emptyUsage();
    const errors: string[] = [];
    let applied = 0;
    this.stepErrors = [];
    const t0 = performance.now();
    let firstTokenMs: number | null = null;
    let firstChangeMs: number | null = null;
    this.currentApply = (op) => {
      const r = input.apply(op);
      if (r.ok) {
        applied++;
        firstChangeMs ??= performance.now() - t0;
      }
      return r;
    };

    // Sent exactly as it will be stored: the history must stay byte-identical (append-only)
    // for the cache and for the model's earlier thinking blocks to stay valid.
    const messages: ModelMessage[] = [...history, { role: "user", content: text }];

    try {
      const review = input.mode === "review" || input.mode === "consolidate";
      const ref = review ? this.reviewRef : this.ref;
      const res = streamText({
        model: languageModel(ref),
        instructions: { role: "system", content: SCRIBE_PROMPT, providerOptions: CACHE_BREAKPOINT },
        messages,
        tools: this.toolSet(),
        providerOptions: review
          ? providerOptions(ref, this.config.reviewEffort ?? this.config.effort)
          : providerOptions(ref, this.config.effort, { fastThinking: this.config.fastThinking }),
        maxOutputTokens: 16000,
        abortSignal: input.signal,
        // Only go back to the model when a call failed validation, so it can fix it.
        stopWhen: ({ steps }) => {
          const last = steps.at(-1);
          const failed = last?.content.some((p) => p.type === "tool-error") ?? false;
          return !failed || steps.length >= this.config.maxSteps;
        },
      });
      for await (const part of res.fullStream) {
        if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error));
        if (firstTokenMs === null && ["text-delta", "reasoning-delta", "tool-input-start", "tool-call"].includes(part.type)) {
          firstTokenMs = performance.now() - t0;
        }
      }
      // responseMessages = every step's assistant and tool messages (not just the last step),
      // so the conversation keeps the calls that succeeded before a correction round.
      const [steps, responseMessages, text2] = await Promise.all([res.steps, res.responseMessages, res.text]);
      for (const s of steps) addUsage(usage, s.usage, ref);
      this.lastInputTokens = steps.at(-1)?.usage.inputTokens ?? 0;
      const last = steps.at(-1);
      if (last?.content.some((p) => p.type === "tool-error") && steps.length >= this.config.maxSteps) {
        errors.push(`stopped after ${steps.length} rounds with unresolved errors`);
      }
      errors.unshift(...this.stepErrors);
      return {
        step: {
          applied,
          errors,
          note: text2.trim(),
          usage,
          timing: { firstTokenMs, firstChangeMs, totalMs: performance.now() - t0, rounds: steps.length },
        },
        messages: responseMessages,
      };
    } finally {
      this.currentApply = null;
    }
  }
}
