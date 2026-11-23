import { useCallback, useEffect, useRef, useState } from "react";
import { formatTs, parseTs } from "../../src/core/types";
import { api, type BotView, type LiveConfig, type ParseInfo, type Snapshot, type TranscriptInfo, type UiOp } from "./api";
import { LiveCapture, type LiveMode } from "./audio";
import { Changelog } from "./Changelog";
import { Decisions } from "./Decisions";
import { DocView } from "./DocView";
import { LiveBar } from "./LiveBar";
import { MermaidView } from "./Mermaid";
import { Transcript } from "./Transcript";

const PASTE = "__paste__";
const SPEEDS = [1, 5, 10, 30];
type Tab = "diagram" | "decisions" | "changelog";
type LiveChoice = LiveMode | "bot";
const LIVE_CHOICES: { value: LiveChoice; label: string; title: string }[] = [
  { value: "type", label: "Type lines", title: "Start an empty meeting and type lines yourself" },
  { value: "mic", label: "Microphone", title: "Transcribe this computer's microphone (in-room meeting)" },
  { value: "tab", label: "Meeting tab audio", title: "Share a Google Meet / Zoom / Teams browser tab with its audio" },
  { value: "tab+mic", label: "Meeting tab + my mic", title: "Remote participants from the tab, you from the mic (use headphones)" },
  { value: "bot", label: "Bot joins a meeting", title: "A Recall.ai bot joins the call and streams named speakers" },
];
const LIVE_KEY = "mwb.liveMode";
const FILE_TYPES = ".vtt,.srt,.txt,.md,.json,.jsonl,text/vtt,text/plain,application/json";

function loadLiveChoice(): LiveChoice {
  try {
    const v = localStorage.getItem(LIVE_KEY);
    return LIVE_CHOICES.some((c) => c.value === v) ? (v as LiveChoice) : "type";
  } catch {
    return "type";
  }
}

/** Subscribe to a session's snapshot stream. */
function useSession(id: string | null) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    setSnap(null);
    if (!id) return;
    const es = new EventSource(api.eventsUrl(id));
    es.addEventListener("snapshot", (e) => {
      setSnap(JSON.parse((e as MessageEvent<string>).data) as Snapshot);
      setReceivedAt(Date.now());
      setConnected(true);
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [id]);
  return { snap, receivedAt, connected };
}

/** The meeting clock ticks between snapshots. */
function useClock(snap: Snapshot | null, receivedAt: number, speed: number): string {
  const [, tick] = useState(0);
  const running = snap?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [running]);
  if (!snap) return "00:00:00";
  if (!running) return snap.meetingTime;
  const base = parseTs(snap.meetingTime);
  return formatTs(base + ((Date.now() - receivedAt) / 1000) * speed);
}

export function App() {
  const [transcripts, setTranscripts] = useState<TranscriptInfo[]>([]);
  const [source, setSource] = useState("");
  const [pasted, setPasted] = useState("");
  const [speed, setSpeed] = useState(10);
  const [sessionSpeed, setSessionSpeed] = useState(1);
  const [isLive, setIsLive] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("diagram");
  const [showDraft, setShowDraft] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusTs, setFocusTs] = useState<{ ts: string; n: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [liveChoice, setLiveChoice] = useState<LiveChoice>(loadLiveChoice);
  const [capture, setCapture] = useState<LiveCapture | null>(null);
  const [showBot, setShowBot] = useState(false);
  const [bot, setBot] = useState<BotView | null>(null);
  const [liveConfig, setLiveConfig] = useState<LiveConfig | null>(null);
  const [parseInfo, setParseInfo] = useState<ParseInfo | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const { snap, receivedAt, connected } = useSession(sessionId);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);
  const clock = useClock(snap, receivedAt, snap?.speed ?? sessionSpeed);

  useEffect(() => {
    api
      .transcripts()
      .then((list) => {
        setTranscripts(list);
        setSource((s) => s || list[0]?.name || PASTE);
      })
      .catch((e: Error) => setError(e.message));
    api
      .current()
      .then(({ id }) => id && setSessionId((cur) => cur ?? id))
      .catch(() => undefined);
    api
      .liveConfig()
      .then(setLiveConfig)
      .catch(() => undefined);
    // Reattach to a bot that is still in a call after a reload.
    api
      .bots()
      .then((list) => {
        const active = list.filter((b) => !b.left).at(-1);
        if (active) setBot(active);
      })
      .catch(() => undefined);
  }, []);

  // Detect the format of pasted / uploaded content as it changes.
  useEffect(() => {
    if (!pasted.trim()) {
      setParseInfo(null);
      setParseError(null);
      return;
    }
    let cancelled = false;
    // Never show the previous content's result while the new one is being checked.
    setParseInfo(null);
    setParseError(null);
    const t = setTimeout(() => {
      api
        .parse(pasted)
        .then((info) => {
          if (cancelled) return;
          setParseInfo(info);
          setParseError(null);
        })
        .catch((e: Error) => {
          if (cancelled) return;
          setParseInfo(null);
          setParseError(e.message);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pasted]);

  // The meeting is over: stop sending audio.
  useEffect(() => {
    if (snap?.status === "done" && capture?.active) void capture.stop();
  }, [snap?.status, capture]);

  const stopAudio = useCallback(async () => {
    if (capture) await capture.stop();
  }, [capture]);

  const report = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  const start = async (live: boolean) => {
    setStarting(true);
    setError(null);
    await stopAudio();
    setCapture(null);
    try {
      const body = live
        ? { live: true }
        : source === PASTE
          ? { content: pasted, speed }
          : { transcript: source, speed };
      const { id } = await api.create(body);
      setIsLive(live);
      setSessionSpeed(live ? 1 : speed);
      setSessionId(id);
    } catch (e) {
      report(e);
    } finally {
      setStarting(false);
    }
  };

  const chooseLive = (c: LiveChoice) => {
    setLiveChoice(c);
    try {
      localStorage.setItem(LIVE_KEY, c);
    } catch {
      /* storage unavailable */
    }
  };

  /** Go live with the chosen source. Audio is requested first, inside the click (browsers require a gesture). */
  const goLive = async () => {
    setError(null);
    if (liveChoice === "type") return start(true);
    if (liveChoice === "bot") {
      setShowBot(true);
      if (!liveConfig) api.liveConfig().then(setLiveConfig).catch(report);
      return;
    }
    if (liveConfig && !liveConfig.openai) {
      setError("Live audio needs OPENAI_API_KEY in the server's .env (it stays on the server).");
      return;
    }
    setStarting(true);
    await stopAudio();
    let cap: LiveCapture | null = null;
    try {
      let micLabel = "";
      try {
        micLabel = localStorage.getItem("mwb.speaker") ?? "";
      } catch {
        /* storage unavailable */
      }
      cap = await LiveCapture.acquire(liveChoice, micLabel);
      const { id } = await api.create({ live: true, title: "Live meeting" });
      setIsLive(true);
      setSessionSpeed(1);
      setSessionId(id);
      setCapture(cap);
      await cap.start(id);
    } catch (e) {
      if (cap) void cap.stop();
      report(e);
    } finally {
      setStarting(false);
    }
  };

  const control = (action: "pause" | "resume" | "finish" | "flush") => {
    if (!sessionId) return;
    api.control(sessionId, { action }).catch(report);
  };

  const changeSpeed = (s: number) => {
    setSpeed(s);
    if (sessionId && !isLive && snap && (snap.status === "running" || snap.status === "paused")) {
      api
        .control(sessionId, { speed: s })
        .then(() => setSessionSpeed(s))
        .catch(report);
    }
  };

  const say = async (speaker: string, text: string) => {
    if (!sessionId) return false;
    try {
      await api.say(sessionId, speaker, text);
      return true;
    } catch (e) {
      report(e);
      return false;
    }
  };

  const edit = async (op: UiOp) => {
    if (!sessionId) return false;
    try {
      await api.edit(sessionId, op);
      return true;
    } catch (e) {
      report(e);
      return false;
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 20_000_000) {
      setError(`${f.name} is too large (${Math.round(f.size / 1e6)} MB); transcripts are text files.`);
      return;
    }
    setFileName(f.name);
    setPasted(await f.text());
    setSource(PASTE);
    if (fileInput.current) fileInput.current.value = "";
  };

  const status = snap?.status ?? "idle";
  const canStart = source === PASTE ? pasted.trim().length > 0 && !parseError : !!source;
  const liveTitle = LIVE_CHOICES.find((c) => c.value === liveChoice)?.title;
  const speakersSeen = snap ? [...new Set(snap.transcript.map((u) => u.speaker))] : [];
  const pending = snap ? snap.transcript.length - snap.processedCount : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ◧
          </span>
          Meeting Whiteboard
        </div>

        <div className="controls">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            aria-label="Transcript"
            className="transcript-select"
          >
            {transcripts.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.utterances} lines)
              </option>
            ))}
            <option value={PASTE}>Paste or upload…</option>
          </select>
          <select
            value={speed}
            onChange={(e) => changeSpeed(Number(e.target.value))}
            aria-label="Replay speed"
            disabled={isLive && status !== "done" && !!snap}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!canStart || starting} onClick={() => void start(false)}>
            {snap && status !== "done" ? "Restart" : "Start"}
          </button>
          {status === "running" && (
            <button className="btn" onClick={() => control("pause")}>
              Pause
            </button>
          )}
          {status === "paused" && (
            <button className="btn" onClick={() => control("resume")}>
              Resume
            </button>
          )}
          <button
            className="btn"
            disabled={!snap || status === "done" || status === "idle"}
            onClick={() => control("finish")}
            title="Stop the meeting and process everything that is left"
          >
            Finish
          </button>
          <span className="divider" />
          <select
            value={liveChoice}
            onChange={(e) => chooseLive(e.target.value as LiveChoice)}
            aria-label="Live source"
            title={liveTitle}
          >
            {LIVE_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <button className="btn live-btn" disabled={starting} onClick={() => void goLive()} title={liveTitle}>
            ● Go live
          </button>
        </div>

        <div className="status">
          <span className={`pill state-${status}`}>
            <span className="dot" />
            {status}
            {isLive && status !== "done" && snap ? " · live" : ""}
          </span>
          <span className="clock" title="Meeting time">
            {clock}
          </span>
          {snap?.agentBusy ? (
            <span className="thinking">
              <span className="spinner" /> agent thinking…
            </span>
          ) : pending > 0 ? (
            <span className="muted small">{pending} queued</span>
          ) : null}
          {snap && (
            <span className="meta" title="Model, running cost and number of model calls">
              {snap.model} · ${snap.usage.costUsd.toFixed(3)} · {snap.usage.calls} call{snap.usage.calls === 1 ? "" : "s"}
            </span>
          )}
          {sessionId && !connected && <span className="badge warn">reconnecting…</span>}
        </div>
      </header>

      {source === PASTE && (!snap || status === "done") && (
        <div className="paste">
          <div className="paste-main">
            <textarea
              placeholder={
                "Paste or drop a transcript: Zoom / Teams .vtt, .srt, Otter or Fireflies .txt, Google Meet transcript, Zoom chat, JSONL / JSON, \"[00:01:10] Name: text\" lines, a markdown table, or plain \"Name: text\" lines."
              }
              value={pasted}
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
              rows={4}
            />
            {parseError ? (
              <div className="parse-status bad" role="alert">
                {parseError}
              </div>
            ) : parseInfo ? (
              <div className="parse-status ok">
                ✓ {fileName ? `${fileName}: ` : ""}
                {parseInfo.formatLabel} · {parseInfo.utterances} utterance{parseInfo.utterances === 1 ? "" : "s"} ·{" "}
                {parseInfo.speakers.length} speaker{parseInfo.speakers.length === 1 ? "" : "s"}
                {parseInfo.timing !== "given" && (
                  <span className="badge tiny warn-badge" title="Times were estimated from utterance length (~2.5 words/s)">
                    {parseInfo.timing === "synthetic" ? "times estimated" : "some times estimated"}
                  </span>
                )}
                {parseInfo.warnings
                  .filter((w) => !/estimated/.test(w))
                  .map((w) => (
                    <span key={w} className="muted"> · {w}</span>
                  ))}
                {parseInfo.preview[0] && (
                  <span className="muted preview">
                    {" "}
                    — {parseInfo.preview[0].ts} {parseInfo.preview[0].speaker}: “{parseInfo.preview[0].text}”
                  </span>
                )}
              </div>
            ) : null}
          </div>
          <div className="paste-side">
            <button className="btn small" onClick={() => fileInput.current?.click()}>
              Upload file…
            </button>
            <input ref={fileInput} type="file" accept={FILE_TYPES} hidden onChange={(e) => void onFile(e.target.files?.[0])} />
            <span className="muted small">{pasted ? `${pasted.split(/\n/).filter(Boolean).length} lines` : ""}</span>
          </div>
        </div>
      )}

      <LiveBar
        capture={capture}
        onStopAudio={() => void stopAudio()}
        speakersSeen={speakersSeen}
        showBot={showBot}
        bot={bot}
        onBot={setBot}
        onCloseBot={() => setShowBot(false)}
        config={liveConfig}
        sessionId={snap && snap.status !== "done" && snap.mode === "live" ? sessionId : null}
        onSession={(id) => {
          setIsLive(true);
          setSessionSpeed(1);
          setSessionId(id);
        }}
        onError={report}
      />

      {error && (
        <div className="error-bar" role="alert">
          <span>{error}</span>
          <button className="btn link small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <main className="columns">
        <Transcript
          lines={snap?.transcript ?? []}
          processedCount={snap?.processedCount ?? 0}
          agentBusy={!!snap?.agentBusy}
          canInject={!!snap}
          focusTs={focusTs}
          onSay={say}
          onFlush={() => control("flush")}
        />

        <section className="panel doc-panel">
          <header className="panel-head">
            <h2>Design doc</h2>
            {sessionId && (
              <a className="btn small" href={api.docUrl(sessionId)} download>
                Download .md
              </a>
            )}
          </header>
          <div className="panel-body">
            {snap ? (
              <DocView key={sessionId} markdown={snap.markdown} />
            ) : (
              <div className="empty hero">
                <h3>Pick a transcript and press Start</h3>
                <p>
                  The agent listens to the meeting and keeps this design doc and the architecture diagram current,
                  including when the team changes its mind. Or press <b>Live</b> and type the meeting yourself.
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="panel side-panel">
          <header className="panel-head tabs" role="tablist">
            {(["diagram", "decisions", "changelog"] as Tab[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={`tab ${tab === t ? "active" : ""}`}
                onClick={() => setTab(t)}
              >
                {t === "diagram" ? "Diagram" : t === "decisions" ? "Decisions" : "Changelog"}
                {t === "decisions" && snap && <span className="count">{snap.state.order.items.length}</span>}
                {t === "changelog" && snap && <span className="count">{snap.events.length}</span>}
              </button>
            ))}
          </header>
          <div className="panel-body">
            {!snap && <div className="empty">No meeting yet.</div>}
            {snap && tab === "diagram" && (
              <div className="diagram-tab">
                <div className="diagram-bar">
                  <label className="toggle">
                    <input type="checkbox" checked={showDraft} onChange={(e) => setShowDraft(e.target.checked)} />
                    Show proposals (dashed)
                  </label>
                  <button className="btn small" onClick={() => setExpanded(true)} disabled={!snap.mermaidDraft}>
                    Expand
                  </button>
                </div>
                <MermaidView
                  key={sessionId}
                  code={showDraft ? snap.mermaidDraft : snap.mermaid}
                  className="big-diagram"
                  empty={showDraft ? "No components yet." : "Nothing agreed yet. Turn on “show proposals” to see what is being discussed."}
                  flashOnChange
                />
                <div className="legend muted small">
                  Solid: agreed · Dashed amber: TBD (open question) · Dashed grey: proposed
                </div>
              </div>
            )}
            {snap && tab === "decisions" && (
              <Decisions
                key={sessionId}
                state={snap.state}
                onEdit={edit}
                onJump={(ts) => setFocusTs({ ts, n: Date.now() })}
              />
            )}
            {snap && tab === "changelog" && <Changelog events={snap.events} log={snap.log} />}
          </div>
        </section>
      </main>

      {expanded && snap && (
        <div className="overlay" role="dialog" aria-label="Architecture diagram" onClick={() => setExpanded(false)}>
          <div className="overlay-card" onClick={(e) => e.stopPropagation()}>
            <div className="overlay-head">
              <h2>Architecture{showDraft ? " (with proposals)" : ""}</h2>
              <label className="toggle">
                <input type="checkbox" checked={showDraft} onChange={(e) => setShowDraft(e.target.checked)} />
                Show proposals
              </label>
              <button className="btn small" onClick={() => setExpanded(false)} autoFocus>
                Close
              </button>
            </div>
            <MermaidView code={showDraft ? snap.mermaidDraft : snap.mermaid} className="overlay-diagram" flashOnChange maxScale={1.6} />
          </div>
        </div>
      )}
    </div>
  );
}
