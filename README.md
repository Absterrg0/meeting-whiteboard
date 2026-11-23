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
 decision layer (Jev, ~0.4 s, before each scribe turn): skip chatter; apply clear accept/reject at once ──▶ reducer

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
- It runs when architecture-relevant items change: debounced by 5 s, at most 20 s behind, and once at the end.
- It is **declarative**. Given all the items and the current diagram, the model returns the *complete* intended diagram and summary. Code diffs that against the current diagram and applies only the difference.
- Same decisions in, same diagram out: the diagram can't accumulate stale edits, and applying the plan twice changes nothing.
- The summary is screened in code. Sentences that mention options that were turned down or replaced are dropped.

**The fast decision layer** (`src/agent/decider.ts`, optional: `DECISION_MODEL=typesafe-ai/jev-latest`) is a "System 1" in front of the scribe. Before each scribe turn, one decision-model call (TypeSafe AI's Jev through the AI SDK's `experimental_decide`, about 0.3–0.5 s, cents per meeting) answers typed questions about the new lines:
- *Does anything here change the design record?* If it's confidently no, the LLM turn is skipped. The lines stay pending and reach the scribe with the next lines that matter, so nothing is lost.
- *For each open proposal: accepted, accepted for now, turned down, or neither?* A confident answer (≥ 0.85) is applied at once through the reducer, so "Agreed." shows in the doc in about a second. The scribe still runs and writes the details and reasons; it is told what was applied.

The layer only picks between options built from the current state. Writing stays with the LLM, and every flip passes the same reducer checks (one live answer per topic, grounding, pinning). That is the hybrid split: a cheap, fast, typed decider for the classification-shaped steps, an LLM for language, and code for the invariants. Measured on all 9 meetings: quality was at parity (221/231 with the layer, 222/231 without, within run-to-run noise) at the same cost. 23 accept/reject flips landed in about 0.9 s instead of about 3.5 s, and on the 60- and 120-minute meetings 12–16 chatter turns skipped the LLM. It turns on automatically when `TYPESAFE_AI_API_KEY` is set (`DECISION_MODEL=off` disables it, or `openai/gpt-6-luna` uses OpenAI's decision model).

**The reducer** (`src/core/reducer.ts`) validates every operation, from either agent or a human, before it touches the state. It rejects:
- statuses that make no sense for the kind of item (an action item cannot be "accepted");
- references to ids that don't exist;
- reviving a superseded item in place (going back to an old option is a new decision that supersedes the current one);
- an agent change whose quote (three or more words, or a short exact phrase) is not found within 90 s of the cited time. This is the guard against writing things nobody said (`src/core/grounding.ts`);
- a revision that leaves the replaced number in the item's title or rationale ("7 days" → "14 days" with a title still saying 7). Deterministic, so **an old value cannot linger** in the doc; it lives only in the history and the changelog.

**The projections** (`src/core/render.ts`) are pure functions of the state. Current sections show only current values; replaced, rejected and settled things go to the decision log.

**Consolidation** runs every 10 minutes of meeting time, and only if the agent changed at least three things since the last one. It runs beside the normal turns, so it doesn't add lag. It is a one-off scribe pass over the last ~8 minutes and the state. It files loose items into topics, merges duplicate topics, accepts proposals the team clearly adopted, rejects ones that were overtaken, rewrites stale wording, and confirms low-confidence items the discussion has since settled. **At the end** the same pass runs over the whole meeting, then the editor runs once more.

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
| Default + Jev decision layer (`TYPESAFE_AI_API_KEY` set), first run | 221/231 (95.7%) | (1 run) | ~3.3 s; accept/reject flips ~0.9 s | $0.51 |
| **Final submitted version**: + topic filing from titles, a second live answer kept as a proposal, decline/deferral rules, Jev on | **225/231 (97.4%)**, 7 of 9 meetings at 100% | (1 run) | **~3.3 s; flips ~0.9 s** | **$0.48** |
| Budget option: Haiku 5.5 scribe, Sonnet 5.5 review (`MODEL=anthropic/claude-haiku-5-5 REVIEW_MODEL=anthropic/claude-sonnet-5-5`) | 219/231 (94.8%) | (1 run) | ~2.9 s | $0.15 |
\* v2's simulation did not count the 0.6 s debounce.

What v3 adds over v2 is not visible in these totals, which were already high. It's in the shape of the doc (one section per question, history per topic), in stability (diagram components matched across runs went from 0.27–1.0 to 0.67–1.0), and in failure modes v2 had. Under v2, a reversal could leave two contradictory "decided" items, and a revised number could survive in a related item; under v3 the reducer and the cross-item check make both structurally impossible or flagged.

**Blind test.** GPT-6 also wrote one more meeting (a video transcoding pipeline, plain `Name: text` lines without timestamps) plus an answer key, from the README only (`final-test/`). In a run at 4× speed, the doc matched every accepted decision, final value and action item in the key, including a declined action picked up by someone else, a lease revised from 10 to 2 minutes, and an "initial attempt plus two retries" policy. Nothing from the key's "must not appear" list appeared. It was not perfect: one rejected option (FIFO queues) was not recorded as rejected; in a faster 15× run, two of the five open questions were missed; and the diagram lacked the workers' write of outputs to storage.

The weakest meeting is still the one with interleaved topics (22/27 in the final run), where pronouns ("that one", "the second option") and topics that resume much later stress the turn-by-turn judgement. The checks that still fail are mostly subtle. An action item someone declined isn't always recorded as declined. In one 120-minute run, a component the team dropped late stayed in the diagram. On the interleaved meeting, a security topic deferred "to another meeting" is sometimes recorded as decided.

## Design choices and trade-offs

| Choice | Why | Cost |
|---|---|---|
| Explicit state + operations, not "rewrite the doc" | Each change is checkable, tied to a line, reversible and listed in the changelog. Cost per turn doesn't grow with the meeting. | More schema and code than one summarisation prompt. |
| Scribe and editor split | The scribe needs low latency and local context; the diagram needs the whole picture. One agent doing both was slow and drifted. | Two prompts; the diagram trails the doc by a few seconds. |
| Declarative editor + code diff | Same inputs give the same diagram, and nothing stale accumulates. | The editor re-reads all items each run, though it is debounced. |
| Append-only, cached scribe conversation | Latency and cost stay flat; the model sees its own earlier calls. | Restarts from a snapshot on long meetings. |
| Deterministic guards (grounding, stale values, status rules) | Failure modes that matter can't depend on the model behaving. | A rejected call costs a correction round. |
| Rendered doc, not model prose | Old values can't survive a revision; structure is stable. | Prose is plainer; the editor's summary covers the narrative. |
| Sonnet 5.5 (medium) for the scribe, Sonnet 5.5 (low) for consolidation and the final review, Haiku 5.5 (low) for the editor | The scribe's judgement is what matters; diagram reconciliation is structured and checked by code, so a small model is enough. Measured per role: the editor fell from the largest cost line to about $0.04 per meeting. | GPT-6.1 Sol was cheaper but scored lower and lagged more (see Results). |
| Concurrent consolidation, only after changes | Catches drift during long meetings without adding lag; idle stretches cost nothing. | A fix can arrive up to 10 minutes later than a perfect scribe would have made it. |
| Lag is the model, not the pipeline | Measured per turn: 0.6 s debounce, about 1.6 s to first token, about 1.5 s to write the change. There is no queueing and a correction round is rare (1 turn in 40). | Going lower means fewer output tokens or a faster model, which trades quality. |

## Assumptions

- One meeting per session; the doc starts empty.
- Agreement is judged from what people say, not from roles.
- **Speakers on live audio.** Realtime transcription has no diarization, so each finished turn's audio is also sent to `gpt-4o-transcribe-diarize`. That call carries the reference clips of voices heard so far, so labels stay consistent across the meeting: Speaker 1, Speaker 2, and so on. Renaming "Speaker 1 → Lena" rewrites the past lines too. This adds about 4.6 s per live line. On a synthetic three-voice test, labels were fully correct in 2 of 4 runs; the failure was two similar voices merged. The "Speaking now" chips override it, and `DIARIZE=0` turns it off. The meeting bot gets real names from the platform instead.
- **Meeting bot: buy before build.** Two providers sit behind one interface (`BOT_PROVIDER`). **Recall.ai** is hosted (about $0.65/hour), with zero ops and every platform. **Attendee** is self-hosted with Docker, gets transcripts free from meeting captions, and has real speaker names. Its licence is the Elastic License 2.0, not OSI open source: fine to self-host for our own use, not to resell. Vexa is Apache-2.0 but has no real-time push yet. Writing our own browser bot (Google sign-in, admission, caption scraping, Zoom's SDK review) is days of brittle work, so it wasn't the right use of the time. Attendee has been tested in a real Google Meet call, and its bot joins with real participant names. Meet's captions were too rough for design talk, so the bot now transcribes each participant's own audio with OpenAI `gpt-4o-transcribe` (`ATTENDEE_TRANSCRIPTION=openai`). The app **pulls** the bot's transcript from Attendee every 2.5 s and treats webhooks only as a fast path. Lines are deduplicated by key, so a dropped tunnel delays lines instead of losing them, and a bot still works with no public URL at all. Calls to Attendee retry when the request certainly never arrived (no connection, or a tunnel error page), so a bot is never created twice. Captions are still available as a free fallback; a growing caption line is held until it settles, so revisions aren't lost. Recall has only been tested against a simulator that follows its documented payloads.
- **Local, single user.** The server binds to 127.0.0.1 and has no auth. Sessions persist to `out/<id>/` (state, event log, transcript) and can be reopened from the start screen.

## What I would do next

- **Better speaker separation**: grow each voice's reference from later confident turns, and confirm a match against only that voice's reference before accepting it. Or move diarization off the per-line path: show the line at once and correct the label when it returns.
- **More of the decision layer.** Jev already gates chatter and applies accept/reject flips (see Results). Next: route each line to its topic ("which existing topic?") and classify the change type, so the scribe gets a narrower job. This needs its own benchmark first, because these models judge options by name and struggle with what several records imply together, which is exactly the reversal case.
- **Streaming bot audio**: take each participant's audio over Attendee's per-participant WebSocket into streaming speech-to-text, so lines appear word by word with names (today a line lands a second or two after the speaker pauses). Also read the meeting chat, so typed decisions count too.
- **A review queue**: low-confidence changes are already flagged "to confirm"; next is to hold them out of the doc until confirmed when a team wants that.
- **Diagram stability**: give the editor a canonical component inventory carried between meetings, and vote over two editor samples on borderline edges.
- **Multi-meeting docs**: load a previous meeting's state as the baseline the next meeting revises.
- **Bot infrastructure without tunnels.** In the local setup the laptop reaches a self-hosted Attendee through free Cloudflare quick tunnels, which have no uptime guarantee; the app copes by pulling transcripts, failing over between routes and retrying, but that is resilience, not a design. In production the app and the bot workers run in the same private network, the app pulls Attendee's transcript with a cursor (webhooks only as a fast path, as now), and only the web UI is public, behind a real ingress (a load balancer with TLS, or a named tunnel with replicas). The session's event log lives in Postgres, so a server restart resumes a live meeting instead of dropping it.
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

About six hours in total, from the commit history:

- **~45 min: design** before any code. Reading the brief, choosing the architecture (typed state + operations + reducer, doc and diagram rendered from state), the stack (TypeScript, Vercel AI SDK) and the evaluation plan.
- **14:00–14:45: core.** State, operations, reducer with grounding, renderers, first agent loop, server and live UI, first held-out meetings, eval harness and unit tests.
- **14:45–16:15: agent v2 and testing.** Scribe and editor split, append-only cached conversation, a hard test set written by another model family, transcript formats, live audio, stale-value guards.
- **16:15–17:45: v3.** Topic-centred core, Notion-style UI, cost and lag work (per-role models), undo over the event log, cross-item stale checks, meeting-bot providers.
- **17:45–18:45: decision layer and final benchmark.** The Jev layer, topic filing, speaker diarization, the blind meeting, 225/231.
- **18:45–19:30: a real call.** A self-hosted Attendee bot in Google Meet, with real names, per-participant speech-to-text, and polling, retries and failover so a dropped tunnel can't lose lines.

