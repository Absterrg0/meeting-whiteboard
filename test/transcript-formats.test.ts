import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseTime,
  parseTranscript,
  parseTranscriptDetailed,
  TranscriptParseError,
  type ParseResult,
} from "../src/ingest/transcript.js";

const fixture = (name: string) => readFileSync(`test/fixtures/${name}`, "utf8");
const rows = (r: ParseResult) => r.utterances.map((u) => [u.ts, u.speaker, u.text]);

describe("parseTime", () => {
  it.each([
    ["00:01:10", 70],
    ["1:02:03", 3723],
    ["04:10", 250],
    ["0:03", 3],
    ["00:00:16.239", 16.239],
    ["00:00:01,500", 1.5],
    ["12:5", NaN],
    ["hello", NaN],
  ])("%s -> %s", (s, n) => {
    if (Number.isNaN(n)) expect(parseTime(s)).toBeNaN();
    else expect(parseTime(s)).toBeCloseTo(n, 3);
  });
});

describe("format detection", () => {
  it("Zoom VTT: strips cue ids, reads 'Name: text', merges same-speaker cues < 2 s apart", () => {
    const r = parseTranscriptDetailed(fixture("zoom-transcript.vtt"));
    expect(r.format).toBe("vtt");
    expect(r.timing).toBe("given");
    expect(rows(r)).toEqual([
      ["00:00:02", "Priya Raman", "Okay, let's get started. Today is the webhook design. We need to pick a queue for the delivery workers."],
      ["00:00:11", "Marcus Lee", "I'd go with SQS. We already run it for billing."],
      ["00:00:16", "Tomás", "What about retries? We said three, right?"],
      ["00:00:22", "Priya Raman", "Let's go with SQS and five retries with exponential backoff."],
    ]);
    expect(r.utterances[0]!.t).toBeCloseTo(2.12, 2);
  });

  it("Teams VTT: <v Speaker> voice tags, GUID cue ids, entities, sentence split across cues", () => {
    const r = parseTranscriptDetailed(fixture("teams-transcript.vtt"));
    expect(r.format).toBe("vtt");
    expect(rows(r)).toEqual([
      ["00:00:03", "Aisha Khan", "So the offline mode question is really about conflict resolution when the tech comes back online."],
      ["00:00:10", "Rohan Mehta", "Last write wins is simplest. Ask R&D <eng> if unsure."],
      ["00:00:18", "Keiko Sato", "I'd rather do per-field merges, because two techs edit the same job."],
      // Same speaker as the previous Aisha cue but 40 s later: not merged.
      ["00:01:02", "Aisha Khan", "Okay, decided: per-field merge, last write wins only as a fallback."],
    ]);
  });

  it("VTT rolling captions: inline timestamps/<c> tags removed, repeated lines dropped", () => {
    const r = parseTranscriptDetailed(fixture("youtube-rolling.vtt"));
    expect(rows(r)).toEqual([["00:00:01", "Unknown speaker", "so the plan is to ship"]]);
  });

  it("does not merge cues 2 s or more apart, nor cues from different speakers", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "Ana: one",
      "",
      "00:00:04.000 --> 00:00:05.000",
      "Ana: two",
      "",
      "00:00:05.500 --> 00:00:06.000",
      "Ben: three",
    ].join("\n");
    expect(parseTranscript(vtt).map((u) => u.text)).toEqual(["one", "two", "three"]);
  });

  it("SRT: comma milliseconds, [Name] and '- Name:' labels, sound tags dropped, unlabeled cues", () => {
    const r = parseTranscriptDetailed(fixture("generic.srt"));
    expect(r.format).toBe("srt");
    expect(rows(r)).toEqual([
      ["00:00:01", "Unknown speaker", "Welcome everyone, this is the search index review. We want to move off the nightly batch job."],
      ["00:00:10", "Grace", "Change data capture from Postgres is the proposal. Debezium into Kafka, then an indexer."],
      ["00:00:17", "Wei", "How far behind can the index be?"],
    ]);
  });

  it("Zoom chat (current layout): multi-line messages, private messages skipped, wall-clock rebased", () => {
    const r = parseTranscriptDetailed(fixture("zoom-chat.txt"));
    expect(r.format).toBe("zoom-chat");
    expect(rows(r)).toEqual([
      ["00:00:00", "Priya Raman", "Agenda: queue choice, retries, signing"],
      ["00:01:29", "Marcus Lee", "+1 to SQS we already pay for it"],
      ["00:03:44", "Tomás", "Retry count: 5 with backoff?"],
    ]);
    expect(r.warnings.join(" ")).toMatch(/private/);
  });

  it("Zoom chat (old tab layout, CRLF)", () => {
    const r = parseTranscriptDetailed(fixture("zoom-chat-old.txt"));
    expect(r.format).toBe("zoom-chat");
    expect(rows(r)).toEqual([
      ["00:01:05", "Priya Raman", "Agenda doc is linked in the invite"],
      ["00:02:40", "Marcus Lee", "SQS console link: https://console.aws.amazon.com/sqs"],
    ]);
  });

  it("Google Meet: skips title/attendees/footer, uses marker times, estimates the rest", () => {
    const r = parseTranscriptDetailed(fixture("google-meet.txt"));
    expect(r.format).toBe("google-meet");
    expect(r.timing).toBe("partial");
    expect(r.utterances.map((u) => u.speaker)).toEqual([
      "Priya Raman",
      "Marcus Lee",
      "Tomás Ruiz",
      "Priya Raman",
      "Marcus Lee",
      "Priya Raman",
    ]);
    expect(r.utterances[0]).toMatchObject({ t: 0 });
    expect(r.utterances[0]!.synthetic).toBeUndefined();
    expect(r.utterances[1]!.synthetic).toBe(true);
    expect(r.utterances[4]).toMatchObject({ t: 300, text: "For the queue, I'd go with SQS." });
    for (let i = 1; i < 4; i++) expect(r.utterances[i]!.t).toBeLessThan(300);
    expect(r.utterances[5]!.t).toBeGreaterThan(300);
  });

  it("Otter.ai: 'Name  m:ss' header + paragraph, wrapped lines joined, footer dropped", () => {
    const r = parseTranscriptDetailed(fixture("otter.txt"));
    expect(r.format).toBe("speaker-blocks");
    expect(rows(r)).toEqual([
      ["00:00:03", "Speaker 1", "Okay, so this is the rate limiting discussion for the public API."],
      [
        "00:00:12",
        "Nadia Petrova",
        "Partners keep hammering us during their nightly syncs. I think we want a token bucket per API key, something like a hundred requests per second with bursts.",
      ],
      ["00:01:05", "Joon Park", "Token bucket in Redis works. We already have a Redis cluster for sessions."],
      ["00:01:31", "Nadia Petrova", "Let's go with that. Joon, can you own the Redis script?"],
    ]);
  });

  it("Fireflies style 'Name - mm:ss' headers", () => {
    const r = parseTranscriptDetailed(fixture("fireflies.txt"));
    expect(r.format).toBe("speaker-blocks");
    expect(r.utterances.map((u) => [u.ts, u.speaker])).toEqual([
      ["00:00:00", "Grace Liu"],
      ["00:00:41", "Wei Zhang"],
      ["00:02:15", "Sofia Rossi"],
      ["00:03:02", "Grace Liu"],
    ]);
  });

  it("Rev style 'Name (hh:mm:ss):' headers", () => {
    const r = parseTranscriptDetailed(fixture("rev.txt"));
    expect(rows(r)).toEqual([
      ["00:00:04", "Aisha Khan", "Right now if a tech loses signal in a basement the app blocks."],
      ["00:00:21", "Keiko Sato", "We need an outbox on the device. SQLite with a sync queue."],
      ["00:01:10", "Rohan Mehta", "Agreed, SQLite outbox."],
    ]);
  });

  it("name and time on separate lines", () => {
    const r = parseTranscriptDetailed(fixture("name-time-lines.txt"));
    expect(r.utterances.map((u) => [u.ts, u.speaker])).toEqual([
      ["00:00:04", "Aisha Khan"],
      ["00:00:21", "Keiko Sato"],
    ]);
  });

  it("plain 'Name: text' without timestamps: synthesized ~2.5 words/s, all flagged", () => {
    const r = parseTranscriptDetailed(fixture("plain-names.txt"));
    expect(r.format).toBe("speaker-lines");
    expect(r.timing).toBe("synthetic");
    expect(r.utterances).toHaveLength(5);
    expect(r.utterances.every((u) => u.synthetic)).toBe(true);
    expect(r.utterances[0]!.t).toBe(0);
    // Line 3 has ~30 words, so line 4 starts ~12 s after it.
    const gap = r.utterances[3]!.t - r.utterances[2]!.t;
    expect(gap).toBeGreaterThan(10);
    expect(gap).toBeLessThan(15);
    for (let i = 1; i < 5; i++) expect(r.utterances[i]!.t).toBeGreaterThan(r.utterances[i - 1]!.t);
    expect(r.warnings.join(" ")).toMatch(/estimated/);
  });

  it("timestamped lines in several layouts, including milliseconds", () => {
    const r = parseTranscriptDetailed(fixture("timestamped.txt"));
    expect(r.format).toBe("timestamped-lines");
    expect(rows(r)).toEqual([
      ["00:00:05", "Tomás", "Morning all."],
      ["00:02:20", "Tomás Ruiz", "Rough sketch: billing emits an event."],
      ["00:03:00", "Ben", "no brackets"],
      ["00:04:10", "Cara", "mm:ss only"],
      ["00:05:30", "Dana", "name first, time in parentheses"],
      ["00:06:00", "Eli", "with milliseconds"],
    ]);
  });

  it("markdown table, JSONL, wrapped JSON with millisecond keys, Recall.ai word lists", () => {
    expect(parseTranscriptDetailed(fixture("table.md")).format).toBe("markdown-table");
    expect(rows(parseTranscriptDetailed(fixture("sample.jsonl")))).toEqual([
      ["00:00:05", "Ana", "Morning."],
      ["00:01:10", "Ben", "Let's go with SQS."],
    ]);
    const seg = parseTranscriptDetailed(fixture("segments.json"));
    expect(seg.utterances.map((u) => [u.t, u.speaker])).toEqual([
      [1.5, "Ana"],
      [64, "Ben"],
    ]);
    expect(rows(parseTranscriptDetailed(fixture("recall-transcript.json")))).toEqual([
      ["00:00:12", "Priya Raman", "Let's use SQS."],
      ["00:00:15", "Marcus Lee", "Agreed."],
    ]);
  });

  it("handles BOM + CRLF for every text format", () => {
    for (const f of ["zoom-transcript.vtt", "generic.srt", "otter.txt", "google-meet.txt", "timestamped.txt", "plain-names.txt"]) {
      const plain = parseTranscript(fixture(f));
      const crlf = parseTranscript("﻿" + fixture(f).replace(/\n/g, "\r\n"));
      expect(crlf, f).toEqual(plain);
    }
  });

  it("sorts out-of-order lines and says so", () => {
    const r = parseTranscriptDetailed("[00:00:10] Ana: second\n[00:00:05] Ben: first");
    expect(r.utterances.map((u) => [u.text, u.idx])).toEqual([
      ["first", 0],
      ["second", 1],
    ]);
    expect(r.warnings.join(" ")).toMatch(/sorted/);
  });

  it("throws a clear error listing supported formats when nothing parses", () => {
    expect(() => parseTranscript(fixture("not-a-transcript.txt"))).toThrow(TranscriptParseError);
    expect(() => parseTranscript(fixture("not-a-transcript.txt"))).toThrow(/Supported formats[\s\S]*WebVTT[\s\S]*Otter/);
    expect(() => parseTranscript("   \n ")).toThrow(/empty/);
    expect(() => parseTranscript("WEBVTT\n\nNOTE nothing here\n")).toThrow(TranscriptParseError);
    expect(() => parseTranscript("[1, 2, 3]")).toThrow(TranscriptParseError);
  });

  it("does not treat metadata labels or sentences with colons as speakers", () => {
    const r = parseTranscriptDetailed("Attendees: Ana, Ben\nAna: hello there\nso the plan is: ship it\nBen: ok");
    expect(r.utterances.map((u) => [u.speaker, u.text])).toEqual([
      ["Ana", "hello there so the plan is: ship it"],
      ["Ben", "ok"],
    ]);
  });
});
