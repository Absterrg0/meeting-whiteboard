import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Utterance } from "../../src/core/types";

interface Props {
  lines: Utterance[];
  processedCount: number;
  agentBusy: boolean;
  canInject: boolean;
  focusTs: { ts: string; n: number } | null;
  onSay: (speaker: string, text: string) => Promise<boolean>;
  onFlush: () => void;
}

const SPEAKER_KEY = "mwb.speaker";

function loadSpeaker(): string {
  try {
    return localStorage.getItem(SPEAKER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function Transcript({ lines, processedCount, agentBusy, canInject, focusTs, onSay, onFlush }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [speaker, setSpeaker] = useState(loadSpeaker);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setShowJump(!stick.current);
  };

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setShowJump(false);
  };

  useLayoutEffect(() => {
    if (stick.current) toBottom();
  }, [lines.length]);

  // Jump to a quoted line (from the decisions panel).
  useEffect(() => {
    if (!focusTs) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-ts="${focusTs.ts}"]`);
    if (!el) return;
    stick.current = false;
    setShowJump(true);
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlight(focusTs.ts);
    const t = setTimeout(() => setHighlight(null), 2000);
    return () => clearTimeout(t);
  }, [focusTs]);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    const who = speaker.trim() || "Guest";
    try {
      localStorage.setItem(SPEAKER_KEY, who);
    } catch {
      /* storage unavailable */
    }
    setSending(true);
    stick.current = true;
    const ok = await onSay(who, t);
    setSending(false);
    if (ok) setText("");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const pending = Math.max(0, lines.length - processedCount);

  return (
    <section className="panel transcript">
      <header className="panel-head">
        <h2>Transcript</h2>
        <span className="muted small">
          {lines.length} line{lines.length === 1 ? "" : "s"}
          {pending > 0 && <> · {pending} pending</>}
        </span>
      </header>
      <div className="panel-body transcript-lines" ref={scroller} onScroll={onScroll}>
        {lines.length === 0 && <div className="empty">Lines appear here as the meeting runs.</div>}
        {lines.map((u) => {
          const isPending = u.idx >= processedCount;
          return (
            <div
              key={u.idx}
              data-ts={u.ts}
              className={`line ${isPending ? "pending" : ""} ${highlight === u.ts ? "focus" : ""}`}
            >
              <div className="line-meta">
                <span className="ts">{u.ts}</span>
                <span className="speaker">{u.speaker}</span>
                {isPending && (
                  <span className="pending-tag" title="Not yet processed by the agent">
                    pending
                  </span>
                )}
              </div>
              <div className="line-text">{u.text}</div>
            </div>
          );
        })}
      </div>
      {showJump && (
        <button className="jump" onClick={toBottom}>
          ↓ Latest
        </button>
      )}
      <div className="inject">
        <div className="inject-row">
          <input
            className="speaker-input"
            placeholder="Speaker"
            value={speaker}
            onChange={(e) => setSpeaker(e.target.value)}
            disabled={!canInject}
            aria-label="Speaker"
          />
          <input
            className="text-input"
            placeholder={canInject ? "Say something… (Enter to send)" : "Start a session to add lines"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            disabled={!canInject}
            aria-label="Utterance"
          />
          <button className="btn primary" onClick={() => void send()} disabled={!canInject || !text.trim() || sending}>
            Send
          </button>
        </div>
        {canInject && pending > 0 && !agentBusy && (
          <div className="inject-hint">
            <span className="muted small">
              The agent batches lines; {pending} waiting.
            </span>
            <button className="btn link small" onClick={onFlush}>
              Process now
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
