/**
 * Grounding check: an agent operation must quote something that was actually said.
 * This is a cheap, deterministic guard against the model inventing content.
 */
import type { Utterance } from "./types.js";
import { parseTs } from "./types.js";

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'%$.\s]/g, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t.length > 0);
}

/** Fraction of quote tokens found in the utterance (multiset-aware). */
export function tokenCoverage(quote: string, text: string): number {
  const q = tokens(quote);
  if (q.length === 0) return 0;
  const bag = new Map<string, number>();
  for (const t of tokens(text)) bag.set(t, (bag.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of q) {
    const n = bag.get(t) ?? 0;
    if (n > 0) {
      hit++;
      bag.set(t, n - 1);
    }
  }
  return hit / q.length;
}

export function quoteMatches(quote: string, text: string): boolean {
  const nq = normalize(quote);
  const nt = normalize(text);
  if (nq.length === 0) return false;
  if (nt.includes(nq)) return true;
  // Tolerate small paraphrase / punctuation / elision differences.
  return tokenCoverage(quote, text) >= 0.8;
}

export interface GroundingResult {
  ok: boolean;
  utterance?: Utterance;
  error?: string;
}

/**
 * Find the utterance the agent is pointing at. Prefer the exact timestamp, then
 * the closest utterances within +/-90s (models sometimes cite a neighbour), then
 * anywhere in the transcript so far.
 */
export function ground(ts: string, quote: string, transcript: Utterance[]): GroundingResult {
  const t = parseTs(ts);
  const candidates = [...transcript];
  if (!Number.isNaN(t)) {
    candidates.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t));
  }
  for (const u of candidates) {
    if (!Number.isNaN(t) && Math.abs(u.t - t) > 90) break;
    if (quoteMatches(quote, u.text)) return { ok: true, utterance: u };
  }
  for (const u of transcript) {
    if (quoteMatches(quote, u.text)) return { ok: true, utterance: u };
  }
  return {
    ok: false,
    error: `quote "${quote}" was not found in the transcript near ${ts}. Quote the speaker's actual words.`,
  };
}
