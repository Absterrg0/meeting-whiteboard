import { useEffect, useMemo, useRef, useState } from "react";
import { ALLOWED_STATUSES, type DocState, type Item, type ItemKind, type ItemStatus } from "../../src/core/types";
import type { UiOp } from "./api";

interface Props {
  state: DocState;
  onEdit: (op: UiOp) => Promise<boolean>;
  onJump: (ts: string) => void;
}

interface Group {
  key: string;
  title: string;
  match: (i: Item) => boolean;
}

const LIVE: ItemStatus[] = ["accepted", "tentative"];
const CLOSED: ItemStatus[] = ["rejected", "superseded", "dropped", "resolved", "done"];

const GROUPS: Group[] = [
  {
    key: "live",
    title: "Accepted & tentative",
    match: (i) => i.kind !== "open_question" && i.kind !== "action_item" && LIVE.includes(i.status),
  },
  { key: "proposed", title: "Proposed", match: (i) => i.status === "proposed" },
  { key: "questions", title: "Open questions", match: (i) => i.kind === "open_question" && i.status === "open" },
  { key: "actions", title: "Action items", match: (i) => i.kind === "action_item" && i.status === "open" },
  { key: "closed", title: "Rejected, superseded & closed", match: (i) => CLOSED.includes(i.status) },
];

const KIND_LABEL: Record<ItemKind, string> = {
  requirement: "Requirement",
  non_goal: "Non-goal",
  fact: "Fact",
  decision: "Decision",
  open_question: "Question",
  action_item: "Action",
};

const KIND_PREFIX: Record<ItemKind, string> = {
  requirement: "req",
  non_goal: "ng",
  fact: "fact",
  decision: "dec",
  open_question: "q",
  action_item: "act",
};

const DEFAULT_STATUS: Record<ItemKind, ItemStatus> = {
  requirement: "accepted",
  non_goal: "accepted",
  fact: "accepted",
  decision: "accepted",
  open_question: "open",
  action_item: "open",
};

const allowed = (i: Item, s: ItemStatus) => ALLOWED_STATUSES[i.kind].includes(s) && i.status !== s;

/** The "positive" close for each kind. */
function acceptAction(i: Item): { status: ItemStatus; label: string } | null {
  if (i.kind === "open_question") return allowed(i, "resolved") ? { status: "resolved", label: "Resolve" } : null;
  if (i.kind === "action_item") return allowed(i, "done") ? { status: "done", label: "Mark done" } : null;
  return allowed(i, "accepted") ? { status: "accepted", label: "Accept" } : null;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function ItemCard({
  item,
  state,
  changed,
  onEdit,
  onJump,
}: {
  item: Item;
  state: DocState;
  changed: boolean;
  onEdit: Props["onEdit"];
  onJump: Props["onJump"];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.detail);
  const [busy, setBusy] = useState(false);

  const run = async (input: Record<string, unknown>) => {
    setBusy(true);
    const ok = await onEdit({ name: "update_item", input: { id: item.id, reason: "edited in UI", ...input } });
    setBusy(false);
    return ok;
  };

  const accept = acceptAction(item);
  const reopen =
    (item.kind === "open_question" || item.kind === "action_item") && CLOSED.includes(item.status) && allowed(item, "open");
  const by = item.supersededBy ? state.items[item.supersededBy] : null;
  const supersedes = item.supersedes.map((id) => state.items[id]).filter((x): x is Item => !!x);

  return (
    <article className={`item ${changed ? "flash" : ""} status-${item.status}`}>
      <div className="item-head">
        <span className="kind">{KIND_LABEL[item.kind]}</span>
        <span className={`badge status ${item.status}`}>{item.status}</span>
        {item.pinned && (
          <span className="badge human" title="A person edited this item; the agent only changes it if the discussion revisits it">
            human-edited
          </span>
        )}
        <span className="item-id muted">{item.id}</span>
      </div>
      <h3 className="item-title">{item.title}</h3>
      {editing ? (
        <div className="item-edit">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(8, Math.max(3, Math.ceil(draft.length / 60)))}
            autoFocus
          />
          <div className="row">
            <button
              className="btn primary small"
              disabled={busy || draft.trim().length < 3 || draft.trim() === item.detail}
              onClick={async () => {
                if (await run({ detail: draft.trim() })) setEditing(false);
              }}
            >
              Save
            </button>
            <button className="btn small" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="item-detail">{item.detail}</p>
      )}
      {(item.owner || item.due) && (
        <div className="item-meta">
          {item.owner && <span>Owner: {item.owner}</span>}
          {item.due && <span>Due: {item.due}</span>}
        </div>
      )}
      {item.reason && <div className="item-reason">Why: {item.reason}</div>}
      {by && <div className="item-link">Superseded by: {by.title}</div>}
      {supersedes.length > 0 && <div className="item-link">Replaces: {supersedes.map((s) => s.title).join(", ")}</div>}

      {(item.evidence.length > 0 || item.history.length > 0) && (
        <details className="item-trail">
          <summary>
            {item.evidence.length} quote{item.evidence.length === 1 ? "" : "s"}
            {item.history.length > 0 && (
              <>
                {" "}
                · {item.history.length} change{item.history.length === 1 ? "" : "s"}
              </>
            )}
          </summary>
          {item.evidence.length > 0 && (
            <ul className="evidence">
              {item.evidence.map((e, i) => (
                <li key={i}>
                  <button className="ts-link" onClick={() => onJump(e.ts)} title="Show in transcript">
                    {e.ts}
                  </button>{" "}
                  <span className="speaker">{e.speaker}</span>
                  {e.quote && <q>{e.quote}</q>}
                </li>
              ))}
            </ul>
          )}
          {item.history.length > 0 && (
            <ul className="history">
              {item.history.map((h, i) => (
                <li key={i}>
                  <span className="ts">{h.ts}</span> <span className="field">{h.field}</span>{" "}
                  <span className="from">{h.from ?? "—"}</span> → <span className="to">{h.to ?? "—"}</span>
                  {h.source === "human" && <span className="badge human tiny">human</span>}
                  {h.reason && <div className="muted small">{h.reason}</div>}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      <div className="item-actions">
        {accept && (
          <button className="btn small" disabled={busy} onClick={() => void run({ status: accept.status })}>
            {accept.label}
          </button>
        )}
        {allowed(item, "rejected") && (
          <button className="btn small" disabled={busy} onClick={() => void run({ status: "rejected" })}>
            Reject
          </button>
        )}
        {reopen && (
          <button className="btn small" disabled={busy} onClick={() => void run({ status: "open" })}>
            Reopen
          </button>
        )}
        {!editing && (
          <button
            className="btn small"
            disabled={busy}
            onClick={() => {
              setDraft(item.detail);
              setEditing(true);
            }}
          >
            Edit detail
          </button>
        )}
        {allowed(item, "dropped") && (
          <button className="btn small danger" disabled={busy} onClick={() => void run({ status: "dropped" })}>
            Drop
          </button>
        )}
      </div>
    </article>
  );
}

function AddItem({ onEdit }: { onEdit: Props["onEdit"] }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ItemKind>("decision");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button className="btn small add-btn" onClick={() => setOpen(true)}>
        + Add item
      </button>
    );
  }
  const submit = async () => {
    setBusy(true);
    const id = `${KIND_PREFIX[kind]}-${slug(title) || "item"}-${Math.random().toString(36).slice(2, 6)}`;
    const ok = await onEdit({
      name: "record_item",
      input: {
        id,
        kind,
        title: title.trim(),
        detail: (detail.trim() || title.trim()),
        status: DEFAULT_STATUS[kind],
        owner: kind === "action_item" && owner.trim() ? owner.trim() : null,
      },
    });
    setBusy(false);
    if (ok) {
      setTitle("");
      setDetail("");
      setOwner("");
      setOpen(false);
    }
  };
  return (
    <div className="add-item">
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>
          {(Object.keys(KIND_LABEL) as ItemKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </div>
      <textarea placeholder="Detail (1–3 sentences)" rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} />
      {kind === "action_item" && <input placeholder="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} />}
      <div className="row">
        <button className="btn primary small" disabled={busy || title.trim().length < 3} onClick={() => void submit()}>
          Add
        </button>
        <button className="btn small" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function Decisions({ state, onEdit, onJump }: Props) {
  // Track which items changed since the previous state, to highlight them briefly.
  const prev = useRef<Map<string, Item> | null>(null);
  const changed = useMemo(() => {
    const before = prev.current;
    const out = new Set<string>();
    if (before) {
      for (const id of state.order.items) {
        const it = state.items[id];
        if (it && before.get(id) !== it && JSON.stringify(before.get(id)) !== JSON.stringify(it)) out.add(id);
      }
    }
    return out;
  }, [state]);
  useEffect(() => {
    prev.current = new Map(Object.entries(state.items));
  }, [state]);

  const items = state.order.items.map((id) => state.items[id]!).filter(Boolean);
  const grouped = GROUPS.map((g) => ({ ...g, items: items.filter(g.match) })).filter(
    (g) => g.items.length > 0 || g.key === "live",
  );

  return (
    <div className="decisions">
      <div className="decisions-toolbar">
        <span className="muted small">{items.length} items</span>
        <AddItem onEdit={onEdit} />
      </div>
      {items.length === 0 && <div className="empty">Decisions, questions and action items appear here.</div>}
      {items.length > 0 &&
        grouped.map((g) => (
          <section key={g.key} className="group">
            <h3 className="group-title">
              {g.title} <span className="count">{g.items.length}</span>
            </h3>
            {g.items.length === 0 && <div className="empty small">None yet.</div>}
            {g.items.map((i) => (
              <ItemCard key={i.id} item={i} state={state} changed={changed.has(i.id)} onEdit={onEdit} onJump={onJump} />
            ))}
          </section>
        ))}
    </div>
  );
}
