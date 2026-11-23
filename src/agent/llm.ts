/**
 * Model access through the Vercel AI SDK, so the agent runs on Anthropic or OpenAI.
 *
 * A model is named "<provider>/<model-id>", e.g. "anthropic/claude-sonnet-5-5" or
 * "openai/gpt-6-luna". A bare id is mapped by prefix (claude-* -> anthropic, gpt-*|o* -> openai).
 */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

type JSONValue = string | number | boolean | null | JSONValue[] | { [k: string]: JSONValue };
type ProviderOptions = Record<string, Record<string, JSONValue>>;

export type Provider = "anthropic" | "openai";
export type Effort = "low" | "medium" | "high";

export interface ModelRef {
  spec: string;
  provider: Provider;
  id: string;
}

export function parseModel(spec: string): ModelRef {
  const s = spec.trim();
  const slash = s.indexOf("/");
  if (slash > 0) {
    const provider = s.slice(0, slash);
    if (provider !== "anthropic" && provider !== "openai") {
      throw new Error(`unknown provider '${provider}' in model '${spec}' (use anthropic/... or openai/...)`);
    }
    return { spec: s, provider, id: s.slice(slash + 1) };
  }
  if (s.startsWith("claude")) return { spec: `anthropic/${s}`, provider: "anthropic", id: s };
  if (/^(gpt|o\d|chatgpt)/.test(s)) return { spec: `openai/${s}`, provider: "openai", id: s };
  throw new Error(`cannot tell the provider of model '${spec}'; write it as anthropic/<id> or openai/<id>`);
}

export function languageModel(ref: ModelRef): LanguageModel {
  return ref.provider === "anthropic" ? anthropic(ref.id) : openai(ref.id);
}

export function hasKey(ref: ModelRef): boolean {
  return ref.provider === "anthropic" ? !!process.env.ANTHROPIC_API_KEY : !!process.env.OPENAI_API_KEY;
}

/**
 * Provider options for a call.
 * Anthropic: adaptive thinking at the given effort, and top-level automatic prompt caching
 * (the cache breakpoint moves to the end of each request by itself, so no per-message
 * markers are needed and the stored conversation stays byte-identical to what was sent;
 * thinking blocks are bound to that exact prefix). `drop_block` is only a safety net:
 * if a prefix ever differs, stale thinking is dropped instead of failing the request.
 * OpenAI: reasoning effort; prefix caching is automatic.
 */
export function providerOptions(ref: ModelRef, effort: Effort): ProviderOptions {
  if (ref.provider === "anthropic") {
    return {
      anthropic: {
        effort,
        thinking: { type: "adaptive", blockBinding: { prefixMismatchBehavior: "drop_block" } },
        cacheControl: { type: "ephemeral" },
      },
    };
  }
  return { openai: { reasoningEffort: effort } };
}

/** Cache breakpoint for the (constant) system prompt on Anthropic; OpenAI caches prefixes automatically. */
export const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" as const } } };

// ---------- usage and cost ----------

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  costUsd: number;
  /** True when a model without a known price was used (cost is then a lower bound). */
  unpriced?: boolean;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, costUsd: 0 };
}

/**
 * $ per million tokens: [uncached input, output, cache read, cache write].
 * Anthropic list prices; OpenAI entries are list prices where known. Unknown models are flagged.
 */
const PRICES: Record<string, [number, number, number, number]> = {
  "anthropic/claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "anthropic/claude-opus-5-5": [4, 20, 0.2, 5],
  "anthropic/claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  // OpenAI standard tier (prompts under 272K tokens), as published at the GPT-6 launch.
  "openai/gpt-6-sol": [2, 10, 0.2, 2.5],
  "openai/gpt-6.1-sol": [2, 10, 0.1, 2.5],
  "openai/gpt-6-luna": [0.1, 0.5, 0.01, 0.125],
};

export function setPrice(spec: string, price: [number, number, number, number]) {
  PRICES[parseModel(spec).spec] = price;
}

interface SdkUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined; noCacheTokens?: number | undefined };
}

/** Adds one model call's usage (AI SDK shape) to a running total. */
export function addUsage(total: Usage, u: SdkUsage | undefined, ref: ModelRef, calls = 1) {
  if (!u) return;
  const inputAll = u.inputTokens ?? 0;
  const cr = u.inputTokenDetails?.cacheReadTokens ?? 0;
  const cw = u.inputTokenDetails?.cacheWriteTokens ?? 0;
  const uncached = u.inputTokenDetails?.noCacheTokens ?? Math.max(0, inputAll - cr - cw);
  const out = u.outputTokens ?? 0;
  total.inputTokens += uncached;
  total.cacheReadTokens += cr;
  total.cacheWriteTokens += cw;
  total.outputTokens += out;
  total.calls += calls;
  const p = PRICES[ref.spec];
  if (!p) {
    total.unpriced = true;
    return;
  }
  total.costUsd += (uncached * p[0] + out * p[1] + cr * p[2] + cw * p[3]) / 1e6;
}

export function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    calls: a.calls + b.calls,
    costUsd: a.costUsd + b.costUsd,
    ...(a.unpriced || b.unpriced ? { unpriced: true } : {}),
  };
}
