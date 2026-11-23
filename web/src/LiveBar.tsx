import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { api, type BotView, type LiveConfig } from "./api";
import type { CaptureState, LiveCapture, SourceState } from "./audio";

const NAMES_KEY = "mwb.names";
const SOURCE_LABELS = new Set(["Mic", "Meeting", "Guest", "Unknown speaker"]);

function loadNames(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(NAMES_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function saveNames(names: string[]) {
  try {
    localStorage.setItem(NAMES_KEY, JSON.stringify(names));
  } catch {
    /* storage unavailable */
  }
}

const EMPTY: CaptureState = { sources: [], speaker: null, target: "mic" };
const noop = () => () => undefined;

function useCapture(capture: LiveCapture | null): CaptureState {
  return useSyncExternalStore(capture?.subscribe ?? noop, capture?.getState ?? (() => EMPTY));
}

function SourceStatus({ s }: { s: SourceState }) {
  const name = s.source === "meeting" ? "Meeting tab" : "Microphone";
  return (
    <span className={`live-source status-${s.status}`} title={s.model ? `Transcribing with ${s.model}` : undefined}>
      <span className="dot" />
      {name}
      {s.source === "mic" && s.label !== "Mic" ? ` (as ${s.label})` : ""}
      <span className="meter" aria-hidden>
        <span style={{ width: `${Math.round(s.level * 100)}%` }} />
      </span>
      <span className="muted small">
        {s.status === "connecting" ? "connecting…" : s.status === "listening" ? "listening" : s.status === "stopped" ? "stopped" : "error"}
      </span>
      {s.error && <span className="live-error">{s.error}</span>}
    </span>
  );
}

/** "Speaking now:" chips. Realtime transcription has no diarization, so the user says who is talking. */
function SpeakerChips({ capture, state, seen }: { capture: LiveCapture; state: CaptureState; seen: string[] }) {
  const [names, setNames] = useState<string[]>(loadNames);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const all = useMemo(() => {
    const out = [...names];
    for (const n of seen) if (!SOURCE_LABELS.has(n) && !out.includes(n)) out.push(n);
    return out.slice(0, 12);
  }, [names, seen]);
  const auto = state.target === "meeting" ? "Meeting" : "Mic";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "0") capture.setSpeaker(null);
      const i = Number(e.key);
      if (i >= 1 && i <= 9 && all[i - 1]) capture.setSpeaker(all[i - 1]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capture, all]);

  const add = (e: FormEvent) => {
    e.preventDefault();
    const n = draft.trim().slice(0, 60);
    if (n && !names.includes(n)) {
      const next = [...names, n];
      setNames(next);
      saveNames(next);
    }
    if (n) capture.setSpeaker(n);
    setDraft("");
    setAdding(false);
  };
  const remove = (n: string) => {
    const next = names.filter((x) => x !== n);
    setNames(next);
    saveNames(next);
    if (state.speaker === n) capture.setSpeaker(null);
  };

  return (
    <div className="chips" role="group" aria-label="Speaking now">
      <span className="chips-label">Speaking now:</span>
      <button className={`chip ${state.speaker === null ? "active" : ""}`} onClick={() => capture.setSpeaker(null)} title="Label by source (key 0)">
        {auto}
      </button>
      {all.map((n, i) => (
        <span key={n} className={`chip ${state.speaker === n ? "active" : ""}`}>
          <button className="chip-name" onClick={() => capture.setSpeaker(n)} title={i < 9 ? `Key ${i + 1}` : undefined}>
            {i < 9 && <kbd>{i + 1}</kbd>}
            {n}
          </button>
          {names.includes(n) && (
            <button className="chip-x" onClick={() => remove(n)} aria-label={`Remove ${n}`}>
              ×
            </button>
          )}
        </span>
      ))}
      {adding ? (
        <form onSubmit={add} className="chip-add">
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Name" onBlur={() => !draft && setAdding(false)} />
        </form>
      ) : (
        <button className="chip add" onClick={() => setAdding(true)}>
          + Add name
        </button>
      )}
    </div>
  );
}

function BotPanel({
  config,
  bot,
  onBot,
  onClose,
  sessionId,
  onSession,
  onError,
}: {
  config: LiveConfig | null;
  bot: BotView | null;
  onBot: (b: BotView | null) => void;
  onClose: () => void;
  sessionId: string | null;
  onSession: (id: string) => void;
  onError: (e: unknown) => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("Meeting Whiteboard");
  const [busy, setBusy] = useState(false);

  // Poll the bot's status while it is in the call.
  const done = !!bot && (bot.left || ["done", "fatal", "call_ended"].includes(bot.status?.code ?? ""));
  useEffect(() => {
    if (!bot || done) return;
    const t = setInterval(() => {
      api.bot(bot.id).then(onBot).catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [bot?.id, done]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!config) return <span className="muted small">Checking configuration…</span>;
  if (!config.recall) {
    return (
      <div className="bot-panel">
        <span className="badge warn-badge">Meeting bot not configured</span>
        <span className="small">
          Set <code>RECALL_API_KEY</code> (and <code>RECALL_REGION</code>, e.g. us-west-2) in <code>.env</code> and restart the server. Until
          then, use <b>Meeting tab audio</b> to transcribe a call from this browser.
        </span>
        <button className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  const join = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.createBot({ meeting_url: url.trim(), bot_name: name.trim() || undefined, session_id: sessionId ?? undefined });
      onBot(r.bot);
      onSession(r.sessionId);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!bot) return;
    try {
      onBot(await api.leaveBot(bot.id));
    } catch (err) {
      onError(err);
    }
  };

  if (bot) {
    const code = bot.status?.code ?? "created";
    const tone = code === "in_call_recording" ? "ok" : code === "fatal" || code.includes("denied") ? "bad" : done ? "" : "warn";
    return (
      <div className="bot-panel">
        <span className={`live-source status-${tone === "ok" ? "listening" : tone === "bad" ? "error" : done ? "stopped" : "connecting"}`}>
          <span className="dot" />
          Bot “{bot.botName}”
        </span>
        <span className="small">{bot.left ? "Left the call" : (bot.status?.label ?? "Created")}</span>
        {bot.status?.subCode && <span className="muted small">({bot.status.subCode})</span>}
        <span className="muted small">
          {bot.utterances} line{bot.utterances === 1 ? "" : "s"}
          {bot.participants.length > 0 && ` · ${bot.participants.join(", ")}`}
        </span>
        {bot.error && <span className="live-error">{bot.error}</span>}
        {!done ? (
          <button className="btn small danger" onClick={() => void leave()}>
            Remove bot
          </button>
        ) : (
          <button className="btn small" onClick={() => onBot(null)}>
            New bot
          </button>
        )}
      </div>
    );
  }

  return (
    <form className="bot-panel" onSubmit={(e) => void join(e)}>
      <span className="chips-label">Join a meeting:</span>
      <input
        className="bot-url"
        type="url"
        required
        placeholder="https://meet.google.com/… · zoom.us/j/… · teams.microsoft.com/…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-label="Meeting link"
      />
      <input className="bot-name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Bot name" maxLength={100} />
      <button className="btn primary small" disabled={busy || !url.trim()}>
        {busy ? "Sending bot…" : "Send bot"}
      </button>
      {!config.publicUrl && (
        <span className="muted small" title="Recall must reach this server to deliver the transcript">
          {config.cloudflared ? "A cloudflared tunnel starts automatically." : "Needs PUBLIC_URL (e.g. a cloudflared tunnel)."}
        </span>
      )}
      <button type="button" className="btn small link" onClick={onClose}>
        Cancel
      </button>
    </form>
  );
}

export interface LiveBarProps {
  capture: LiveCapture | null;
  onStopAudio: () => void;
  speakersSeen: string[];
  showBot: boolean;
  bot: BotView | null;
  onBot: (b: BotView | null) => void;
  onCloseBot: () => void;
  config: LiveConfig | null;
  sessionId: string | null;
  onSession: (id: string) => void;
  onError: (e: unknown) => void;
}

export function LiveBar(p: LiveBarProps) {
  const state = useCapture(p.capture);
  if (!p.capture && !p.showBot && !p.bot) return null;
  const partials = state.sources.filter((s) => s.partial);
  const listening = !!p.capture && state.sources.some((s) => s.status === "listening" || s.status === "connecting");
  return (
    <div className="livebar">
      {p.capture && (
        <div className="livebar-row">
          {state.sources.map((s) => (
            <SourceStatus key={s.source} s={s} />
          ))}
          {listening ? (
            <button className="btn small danger" onClick={p.onStopAudio}>
              Stop audio
            </button>
          ) : (
            <span className="muted small">Audio stopped.</span>
          )}
          {partials.length > 0 && (
            <span className="partial" aria-live="polite">
              {partials.map((s) => s.partial).join(" · ")}
              <span className="caret" />
            </span>
          )}
        </div>
      )}
      {p.capture && listening && <SpeakerChips capture={p.capture} state={state} seen={p.speakersSeen} />}
      {(p.showBot || p.bot) && (
        <div className="livebar-row">
          <BotPanel
            config={p.config}
            bot={p.bot}
            onBot={p.onBot}
            onClose={p.onCloseBot}
            sessionId={p.sessionId}
            onSession={p.onSession}
            onError={p.onError}
          />
        </div>
      )}
    </div>
  );
}
