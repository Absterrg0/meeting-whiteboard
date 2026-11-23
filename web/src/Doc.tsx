import { ChevronRight, MoreHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TopicStatus } from "../../src/core/topics";
import type { ChangeEvent, DocState, Item, Utterance } from "../../src/core/types";
import type { LiveSnapshot } from "./api";
import { ArchitectureFigure } from "./Diagram";
import { buildDoc, STATUS_LABEL, type Block } from "./docModel";
import { itemActions, moveToTopic, replaceWith, saveText, type EditFn, type MenuAction } from "./edits";
import { capitalize, docTitle, hue, initials, plural, shortTs, splitTitle } from "./format";
import { FRESH_MS, type FreshMap } from "./useLiveSession";

interface DocProps {
  snap: LiveSnapshot;
  fresh: FreshMap;
  now: number;
  dark: boolean;
  clock: string;
  onEdit: EditFn;
  focus: { id: string; n: number } | null;
  onFocus: (id: string) => void;
}

interface Ctx {
  state: DocState;
  fresh: FreshMap;
  now: number;
  onEdit: EditFn;
  readOnly: boolean;
}

// ---------- small pieces ----------

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, ["--h" as string]: hue(name) }} title={name} aria-hidden>
      {initials(name)}
    </span>
  );
}

function StatusLabel({ status }: { status: TopicStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

function freshAt(ctx: Ctx, id: string): number {
  const t = ctx.fresh[id];
  return t && ctx.now - t < FRESH_MS ? t : 0;
}

function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close, ref]);
}

// ---------- an item with its hover menu ----------

function RowMenu({ actions, topics, item, onRun, onForm, onMove }: {
  actions: MenuAction[];
  topics: { id: string; title: string }[];
  item: Item;
  onRun: (a: MenuAction) => void;
  onForm: (f: "edit" | "replace") => void;
  onMove: (topic: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setMoving(false);
  };
  useDismiss(open, close, ref);
  return (
    <div className={`row-menu${open ? " open" : ""}`} ref={ref}>
      <button className="row-menu-btn" aria-label="Item actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {!moving ? (
            <>
              {actions.map((a) => (
                <button
                  key={a.key}
                  role="menuitem"
                  className={`menu-item${a.danger ? " danger" : ""}`}
                  onClick={() => {
                    close();
                    if (a.form) onForm(a.form);
                    else onRun(a);
                  }}
                >
                  {a.label}
                </button>
              ))}
              {topics.length > 0 && (
                <button role="menuitem" className="menu-item" onClick={() => setMoving(true)}>
                  Move to topic <ChevronRight size={13} className="menu-chev" />
                </button>
              )}
            </>
          ) : (
            <>
              <div className="menu-label">Move to</div>
              {topics.map((t) => (
                <button
                  key={t.id}
                  role="menuitem"
                  className={`menu-item${item.topic === t.id ? " current" : ""}`}
                  disabled={item.topic === t.id}
                  onClick={() => {
                    close();
                    onMove(t.id);
                  }}
                >
                  {t.title}
                </button>
              ))}
              {item.topic && (
                <button
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    close();
                    onMove(null);
                  }}
                >
                  No topic (meeting-wide)
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ItemRow({ item, ctx, className = "", children }: { item: Item; ctx: Ctx; className?: string; children: ReactNode }) {
  const [form, setForm] = useState<"edit" | "replace" | null>(null);
  const [title, setTitle] = useState(item.title);
  const [detail, setDetail] = useState(item.detail);
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = freshAt(ctx, item.id);
  const actions = useMemo(() => itemActions(item, ctx.state, ctx.onEdit), [item, ctx.state, ctx.onEdit]);
  const topics = useMemo(
    () => ctx.state.order.topics.map((id) => ctx.state.topics[id]).filter((t): t is NonNullable<typeof t> => !!t).map((t) => ({ id: t.id, title: t.title })),
    [ctx.state],
  );
  const lowConf = item.confidence === "low" && !["rejected", "superseded", "dropped", "resolved", "done"].includes(item.status);

  const run = async (p: Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const err = await p;
    setBusy(false);
    if (err) setError(err);
    return !err;
  };
  const openForm = (f: "edit" | "replace") => {
    setTitle(item.title);
    setDetail(item.detail);
    setReplacement("");
    setError(null);
    setForm(f);
  };

  return (
    <div className={`row ${className}${lowConf ? " needs-review" : ""}${busy ? " busy" : ""}`} data-anchor={item.id}>
      {at > 0 && <span className="wash" key={at} aria-hidden />}
      {form === "edit" ? (
        <form
          className="row-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(saveText(item, title, detail, ctx.onEdit)).then((ok) => ok && setForm(null));
          }}
          onKeyDown={(e) => e.key === "Escape" && setForm(null)}
        >
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" autoFocus maxLength={120} />
          <textarea className="field" value={detail} onChange={(e) => setDetail(e.target.value)} aria-label="Statement" rows={3} />
          <div className="row-form-actions">
            <button className="btn primary sm" disabled={busy}>
              Save
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        children
      )}
      {form === "replace" && (
        <form
          className="row-form inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (!replacement.trim()) return;
            void run(replaceWith(item, replacement, ctx.onEdit)).then((ok) => ok && setForm(null));
          }}
          onKeyDown={(e) => e.key === "Escape" && setForm(null)}
        >
          <input
            className="field"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder={`Replace “${splitTitle(item.title).choice}” with…`}
            aria-label="Replacement"
            autoFocus
            maxLength={120}
          />
          <button className="btn primary sm" disabled={busy || replacement.trim().length < 3}>
            Replace
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setForm(null)}>
            Cancel
          </button>
        </form>
      )}
      {lowConf && !form && (
        <div className="needs">
          <span className="needs-label">Needs confirmation</span>
          <button className="link-btn" onClick={() => void run(ctx.onEdit({ name: "confirm_item", input: { id: item.id } }))}>
            Confirm
          </button>
          <button className="link-btn" onClick={() => openForm("edit")}>
            Edit
          </button>
        </div>
      )}
      {error && (
        <div className="row-error" role="alert">
          {error}
          <button className="link-btn" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {!form && (
        <RowMenu
          actions={actions}
          topics={topics}
          item={item}
          onRun={(a) => a.run && void run(a.run())}
          onForm={openForm}
          onMove={(t) => void run(moveToTopic(item, t, ctx.onEdit))}
        />
      )}
    </div>
  );
}

// ---------- topic blocks ----------

function Line({ item, ctx, tone, children, time }: { item: Item; ctx: Ctx; tone: string; children: ReactNode; time?: string }) {
  return (
    <ItemRow item={item} ctx={ctx} className="line">
      <span className={`dot dot-${tone}`} aria-hidden />
      <span className="line-body">{children}</span>
      {time && <time className="line-time">{shortTs(time)}</time>}
    </ItemRow>
  );
}

function DecisionBody({ item, heading }: { item: Item; heading: string }) {
  const { choice } = splitTitle(item.title);
  const showChoice = choice.toLowerCase() !== heading.toLowerCase();
  const detail = item.detail?.trim();
  return (
    <>
      {showChoice ? <p className="decision">{capitalize(choice)}</p> : null}
      {detail && detail.toLowerCase() !== choice.toLowerCase() && <p className={showChoice ? "decision-detail" : "decision"}>{detail}</p>}
      {item.reason && (
        <p className="why">
          <span className="why-label">Why</span>
          {item.reason}
        </p>
      )}
      {item.status === "tentative" && <p className="tentative-note">Agreed for now; to be revisited.</p>}
    </>
  );
}

function TopicBlock({ block, ctx }: { block: Block; ctx: Ctx }) {
  const changed = block.ids.some((id) => freshAt(ctx, id)) || (block.topicId ? freshAt(ctx, block.topicId) > 0 : false);
  return (
    <section className={`topic${changed ? " is-fresh" : ""}`} data-anchor={block.topicId ?? block.key} id={`t-${block.key}`}>
      <header className="topic-head">
        <h3 className="topic-title">{block.title}</h3>
        <StatusLabel status={block.status} />
        {changed && <span className="updated">updated {shortTs(block.lastTs)}</span>}
      </header>
      {block.question && (!block.decision || block.status === "tentative") && <p className="topic-question">{block.question}</p>}

      {block.decision && (
        <ItemRow item={block.decision} ctx={ctx} className="decision-row">
          <DecisionBody item={block.decision} heading={block.title} />
        </ItemRow>
      )}
      {block.extraDecisions.map((d) => (
        <ItemRow key={d.id} item={d} ctx={ctx} className="decision-row extra">
          <DecisionBody item={d} heading={block.title} />
        </ItemRow>
      ))}

      {block.proposals.length > 0 && (
        <div className="sub">
          <div className="sub-label">{block.decision ? "Also proposed" : "On the table"}</div>
          {block.proposals.map((p) => (
            <Line key={p.id} item={p} ctx={ctx} tone="proposed">
              <span className="line-main">{capitalize(splitTitle(p.title).choice)}</span>
              {p.detail && p.detail !== p.title && <span className="line-note">{p.detail}</span>}
            </Line>
          ))}
        </div>
      )}

      {block.questions.length > 0 && (
        <div className="sub">
          <div className="sub-label">{block.questions.length === 1 ? "Open question" : "Open questions"}</div>
          {block.questions.map((q) => (
            <Line key={q.id} item={q} ctx={ctx} tone="open">
              <span className="line-main">{q.title}</span>
              {q.detail && q.detail !== q.title && <span className="line-note">{q.detail}</span>}
            </Line>
          ))}
        </div>
      )}

      {block.notes.length > 0 && (
        <div className="sub">
          <div className="sub-label">Constraints</div>
          {block.notes.map((n) => (
            <Line key={n.id} item={n} ctx={ctx} tone="note">
              <span className="line-main">{n.title}</span>
              {n.detail && n.detail !== n.title && <span className="line-note">{n.detail}</span>}
            </Line>
          ))}
        </div>
      )}

      {block.considered.length > 0 && (
        <div className="sub">
          <div className="sub-label">Considered</div>
          {block.considered.map((c) => (
            <Line key={c.id} item={c} ctx={ctx} tone={c.status === "superseded" ? "replaced" : "rejected"}>
              <span className="line-top">
                <s className="line-struck">{capitalize(splitTitle(c.title).choice)}</s>
                <time className="line-time">{shortTs(c.updatedAt)}</time>
              </span>
              <span className="line-note">
                {c.status === "superseded" ? "Replaced" : "Rejected"}
                {c.reason ? ` — ${c.reason}` : ""}
              </span>
            </Line>
          ))}
        </div>
      )}

      {block.resolved.length > 0 && (
        <div className="sub">
          <div className="sub-label">Answered</div>
          {block.resolved.map((q) => (
            <Line key={q.id} item={q} ctx={ctx} tone="resolved">
              <span className="line-main muted">{q.title}</span>
              {q.reason && <span className="line-note">{q.reason}</span>}
            </Line>
          ))}
        </div>
      )}

      {block.actions.length > 0 && (
        <div className="owners">
          {block.actions.map((a) => (
            <a key={a.id} className="owner-chip" href={`#a-${a.id}`} title={a.title}>
              {a.owner ? <Avatar name={a.owner} size={16} /> : <span className="owner-none" />}
              <span className="owner-chip-text">
                {a.owner ? `${a.owner}: ` : ""}
                {a.title}
              </span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- meeting-wide sections ----------

function Section({ title, count, children, id }: { title: string; count?: number; children: ReactNode; id?: string }) {
  return (
    <section className="doc-section" id={id} data-anchor={id}>
      <h2 className="section-title">
        {title}
        {count !== undefined && count > 0 && <span className="section-count">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function ActionTable({ actions, ctx }: { actions: Item[]; ctx: Ctx }) {
  return (
    <div className="table" role="table" aria-label="Action items">
      <div className="tr th" role="row">
        <span role="columnheader">Owner</span>
        <span role="columnheader">Task</span>
        <span role="columnheader">Due</span>
      </div>
      {actions.map((a) => (
        <ItemRow key={a.id} item={a} ctx={ctx} className="tr">
          <span className="td owner" id={`a-${a.id}`}>
            {a.owner ? (
              <>
                <Avatar name={a.owner} size={18} />
                {a.owner}
              </>
            ) : (
              <span className="muted">Unassigned</span>
            )}
          </span>
          <span className="td task">
            {a.title}
            {a.topic && ctx.state.topics[a.topic] && <span className="task-topic">{ctx.state.topics[a.topic]!.title}</span>}
          </span>
          <span className="td due">{a.due || <span className="muted">—</span>}</span>
        </ItemRow>
      ))}
    </div>
  );
}

const SOURCE_LABEL = { agent: "Agent", editor: "Diagram", human: "You" } as const;

function Changelog({ events }: { events: ChangeEvent[] }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const list = [...events].reverse();
  const shown = all ? list : list.slice(0, 40);
  return (
    <section className="doc-section changelog">
      <button className="disclosure" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={14} className="disclosure-chev" />
        <span className="section-title inline">Changelog</span>
        <span className="section-count">{events.length}</span>
      </button>
      {open && (
        <ol className="log">
          {shown.map((e) => (
            <li key={e.seq} className="log-row">
              <time>{shortTs(e.ts)}</time>
              <span className={`log-src src-${e.source}`}>{SOURCE_LABEL[e.source] ?? e.source}</span>
              <span className="log-text">{e.summary}</span>
            </li>
          ))}
          {!all && list.length > shown.length && (
            <li>
              <button className="link-btn" onClick={() => setAll(true)}>
                Show all {list.length}
              </button>
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

// ---------- the page ----------

function participants(transcript: Utterance[]): string[] {
  const count = new Map<string, number>();
  for (const u of transcript) count.set(u.speaker, (count.get(u.speaker) ?? 0) + 1);
  return [...count.entries()]
    .filter(([n]) => !["Guest", "Unknown speaker"].includes(n))
    .sort((a, b) => b[1] - a[1])
    .map(([n]) => n);
}

function dateOf(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function Doc({ snap, fresh, now, dark, clock, onEdit, focus, onFocus }: DocProps) {
  const state = snap.state;
  const model = useMemo(() => buildDoc(state), [state]);
  const people = useMemo(() => participants(snap.transcript), [snap.transcript]);
  const ctx: Ctx = { state, fresh, now, onEdit, readOnly: snap.readOnly };
  const root = useRef<HTMLElement>(null);
  const title = docTitle(state.meeting.title, snap.title);
  const summary = state.meeting.overview?.trim() || state.meeting.context?.trim();
  const c = model.counts;
  const summaryFresh = freshAt(ctx, "doc-summary");

  // Scroll to and flash whatever the activity feed or the diagram pointed at.
  useEffect(() => {
    if (!focus || !root.current) return;
    const find = (id: string) => root.current!.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(id)}"]`);
    let el = find(focus.id);
    if (!el) {
      const item = state.items[focus.id];
      const block = model.blocks.find((b) => b.ids.includes(focus.id));
      el = (item?.topic && find(item.topic)) || (block && find(block.topicId ?? block.key)) || null;
    }
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("focus-flash");
    void el.offsetWidth;
    el.classList.add("focus-flash");
    const t = setTimeout(() => el!.classList.remove("focus-flash"), 1800);
    return () => clearTimeout(t);
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  const wideEmpty = !model.requirements.length && !model.nonGoals.length && !model.facts.length && !model.questions.length;
  const live = snap.status === "running" || snap.status === "paused";

  return (
    <article className="doc" ref={root}>
      <header className="doc-head">
        <h1 className={`doc-title${state.meeting.title ? "" : " placeholder"}`}>{title}</h1>
        <div className="meta">
          {people.length > 0 && (
            <span className="meta-people" title={people.join(", ")}>
              <span className="avatars">
                {people.slice(0, 5).map((p) => (
                  <Avatar key={p} name={p} size={22} />
                ))}
              </span>
              <span>
                {people.slice(0, 3).join(", ")}
                {people.length > 3 ? ` +${people.length - 3}` : ""}
              </span>
            </span>
          )}
          <span className="meta-sep" />
          <span>{dateOf(snap.createdAt)}</span>
          {live && snap.mode === "live" && (
            <>
              <span className="meta-sep" />
              <span className="meta-live">Live · {shortTs(clock)}</span>
            </>
          )}
          {c.decided + c.tentative + c.open + c.actions > 0 && <span className="meta-sep" />}
          <span className="meta-counts" hidden={c.decided + c.tentative + c.open + c.actions === 0}>
            <span className="mc">
              <span className="dot dot-decided" />
              {c.decided + c.tentative} decided
            </span>
            <span className="mc">
              <span className="dot dot-open" />
              {c.open} open
            </span>
            <span className="mc">
              <span className="dot dot-action" />
              {plural(c.actions, "action")}
            </span>
          </span>
        </div>
      </header>

      {model.needsReview.length > 0 && (
        <button className="review-banner" onClick={() => onFocus(model.needsReview[0]!.id)}>
          <span className="dot dot-review" />
          <span>
            <b>{plural(model.needsReview.length, "item")} need confirmation.</b> The agent wasn’t sure it heard {model.needsReview.length === 1 ? "this" : "these"} right.
          </span>
          <span className="review-banner-go">Review</span>
        </button>
      )}

      <section className={`summary${summaryFresh ? " is-fresh" : ""}`} id="doc-summary" data-anchor="doc-summary">
        {summaryFresh > 0 && <span className="wash" key={summaryFresh} aria-hidden />}
        {summary ? <p>{summary}</p> : <p className="placeholder">The summary appears once the agent has heard enough of the discussion.</p>}
      </section>

      <ArchitectureFigure state={state} fresh={fresh} now={now} dark={dark} onFocusItem={onFocus} />

      <Section title="Topics" count={model.blocks.length}>
        {model.blocks.length === 0 ? (
          <p className="empty-note">Nothing decided yet. Each question the team works on gets a section here, with the decision, the reasoning and what was considered.</p>
        ) : (
          <div className="topics">
            {model.blocks.map((b) => (
              <TopicBlock key={b.key} block={b} ctx={ctx} />
            ))}
          </div>
        )}
      </Section>

      {model.questions.length > 0 && (
        <Section title="Open questions" count={model.questions.length}>
          {model.questions.map((q) => (
            <Line key={q.id} item={q} ctx={ctx} tone="open">
              <span className="line-main">{q.title}</span>
              {q.detail && q.detail !== q.title && <span className="line-note">{q.detail}</span>}
            </Line>
          ))}
        </Section>
      )}

      {(model.requirements.length > 0 || model.nonGoals.length > 0) && (
        <Section title="Requirements" count={model.requirements.length}>
          {model.requirements.map((r) => (
            <Line key={r.id} item={r} ctx={ctx} tone="note">
              <span className="line-main">{r.title}</span>
              {r.detail && r.detail !== r.title && <span className="line-note">{r.detail}</span>}
            </Line>
          ))}
          {model.nonGoals.length > 0 && (
            <div className="sub">
              <div className="sub-label">Out of scope</div>
              {model.nonGoals.map((r) => (
                <Line key={r.id} item={r} ctx={ctx} tone="muted">
                  <span className="line-main">{r.title}</span>
                  {r.detail && r.detail !== r.title && <span className="line-note">{r.detail}</span>}
                </Line>
              ))}
            </div>
          )}
        </Section>
      )}

      {model.facts.length > 0 && (
        <Section title="Context" count={model.facts.length}>
          {model.facts.map((f) => (
            <Line key={f.id} item={f} ctx={ctx} tone="muted">
              <span className="line-main">{f.title}</span>
              {f.detail && f.detail !== f.title && <span className="line-note">{f.detail}</span>}
            </Line>
          ))}
        </Section>
      )}

      {model.actions.length > 0 && (
        <Section title="Action items" count={model.actions.length} id="doc-actions">
          <ActionTable actions={model.actions} ctx={ctx} />
        </Section>
      )}

      {wideEmpty && model.actions.length === 0 && model.blocks.length > 0 && <div className="spacer" />}

      {snap.events.length > 0 && <Changelog events={snap.events} />}
    </article>
  );
}
