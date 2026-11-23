import { ArrowRight, Check, ChevronRight, FileUp, Keyboard, Mic, MonitorSpeaker, Radio, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type BotView, type LiveConfig, type ParseInfo, type SavedSessionInfo, type TranscriptInfo } from "./api";
import { LiveCapture, type LiveMode } from "./audio";
import { plural, prettyName } from "./format";
import { BotForm } from "./live";

type Mode = "replay" | "live" | "bot";
const PASTE = "__paste__";
const SPEEDS = [1, 5, 10, 30];
const FILE_TYPES = ".vtt,.srt,.txt,.md,.json,.jsonl,text/vtt,text/plain,application/json";
const LIVE_KEY = "mwb.liveMode";

const LIVE_OPTIONS: { value: LiveMode; label: string; note: string; icon: typeof Mic }[] = [
  { value: "mic", label: "Microphone", note: "An in-room meeting, through this computer’s mic", icon: Mic },
  { value: "tab", label: "Meeting tab", note: "Share a Meet, Zoom or Teams browser tab with its audio", icon: MonitorSpeaker },
  { value: "tab+mic", label: "Meeting tab + my mic", note: "Others from the tab, you from the mic (use headphones)", icon: Users },
  { value: "type", label: "Type lines", note: "An empty meeting; type what people say", icon: Keyboard },
];

function load<T extends string>(key: string, ok: readonly T[], dflt: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && ok.includes(v) ? v : dflt;
  } catch {
    return dflt;
  }
}
function store(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

export interface StartProps {
  current: { id: string; title: string; live: boolean } | null;
  onReturn: () => void;
  onStarted: (id: string, opts?: { capture?: LiveCapture; bot?: BotView }) => void;
}

export function StartScreen({ current, onReturn, onStarted }: StartProps) {
  const [mode, setMode] = useState<Mode>(() => load("mwb.startMode", ["replay", "live", "bot"] as const, "replay"));
  const [transcripts, setTranscripts] = useState<TranscriptInfo[] | null>(null);
  const [source, setSource] = useState<string>("");
  const [speed, setSpeed] = useState(() => Number(load("mwb.speed", ["1", "5", "10", "30"] as const, "10")));
  const [pasted, setPasted] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [parse, setParse] = useState<ParseInfo | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState<LiveMode>(() => load(LIVE_KEY, ["mic", "tab", "tab+mic", "type"] as const, "mic"));
  const [config, setConfig] = useState<LiveConfig | null>(null);
  const [saved, setSaved] = useState<SavedSessionInfo[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .transcripts()
      .then((list) => {
        setTranscripts(list);
        setSource((s) => s || list.find((t) => /webhooks/.test(t.name))?.name || list[0]?.name || PASTE);
      })
      .catch((e: Error) => setError(e.message));
    api.liveConfig().then(setConfig).catch(() => undefined);
    api.saved().then(setSaved).catch(() => undefined);
  }, []);

  // Detect the format of pasted / uploaded content as it changes.
  useEffect(() => {
    setParse(null);
    setParseError(null);
    if (!pasted.trim()) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .parse(pasted)
        .then((info) => !cancelled && setParse(info))
        .catch((e: Error) => !cancelled && setParseError(e.message));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pasted]);

  const choose = (m: Mode) => {
    setMode(m);
    setError(null);
    store("mwb.startMode", m);
  };

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 20_000_000) return fail(new Error(`${f.name} is too large (${Math.round(f.size / 1e6)} MB); transcripts are text files.`));
    setFileName(f.name);
    setPasted(await f.text());
    setSource(PASTE);
    if (fileInput.current) fileInput.current.value = "";
  };

  const startReplay = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = source === PASTE ? { content: pasted, speed, title: fileName ? prettyName(fileName) : undefined } : { transcript: source, speed };
      const { id } = await api.create(body);
      onStarted(id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  /** Audio is requested first, inside the click (browsers require a gesture). */
  const goLive = async () => {
    setError(null);
    if (liveMode !== "type" && config && !config.openai) {
      fail(new Error("Live audio needs OPENAI_API_KEY in the server’s .env (the key stays on the server)."));
      return;
    }
    setBusy(true);
    let cap: LiveCapture | null = null;
    try {
      if (liveMode !== "type") {
        let micLabel = "";
        try {
          micLabel = localStorage.getItem("mwb.speaker") ?? "";
        } catch {
          /* storage unavailable */
        }
        cap = await LiveCapture.acquire(liveMode, micLabel);
      }
      const { id } = await api.create({ live: true, title: "Live meeting" });
      if (cap) await cap.start(id);
      onStarted(id, cap ? { capture: cap } : undefined);
    } catch (e) {
      if (cap) void cap.stop();
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const openSaved = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.openSaved(name);
      onStarted(id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const scrollIntoList = (el: HTMLButtonElement | null) => {
    const list = el?.parentElement;
    if (el && list && (el.offsetTop < list.scrollTop || el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight)) {
      list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
    }
  };

  const canReplay = source === PASTE ? !!pasted.trim() && !!parse && !parseError : !!source;

  return (
    <div className="start">
      <div className="start-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          Meeting Whiteboard
        </div>
        <h1 className="start-title">Start a session</h1>
        <p className="start-lede">An agent listens to your design meeting and keeps the doc and the architecture diagram current, even when the team changes its mind.</p>

        {current && (
          <button className="resume" onClick={onReturn}>
            <span className={`resume-dot${current.live ? " live" : ""}`} />
            <span className="resume-text">
              Back to <b>{current.title}</b>
            </span>
            <ArrowRight size={15} />
          </button>
        )}

        <div className="segmented" role="tablist" aria-label="Source">
          {(
            [
              ["replay", "Replay a transcript"],
              ["live", "Go live"],
              ["bot", "Join a meeting"],
            ] as const
          ).map(([m, label]) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => choose(m)}>
              {label}
            </button>
          ))}
        </div>

        <div className="start-panel">
          {mode === "replay" && (
            <>
              <div className="choices scroll" role="radiogroup" aria-label="Transcript">
                {transcripts === null && <div className="hint">Loading transcripts…</div>}
                {transcripts?.map((t) => (
                  <button
                    key={t.name}
                    ref={source === t.name ? scrollIntoList : undefined}
                    role="radio" aria-checked={source === t.name} className={`choice${source === t.name ? " on" : ""}`} onClick={() => setSource(t.name)}>
                    <span className="choice-check">{source === t.name && <Check size={12} strokeWidth={2.5} />}</span>
                    <span className="choice-label">{prettyName(t.name)}</span>
                    <span className="choice-meta">{plural(t.utterances, "line")}</span>
                  </button>
                ))}
                <button role="radio" aria-checked={source === PASTE} className={`choice${source === PASTE ? " on" : ""}`} onClick={() => setSource(PASTE)}>
                  <span className="choice-check">{source === PASTE && <Check size={12} strokeWidth={2.5} />}</span>
                  <span className="choice-label">Paste or upload a transcript</span>
                  <span className="choice-meta">VTT, SRT, Otter, Zoom, JSON…</span>
                </button>
              </div>

              {source === PASTE && (
                <div className="paste">
                  <textarea
                    className="field paste-area"
                    placeholder={"Paste a transcript, or drop a file here.\n\n[00:01:10] Priya: Let’s agree the queue first.\n[00:01:18] Marcus: SQS with a dead-letter queue?"}
                    value={pasted}
                    rows={6}
                    onChange={(e) => {
                      setPasted(e.target.value);
                      setFileName(null);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      const f = e.dataTransfer.files?.[0];
                      if (f) {
                        e.preventDefault();
                        void onFile(f);
                      }
                    }}
                  />
                  <div className="paste-bar">
                    <button className="btn ghost sm" onClick={() => fileInput.current?.click()}>
                      <FileUp size={14} /> Upload file
                    </button>
                    <input ref={fileInput} type="file" accept={FILE_TYPES} hidden onChange={(e) => void onFile(e.target.files?.[0])} />
                    {fileName && <span className="hint">{fileName}</span>}
                  </div>
                  {parseError ? (
                    <div className="parse bad" role="alert">
                      {parseError}
                    </div>
                  ) : parse ? (
                    <div className="parse ok">
                      <div className="parse-line">
                        <Check size={14} className="parse-ok" />
                        <span>
                          <b>{parse.formatLabel}</b> · {plural(parse.utterances, "line")} · {plural(parse.speakers.length, "speaker")}
                        </span>
                        {parse.timing !== "given" && (
                          <span className="tag" title="Times were estimated from utterance length (about 2.5 words per second)">
                            {parse.timing === "synthetic" ? "times estimated" : "some times estimated"}
                          </span>
                        )}
                      </div>
                      {parse.warnings
                        .filter((w) => !/estimated/.test(w))
                        .map((w) => (
                          <div key={w} className="hint">
                            {w}
                          </div>
                        ))}
                      {parse.preview.length > 0 && (
                        <ul className="parse-preview">
                          {parse.preview.map((u, i) => (
                            <li key={i}>
                              <time>{u.ts}</time>
                              <b>{u.speaker}</b>
                              <span>{u.text}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </div>
              )}

              <div className="start-actions">
                <div className="speed" role="radiogroup" aria-label="Replay speed">
                  <span className="speed-label">Speed</span>
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      role="radio"
                      aria-checked={speed === s}
                      className={speed === s ? "on" : ""}
                      onClick={() => {
                        setSpeed(s);
                        store("mwb.speed", String(s));
                      }}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
                <button className="btn primary" disabled={!canReplay || busy} onClick={() => void startReplay()}>
                  {busy ? "Starting…" : "Start replay"}
                </button>
              </div>
            </>
          )}

          {mode === "live" && (
            <>
              <div className="choices" role="radiogroup" aria-label="Audio source">
                {LIVE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    role="radio"
                    aria-checked={liveMode === o.value}
                    className={`choice tall${liveMode === o.value ? " on" : ""}`}
                    onClick={() => {
                      setLiveMode(o.value);
                      store(LIVE_KEY, o.value);
                    }}
                  >
                    <o.icon size={16} className="choice-icon" />
                    <span className="choice-text">
                      <span className="choice-label">{o.label}</span>
                      <span className="choice-note">{o.note}</span>
                    </span>
                    <span className="choice-check round">{liveMode === o.value && <Check size={12} strokeWidth={2.5} />}</span>
                  </button>
                ))}
              </div>
              {config && !config.openai && liveMode !== "type" && (
                <p className="hint warn">Live audio needs <code>OPENAI_API_KEY</code> in the server’s <code>.env</code>; the key stays on the server.</p>
              )}
              <div className="start-actions">
                <span className="hint">{config?.openai && liveMode !== "type" ? `Transcribed with ${config.transcribeModel}` : ""}</span>
                <button className="btn primary live" disabled={busy || (liveMode !== "type" && !!config && !config.openai)} onClick={() => void goLive()}>
                  <Radio size={14} /> {busy ? "Starting…" : "Go live"}
                </button>
              </div>
            </>
          )}

          {mode === "bot" && <BotForm config={config} onError={fail} onJoined={(bot, id) => onStarted(id, { bot })} />}

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>

        {saved.length > 0 && (
          <div className="saved">
            <button className="disclosure" aria-expanded={showSaved} onClick={() => setShowSaved((s) => !s)}>
              <ChevronRight size={14} className="disclosure-chev" />
              Open a past session
              <span className="section-count">{saved.length}</span>
            </button>
            {showSaved && (
              <ul className="saved-list">
                {saved.map((s) => (
                  <li key={s.name}>
                    <button className="saved-row" disabled={busy} onClick={() => void openSaved(s.name)}>
                      <span className="saved-title">{s.title}</span>
                      <span className="saved-meta">
                        {s.topics > 0 ? `${plural(s.topics, "topic")} · ` : ""}
                        {plural(s.items, "item")} · {new Date(s.modifiedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
