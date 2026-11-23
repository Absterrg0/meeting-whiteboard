import { Marked, type Token, type Tokens } from "marked";
import { useLayoutEffect, useMemo, useRef } from "react";
import { MermaidView } from "./Mermaid";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Doc text comes from the model and from transcripts: never pass raw HTML through.
const md = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
  },
});

type Block = { kind: "html"; html: string; key: string } | { kind: "mermaid"; code: string; key: string };

/** Split the doc into HTML chunks and mermaid diagrams, so diagrams render as SVG in place. */
function toBlocks(markdown: string): Block[] {
  const tokens = md.lexer(markdown);
  const blocks: Block[] = [];
  let run: Token[] = [];
  // Keys count per kind, so a diagram keeps its identity (and SVG) when text blocks shift around it.
  let nHtml = 0;
  let nMermaid = 0;
  const flushRun = () => {
    if (!run.length) return;
    const list = Object.assign(run, { links: tokens.links });
    blocks.push({ kind: "html", html: md.parser(list), key: `h${nHtml++}` });
    run = [];
  };
  for (const t of tokens) {
    if (t.type === "code" && (t as Tokens.Code).lang === "mermaid") {
      flushRun();
      blocks.push({ kind: "mermaid", code: (t as Tokens.Code).text, key: `m${nMermaid++}` });
    } else {
      run.push(t);
    }
  }
  flushRun();
  return blocks;
}

/** Text of an element excluding nested lists, so a changed sub-bullet doesn't flash its parent. */
function ownText(el: Element): string {
  if (el.tagName !== "LI") return el.textContent?.trim() ?? "";
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll("ul, ol").forEach((n) => n.remove());
  return clone.textContent?.trim() ?? "";
}

const FLASH_SELECTOR = "h1, h2, h3, h4, p, li, blockquote, td";

export function DocView({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => toBlocks(markdown), [markdown]);
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<Set<string> | null>(null);

  // Highlight blocks whose text did not exist in the previous version of the doc.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    // Diagram labels render asynchronously (and the diagram flashes itself), so skip them.
    const els = [...root.querySelectorAll(FLASH_SELECTOR)].filter((el) => !el.closest("svg"));
    const texts = els.map(ownText);
    const before = prev.current;
    if (before) {
      els.forEach((el, i) => {
        const t = texts[i]!;
        if (!t || before.has(t)) return;
        el.classList.remove("flash");
        void (el as HTMLElement).offsetWidth; // restart the animation
        el.classList.add("flash");
      });
    }
    prev.current = new Set(texts);
  }, [markdown]);

  return (
    <div className="doc" ref={ref}>
      {blocks.map((b) =>
        b.kind === "mermaid" ? (
          <MermaidView key={b.key} code={b.code} className="doc-diagram" flashOnChange />
        ) : (
          <div key={b.key} dangerouslySetInnerHTML={{ __html: b.html }} />
        ),
      )}
    </div>
  );
}
