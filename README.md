# Meeting Whiteboard

An agent that joins a technical meeting and keeps a design doc and an architecture diagram correct while people talk, including when the team changes its mind.

It takes the meeting as it happens: a transcript replayed in real time (any common export format), your microphone or a meeting tab's audio, or a bot that joins a Zoom / Google Meet / Teams call. From that it maintains:

- a **design doc organised by topic**: a summary, requirements and constraints, the architecture, then one section per question the meeting worked on ("Delivery queue", "Secret storage"), each with its current answer and reason, open points, owners, and what was considered and turned down or replaced; plus open questions, action items and a changelog;
- a **diagram** (Mermaid) of the design the team agreed on, with undecided parts drawn as TBD and rejected options never shown;
- an **audit trail**: every change is an event tied to the line that caused it, with a verbatim quote.

## Quick start

Requirements: Node 20+, pnpm, and an Anthropic or OpenAI API key.

```bash
pnpm install
cp .env.example .env     # put ANTHROPIC_API_KEY (and/or OPENAI_API_KEY) in .env
pnpm start               # builds the UI and serves it on http://localhost:8787
```

The start screen offers four ways in:
- **Replay a transcript** (pick one, or paste/upload any export) at a chosen speed;
- **Go live** with your microphone or a meeting tab's audio;
- **Join a meeting** with the bot;
- **Open a past session** from `out/`. It opens instantly, costs nothing, and can be replayed to watch the doc build up.

The meeting view is a single document:
- a title, the summary, and the architecture diagram (pan/zoom; hover a component to see its connections; toggle proposals);
- one section per topic.

A sidebar holds the **Activity** feed (each change in plain words, with the quote behind it) and the live **Transcript**. Type into the meeting at any time ("Actually, let's make it seven days"). Hover any item to confirm, edit, reject or replace it.

```bash
pnpm dev                                    # server + Vite dev server with hot reload
pnpm replay transcripts/adv-flipflop.jsonl  # headless run: prints each change, writes out/<run>/design-doc.md, state.json, events.jsonl
pnpm eval --runs 2                          # replays every meeting with expected outcomes, grades, reports stability across runs
pnpm test                                   # unit tests, no network
```

**Models.** Any Anthropic or OpenAI model, set as `<provider>/<model>`:

```bash
MODEL=anthropic/claude-sonnet-5-5   EFFORT=medium   # default
MODEL=anthropic/claude-opus-5-5     EFFORT=low
MODEL=openai/gpt-6-luna             EFFORT=medium
EDITOR_MODEL=...  EDITOR_EFFORT=...                 # optional: a different model for the diagram/summary
```

The same flags work on the CLI and the eval: `--model`, `--effort`, `--editor-model`, `--editor-effort`.

Live sources (microphone, meeting tab, Recall.ai bot) are described in [docs/live-sources.md](docs/live-sources.md).

## How it works

```
 sources                          scribe (every speaker turn)                    state                     views
 ─────────                        ───────────────────────────                    ─────                     ─────
 transcript replay ─┐             one append-only conversation:                  items                     design-doc.md
 mic / tab audio ───┼─ session ─▶ new lines in → tool calls out ── reducer ──▶   components, edges   ──▶   Mermaid diagram
 meeting bot ───────┤  (serial)   (cached prefix; calls applied   (validates,    event log                 web UI (SSE)
 typed lines ───────┘             as they stream)                  grounds)        ▲    │
                                                                                   │    ▼ items changed (debounced)
                                  editor (debounced) ── whole diagram + summary ───┘  diff applied by code
                                  human edits in the UI ─────────── same operations, pinned
```

The work is split by how fast and how globally each part has to think.

**The scribe** (`src/agent/scribe.ts`) turns what is said into operations on **topics** and **items**: `upsert_topic`, `record_item`, `update_item`, `supersede_item`, `confirm_item`, `set_meeting_info`. A topic is one question the meeting works on ("Which queue carries deliveries?"). Every option, decision, open question and owner for that question hangs off it, and a topic can have **at most one live answer**: a second accepted decision in the same topic is refused, so changing an answer is always an explicit supersede, never two contradictory "decided" items.
- It runs after every speaker turn. Lines that arrive while it is busy go into its next turn, so a slow call never drops input or builds a queue.
- It keeps **one append-only conversation per meeting**, so each turn sends only the new lines. Everything before them is a cached prefix, which keeps the time to first token and the cost flat as the meeting goes on. After 40 turns or 60k tokens it restarts from a snapshot of the state, so long meetings stay bounded.
- Each tool call is **applied while the response is still streaming**, so the doc updates call by call. The model gets a second round only when a call fails validation.

**The editor** (`src/agent/editor.ts`) maintains the diagram and the summary.
- It runs when architecture-relevant items change: debounced by 4 s, at most 15 s behind, and once at the end.
- It is **declarative**. Given all the items and the current diagram, the model returns the *complete* intended diagram and summary. Code diffs that against the current diagram and applies only the difference.
- Same decisions in, same diagram out: the diagram can't accumulate stale edits, and applying the plan twice changes nothing.
- The summary is screened in code. Sentences that mention options that were turned down or replaced are dropped.

**The reducer** (`src/core/reducer.ts`) validates every operation, from either agent or a human, before it touches the state. It rejects:
- statuses that make no sense for the kind of item (an action item cannot be "accepted");
- references to ids that don't exist;
- reviving a superseded item in place (going back to an old option is a new decision that supersedes the current one);
- an agent change whose quote (three or more words, or a short exact phrase) is not found within 90 s of the cited time. This is the guard against writing things nobody said (`src/core/grounding.ts`);
- a revision that leaves the replaced number in the item's title or rationale ("7 days" → "14 days" with a title still saying 7). Deterministic, so **an old value cannot linger** in the doc; it lives only in the history and the changelog.

**The projections** (`src/core/render.ts`) are pure functions of the state. Current sections show only current values; replaced, rejected and settled things go to the decision log.

**Consolidation** runs every 5 minutes of meeting time, beside the normal turns, so it doesn't add lag. It is a one-off scribe pass over the last ~8 minutes and the state. It files loose items into topics, merges duplicate topics, accepts proposals the team clearly adopted, rejects ones that were overtaken, rewrites stale wording, and confirms low-confidence items the discussion has since settled. **At the end** the same pass runs over the whole meeting, then the editor runs once more.

**Confidence.** When agreement is only implied, or an owner or value is unclear, the scribe marks the item `confidence: low`. The doc and the UI show it as "to confirm" until a person confirms it (one click) or a later pass does.

### The state

**Topics** have a title and a question. Their status is derived from their items, never set by the model: decided, tentative, open, under discussion, or closed (`src/core/topics.ts`).

**Items** have a kind (`requirement`, `non_goal`, `fact`, `decision`, `open_question`, `action_item`), a status (`proposed`, `accepted`, `tentative`, `rejected`, `superseded`, `open`, `resolved`, `done`, `dropped`), an optional topic and a confidence. Each keeps its evidence (time, speaker, quote), its history of changes with reasons, and its supersede links. Every change is an event with a kind (decided, proposed, rejected, replaced, revised, opened, resolved, action…), which drives the activity feed.

Diagram components and edges carry a **basis**: the item ids that put them in the design. Visibility is derived from the basis, not remembered by a model:

| Basis | Diagram |
|---|---|
| an accepted or tentative decision (decisions dominate other kinds) | shown |
| ...and an open question about what it is ("which store?") | shown dashed as TBD |
| only proposals | hidden (greyed under "show proposals") |
| only rejected / superseded items, or only facts about today's system | gone |

### The rules the scribe applies

These are in `src/agent/prompt.ts`, as a status rubric applied the same way every time.
- "What if we..." is a proposal. Hypotheticals, illustrations and sarcasm are not recorded at all.
- An explicit call or an explicit endorsement makes a decision; so does the group building on a proposal without objection. Job titles don't count.
- "For now", "for v1, revisit", "unless the load test fails" make it tentative.
- "Not deciding today" or a debate with no conclusion makes an open question.
- One topic per independent question and one live answer per topic. A reversal records the new option and supersedes the old answer.
- A revised value updates the existing item. A relative change ("double it") is resolved to the number.
- A reason is only recorded if someone gave one; "the team agreed" is not a reason.

### Human corrections and undo

In the document, hover any item to confirm, edit, reject or replace it; items the agent was unsure about carry a "to confirm" marker. An edit goes through the same reducer as an event with `source: human`, pins the item, and is passed to the scribe as a notice on its next turn. The agent can still change a pinned item, but only with a quote from a line said after the edit. So a correction survives the agent re-reading the same discussion, while a real revisit later in the meeting is still picked up.

**Undo** works on any change, the agent's or a human's, from the Activity feed. The state is a fold over the event log, so undo is exact: the state is rebuilt from the log without that event. Later changes that relied on it no longer pass the reducer and are undone with it, and the response lists them. The undo is itself an event in the changelog, and the scribe is told about it so it doesn't just record the same thing again. The editor then brings the diagram and summary back in line.

**Stale values across items.** The reducer refuses a revision that leaves the old number in the item itself. Separately, after every revision the session scans all other live items for the number that was replaced (e.g. a fact saying "exceeds the 100/min limit" after the limit became 300) and tells the scribe on its next pass to reword them.

## Results

`transcripts/webhooks-design-review.jsonl` is the sample from the brief and was the dev set. Everything else is held out:

- three meetings I wrote early on (offline sync, search-index CDC, rate-limit smoke test);
- **six harder meetings written by a different model family (GPT-6), from the README only, without seeing the prompts**: speech-to-text-style mess, A→B→A flip-flops, hypotheticals and sarcasm, interleaved topics, and 60- and 120-minute meetings with late reversals.

`pnpm eval` replays each as a simulated live meeting: each model call takes as much meeting time as it really took, so batch sizes and lag match a real-time run. It grades deterministic checks (e.g. "the old value must not appear in the current doc", "the removed service is not in the diagram") plus an LLM judge.

Each configuration was run on all 9 meetings (21 to 34 checks each, 231 in total). Lag is the median time from a line being spoken to the doc reflecting it. Cost is the agent spend per meeting (the 2-hour meeting costs about $1).

| Configuration | Checks passed | Same verdict across 2 runs | Lag p50 | Cost per meeting |
|---|---|---|---|---|
| v2: flat item list, one agent for items, separate diagram editor (Sonnet 5.5) | 444/462 (96.1%) | 97% | ~2.2 s* | $0.79 |
| v3: topics, consolidation, all roles on Sonnet 5.5 | 442/462 (95.7%) | 96% | ~3.3 s | $0.98 |
| **v3 optimized (default)**: Sonnet 5.5 scribe, Haiku 5.5 editor, review at low effort, consolidation only after changes, one-call topic creation and reversals | **222/231 (96.1%)** | (1 run) | **~3.1 s** | **$0.51** |
| v3 on GPT-6.1 Sol (OpenAI) | 430/462 (93.1%) | 94% | ~5.0 s | $0.59 |
| Budget option: Haiku 5.5 scribe, Sonnet 5.5 review (`MODEL=anthropic/claude-haiku-5-5 REVIEW_MODEL=anthropic/claude-sonnet-5-5`) | 219/231 (94.8%) | (1 run) | ~2.9 s | $0.15 |
\* v2's simulation did not count the 0.6 s debounce.

What v3 adds over v2 is not visible in these totals, which were already high. It's in the shape of the doc (one section per question, history per topic), in stability (diagram components matched across runs went from 0.27–1.0 to 0.67–1.0), and in failure modes v2 had. Under v2, a reversal could leave two contradictory "decided" items, and a revised number could survive in a related item; under v3 the reducer and the cross-item check make both structurally impossible or flagged.

The checks that still fail are mostly subtle. An action item someone declined isn't always recorded as declined. In one 120-minute run, a component the team dropped late stayed in the diagram. On the interleaved meeting, a security topic deferred "to another meeting" is sometimes recorded as decided.

## Design choices and trade-offs

| Choice | Why | Cost |
|---|---|---|
| Explicit state + operations, not "rewrite the doc" | Each change is checkable, tied to a line, reversible and listed in the changelog. Cost per turn doesn't grow with the meeting. | More schema and code than one summarisation prompt. |
| Scribe and editor split | The scribe needs low latency and local context; the diagram needs the whole picture. One agent doing both was slow and drifted. | Two prompts; the diagram trails the doc by a few seconds. |
| Declarative editor + code diff | Same inputs give the same diagram, and nothing stale accumulates. | The editor re-reads all items each run, though it is debounced. |
| Append-only, cached scribe conversation | Latency and cost stay flat; the model sees its own earlier calls. | Restarts from a snapshot on long meetings. |
| Deterministic guards (grounding, stale values, status rules) | Failure modes that matter can't depend on the model behaving. | A rejected call costs a correction round. |
| Rendered doc, not model prose | Old values can't survive a revision; structure is stable. | Prose is plainer; the editor's summary covers the narrative. |
| Sonnet 5.5 (medium) for the scribe, Haiku 5.5 (low) for the editor and review passes | The scribe's judgement is what matters; diagram reconciliation is structured and checked by code, so a small model is enough. Measured per role: the editor fell from the largest cost line to about $0.04 per meeting. | GPT-6.1 Sol was cheaper but scored lower and lagged more (see Results). |
| Concurrent consolidation, only after changes | Catches drift during long meetings without adding lag; idle stretches cost nothing. | A fix can arrive up to 10 minutes later than a perfect scribe would have made it. |
| Lag is the model, not the pipeline | Measured per turn: 0.6 s debounce, about 1.6 s to first token, about 1.5 s to write the change. There is no queueing and a correction round is rare (1 turn in 40). | Going lower means fewer output tokens or a faster model, which trades quality. |

## Assumptions

- One meeting per session; the doc starts empty.
- Agreement is judged from what people say, not from roles.
- With live audio, speakers are set with the "Speaking now" chips, because realtime transcription has no diarization. The meeting bot gets real names from the platform.
- **Meeting bot: buy before build.** Two providers sit behind one interface (`BOT_PROVIDER`). **Recall.ai** is hosted (about $0.65/hour), with zero ops and every platform. **Attendee** is self-hosted with Docker, gets transcripts free from meeting captions, and has real speaker names. Its licence is the Elastic License 2.0, not OSI open source: fine to self-host for our own use, not to resell. Vexa is Apache-2.0 but has no real-time push yet. Writing our own browser bot (Google sign-in, admission, caption scraping, Zoom's SDK review) is days of brittle work, so it wasn't the right use of the time. Neither provider has been tested against a real call; both are tested against simulators that follow their documented and source-verified payloads.
- **Local, single user.** The server binds to 127.0.0.1 and has no auth. Sessions persist to `out/<id>/` (state, event log, transcript) and can be reopened from the start screen.

## What I would do next

- **Speaker detection for raw audio**: chunked diarization with `gpt-4o-transcribe-diarize`, with short reference clips per participant so the labels stay consistent across chunks.
- **A fast decision layer** (e.g. TypeSafe AI's Jev, a "System 1" model that picks among given options in about 0.2 s at a fraction of LLM cost):
  - Use it for the routing calls: "does this line change the doc: none / proposal / agreement / rejection / reversal / revision / question / action?" and "which existing topic?".
  - With high confidence, chatter skips the scribe entirely, which is a big saving on long meetings, and a pure status flip ("works for me" → accept the open proposal) is applied without an LLM.
  - The LLM keeps the writing; the reducer and guards stay unchanged.
  - Not done tonight. It needs its own benchmark, because published evaluations say these models judge options by name and struggle with what several records imply together, which is exactly our reversal case.
- **A review queue**: low-confidence changes are already flagged "to confirm"; next is to hold them out of the doc until confirmed when a team wants that.
- **Diagram stability**: give the editor a canonical component inventory carried between meetings, and vote over two editor samples on borderline edges.
- **Multi-meeting docs**: load a previous meeting's state as the baseline the next meeting revises.
- **Production**: the event log in Postgres (the state is already a fold over it), auth, per-team docs, export to Notion/Confluence/GitHub (a PR when a decision changes), per-meeting cost caps, tracing, and a hosted bot fleet.

## Repository layout

```
src/core/       types, operations (zod), reducer + guards, grounding, renderers   (no model calls)
src/agent/      scribe, editor, prompts, provider layer (Vercel AI SDK: Anthropic, OpenAI)
src/session.ts  scheduling, meeting clock, replay, simulated-live headless runs, human edits, outputs
src/ingest/     transcript format detection and parsing
src/live/       browser audio relay to OpenAI realtime transcription, meeting bots (Recall.ai / Attendee), tunnel
src/server.ts   HTTP API; SSE stream (full snapshot on connect, then small deltas: src/wire.ts)
src/cli.ts      headless replay        src/eval.ts   multi-run eval with stability metrics
web/            React UI               transcripts/, expected/   meetings and expected outcomes
test/           unit tests             docs/live-sources.md      live input details
```

## How the time was spent

_To be filled in._
