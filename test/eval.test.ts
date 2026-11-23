import { readdirSync, readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { currentSections, gradeDeterministic } from "../src/eval.js";

const MD = [
  "# Doc",
  "",
  "## Decisions",
  "",
  "- **Retention**: Jobs stay for 14 days.",
  "  - Why: callbacks",
  "  - Replaces: Retention 7 days",
  "",
  "## Decision log",
  "",
  "- ~~Old~~ (superseded): 7 days.",
  "",
  "## Changelog",
  "",
  "- `00:01:00` detail: 7 days → 14 days",
].join("\n");

describe("eval grading helpers", () => {
  it("currentSections cuts at the decision log / changelog and drops Replaces back-links", () => {
    const cur = currentSections(MD);
    expect(cur).toContain("14 days");
    expect(cur).not.toContain("7 days");
    expect(cur).not.toContain("Decision log");
    expect(currentSections("# A\n\n## Changelog\n- x")).toBe("# A\n");
  });

  it("grades include/exclude checks on doc sections and diagram", () => {
    const g = (c: Parameters<typeof gradeDeterministic>[0]) => gradeDeterministic(c, MD, 'flowchart LR\n  a["S3 bucket"]');
    expect(g({ type: "doc_excludes", id: "a", desc: "", pattern: "\\b7 days", sections: "current" }).pass).toBe(true);
    expect(g({ type: "doc_excludes", id: "a", desc: "", pattern: "\\b7 days", sections: "all" }).pass).toBe(false);
    expect(g({ type: "doc_includes", id: "a", desc: "", pattern: "FOURTEEN|14 days", sections: "current" }).pass).toBe(true);
    expect(g({ type: "diagram_includes", id: "a", desc: "", pattern: "s3" }).pass).toBe(true);
    expect(g({ type: "diagram_excludes", id: "a", desc: "", pattern: "s3" }).pass).toBe(false);
  });

  it("every expected file is valid, has a transcript and compiles its regexes", () => {
    for (const f of readdirSync("expected").filter((n) => n.endsWith(".json"))) {
      const name = f.replace(/\.json$/, "");
      expect(existsSync(`transcripts/${name}.jsonl`), name).toBe(true);
      const { checks } = JSON.parse(readFileSync(`expected/${f}`, "utf8")) as { checks: { id: string; type: string; pattern?: string; expect?: string }[] };
      const ids = checks.map((c) => c.id);
      expect(new Set(ids).size, `${f} has duplicate ids`).toBe(ids.length);
      for (const c of checks) {
        if (c.type === "llm") expect(c.expect, c.id).toBeTruthy();
        else expect(() => new RegExp(c.pattern!, "i"), c.id).not.toThrow();
      }
    }
  });
});
