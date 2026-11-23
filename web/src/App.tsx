import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BotView, type UiOp } from "./api";
import type { LiveCapture } from "./audio";
import { Doc } from "./Doc";
import { docTitle } from "./format";
import { BotStatus } from "./live";
import { Sidebar, type InjectHandle, type SideTab } from "./Sidebar";
import { StartScreen } from "./StartScreen";
import { TopBar, type ThemePref } from "./TopBar";
import { useLiveSession, useMeetingClock, useNow } from "./useLiveSession";

const THEME_KEY = "mwb.theme";
const SIDEBAR_KEY = "mwb.sidebar";

function loadTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function useTheme() {
  const [pref, setPref] = useState<ThemePref>(loadTheme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const dark = pref === "dark" || (pref === "system" && systemDark);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  const set = (t: ThemePref) => {
    setPref(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* storage unavailable */
    }
  };
  return { pref, dark, set };
}

export function App() {
  const theme = useTheme();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<"loading" | "start" | "doc">("loading");
  const [capture, setCapture] = useState<LiveCapture | null>(null);
  const [bot, setBot] = useState<BotView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [tab, setTab] = useState<SideTab>("activity");
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== "0" && window.innerWidth > 860;
    } catch {
      return true;
    }
  });
  const injectRef = useRef<InjectHandle>(null);
  const { snap, fresh, receivedAt, connected, lost } = useLiveSession(sessionId);
  const clock = useMeetingClock(snap, receivedAt);
  const now = useNow(fresh);

  useEffect(() => {
    api
      .current()
      .then(({ id }) => {
        if (id) {
          setSessionId(id);
          setView("doc");
        } else setView("start");
      })
      .catch(() => setView("start"));
    // Reattach to a bot that is still in a call after a reload.
    api
      .bots()
      .then((list) => {
        const active = list.filter((b) => !b.left).at(-1);
        if (active) setBot(active);
      })
      .catch(() => undefined);
  }, []);

  // The meeting is over: stop sending audio.
  useEffect(() => {
    if (snap?.status === "done" && capture?.active) void capture.stop();
  }, [snap?.status, capture]);

  // "/" focuses the inject box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (view !== "doc") return;
      e.preventDefault();
      setSidebarOpen(true);
      setTab("transcript");
      setTimeout(() => injectRef.current?.focus(), 30);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  const toggleSidebar = (open: boolean) => {
    setSidebarOpen(open);
    try {
      localStorage.setItem(SIDEBAR_KEY, open ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };

  const edit = useCallback(
    async (op: UiOp): Promise<string | null> => {
      if (!sessionId) return "No session";
      try {
        await api.edit(sessionId, op);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [sessionId],
  );

  const say = async (speaker: string, text: string) => {
    if (!sessionId) return false;
    try {
      await api.say(sessionId, speaker, text);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const control = (action: "pause" | "resume" | "finish") => {
    if (!sessionId) return;
    api.control(sessionId, { action }).catch((e: Error) => setError(e.message));
  };

  const started = async (id: string, opts?: { capture?: LiveCapture; bot?: BotView }) => {
    if (capture && capture !== opts?.capture) await capture.stop().catch(() => undefined);
    setCapture(opts?.capture ?? null);
    if (opts?.bot) setBot(opts.bot);
    setError(null);
    setSessionId(id);
    setTab(opts?.capture ? "transcript" : "activity");
    setView("doc");
  };

  const onFocus = (id: string) => setFocus({ id, n: Date.now() });

  if (view === "loading") return <div className="app" />;

  const botForSession = bot && snap && bot.sessionId === snap.id ? bot : null;

  return (
    <div className={`app${view === "doc" && snap && sidebarOpen ? " with-sidebar" : ""}`}>
      <TopBar
        snap={view === "doc" ? snap : null}
        clock={clock}
        connected={connected}
        lost={lost}
        theme={theme.pref}
        onTheme={theme.set}
        sidebarOpen={sidebarOpen}
        onSidebar={() => toggleSidebar(true)}
        onHome={() => setView("start")}
        onControl={control}
      />
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button className="link-btn" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {view === "start" ? (
        <main className="main-start">
          <StartScreen
            current={sessionId && snap ? { id: sessionId, title: docTitle(snap.state.meeting.title, snap.title), live: snap.status === "running" || snap.status === "paused" } : null}
            onReturn={() => setView("doc")}
            onStarted={(id, opts) => void started(id, opts)}
          />
        </main>
      ) : !snap ? (
        <main className="main-doc">
          <div className="doc-loading">
            <span className="skeleton w60" />
            <span className="skeleton w40" />
            <span className="skeleton w90" />
            <span className="skeleton w80" />
          </div>
        </main>
      ) : (
        <>
          <main className="main-doc">
            <Doc snap={snap} fresh={fresh} now={now} dark={theme.dark} clock={clock} onEdit={edit} focus={focus} onFocus={onFocus} />
          </main>
          {sidebarOpen && (
            <Sidebar
              snap={snap}
              fresh={fresh}
              now={now}
              tab={tab}
              onTab={setTab}
              onClose={() => toggleSidebar(false)}
              onFocus={onFocus}
              capture={capture}
              onSay={say}
              injectRef={injectRef}
              extra={botForSession ? <BotStatus bot={botForSession} onBot={setBot} onError={(e) => setError(String(e))} /> : null}
            />
          )}
        </>
      )}
    </div>
  );
}
