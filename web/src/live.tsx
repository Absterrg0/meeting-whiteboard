/** Live-audio and meeting-bot pieces (capture status, "speaking now" chips, the bot panel). */
import { Mic, MonitorSpeaker, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { api, type BotView, type LiveConfig } from "./api";
import type { CaptureState, LiveCapture } from "./audio";

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

export function useCapture(capture: LiveCapture | null): CaptureState {
  return useSyncExternalStore(capture?.subscribe ?? noop, capture?.getState ?? (() => EMPTY));
}

/** One line per audio source: icon, level meter, state; and a stop button. */
export function CaptureStatus({ capture }: { capture: LiveCapture }) {
  const state = useCapture(capture);
  const listening = state.sources.some((s) => s.status === "listening" || s.status === "connecting");
  return (
    <div className="capture">
      {state.sources.map((s) => {
        const Icon = s.source === "meeting" ? MonitorSpeaker : Mic;
        return (
          <div key={s.source} className={`capture-row st-${s.status}`} title={s.model ? `Transcribing with ${s.model}` : undefined}>
            <Icon size={13} className="capture-icon" />
            <span className="capture-name">
              {s.source === "meeting" ? "Meeting tab" : "Microphone"}
              {s.source === "mic" && s.label !== "Mic" ? ` · ${s.label}` : ""}
            </span>
            <span className="meter" aria-hidden>
              <span style={{ transform: `scaleX(${Math.max(0.02, s.level)})` }} />
            </span>
            <span className="capture-state">
              {s.status === "connecting" ? "Connecting" : s.status === "listening" ? "Listening" : s.status === "stopped" ? "Stopped" : "Error"}
            </span>
            {s.error && <span className="capture-error">{s.error}</span>}
          </div>
        );
      })}
      {listening && (
        <button className="btn ghost sm capture-stop" onClick={() => void capture.stop()}>
          Stop audio
        </button>
      )}
    </div>
  );
}

/** "Speaking now" chips. Realtime transcription has no diarization, so the user says who is talking. */
export function SpeakerChips({ capture, state, seen }: { capture: LiveCapture; state: CaptureState; seen: string[] }) {
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
      <span className="chips-label">Speaking</span>
      <button className={`chip${state.speaker === null ? " active" : ""}`} onClick={() => capture.setSpeaker(null)} title="Label by source (key 0)">
        {auto}
      </button>
      {all.map((n, i) => (
        <span key={n} className={`chip${state.speaker === n ? " active" : ""}`}>
          <button className="chip-name" onClick={() => capture.setSpeaker(n)} title={i < 9 ? `Key ${i + 1}` : undefined}>
            {n}
          </button>
          {names.includes(n) && (
            <button className="chip-x" onClick={() => remove(n)} aria-label={`Remove ${n}`}>
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      {adding ? (
        <form onSubmit={add} className="chip-add">
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Name" onBlur={() => !draft && setAdding(false)} />
        </form>
      ) : (
        <button className="chip ghost" onClick={() => setAdding(true)} aria-label="Add a name">
          <Plus size={12} />
        </button>
      )}
    </div>
  );
}

/** Status of a meeting bot that is in (or left) a call; polls while it is in the call. */
export function BotStatus({ bot, onBot, onError }: { bot: BotView; onBot: (b: BotView | null) => void; onError: (e: unknown) => void }) {
  const done = bot.left || ["done", "fatal", "call_ended"].includes(bot.status?.code ?? "");
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => {
      api.bot(bot.id).then(onBot).catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [bot.id, done]); // eslint-disable-line react-hooks/exhaustive-deps
  const code = bot.status?.code ?? "created";
  const tone = code === "in_call_recording" ? "listening" : code === "fatal" || code.includes("denied") ? "error" : done ? "stopped" : "connecting";
  return (
    <div className="capture">
      <div className={`capture-row st-${tone}`}>
        <MonitorSpeaker size={13} className="capture-icon" />
        <span className="capture-name">{bot.botName}</span>
        <span className="capture-state">{bot.left ? "Left the call" : (bot.status?.label ?? "Joining")}</span>
      </div>
      <div className="capture-sub">
        {bot.utterances} line{bot.utterances === 1 ? "" : "s"}
        {bot.participants.length > 0 && ` · ${bot.participants.join(", ")}`}
        {bot.error && <span className="capture-error"> · {bot.error}</span>}
      </div>
      {!done && (
        <button
          className="btn ghost sm capture-stop"
          onClick={() =>
            api
              .leaveBot(bot.id)
              .then(onBot)
              .catch(onError)
          }
        >
          Remove bot
        </button>
      )}
    </div>
  );
}

/** The "Join a meeting" form on the start screen. */
export function BotForm({ config, onJoined, onError }: { config: LiveConfig | null; onJoined: (bot: BotView, sessionId: string) => void; onError: (e: unknown) => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("Meeting Whiteboard");
  const [busy, setBusy] = useState(false);
  if (!config) return <p className="hint">Checking configuration…</p>;
  if (!config.recall) {
    return (
      <div className="notice">
        <p className="notice-title">Meeting bot not set up</p>
        <p>
          Add <code>RECALL_API_KEY</code> (and <code>RECALL_REGION</code>, e.g. <code>us-west-2</code>) to <code>.env</code> and restart the server. A bot then
          joins Google Meet, Zoom or Teams and streams named speakers.
        </p>
        <p className="hint">Until then, “Go live → Meeting tab” transcribes a call from this browser.</p>
      </div>
    );
  }
  const join = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.createBot({ meeting_url: url.trim(), bot_name: name.trim() || undefined });
      onJoined(r.bot, r.sessionId);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={(e) => void join(e)}>
      <label className="field-label">
        Meeting link
        <input
          className="field"
          type="url"
          required
          placeholder="https://meet.google.com/abc-defg-hij"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="field-label">
        Bot name
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </label>
      {!config.publicUrl && (
        <p className="hint">{config.cloudflared ? "A cloudflared tunnel starts automatically so the bot can reach this server." : "Needs PUBLIC_URL (e.g. a cloudflared tunnel) so the bot can reach this server."}</p>
      )}
      <div className="start-actions">
        <button className="btn primary" disabled={busy || !url.trim()}>
          {busy ? "Sending bot…" : "Send bot"}
        </button>
      </div>
    </form>
  );
}
