import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTranscript } from "../src/ingest/transcript.js";

describe("parseTranscript", () => {
  it("parses JSONL with time/speaker/text", () => {
    const u = parseTranscript(
      [
        '{"time": "00:00:05", "speaker": "Ana", "text": "Morning."}',
        "",
        '{"time": "00:01:10", "speaker": "Ben", "text": "Let\'s go with SQS."}',
      ].join("\n"),
    );
    expect(u).toEqual([
      { t: 5, ts: "00:00:05", speaker: "Ana", text: "Morning.", idx: 0 },
      { t: 70, ts: "00:01:10", speaker: "Ben", text: "Let's go with SQS.", idx: 1 },
    ]);
  });

  it("accepts alternative keys and numeric seconds", () => {
    const u = parseTranscript('{"start": 75.5, "name": "Ana", "content": "Hi"}\n{"ts": "90", "who": "Ben", "utterance": "Yo"}');
    expect(u.map((x) => [x.t, x.ts, x.speaker, x.text])).toEqual([
      [75.5, "00:01:15", "Ana", "Hi"],
      [90, "00:01:30", "Ben", "Yo"],
    ]);
  });

  it("parses a JSON array", () => {
    const u = parseTranscript('[{"time": "00:00:05", "speaker": "Ana", "text": "One"}, {"time": "00:00:09", "speaker": "Ben", "text": "Two"}]');
    expect(u.map((x) => x.text)).toEqual(["One", "Two"]);
  });

  it('parses "[hh:mm:ss] Name: text" lines, keeping colons in the text', () => {
    const u = parseTranscript(
      ["[00:00:05] Ana: Morning all.", "[00:02:20] Tomás Ruiz: Rough sketch: billing emits an event.", "00:03:00 Ben: no brackets", "[04:10] Cara: mm:ss only"].join("\n"),
    );
    expect(u.map((x) => [x.ts, x.speaker, x.text])).toEqual([
      ["00:00:05", "Ana", "Morning all."],
      ["00:02:20", "Tomás Ruiz", "Rough sketch: billing emits an event."],
      ["00:03:00", "Ben", "no brackets"],
      ["00:04:10", "Cara", "mm:ss only"],
    ]);
  });

  it("parses markdown table rows and skips header/separator rows", () => {
    const u = parseTranscript(
      [
        "| Time | Speaker | Text |",
        "|---|---|---|",
        "| 00:00:05 | Ana | Morning. |",
        "| 00:01:10 | Ben | Use the `dead\\_letter` queue, ok? |",
      ].join("\n"),
    );
    expect(u.map((x) => [x.ts, x.speaker, x.text])).toEqual([
      ["00:00:05", "Ana", "Morning."],
      ["00:01:10", "Ben", "Use the `dead_letter` queue, ok?"],
    ]);
  });

  it("fills missing times monotonically from utterance length, flags them synthetic, and assigns stable indices", () => {
    const u = parseTranscript(
      '{"time": "00:00:10", "speaker": "A", "text": "x"}\n{"speaker": "B", "text": "one two three four five six seven eight nine ten"}\n{"speaker": "C", "text": "z"}',
    );
    // A: 1 word -> min 1.5 s + 0.5 s gap; B: 10 words / 2.5 = 4 s + 0.5 s gap.
    expect(u.map((x) => [x.t, x.idx, x.synthetic])).toEqual([
      [10, 0, undefined],
      [12, 1, true],
      [16.5, 2, true],
    ]);
  });

  it("parses every shipped transcript into ordered, non-empty utterances", () => {
    for (const f of readdirSync("transcripts").filter((n) => /\.(jsonl|json|txt|md|vtt|srt)$/.test(n) && !/^readme/i.test(n))) {
      const content = readFileSync(`transcripts/${f}`, "utf8");
      const u = parseTranscript(content);
      if (f.endsWith(".jsonl")) expect(u.length, f).toBe(content.split("\n").filter((l) => l.trim()).length);
      expect(u.length, f).toBeGreaterThan(0);
      for (let i = 1; i < u.length; i++) expect(u[i]!.t, `${f}#${i}`).toBeGreaterThanOrEqual(u[i - 1]!.t);
      expect(u.every((x) => x.speaker && x.text), f).toBe(true);
    }
  });
});
