import type { ChangeEvent } from "../../src/core/types";
import type { SessionLogEntry } from "../../src/session";

const OP_LABEL: Record<string, string> = {
  set_meeting_info: "meeting",
  record_item: "added",
  update_item: "updated",
  supersede_item: "superseded",
  upsert_component: "component",
  remove_component: "removed",
  upsert_edge: "edge",
  remove_edge: "edge removed",
};

export function Changelog({ events, log }: { events: ChangeEvent[]; log: SessionLogEntry[] }) {
  const evs = [...events].reverse();
  const logs = [...log].reverse();
  return (
    <div className="changelog">
      {evs.length === 0 && <div className="empty">Every change to the doc is listed here, newest first.</div>}
      <ol className="events">
        {evs.map((e) => (
          <li key={e.seq} className={`event op-${e.op} src-${e.source}`}>
            <div className="event-meta">
              <span className="ts">{e.ts}</span>
              <span className={`badge op ${e.op}`}>{OP_LABEL[e.op] ?? e.op}</span>
              {e.source === "human" && <span className="badge human tiny">human</span>}
              <span className="seq muted">#{e.seq}</span>
            </div>
            <div className="event-summary">{e.summary}</div>
          </li>
        ))}
      </ol>
      {logs.length > 0 && (
        <>
          <h3 className="group-title">Session log</h3>
          <ol className="session-log">
            {logs.map((l, i) => (
              <li key={`${l.at}-${i}`} className={`log-${l.kind}`}>
                <span className="ts">{l.ts}</span>
                <span className={`badge log ${l.kind}`}>{l.kind}</span>
                <span className="log-msg">{l.message}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
