import { ArrowDown, CornerDownLeft, PanelRightClose, Quote } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Utterance } from "../../src/core/types";
import { buildActivity, type ActivityEntry } from "./activity";
import type { LiveSnapshot } from "./api";
import type { LiveCapture } from "./audio";
import { shortTs } from "./format";
import { CaptureStatus, SpeakerChips, useCapture } from "./live";
import { FRESH_MS, type FreshMap } from "./useLiveSession";

export type SideTab = "activity" | "transcript";

// ---------- activity ----------

function ActivityRow({ e, onFocus, fresh }: { e: ActivityEntry; onFocus: (id: string) => void; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const compact = e.tone === "diagram";
  return (
    <li className={`act${compact ? " compact" : ""}${fresh ? " is-fresh" : ""}${open ? " open" : ""}`}>
      <time className="act-time">{shortTs(e.ts)}</time>
      <span className={`act-dot tone-${e.tone}`} aria-hidden />
      <div className="act-body">
        <button className="act-head" onClick={() => e.target && onFocus(e.target)} disabled={!e.target}>
          {e.headline}
          {compact && e.detail && <span className="act-inline"> · {e.detail}</span>}
          {e.human && <span className="act-you">you</span>}
        </button>
        {!compact &&
          (e.from && e.to ? (
            <div className="act-detail">
              <s>{e.from}</s> <span className="act-arrow">→</span> {e.to}
            </div>
          ) : (
            e.detail && <div className="act-detail clamp">{e.detail}</div>
          ))}
        {open && e.quote && (
          <blockquote className="act-quote">
            “{e.quote.text}”
            {e.quote.speaker && (
              <footer>
                {e.quote.speaker} · {shortTs(e.quote.ts)}
              </footer>
            )}
          </blockquote>
        )}
      </div>
      {e.quote && (
        <button className="act-quote-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? "Hide quote" : "Show what was said"} aria-label="Quote">
          <Quote size={12} />
        </button>
      )}
    </li>
  );
}

function Activity({ snap, fresh, now, onFocus }: { snap: LiveSnapshot; fresh: FreshMap; now: number; onFocus: (id: string) => void }) {
  const entries = useMemo(() => buildActivity(snap.events, snap.state, snap.transcript), [snap.events, snap.state, snap.transcript]);
  const [limit, setLimit] = useState(80);
  if (entries.length === 0) {
    return (
      <div className="side-empty">
        <p>Changes to the doc show up here as the agent makes them: decisions, reversals, open questions.</p>
      </div>
    );
  }
  const latestFresh = Object.values(fresh).some((t) => now - t < FRESH_MS);
  return (
    <ol className="activity">
      {entries.slice(0, limit).map((e, i) => (
        <ActivityRow key={e.key} e={e} onFocus={onFocus} fresh={latestFresh && i === 0} />
      ))}
      {entries.length > limit && (
        <li className="act-more">
          <button className="link-btn" onClick={() => setLimit((l) => l + 200)}>
            Show older
          </button>
        </li>
      )}
    </ol>
  );
}

// ---------- transcript ----------

interface Group {
  speaker: string;
  ts: string;
  lines: Utterance[];
}

function group(lines: Utterance[]): Group[] {
  const out: Group[] = [];
  for (const u of lines) {
    const g = out.at(-1);
    if (g && g.speaker === u.speaker && u.t - g.lines.at(-1)!.t < 60) g.lines.push(u);
    else out.push({ speaker: u.speaker, ts: u.ts, lines: [u] });
  }
  return out;
}

const SPEAKER_KEY = "mwb.speaker";

function loadSpeaker(): string {
  try {
    return localStorage.getItem(SPEAKER_KEY) ?? "";
  } catch {
    return "";
  }
}

export interface InjectHandle {
  focus: () => void;
}

const Inject = forwardRef<InjectHandle, { onSay: (speaker: string, text: string) => Promise<boolean>; disabled: boolean }>(function Inject(
  { onSay, disabled },
  ref,
) {
  const [speaker, setSpeaker] = useState(loadSpeaker);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);
  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    const ok = await onSay(speaker.trim() || "Guest", t);
    setSending(false);
    if (ok) setText("");
  };
  return (
    <form
      className="inject"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        ref={input}
        className="inject-text"
        value={text}
        rows={2}
        disabled={disabled}
        placeholder={disabled ? "This meeting has ended" : "Say something into the meeting…"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape") input.current?.blur();
        }}
      />
      <div className="inject-bar">
        <input
          className="inject-speaker"
          value={speaker}
          placeholder="Your name"
          aria-label="Speaker"
          maxLength={60}
          onChange={(e) => {
            setSpeaker(e.target.value);
            try {
              localStorage.setItem(SPEAKER_KEY, e.target.value);
            } catch {
              /* storage unavailable */
            }
          }}
        />
        <span className="inject-hint">
          <kbd>/</kbd> to focus
        </span>
        <button className="btn sm primary" disabled={disabled || sending || !text.trim()} aria-label="Send">
          <CornerDownLeft size={13} /> Send
        </button>
      </div>
    </form>
  );
});

function Transcript({
  snap,
  capture,
  onSay,
  injectRef,
}: {
  snap: LiveSnapshot;
  capture: LiveCapture | null;
  onSay: (speaker: string, text: string) => Promise<boolean>;
  injectRef: React.Ref<InjectHandle>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const groups = useMemo(() => group(snap.transcript), [snap.transcript]);
  const cap = useCapture(capture);
  const partials = cap.sources.filter((s) => s.partial).map((s) => s.partial);
  const pending = snap.transcript.length - snap.processedCount;
  const speakers = useMemo(() => [...new Set(snap.transcript.map((u) => u.speaker))], [snap.transcript]);

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAway(false);
  };
  useLayoutEffect(() => {
    if (stick.current) toBottom();
  }, [snap.transcript.length, partials.join("")]);

  const canSay = !snap.readOnly && !(snap.status === "done" && snap.mode !== "live");

  return (
    <div className="transcript">
      {capture && <CaptureStatus capture={capture} />}
      <div
        className="transcript-scroll"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current!;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          setAway(!stick.current);
        }}
      >
        {groups.length === 0 && partials.length === 0 ? (
          <div className="side-empty">
            <p>{snap.mode === "live" ? "Listening. Lines appear here as people speak." : "The transcript appears here as the replay plays."}</p>
          </div>
        ) : (
          groups.map((g) => {
            const allPending = g.lines[0]!.idx >= snap.processedCount;
            return (
              <div key={g.lines[0]!.idx} className={`utt${allPending ? " pending" : ""}`}>
                <div className="utt-head">
                  <span className="utt-speaker">{g.speaker}</span>
                  <time>{shortTs(g.ts)}</time>
                </div>
                {g.lines.map((u) => (
                  <p key={u.idx} className={`utt-text${u.idx >= snap.processedCount ? " pending" : ""}`} data-ts={u.ts}>
                    {u.text}
                  </p>
                ))}
              </div>
            );
          })
        )}
        {partials.length > 0 && (
          <div className="utt partial" aria-live="polite">
            <p className="utt-text">
              {partials.join(" · ")}
              <span className="caret" />
            </p>
          </div>
        )}
      </div>
      {away && (
        <button className="jump" onClick={toBottom}>
          <ArrowDown size={13} /> Latest
        </button>
      )}
      <div className="transcript-foot">
        {pending > 0 && (
          <div className="queue-note">
            <span className={`queue-dot${snap.agentBusy ? " busy" : ""}`} />
            {snap.agentBusy ? `Agent is reading ${pending} new line${pending === 1 ? "" : "s"}…` : `${pending} line${pending === 1 ? "" : "s"} waiting for the agent`}
          </div>
        )}
        {capture && cap.sources.some((s) => s.status === "listening") && <SpeakerChips capture={capture} state={cap} seen={speakers} />}
        {canSay && <Inject ref={injectRef} onSay={onSay} disabled={false} />}
      </div>
    </div>
  );
}

// ---------- the sidebar ----------

export interface SidebarProps {
  snap: LiveSnapshot;
  fresh: FreshMap;
  now: number;
  tab: SideTab;
  onTab: (t: SideTab) => void;
  onClose: () => void;
  onFocus: (id: string) => void;
  capture: LiveCapture | null;
  onSay: (speaker: string, text: string) => Promise<boolean>;
  injectRef: React.Ref<InjectHandle>;
  extra?: ReactNode;
}

export function Sidebar(p: SidebarProps) {
  const pending = p.snap.transcript.length - p.snap.processedCount;
  // A new line from the room: nudge the transcript tab.
  const [unseen, setUnseen] = useState(0);
  const lastLen = useRef(p.snap.transcript.length);
  useEffect(() => {
    if (p.tab === "transcript") setUnseen(0);
    else if (p.snap.transcript.length > lastLen.current) setUnseen((n) => n + p.snap.transcript.length - lastLen.current);
    lastLen.current = p.snap.transcript.length;
  }, [p.snap.transcript.length, p.tab]);

  return (
    <aside className="sidebar" aria-label="Meeting activity">
      <div className="side-tabs" role="tablist">
        <button role="tab" aria-selected={p.tab === "activity"} className={`side-tab${p.tab === "activity" ? " active" : ""}`} onClick={() => p.onTab("activity")}>
          Activity
        </button>
        <button
          role="tab"
          aria-selected={p.tab === "transcript"}
          className={`side-tab${p.tab === "transcript" ? " active" : ""}`}
          onClick={() => p.onTab("transcript")}
        >
          Transcript
          {p.tab !== "transcript" && unseen > 0 && <span className="tab-badge">{unseen > 99 ? "99+" : unseen}</span>}
          {p.tab === "transcript" && pending > 0 && <span className="tab-count">{pending}</span>}
        </button>
        <span className="grow" />
        <button className="icon-btn" onClick={p.onClose} aria-label="Hide sidebar" title="Hide sidebar">
          <PanelRightClose size={16} />
        </button>
      </div>
      {p.extra}
      <div className="side-body">
        {p.tab === "activity" ? (
          <div className="side-scroll">
            <Activity snap={p.snap} fresh={p.fresh} now={p.now} onFocus={p.onFocus} />
          </div>
        ) : (
          <Transcript snap={p.snap} capture={p.capture} onSay={p.onSay} injectRef={p.injectRef} />
        )}
      </div>
    </aside>
  );
}
