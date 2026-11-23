import type { OpName } from "../../src/core/ops";
import type { LiveDelta, LiveSnapshot, SavedSessionInfo } from "../../src/wire";

export type { LiveDelta, LiveSnapshot, SavedSessionInfo };

export interface TranscriptInfo {
  name: string;
  utterances: number;
}

export interface ParseInfo {
  format: string;
  formatLabel: string;
  utterances: number;
  timing: "given" | "partial" | "synthetic";
  warnings: string[];
  preview: { ts: string; speaker: string; text: string }[];
  speakers: string[];
}

export interface LiveConfig {
  openai: boolean;
  transcribeModel: string;
  recall: boolean;
  recallRegion: string;
  recallSignature: boolean;
  publicUrl: string | null;
  cloudflared: boolean;
}

export interface BotView {
  id: string;
  sessionId: string;
  meetingUrl: string;
  botName: string;
  createdAt: string;
  utterances: number;
  participants: string[];
  lastEventAt: string | null;
  left: boolean;
  status: { code: string; label: string; subCode: string | null; message: string | null } | null;
  error: string | null;
}

export interface UiOp {
  name: OpName;
  input: Record<string, unknown>;
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  // Only JSON bodies (the server refuses other POSTs); DELETE has no body.
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
  create: (body: { transcript?: string; content?: string; speed?: number; live?: boolean; title?: string }) =>
    request<{ id: string; parse: ParseInfo | null }>("/api/session", { method: "POST", json: body }),
  parse: (content: string) => request<ParseInfo>("/api/transcript/parse", { method: "POST", json: { content } }),
  liveConfig: () => request<LiveConfig>("/api/live/config"),
  createBot: (body: { meeting_url: string; bot_name?: string; session_id?: string }) =>
    request<{ bot: BotView; sessionId: string }>("/api/bot", { method: "POST", json: body }),
  bot: (id: string) => request<BotView>(`/api/bot/${encodeURIComponent(id)}`),
  bots: () => request<BotView[]>("/api/bots"),
  leaveBot: (id: string) => request<BotView>(`/api/bot/${encodeURIComponent(id)}`, { method: "DELETE" }),
  control: (id: string, body: { action?: "pause" | "resume" | "finish" | "flush"; speed?: number }) =>
    request<{ ok: true }>(`/api/session/${encodeURIComponent(id)}/control`, { method: "POST", json: body }),
  say: (id: string, speaker: string, text: string) =>
    request<{ ok: true }>(`/api/session/${encodeURIComponent(id)}/utterance`, {
      method: "POST",
      json: { speaker, text },
    }),
  edit: (id: string, op: UiOp) =>
    request<{ ok: true }>(`/api/session/${encodeURIComponent(id)}/edit`, { method: "POST", json: { op } }),
  undo: (id: string, seq: number) =>
    request<{ ok: true; undone: string[] }>(`/api/session/${encodeURIComponent(id)}/undo`, { method: "POST", json: { seq } }),
  saved: () => request<SavedSessionInfo[]>("/api/saved"),
  openSaved: (name: string) => request<{ id: string }>("/api/saved/open", { method: "POST", json: { name } }),
  docUrl: (id: string) => `/api/session/${encodeURIComponent(id)}/doc.md`,
  eventsUrl: (id: string) => `/api/session/${encodeURIComponent(id)}/events`,
};
