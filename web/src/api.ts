import type { OpName } from "../../src/core/ops";
import type { Snapshot } from "../../src/session";

export type { Snapshot };

export interface TranscriptInfo {
  name: string;
  utterances: number;
}

export interface UiOp {
  name: OpName;
  input: Record<string, unknown>;
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  transcripts: () => request<TranscriptInfo[]>("/api/transcripts"),
  current: () => request<{ id: string | null }>("/api/current"),
  create: (body: { transcript?: string; content?: string; speed?: number; live?: boolean }) =>
    request<{ id: string }>("/api/session", { method: "POST", json: body }),
  control: (id: string, body: { action?: "pause" | "resume" | "finish" | "flush"; speed?: number }) =>
    request<{ ok: true }>(`/api/session/${encodeURIComponent(id)}/control`, { method: "POST", json: body }),
  say: (id: string, speaker: string, text: string) =>
    request<{ ok: true }>(`/api/session/${encodeURIComponent(id)}/utterance`, {
      method: "POST",
      json: { speaker, text },
    }),
  edit: (id: string, op: UiOp) =>
    request<{ ok: true }>(`/api/session/${encodeURIComponent(id)}/edit`, { method: "POST", json: { op } }),
  docUrl: (id: string) => `/api/session/${encodeURIComponent(id)}/doc.md`,
  eventsUrl: (id: string) => `/api/session/${encodeURIComponent(id)}/events`,
};
