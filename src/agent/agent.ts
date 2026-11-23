/**
 * The agent step: given the current state and a batch of new utterances, ask the
 * model for operations, validate and apply them through the reducer, and feed
 * any validation errors back so the model can correct itself.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { OPS, isOpName, type OpName } from "../core/ops.js";
import { applyOp } from "../core/reducer.js";
import { componentVisibility, edgeVisibility } from "../core/render.js";
import type { ChangeEvent, DocState, Utterance } from "../core/types.js";
import { SYSTEM_PROMPT } from "./prompt.js";

export interface AgentConfig {
  model: string;
  effort: "low" | "medium" | "high";
  /** Max model round-trips per batch (first pass + error corrections). */
  maxRounds: number;
  /** Already-processed transcript lines to include as context. */
  contextLines: number;
}

export const DEFAULT_CONFIG: AgentConfig = {
  model: process.env.MODEL ?? "claude-sonnet-5-5",
  effort: (process.env.EFFORT as AgentConfig["effort"]) ?? "medium",
  maxRounds: 4,
  contextLines: 24,
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  costUsd: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, costUsd: 0 };
}

/** $ per million tokens: [input, output, cache read, cache write]. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

const TOOL_DESCRIPTIONS: Record<OpName, string> = {
  set_meeting_info: "Set the design doc's title and a 1-3 sentence context (what is being designed and why).",
  record_item:
    "Create a new item: requirement, non_goal, fact, decision (including proposals), open_question or action_item.",
  update_item:
    "Change an existing item: its status (accept, reject, resolve, drop, mark tentative), its detail (revised values, narrowed scope), owner or due. Always give the reason.",
  supersede_item:
    "Mark an existing item as replaced by another item (record the replacement first). Use when the team reverses or replaces an earlier choice.",
  upsert_component: "Add or update a component of the architecture diagram, with the item ids that justify it.",
  remove_component: "Take a component out of the design when the team removes it while its basis item is still live.",
  upsert_edge: "Add or update a directed connection between two components (data or call flow).",
  remove_edge: "Remove a connection that is no longer part of the design.",
};

function toolDefs(): Anthropic.Beta.BetaTool[] {
  const names = Object.keys(OPS) as OpName[];
  return names.map((name, i) => {
    const schema = z.toJSONSchema(OPS[name], { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    const tool: Anthropic.Beta.BetaTool = {
      name,
      description: TOOL_DESCRIPTIONS[name],
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
    };
    // Cache the stable prefix (tools + system) across batches.
    if (i === names.length - 1) tool.cache_control = { type: "ephemeral" };
    return tool;
  });
}

const TOOLS = toolDefs();

function line(u: Utterance): string {
  return `[${u.ts}] ${u.speaker}: ${u.text}`;
}

/** Compact, model-readable view of the current state. */
export function describeState(state: DocState): string {
  const out: string[] = [];
  out.push(`Title: ${state.meeting.title || "(not set)"}`);
  if (state.meeting.context) out.push(`Context: ${state.meeting.context}`);
  out.push("", "ITEMS (id | kind | status | title — detail):");
  if (state.order.items.length === 0) out.push("(none yet)");
  for (const id of state.order.items) {
    const i = state.items[id]!;
    const extra = [
      i.owner ? `owner=${i.owner}` : "",
      i.due ? `due=${i.due}` : "",
      i.supersededBy ? `superseded_by=${i.supersededBy}` : "",
      i.reason ? `reason=${i.reason}` : "",
      i.pinned ? "HUMAN-EDITED" : "",
      `since=${i.evidence[0]?.ts ?? "?"}`,
    ]
      .filter(Boolean)
      .join(", ");
    out.push(`- ${i.id} | ${i.kind} | ${i.status} | ${i.title} — ${i.detail} (${extra})`);
  }
  out.push("", "COMPONENTS (id | type | name | basis | shown as | description):");
  if (state.order.components.length === 0) out.push("(none yet)");
  for (const id of state.order.components) {
    const c = state.components[id]!;
    out.push(
      `- ${c.id} | ${c.type} | ${c.name} | basis=[${c.basis.join(", ")}] | ${componentVisibility(state, c)} | ${c.description}`,
    );
  }
  out.push("", "EDGES (from -> to | label | shown as):");
  if (state.order.edges.length === 0) out.push("(none yet)");
  for (const id of state.order.edges) {
    const e = state.edges[id]!;
    out.push(`- ${e.from} -> ${e.to} | ${e.label} | ${edgeVisibility(state, e)}`);
  }
  return out.join("\n");
}

export interface StepInput {
  state: DocState;
  /** Full transcript so far (processed + new). */
  transcript: Utterance[];
  /** The utterances to process now (a suffix of transcript). */
  fresh: Utterance[];
  nextSeq: number;
  meetingTime: number;
  /** "batch": process new lines. "review": end-of-meeting consistency pass over the whole state. */
  mode?: "batch" | "review";
}

export interface StepResult {
  state: DocState;
  events: ChangeEvent[];
  errors: string[];
  note: string;
  usage: Usage;
}

/**
 * End-of-meeting review: one pass over the full transcript and state to catch what
 * incremental processing can miss (a sketch the team adopted without saying so,
 * stale component descriptions, proposals that were overtaken, duplicates).
 * It uses the same operations and grounding checks as normal batches.
 */
function reviewPrompt(state: DocState, transcript: Utterance[]): string {
  return [
    "<doc_state>",
    describeState(state),
    "</doc_state>",
    "",
    "<full_transcript>",
    transcript.map(line).join("\n"),
    "</full_transcript>",
    "",
    "The meeting has ended. Review the doc state against the full transcript and fix only real problems:",
    "- proposals the team clearly adopted and built on (they went on to choose its parts or detail it) but that are still 'proposed': accept them, quoting where the team built on them;",
    "- proposals that were overtaken by a later decision but are still 'proposed': reject them with the reason;",
    "- details, titles or component descriptions that still describe an earlier version of a decision: rewrite them to the final version;",
    "- components or edges that no longer match the final design, or a component in the final design that is missing an edge it obviously needs from the discussion;",
    "- duplicate items that say the same thing.",
    "Do not add anything that was not discussed. Do not change items marked HUMAN-EDITED. If everything is consistent, make no calls.",
  ].join("\n");
}

export class ScribeAgent {
  private client: Anthropic;
  constructor(
    public config: AgentConfig = DEFAULT_CONFIG,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
  }

  async step(input: StepInput): Promise<StepResult> {
    let state = input.state;
    const events: ChangeEvent[] = [];
    const errors: string[] = [];
    const usage = emptyUsage();
    let seq = input.nextSeq;

    const firstFresh = input.fresh[0]?.idx ?? input.transcript.length;
    const context = input.transcript.filter((u) => u.idx < firstFresh).slice(-this.config.contextLines);

    const userText = input.mode === "review" ? reviewPrompt(state, input.transcript) : [
      "<doc_state>",
      describeState(state),
      "</doc_state>",
      "",
      "<earlier_transcript note=\"already processed; for context only\">",
      context.length ? context.map(line).join("\n") : "(start of meeting)",
      "</earlier_transcript>",
      "",
      "<new_transcript>",
      input.fresh.map(line).join("\n"),
      "</new_transcript>",
      "",
      "Update the doc state for the new transcript lines.",
    ].join("\n");

    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: userText }];
    let note = "";

    for (let round = 0; round < this.config.maxRounds; round++) {
      const res = await this.client.beta.messages.create({
        model: this.config.model,
        max_tokens: 16000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages,
        output_config: { effort: this.config.effort },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      addUsage(usage, res.usage, this.config.model);

      if (res.stop_reason === "refusal") {
        errors.push("model declined this batch");
        break;
      }

      const toolUses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      if (text) note = text;
      if (toolUses.length === 0) break;

      messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (!isOpName(tu.name)) {
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `unknown tool ${tu.name}` });
          continue;
        }
        const r = applyOp(state, { name: tu.name, input: tu.input as never }, {
          source: "agent",
          transcript: input.transcript,
          meetingTime: input.meetingTime,
          seq,
        });
        if (r.ok) {
          state = r.state;
          events.push(r.event);
          seq++;
          results.push({ type: "tool_result", tool_use_id: tu.id, content: `ok: ${r.event.summary}` });
        } else {
          errors.push(`${tu.name}: ${r.error}`);
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: r.error });
        }
      }
      messages.push({ role: "user", content: results });
      if (res.stop_reason !== "tool_use") break;
    }
    return { state, events, errors, note, usage };
  }
}

function addUsage(u: Usage, r: Anthropic.Beta.BetaUsage, model: string) {
  const input = r.input_tokens ?? 0;
  const output = r.output_tokens ?? 0;
  const cr = r.cache_read_input_tokens ?? 0;
  const cw = r.cache_creation_input_tokens ?? 0;
  u.inputTokens += input;
  u.outputTokens += output;
  u.cacheReadTokens += cr;
  u.cacheWriteTokens += cw;
  u.calls += 1;
  const p = PRICES[model] ?? PRICES["claude-sonnet-5-5"]!;
  u.costUsd += (input * p[0] + output * p[1] + cr * p[2] + cw * p[3]) / 1e6;
}

export function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    calls: a.calls + b.calls,
    costUsd: a.costUsd + b.costUsd,
  };
}
