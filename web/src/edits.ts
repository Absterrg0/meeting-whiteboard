/** Human edits from the document, as the same operations the agent uses. */
import type { DocState, Item } from "../../src/core/types";
import type { UiOp } from "./api";

export type EditFn = (op: UiOp) => Promise<string | null>;

export interface MenuAction {
  key: string;
  label: string;
  run?: () => Promise<string | null>;
  /** Opens an inline form instead of running directly. */
  form?: "edit" | "replace";
  danger?: boolean;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "item"
  );
}

export function newId(prefix: string, title: string): string {
  return `${prefix}-${slug(title)}-${Math.random().toString(36).slice(2, 6)}`;
}

function liveDecisionIn(state: DocState, topic: string | null, except: string): Item | null {
  if (!topic) return null;
  return (
    Object.values(state.items).find(
      (i) => i.id !== except && i.topic === topic && i.kind === "decision" && (i.status === "accepted" || i.status === "tentative"),
    ) ?? null
  );
}

export function itemActions(item: Item, state: DocState, edit: EditFn): MenuAction[] {
  const out: MenuAction[] = [];
  const update = (input: Record<string, unknown>) => edit({ name: "update_item", input: { id: item.id, ...input } });
  const lowConf = item.confidence === "low" && !["rejected", "superseded", "dropped", "resolved", "done"].includes(item.status);
  if (lowConf) out.push({ key: "confirm", label: "Confirm", run: () => edit({ name: "confirm_item", input: { id: item.id } }) });
  out.push({ key: "edit", label: "Edit text…", form: "edit" });
  if (item.kind === "decision") {
    if (item.status === "proposed") {
      const current = liveDecisionIn(state, item.topic, item.id);
      out.push({
        key: "accept",
        label: current ? "Accept (replaces current)" : "Accept",
        run: () =>
          current
            ? edit({ name: "supersede_item", input: { old_id: current.id, new_id: item.id, new_status: "accepted", reason: "chosen in the doc" } })
            : update({ status: "accepted", reason: "accepted in the doc" }),
      });
      out.push({ key: "reject", label: "Reject", danger: true, run: () => update({ status: "rejected", reason: "rejected in the doc" }) });
    } else if (item.status === "accepted" || item.status === "tentative") {
      out.push({ key: "replace", label: "Replace with…", form: "replace" });
      if (item.status === "tentative") out.push({ key: "firm", label: "Mark as decided", run: () => update({ status: "accepted", reason: "confirmed in the doc" }) });
      out.push({ key: "reject", label: "Reject", danger: true, run: () => update({ status: "rejected", reason: "rejected in the doc" }) });
    } else if (item.status === "rejected") {
      out.push({ key: "reconsider", label: "Reconsider", run: () => update({ status: "proposed", reason: "reopened in the doc" }) });
    }
  } else if (item.kind === "open_question" && item.status === "open") {
    out.push({ key: "resolve", label: "Mark resolved", run: () => update({ status: "resolved", reason: "resolved in the doc" }) });
    out.push({ key: "drop", label: "Remove", danger: true, run: () => update({ status: "dropped", reason: "removed in the doc" }) });
  } else if (item.kind === "action_item" && item.status === "open") {
    out.push({ key: "done", label: "Mark done", run: () => update({ status: "done", reason: "done" }) });
    out.push({ key: "drop", label: "Remove", danger: true, run: () => update({ status: "dropped", reason: "removed in the doc" }) });
  } else if (["requirement", "non_goal"].includes(item.kind) && (item.status === "accepted" || item.status === "tentative")) {
    out.push({ key: "replace", label: "Replace with…", form: "replace" });
    out.push({ key: "drop", label: "Remove", danger: true, run: () => update({ status: "dropped", reason: "removed in the doc" }) });
  } else if (item.kind === "fact" && item.status === "accepted") {
    out.push({ key: "drop", label: "Remove", danger: true, run: () => update({ status: "dropped", reason: "removed in the doc" }) });
  }
  return out;
}

export function moveToTopic(item: Item, topic: string | null, edit: EditFn) {
  return edit({ name: "update_item", input: { id: item.id, topic, reason: "moved in the doc" } });
}

export function saveText(item: Item, title: string, detail: string, edit: EditFn) {
  const input: Record<string, unknown> = { id: item.id, reason: "edited in the doc" };
  if (title.trim() && title.trim() !== item.title) input.title = title.trim();
  if (detail.trim() && detail.trim() !== item.detail) input.detail = detail.trim();
  if (Object.keys(input).length === 2) return Promise.resolve(null);
  return edit({ name: "update_item", input });
}

/** Record the replacement as a proposal in the same topic, then supersede the old item with it. */
export async function replaceWith(item: Item, title: string, edit: EditFn): Promise<string | null> {
  const prefix = item.kind === "decision" ? "dec" : item.kind === "non_goal" ? "ng" : "req";
  const id = newId(prefix, title);
  const err = await edit({
    name: "record_item",
    input: {
      id,
      kind: item.kind,
      title: title.trim(),
      detail: title.trim(),
      status: "proposed",
      topic: item.topic,
      reason: null,
    },
  });
  if (err) return err;
  return edit({
    name: "supersede_item",
    input: { old_id: item.id, new_id: id, new_status: item.status === "tentative" ? "tentative" : "accepted", reason: "replaced in the doc" },
  });
}
