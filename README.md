# Meeting Whiteboard

An agent that sits in a technical meeting and keeps a design doc and an architecture diagram correct as the discussion moves, including when the team changes its mind.

It takes a meeting as it happens (a transcript replayed in real time or faster, or lines typed live), and maintains:

- a **design doc**: context, goals and non-goals, architecture, accepted decisions with their reasons, open questions, action items, a decision log of rejected and superseded options, and a changelog;
- a **diagram** (Mermaid) that only shows what the team agreed on, with undecided parts drawn as TBD;
- an **audit trail**: every change is an event tied to the moment in the meeting that caused it, with a verbatim quote.

## Quick start

Requirements: Node 20+ and pnpm. An Anthropic API key.

```bash
pnpm install
cp .env.example .env          # then put your ANTHROPIC_API_KEY in .env
pnpm start                    # builds the UI and serves it on http://localhost:8787
```

In the UI: pick a transcript (or paste one), pick a speed, press Start. You can type lines into the meeting at any time with the inject box (for example a reversal: "Actually, let's make it seven days"), and correct the agent from the Decisions tab.

Other entry points:

```bash
pnpm dev                                            # server + Vite dev server with hot reload
pnpm replay transcripts/webhooks-design-review.jsonl # headless run; writes out/<run>/design-doc.md, state.json, events.jsonl
pnpm eval                                           # replays the held-out meetings and grades the result
pnpm test                                           # unit tests (no network)
```

Transcript formats accepted: JSONL (`{"time": "00:01:10", "speaker": "...", "text": "..."}` per line), a JSON array of the same, plain lines like `[00:01:10] Name: text`, or a markdown table `| time | speaker | text |`.

Model settings (in `.env` or the environment): `MODEL` (default `claude-sonnet-5-5`), `EFFORT` (`low` | `medium` | `high`, default `medium`). A full replay of the 29-minute sample costs about $0.60 with the defaults.

## How it works

```
 transcript source ──▶ batcher ──▶ agent step ──▶ reducer ──▶ state + event log ──▶ doc.md / diagram / UI
 (replay | live)      (serial)    (LLM + tools)  (validates,        ▲
                                                   grounds)          └── human edits (same operations)
```

1. **Batcher** (`src/session.ts`). Lines are buffered and handed to the agent when 4 are waiting, when the oldest has waited 45 s of meeting time, or straight away when a line sounds like a decision ("let's go with", "changing that", "let's drop"...). The cue list only makes updates faster; it never decides anything. The agent runs serially; if it is slow, lines pile up and go into the next batch. A failed model call is retried with the same lines; after three failures in a row the lines are skipped and the skip is logged, so one bad batch cannot stall the meeting.
2. **Agent step** (`src/agent/`). One model call per batch with: the current state (compact), the last ~24 already-processed lines for context, and the new lines. The model answers with tool calls, one per change: `record_item`, `update_item`, `supersede_item`, `upsert_component`, `remove_component`, `upsert_edge`, `remove_edge`, `set_meeting_info`. Each call is applied to the live session state as it arrives (the UI updates call by call), and validation errors go back to the model as tool errors so it can correct itself (up to 4 rounds per batch). The agent never holds its own copy of the state, so a human edit made while the model is thinking is not overwritten.
3. **Reducer** (`src/core/reducer.ts`). Validates each operation and applies it to the state. It rejects:
   - statuses that make no sense for the kind of item (an action item cannot be "accepted");
   - references to ids that do not exist;
   - superseding something already rejected;
   - and any agent change whose quote (at least three words) cannot be found within 90 s of the cited timestamp. A quote with a wrong timestamp is accepted only if it is an exact match of five or more words (`src/core/grounding.ts`). That is the guard against the model writing things nobody said.
4. **Projections** (`src/core/render.ts`). The doc and the diagram are pure functions of the state. Revisions overwrite the current value and the old one goes to the item's history, so an old value cannot linger in the doc. It only shows up in the changelog.
5. **End-of-meeting review.** When the meeting ends, one more pass looks at the full transcript and the state and fixes what incremental processing tends to miss: a sketch the team adopted without saying "agreed", stale component descriptions, duplicates. It uses the same tools and checks.

### The state

Items have a kind (`requirement`, `non_goal`, `fact`, `decision`, `open_question`, `action_item`) and a status (`proposed`, `accepted`, `tentative`, `rejected`, `superseded`, `open`, `resolved`, `done`, `dropped`). Every item keeps its evidence (timestamp, speaker, quote), its history of changes with reasons, and `supersedes` / `supersededBy` links.

Components and edges carry a **basis**: the item ids that put them in the design. Visibility is derived, not remembered by the model:

| Basis items | Diagram |
|---|---|
| at least one accepted or tentative decision (or requirement, if there are no decisions in the basis) | shown |
| only an open question | shown dashed as TBD |
| only proposals | hidden (shown greyed with "show proposals") |
| all rejected or superseded | gone |

If a basis contains decisions, only the decisions count, so when the team drops the option a component depended on, the component leaves the diagram even if the model forgets to remove it. Facts ("today a nightly job rebuilds the index") never put anything on the diagram: it shows the target design, not the system being replaced.

### Rules the agent follows (see `src/agent/prompt.ts`)

- "What if we...", "I'd use..." is a proposal. Agreement makes a decision: an explicit call, an explicit endorsement, or the team building on it without objection. Job titles do not matter.
- "For now, revisit later" is tentative. "Not deciding that today" is an open question, usually with an action item.
- A reversal records the new decision and supersedes the old one with the reason. A revised number rewrites the detail; the old value lives only in history and the changelog.
- Small talk is ignored. Due dates are kept exactly as said ("by Friday").

### Human corrections

Every item in the Decisions tab can be accepted, rejected, dropped or edited, and new items can be added. A human edit goes through the same reducer as an event with `source: human` and pins the item. The agent can still change a pinned item, but only with a quote from a line said *after* the human edit (checked by transcript position), so a correction is not overwritten by the agent re-reading the same discussion, while a later revisit in the meeting still gets picked up. A superseded item cannot be revived in place; going back to an old option is recorded as a new decision that supersedes the current one, so the history stays linear.

The model's rationale for an item ("Why") is kept separate from the reason for a change. When a value is revised, the change reason ("from 12 to 32 partitions because...") goes to the changelog, and the item's rationale is restated or dropped, so an old value cannot come back through the "Why" line.

## Design choices and trade-offs

| Choice | Why | Cost |
|---|---|---|
| Explicit state + operations, not "rewrite the doc" | Each change is checkable, attributable to a moment, reversible, and listed in a changelog. Per-call cost stays flat regardless of meeting length. | More schema and code than a single summarization prompt. |
| Rendered doc, not model-written prose | Old values cannot survive a revision; the doc structure is stable between updates. | The prose is plainer than a hand-written doc. Item details are written by the model, which keeps them readable. |
| Diagram visibility derived from decision status | The diagram cannot show a rejected option as chosen, and drops components when their basis goes away. | The model must link components to items (enforced by the reducer). |
| Grounding check on every agent change | Cheap, deterministic protection against invented content. | Occasionally a paraphrased quote is rejected and costs a retry round. |
| Batches of a few lines, not every line | Decisions span several turns; a little context avoids flip-flopping and saves calls. | Updates lag the conversation by up to ~45 s of meeting time (less after a decision cue). |
| Sonnet 5.5 at medium effort by default | Fast enough to keep up in real time; ~$0.60 per 30-minute meeting. | Opus is available with `MODEL=claude-opus-5-5`. |

## Assumptions

- One meeting per session. The doc starts empty; carrying it across meetings is listed under next steps.
- Agreement is judged from what people say, not from roles.
- The transcript already has speaker names (from a meeting platform or diarization). Live audio capture is out of scope; the inject box stands in for it.
- Timestamps in the transcript are meeting-relative.

## Evaluation

`transcripts/webhooks-design-review.jsonl` is the sample meeting from the brief and was the dev set. To check the system is not tuned to it, `transcripts/` also has meetings in other domains, written for this project, with expected outcomes in `expected/`. `pnpm eval` replays them and grades the result with deterministic checks (e.g. "the old retention value must not appear in the current doc", "the removed service must not be in the diagram") plus an LLM judge for checks that need reading comprehension.

## What I would do next

- **Long meetings**: summarize processed transcript into a rolling digest so context stays small, and run the review pass periodically (e.g. every 10 minutes) rather than only at the end.
- **Live audio**: a streaming speech-to-text source with diarization (the `MeetingSession.addUtterance` interface is already the seam), or a meeting bot.
- **Multi-meeting docs**: load a previous meeting's state as the starting point; treat it as baseline that the new meeting can revise.
- **Confidence and review queue**: let the agent mark low-confidence changes for a human to confirm instead of applying them straight away.
- **Export**: push the doc to Notion/Confluence/GitHub and the diagram as an image; open a PR when a decision changes.
- **Eval**: more meetings, multiple runs per meeting to measure variance, and per-trap scores tracked over prompt changes.

## Repository layout

```
src/core/       types, operations (zod), reducer, grounding, renderers   — no model calls
src/agent/      prompt, tools, agent step loop, review pass
src/ingest/     transcript parsing
src/session.ts  batcher, meeting clock, replay, human edits, outputs
src/server.ts   HTTP API + SSE for the UI
src/cli.ts      headless replay
src/eval.ts     replay + grading against expected/
web/            React UI
transcripts/    sample + held-out meetings
expected/       expected outcomes for the held-out meetings
test/           unit tests
```

## How the time was spent

_To be filled in._
