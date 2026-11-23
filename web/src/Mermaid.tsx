import { useEffect, useLayoutEffect, useRef, useState } from "react";

type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

/** Load and initialize mermaid once (it is large, so it is split out of the main bundle). */
function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "neutral",
      fontFamily: "inherit",
      flowchart: { curve: "basis", padding: 12 },
    });
    return mermaid;
  });
  return mermaidPromise;
}

/** mermaid.render is not re-entrant; serialize all renders. */
function renderSvg(code: string): Promise<string> {
  const id = `mmd-${++counter}`;
  const job = queue.then(async () => {
    const mermaid = await loadMermaid();
    try {
      const { svg } = await mermaid.render(id, code);
      return svg;
    } finally {
      // On failure mermaid can leave its scratch element behind.
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

interface Props {
  code: string;
  className?: string;
  empty?: string;
  /** Briefly highlight the diagram when it changes (not on first render). */
  flashOnChange?: boolean;
  /** Allow the diagram to grow up to this multiple of its natural width (default: never upscale). */
  maxScale?: number;
}

export function MermaidView({ code, className, empty = "No diagram yet.", flashOnChange, maxScale }: Props) {
  // Keep the previous SVG on screen until the new one is ready, to avoid layout jumps.
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(0);
  const rendered = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Mermaid caps the SVG at its natural width (inline max-width); optionally relax that cap.
  useLayoutEffect(() => {
    const el = box.current?.querySelector("svg");
    if (!el || !maxScale) return;
    el.dataset.naturalWidth ??= String(parseFloat(el.style.maxWidth));
    const natural = Number(el.dataset.naturalWidth);
    if (natural > 0) el.style.maxWidth = `${natural * maxScale}px`;
  }, [svg, flash, maxScale]);

  useEffect(() => {
    if (!code) {
      setSvg("");
      setError(null);
      rendered.current = "";
      return;
    }
    let cancelled = false;
    renderSvg(code).then(
      (out) => {
        if (cancelled) return;
        const first = rendered.current === null || rendered.current === "";
        rendered.current = code;
        setSvg(out);
        setError(null);
        if (flashOnChange && !first) setFlash((n) => n + 1);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, flashOnChange]);

  if (!code) return <div className={`mermaid-empty ${className ?? ""}`}>{empty}</div>;
  if (error) {
    return (
      <div className={`mermaid-error ${className ?? ""}`}>
        <div className="mermaid-error-msg">Diagram could not be rendered: {error}</div>
        <pre>{code}</pre>
      </div>
    );
  }
  return (
    <div
      key={flash}
      ref={box}
      className={`mermaid-view ${flash ? "flash" : ""} ${className ?? ""}`}
      // Mermaid output with securityLevel "strict" is sanitized by mermaid itself.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
