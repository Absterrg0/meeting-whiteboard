import { Download, Monitor, Moon, PanelRightOpen, Pause, Play, Square, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { LiveSnapshot } from "./api";
import { api } from "./api";
import { docTitle, money, shortTs } from "./format";

export type ThemePref = "system" | "light" | "dark";

function Popover({ open, onClose, children, align = "right" }: { open: boolean; onClose: () => void; children: ReactNode; align?: "left" | "right" }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="pop-scrim" onMouseDown={onClose} />
      <div className={`pop pop-${align}`} role="dialog">
        {children}
      </div>
    </>
  );
}

function LiveIndicator({ snap, clock }: { snap: LiveSnapshot; clock: string }) {
  if (snap.readOnly) return <span className="live-pill ended">Saved session</span>;
  if (snap.status === "done") return <span className="live-pill ended">Ended · {shortTs(clock)}</span>;
  if (snap.status === "paused") return <span className="live-pill paused">Paused · {shortTs(clock)}</span>;
  const label = snap.mode === "live" ? "Live" : `Replay ${snap.speed}×`;
  return (
    <span className={`live-pill ${snap.mode === "live" ? "live" : "replay"}`}>
      <span className="pulse" aria-hidden />
      {label}
      <span className="live-clock">{shortTs(clock)}</span>
    </span>
  );
}

function Thinking({ snap }: { snap: LiveSnapshot }) {
  const pending = snap.transcript.length - snap.processedCount;
  let text: string | null = null;
  if (snap.agentBusy) text = snap.status === "done" && pending === 0 ? "Reviewing the whole meeting…" : "Updating the doc…";
  else if (snap.editorBusy) text = "Redrawing the diagram…";
  if (!text) return null;
  return (
    <span className="thinking" aria-live="polite">
      <span className="shimmer">{text}</span>
    </span>
  );
}

export interface TopBarProps {
  snap: LiveSnapshot | null;
  clock: string;
  connected: boolean;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
  sidebarOpen: boolean;
  onSidebar: () => void;
  onHome: () => void;
  onControl: (a: "pause" | "resume" | "finish") => void;
}

export function TopBar({ snap, clock, connected, theme, onTheme, sidebarOpen, onSidebar, onHome, onControl }: TopBarProps) {
  const [stats, setStats] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const title = snap ? docTitle(snap.state.meeting.title, snap.title) : "";
  const pending = snap ? snap.transcript.length - snap.processedCount : 0;
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const nextTheme: ThemePref = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const running = snap && !snap.readOnly && (snap.status === "running" || snap.status === "paused");

  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button className="crumb" onClick={onHome}>
          <span className="brand-mark sm" aria-hidden />
          Meetings
        </button>
        {snap && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb current" title={title}>
              {title}
            </span>
          </>
        )}
      </nav>

      {snap && <LiveIndicator snap={snap} clock={clock} />}
      {snap && <Thinking snap={snap} />}
      {snap && !connected && <span className="reconnecting">Reconnecting…</span>}

      <span className="grow" />

      {snap && !snap.readOnly && (
        <div className="anchor">
          <button className="quiet-btn" onClick={() => setStats((s) => !s)} aria-expanded={stats} title="Model, cost and latency">
            <span className="stat-model">{snap.model.split("/").pop()}</span>
            <span className="stat-sep" />
            {money(snap.usage.costUsd)}
          </button>
          <Popover open={stats} onClose={() => setStats(false)}>
            <dl className="stats">
              <dt>Scribe</dt>
              <dd>{snap.model}</dd>
              {snap.editorModel !== snap.model && (
                <>
                  <dt>Diagram</dt>
                  <dd>{snap.editorModel}</dd>
                </>
              )}
              <dt>Cost</dt>
              <dd>
                {money(snap.usage.costUsd)}
                {snap.usage.unpriced ? " (at least)" : ""} · {snap.usage.calls} call{snap.usage.calls === 1 ? "" : "s"}
              </dd>
              <dt>Tokens</dt>
              <dd>
                {Math.round(snap.usage.inputTokens / 1000)}k in · {Math.round(snap.usage.outputTokens / 1000)}k out
                {snap.usage.cacheReadTokens > 0 ? ` · ${Math.round(snap.usage.cacheReadTokens / 1000)}k cached` : ""}
              </dd>
              <dt>Latency</dt>
              <dd>
                {snap.latency.p50 === null ? "—" : `${snap.latency.p50.toFixed(1)}s median · ${snap.latency.p90!.toFixed(1)}s p90`}
              </dd>
              <dt>Queue</dt>
              <dd>{pending ? `${pending} line${pending === 1 ? "" : "s"} waiting` : "Up to date"}</dd>
            </dl>
          </Popover>
        </div>
      )}

      {running && (
        <div className="tool-group">
          {snap!.status === "running" ? (
            <button className="icon-btn" onClick={() => onControl("pause")} title="Pause" aria-label="Pause">
              <Pause size={15} />
            </button>
          ) : (
            <button className="icon-btn" onClick={() => onControl("resume")} title="Resume" aria-label="Resume">
              <Play size={15} />
            </button>
          )}
          <div className="anchor">
            <button className="icon-btn" onClick={() => setConfirmEnd(true)} title="End meeting" aria-label="End meeting">
              <Square size={13} />
            </button>
            <Popover open={confirmEnd} onClose={() => setConfirmEnd(false)}>
              <div className="confirm">
                <p className="confirm-title">End the meeting?</p>
                <p className="confirm-text">The agent finishes the lines it has, then reviews the whole meeting once more.</p>
                <div className="confirm-actions">
                  <button className="btn ghost sm" onClick={() => setConfirmEnd(false)} autoFocus>
                    Keep going
                  </button>
                  <button
                    className="btn primary sm"
                    onClick={() => {
                      setConfirmEnd(false);
                      onControl("finish");
                    }}
                  >
                    End meeting
                  </button>
                </div>
              </div>
            </Popover>
          </div>
        </div>
      )}

      {snap && (
        <a className="icon-btn" href={api.docUrl(snap.id)} download title="Export as Markdown" aria-label="Export as Markdown">
          <Download size={15} />
        </a>
      )}
      <button className="icon-btn" onClick={() => onTheme(nextTheme)} title={`Theme: ${theme}`} aria-label={`Theme: ${theme}`}>
        <ThemeIcon size={15} />
      </button>
      {snap && !sidebarOpen && (
        <button className="icon-btn" onClick={onSidebar} title="Show activity" aria-label="Show activity">
          <PanelRightOpen size={16} />
        </button>
      )}
    </header>
  );
}
