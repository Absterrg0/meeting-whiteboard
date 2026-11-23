import { useCallback, useEffect, useRef, useState } from "react";
import { formatTs, parseTs } from "../../src/core/types";
import { api, type Snapshot, type TranscriptInfo, type UiOp } from "./api";
import { Changelog } from "./Changelog";
import { Decisions } from "./Decisions";
import { DocView } from "./DocView";
import { MermaidView } from "./Mermaid";
import { Transcript } from "./Transcript";

const PASTE = "__paste__";
const SPEEDS = [1, 5, 10, 30];
type Tab = "diagram" | "decisions" | "changelog";

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
  }, []);

  const report = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  const start = async (live: boolean) => {
    setStarting(true);
    setError(null);
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
    setPasted(await f.text());
    setSource(PASTE);
  };

  const status = snap?.status ?? "idle";
  const canStart = source === PASTE ? pasted.trim().length > 0 : !!source;
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
          <button className="btn" disabled={starting} onClick={() => void start(true)} title="Start an empty meeting and type lines yourself">
            ● Live
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
          <textarea
            placeholder={
              'Paste a transcript: JSONL ({"time","speaker","text"} per line), a JSON array, "[00:01:10] Name: text" lines, or a markdown table.'
            }
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={4}
          />
          <div className="paste-side">
            <button className="btn small" onClick={() => fileInput.current?.click()}>
              Upload file…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".jsonl,.json,.txt,.md,text/plain"
              hidden
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <span className="muted small">{pasted ? `${pasted.split(/\n/).filter(Boolean).length} lines` : ""}</span>
          </div>
        </div>
      )}

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
