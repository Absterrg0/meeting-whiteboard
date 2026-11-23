import { useEffect, useRef, useState } from "react";
import { formatTs, parseTs, type DocState } from "../../src/core/types";
import { applyStatePatch } from "../../src/wire";
import { api, type LiveDelta, type LiveSnapshot } from "./api";

/** Wall time (ms) each id (item, topic, component, edge) last changed while this page watched. */
export type FreshMap = Record<string, number>;

export const FRESH_MS = 6500;

function topicsOf(state: DocState, ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const t = state.items[id]?.topic;
    if (t) out.push(t);
  }
  return out;
}

/**
 * The session's snapshot stream: one full snapshot on connect, then deltas.
 * If a delta does not line up with what we have, reconnect (the server starts with a full one).
 */
export function useLiveSession(id: string | null) {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [fresh, setFresh] = useState<FreshMap>({});
  const [receivedAt, setReceivedAt] = useState(0);
  const [connected, setConnected] = useState(false);
  /** The server no longer has this session (it was restarted); reconnecting cannot help. */
  const [lost, setLost] = useState(false);
  const [generation, setGeneration] = useState(0);
  const snapRef = useRef<LiveSnapshot | null>(null);

  useEffect(() => {
    setSnap(null);
    snapRef.current = null;
    setFresh({});
    setLost(false);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(api.eventsUrl(id));
    let dead = false;
    const resync = () => {
      if (dead) return;
      dead = true;
      es.close();
      setTimeout(() => setGeneration((g) => g + 1), 300);
    };
    es.addEventListener("full", (e) => {
      const full = JSON.parse((e as MessageEvent<string>).data) as LiveSnapshot;
      snapRef.current = full;
      setSnap(full);
      setReceivedAt(Date.now());
      setConnected(true);
    });
    es.addEventListener("delta", (e) => {
      const d = JSON.parse((e as MessageEvent<string>).data) as LiveDelta;
      const prev = snapRef.current;
      if (!prev || d.id !== prev.id || d.transcriptFrom !== prev.transcript.length || d.eventsFrom !== prev.events.length) {
        resync();
        return;
      }
      const { patch, transcript, events, log, transcriptFrom: _t, eventsFrom: _e, logFrom: _l, ...header } = d;
      const next: LiveSnapshot = {
        ...prev,
        ...header,
        state: patch ? applyStatePatch(prev.state, patch) : prev.state,
        transcript: transcript.length ? [...prev.transcript, ...transcript] : prev.transcript,
        events: events.length ? [...prev.events, ...events] : prev.events,
        log: log.length ? [...prev.log, ...log].slice(-200) : prev.log,
      };
      snapRef.current = next;
      setSnap(next);
      setReceivedAt(Date.now());
      if (events.length) {
        const now = Date.now();
        setFresh((f) => {
          const out = { ...f };
          for (const ev of events) {
            for (const t of ev.targets) out[t] = now;
            for (const t of topicsOf(next.state, ev.targets)) out[t] = now;
            // Edges are keyed `${from}->${to}`; mark both components' edges via the edge id itself.
          }
          return out;
        });
      }
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      // EventSource retries forever; stop if the session itself is gone.
      fetch(api.docUrl(id))
        .then((r) => {
          if (r.status === 404 && !dead) {
            dead = true;
            es.close();
            setLost(true);
          }
        })
        .catch(() => {});
    };
    return () => {
      dead = true;
      es.close();
    };
  }, [id, generation]);

  return { snap, fresh, receivedAt, connected, lost };
}

/** The meeting clock, ticking between snapshots while the meeting runs. */
export function useMeetingClock(snap: LiveSnapshot | null, receivedAt: number): string {
  const [, tick] = useState(0);
  const running = snap?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!snap) return "00:00:00";
  if (!running) return snap.meetingTime;
  return formatTs(parseTs(snap.meetingTime) + ((Date.now() - receivedAt) / 1000) * snap.speed);
}

/** Re-render every second while anything is fresh, so highlights and "updated" markers expire. */
export function useNow(fresh: FreshMap): number {
  const [now, setNow] = useState(Date.now());
  const latest = Object.values(fresh).reduce((m, t) => Math.max(m, t), 0);
  useEffect(() => {
    if (Date.now() - latest > FRESH_MS) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - latest > FRESH_MS) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [latest]);
  return Math.max(now, latest);
}
