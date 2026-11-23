/**
 * The operations the agent (or a human, through the UI) can apply to the doc state.
 * Each operation is also exposed to the model as a tool with the same name.
 */
import { z } from "zod";
import { COMPONENT_TYPES, ITEM_KINDS, ITEM_STATUSES } from "./types.js";

/**
 * Models occasionally send an array argument as a JSON-encoded string ("[\"a\"]") or a bare
 * string; accept both rather than burning a round-trip on it.
 */
function lenientArray<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const t = v.trim();
    if (t.startsWith("[")) {
      try {
        return JSON.parse(t);
      } catch {
        /* fall through to slug extraction */
      }
    }
    return t.match(/[a-z0-9][a-z0-9-]{1,60}/g) ?? [];
  }, z.array(inner));
}

const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,60}$/, "ids are lowercase slugs like 'dec-queue-sqs'");

/** Grounding: every change the agent makes must point at what was actually said. */
const grounding = {
  ts: z.string().describe("Timestamp (HH:MM:SS) of the utterance that supports this change."),
  quote: z
    .string()
    .min(3)
    .describe("Short verbatim excerpt (a few words to one sentence) from that utterance."),
};

export const RecordItem = z.object({
  id: id.describe(
    "New unique slug id. Prefix by kind: req-, ng-, fact-, dec-, q-, act-. e.g. 'dec-queue-sqs'.",
  ),
  kind: z.enum(ITEM_KINDS),
  title: z.string().min(3).max(120).describe("Short noun phrase, e.g. 'Delivery queue: SQS + DLQ'."),
  detail: z
    .string()
    .min(3)
    .describe(
      "The current statement, written as documentation in 1-3 sentences. Include concrete values (numbers, durations, names).",
    ),
  status: z.enum(ITEM_STATUSES),
  reason: z
    .string()
    .nullable()
    .optional()
    .describe("The team's rationale for this item as it now stands. Never mention earlier values here."),
  owner: z.string().nullable().optional().describe("For action items: who took it."),
  due: z.string().nullable().optional().describe("For action items: due date exactly as said, else null."),
  related: lenientArray(id).optional().describe("Ids of related items."),
  revised_from: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Only if the value was stated and then revised within the new lines: the earlier statement (e.g. 'auto-disable after 3 days'). It goes to the changelog, not the doc.",
    ),
  ...grounding,
});
export type RecordItem = z.infer<typeof RecordItem>;

export const UpdateItem = z.object({
  id,
  title: z.string().min(3).max(120).optional(),
  detail: z.string().min(3).optional().describe("Full replacement statement (not a diff)."),
  status: z.enum(ITEM_STATUSES).optional(),
  owner: z.string().nullable().optional(),
  due: z.string().nullable().optional(),
  related: lenientArray(id).optional(),
  rationale: z
    .string()
    .nullable()
    .optional()
    .describe(
      "When you change detail: the item's rationale as it now stands, without old values. Omitted, the previous rationale is dropped (it may describe the old version).",
    ),
  reason: z
    .string()
    .min(3)
    .describe(
      "Why it changed, in the team's terms (goes to the changelog). For status changes (accepted, rejected, resolved...) it also becomes the item's shown rationale.",
    ),
  ...grounding,
});
export type UpdateItem = z.infer<typeof UpdateItem>;

export const SupersedeItem = z.object({
  old_id: id,
  new_id: id.describe("The replacing item. Create it with record_item first (earlier in the same response is fine)."),
  reason: z.string().min(3),
  ...grounding,
});
export type SupersedeItem = z.infer<typeof SupersedeItem>;

export const UpsertComponent = z.object({
  id: id.describe("Slug prefixed 'cmp-', e.g. 'cmp-delivery-worker'."),
  name: z.string().min(2).max(60),
  type: z.enum(COMPONENT_TYPES),
  description: z.string().min(3).describe("What it does in this design, 1-2 sentences."),
  basis: lenientArray(id)
    .refine((a) => a.length > 0, "at least one basis id")
    .describe(
      "Item ids (decisions, requirements, open questions) that put this component in the design. The component is shown only while at least one basis item is accepted/tentative; it is drawn as TBD if its basis is only open questions.",
    ),
});
export type UpsertComponent = z.infer<typeof UpsertComponent>;

export const RemoveComponent = z.object({
  id,
  reason: z.string().min(3),
  ...grounding,
});
export type RemoveComponent = z.infer<typeof RemoveComponent>;

export const UpsertEdge = z.object({
  from: id,
  to: id,
  label: z.string().max(40).describe("Short verb phrase, e.g. 'enqueue event'."),
  basis: lenientArray(id).refine((a) => a.length > 0, "at least one basis id"),
});
export type UpsertEdge = z.infer<typeof UpsertEdge>;

export const RemoveEdge = z.object({
  from: id,
  to: id,
  reason: z.string().min(3),
});
export type RemoveEdge = z.infer<typeof RemoveEdge>;

export const SetMeetingInfo = z.object({
  title: z.string().min(3).max(100).describe("Title of the design doc, e.g. 'Outbound webhooks: design'."),
  context: z.string().min(3).describe("1-3 sentences: what is being designed and why."),
  ...grounding,
});
export type SetMeetingInfo = z.infer<typeof SetMeetingInfo>;

export const OPS = {
  set_meeting_info: SetMeetingInfo,
  record_item: RecordItem,
  update_item: UpdateItem,
  supersede_item: SupersedeItem,
  upsert_component: UpsertComponent,
  remove_component: RemoveComponent,
  upsert_edge: UpsertEdge,
  remove_edge: RemoveEdge,
} as const;
export type OpName = keyof typeof OPS;
export type OpInput<N extends OpName> = z.infer<(typeof OPS)[N]>;

export interface Op<N extends OpName = OpName> {
  name: N;
  input: OpInput<N>;
}

export function isOpName(name: string): name is OpName {
  return Object.prototype.hasOwnProperty.call(OPS, name);
}
