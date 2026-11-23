/**
 * The architecture diagram: React Flow with a dagre layout that stays put between updates.
 * The layout is recomputed on every change but anchored to where the nodes already were,
 * and every move is tweened, so the picture settles instead of jumping.
 */
import dagre from "@dagrejs/dagre";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import {
  Box,
  Cloud,
  Cog,
  Database,
  Expand,
  Layers,
  Minus,
  Monitor,
  Plus,
  Scan,
  Shield,
  Shapes,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { componentVisibility, edgeVisibility } from "../../src/core/render";
import type { ComponentType, DocState } from "../../src/core/types";
import { FRESH_MS, type FreshMap } from "./useLiveSession";

type Vis = "active" | "tbd" | "proposed";

interface GNode {
  id: string;
  name: string;
  type: ComponentType;
  description: string;
  vis: Vis;
  basis: string[];
}
interface GEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  vis: Vis;
}
interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}
interface P {
  x: number;
  y: number;
}

const W = 180;
const H = 58;
const GAP_X = 56;
const GAP_Y = 20;

const TYPE_ICON: Record<ComponentType, LucideIcon> = {
  service: Box,
  worker: Cog,
  queue: Layers,
  datastore: Database,
  external: Cloud,
  client: Monitor,
  infra: Shield,
  other: Shapes,
};

const TYPE_LABEL: Record<ComponentType, string> = {
  service: "Service",
  worker: "Worker",
  queue: "Queue",
  datastore: "Datastore",
  external: "External",
  client: "Client",
  infra: "Infrastructure",
  other: "Component",
};

export function graphOf(state: DocState, showProposals: boolean): Graph {
  const nodes: GNode[] = [];
  const shown = new Set<string>();
  for (const id of state.order.components) {
    const c = state.components[id];
    if (!c) continue;
    const v = componentVisibility(state, c);
    if (v === "retired" || (v === "proposed" && !showProposals)) continue;
    shown.add(id);
    nodes.push({ id, name: c.name, type: c.type, description: c.description, vis: v, basis: c.basis });
  }
  const edges: GEdge[] = [];
  for (const id of state.order.edges) {
    const e = state.edges[id];
    if (!e || !shown.has(e.from) || !shown.has(e.to)) continue;
    const v = edgeVisibility(state, e);
    if (v === "retired" || (v === "proposed" && !showProposals)) continue;
    edges.push({ id, from: e.from, to: e.to, label: e.label, vis: v });
  }
  return { nodes, edges };
}

// ---------- layout ----------

function ideal(g: Graph): Map<string, P> {
  const dg = new dagre.graphlib.Graph();
  dg.setGraph({ rankdir: "LR", nodesep: GAP_Y + 6, ranksep: GAP_X, edgesep: 16, marginx: 0, marginy: 0 });
  dg.setDefaultEdgeLabel(() => ({}));
  for (const n of g.nodes) dg.setNode(n.id, { width: W, height: H });
  for (const e of g.edges) dg.setEdge(e.from, e.to);
  dagre.layout(dg);
  const out = new Map<string, P>();
  for (const n of g.nodes) {
    const p = dg.node(n.id) as { x: number; y: number };
    out.set(n.id, { x: Math.round(p.x - W / 2), y: Math.round(p.y - H / 2) });
  }
  return out;
}

/**
 * Positions for the graph. The layout is recomputed from scratch (dagre is deterministic
 * and nodes are added in a stable order, so a small change gives a similar picture), then
 * shifted so the nodes that were already on screen move as little as possible. The tween
 * below animates whatever still moves.
 */
function place(g: Graph, prev: Map<string, P>): Map<string, P> {
  const want = ideal(g);
  const kept = g.nodes.filter((n) => prev.has(n.id));
  if (!kept.length) return want;
  // Median shift (robust to the one node that moved a lot).
  const xs = kept.map((n) => prev.get(n.id)!.x - want.get(n.id)!.x).sort((a, b) => a - b);
  const ys = kept.map((n) => prev.get(n.id)!.y - want.get(n.id)!.y).sort((a, b) => a - b);
  const dx = Math.round(xs[Math.floor(xs.length / 2)]!);
  const dy = Math.round(ys[Math.floor(ys.length / 2)]!);
  const out = new Map<string, P>();
  for (const [id, p] of want) out.set(id, { x: p.x + dx, y: p.y + dy });
  return out;
}

function sameMap(a: Map<string, P>, b: Map<string, P>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, p] of a) {
    const q = b.get(k);
    if (!q || q.x !== p.x || q.y !== p.y) return false;
  }
  return true;
}

function useStableLayout(g: Graph): Map<string, P> {
  const last = useRef(new Map<string, P>());
  return useMemo(() => {
    const out = place(g, last.current);
    if (sameMap(out, last.current)) return last.current;
    last.current = out;
    return out;
  }, [g]);
}

/** Tween from the positions on screen to the target. */
function useTween(target: Map<string, P>): Map<string, P> {
  const [cur, setCur] = useState(target);
  const ref = useRef(target);
  useEffect(() => {
    const from = ref.current;
    let moved = false;
    for (const [id, p] of target) {
      const f = from.get(id);
      if (f && (f.x !== p.x || f.y !== p.y)) moved = true;
    }
    if (!moved || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      ref.current = target;
      setCur(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 520);
      const e = 1 - Math.pow(1 - k, 3);
      const m = new Map<string, P>();
      for (const [id, p] of target) {
        const f = from.get(id) ?? p;
        m.set(id, { x: f.x + (p.x - f.x) * e, y: f.y + (p.y - f.y) * e });
      }
      ref.current = m;
      setCur(m);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return cur;
}

function bounds(pos: Map<string, P>) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + W);
    maxY = Math.max(maxY, p.y + H);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, w: 0, h: 0 };
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

// ---------- rendering ----------

interface NodeData extends Record<string, unknown> {
  name: string;
  type: ComponentType;
  description: string;
  vis: Vis;
  fresh: number;
  isNew: boolean;
  dim: boolean;
}

const ComponentNode = memo(function ComponentNode({ data }: NodeProps<Node<NodeData>>) {
  const Icon = TYPE_ICON[data.type] ?? Shapes;
  return (
    <div className={`dg-node vis-${data.vis}${data.isNew ? " is-new" : ""}${data.dim ? " dim" : ""}`} title={`${TYPE_LABEL[data.type]} · ${data.description}`}>
      {data.fresh > 0 && <span className="dg-node-wash" key={data.fresh} />}
      <Handle type="target" position={Position.Left} className="dg-handle" isConnectable={false} />
      <div className="dg-node-head">
        <Icon size={13} strokeWidth={1.8} className="dg-node-icon" aria-hidden />
        <span className="dg-node-name">{data.name}</span>
        {data.vis === "tbd" && <span className="dg-tag tbd">TBD</span>}
        {data.vis === "proposed" && <span className="dg-tag">Proposal</span>}
      </div>
      <div className="dg-node-desc">{data.description}</div>
      <Handle type="source" position={Position.Right} className="dg-handle" isConnectable={false} />
    </div>
  );
});

const NODE_TYPES = { component: ComponentNode };

interface EdgeData extends Record<string, unknown> {
  label: string;
  showLabel: boolean;
  /** Which end the label sits next to: the neighbour of the hovered node, where labels do not pile up. */
  near: "source" | "target";
}

/** A bezier edge whose label is an HTML chip above the nodes, shown only when asked for. */
function LabeledEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data }: EdgeProps<Edge<EdgeData>>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const atTarget = data?.near !== "source";
  const lx = atTarget ? targetX - 10 : sourceX + 10;
  const ly = atTarget ? targetY : sourceY;
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {data?.showLabel && data.label && (
        <EdgeLabelRenderer>
          <div className="dg-edge-label" style={{ transform: `translate(${atTarget ? "-100%" : "0"}, -50%) translate(${lx}px, ${ly}px)` }}>
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const EDGE_TYPES = { labeled: LabeledEdge };

interface CanvasProps {
  graph: Graph;
  target: Map<string, P>;
  fresh: FreshMap;
  now: number;
  mode: "inline" | "full";
  dark: boolean;
  onNodeClick?: (basis: string[]) => void;
}

function Canvas({ graph, target, fresh, now, mode, dark, onNodeClick }: CanvasProps) {
  const pos = useTween(target);
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const touched = useRef(false);
  const seen = useRef<Set<string> | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Nodes that appear after the first render get an entrance animation.
  const known = seen.current;
  const isNew = (id: string) => !!known && !known.has(id);
  useEffect(() => {
    seen.current = new Set(graph.nodes.map((n) => n.id));
  }, [graph]);

  const b = bounds(target);
  const PAD = 28;
  const zoom = mode === "inline" && width ? Math.max(0.8, Math.min(1, (width - PAD * 2) / Math.max(1, b.w))) : 1;
  // Edge labels only where they are legible; the expanded view always has them.
  const [hover, setHover] = useState<string | null>(null);
  const linked = (e: GEdge) => hover !== null && (e.from === hover || e.to === hover);
  const near = new Set<string>();
  if (hover) {
    near.add(hover);
    for (const e of graph.edges) if (linked(e)) near.add(e.from === hover ? e.to : e.from);
  }
  const height = mode === "inline" ? Math.round(Math.min(600, Math.max(180, b.h * zoom + PAD * 2))) : undefined;
  const overflow = mode === "inline" && b.w * zoom + PAD * 2 > width + 1;

  // Frame the drawing whenever it changes, unless the reader has panned or zoomed.
  useEffect(() => {
    if (!width || touched.current) return;
    if (mode === "full") {
      void rf.fitView({ padding: 0.12, maxZoom: 1.15, duration: 400 });
      return;
    }
    const contentW = b.w * zoom;
    const x = contentW + PAD * 2 <= width ? (width - contentW) / 2 - b.minX * zoom : PAD - b.minX * zoom;
    void rf.setViewport({ x, y: PAD - b.minY * zoom, zoom }, { duration: seen.current ? 400 : 0 });
  }, [width, b.minX, b.minY, b.w, b.h, zoom, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const edgeColor = dark ? "#62625d" : "#a9a9a3";
  const accent = dark ? "#a594f9" : "#6e56cf";
  const isFresh = (id: string) => (fresh[id] && now - fresh[id]! < FRESH_MS ? fresh[id]! : 0);

  const nodes: Node<NodeData>[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "component",
    position: pos.get(n.id) ?? target.get(n.id) ?? { x: 0, y: 0 },
    data: { name: n.name, type: n.type, description: n.description, vis: n.vis, fresh: isFresh(n.id), isNew: isNew(n.id), dim: !!hover && !near.has(n.id) },
    width: W,
    height: H,
    // Without `measured`, React Flow drops the handle positions whenever the node objects change
    // (we do not feed its dimension changes back), and edges disappear until the next resize.
    measured: { width: W, height: H },
    draggable: false,
    selectable: false,
  }));
  const edges: Edge<EdgeData>[] = graph.edges.map((e) => {
    const f = isFresh(e.id) || isFresh(e.from + "->" + e.to);
    const hl = linked(e);
    const color = f || hl ? accent : edgeColor;
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      type: "labeled",
      data: { label: e.label, showLabel: hl, near: e.from === hover ? "target" : "source" },
      className: `dg-edge vis-${e.vis}${f ? " fresh" : ""}${hover && !hl ? " dim" : ""}${hl ? " hl" : ""}`,
      zIndex: hl ? 2 : 0,
      style: { stroke: color, strokeWidth: hl ? 1.6 : 1.25, strokeDasharray: e.vis === "active" ? undefined : "5 4" },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      selectable: false,
    };
  });

  return (
    <div ref={wrap} className={`dg-canvas dg-${mode}${overflow ? " overflow" : ""}`} style={height ? { height } : undefined}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll={mode === "full"}
        panOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        preventScrolling={mode === "full"}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        onMoveStart={(e) => {
          if (e) touched.current = true;
        }}
        onNodeClick={(_, n) => onNodeClick?.(graph.nodes.find((g) => g.id === n.id)?.basis ?? [])}
        onNodeMouseEnter={(_, n) => setHover(n.id)}
        onNodeMouseLeave={() => setHover(null)}
      />
      {mode === "full" && (
        <div className="dg-zoom">
          <button className="icon-btn" onClick={() => void rf.zoomIn({ duration: 200 })} aria-label="Zoom in">
            <Plus size={15} />
          </button>
          <button className="icon-btn" onClick={() => void rf.zoomOut({ duration: 200 })} aria-label="Zoom out">
            <Minus size={15} />
          </button>
          <button
            className="icon-btn"
            onClick={() => {
              touched.current = false;
              void rf.fitView({ padding: 0.12, maxZoom: 1.15, duration: 300 });
            }}
            aria-label="Fit to screen"
          >
            <Scan size={15} />
          </button>
        </div>
      )}
      {mode === "inline" && touched.current && (
        <button
          className="dg-reset"
          onClick={() => {
            touched.current = false;
            setWidth((w) => w + 0.001);
          }}
        >
          Reset view
        </button>
      )}
    </div>
  );
}

export interface FigureProps {
  state: DocState;
  fresh: FreshMap;
  now: number;
  dark: boolean;
  onFocusItem: (id: string) => void;
}

const PROPOSALS_KEY = "mwb.showProposals";

function loadBool(key: string, dflt: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === "1";
  } catch {
    return dflt;
  }
}

export function ArchitectureFigure({ state, fresh, now, dark, onFocusItem }: FigureProps) {
  const [showProposals, setShowProposals] = useState(() => loadBool(PROPOSALS_KEY, true));
  const [expanded, setExpanded] = useState(false);
  const graph = useMemo(() => graphOf(state, showProposals), [state, showProposals]);
  const target = useStableLayout(graph);
  const hasProposals = useMemo(
    () => state.order.components.some((id) => state.components[id] && componentVisibility(state, state.components[id]!) === "proposed"),
    [state],
  );
  const hasTbd = graph.nodes.some((n) => n.vis === "tbd");

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const toggle = (v: boolean) => {
    setShowProposals(v);
    try {
      localStorage.setItem(PROPOSALS_KEY, v ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };

  const focusBasis = (basis: string[]) => {
    const live = basis.find((id) => state.items[id]?.kind === "decision") ?? basis[0];
    if (live) {
      setExpanded(false);
      onFocusItem(live);
    }
  };

  const toolbar = (
    <>
      {hasProposals && (
        <label className="switch">
          <input type="checkbox" checked={showProposals} onChange={(e) => toggle(e.target.checked)} />
          <span className="switch-track" aria-hidden />
          Show proposals
        </label>
      )}
    </>
  );

  return (
    <figure className="figure" id="doc-diagram" data-anchor="doc-diagram">
      <figcaption className="figure-head">
        <span className="figure-title">Architecture</span>
        <span className="figure-legend" title="Hover a component to see its connections" hidden={!graph.nodes.length}>
          <span className="lg lg-solid" /> agreed
          {hasTbd && (
            <>
              <span className="lg lg-tbd" /> to be decided
            </>
          )}
          {showProposals && hasProposals && (
            <>
              <span className="lg lg-dash" /> proposal
            </>
          )}
        </span>
        <span className="figure-tools">
          {toolbar}
          <button className="icon-btn" onClick={() => setExpanded(true)} title="Expand" aria-label="Expand diagram" disabled={!graph.nodes.length}>
            <Expand size={15} />
          </button>
        </span>
      </figcaption>
      {graph.nodes.length === 0 ? (
        <div className="figure-empty">
          <span>The diagram appears as soon as the team agrees on its first components.</span>
        </div>
      ) : (
        <ReactFlowProvider>
          <Canvas graph={graph} target={target} fresh={fresh} now={now} mode="inline" dark={dark} onNodeClick={focusBasis} />
        </ReactFlowProvider>
      )}
      {expanded &&
        createPortal(
          <div className="overlay" role="dialog" aria-modal="true" aria-label="Architecture diagram" onMouseDown={() => setExpanded(false)}>
            <div className="overlay-panel" onMouseDown={(e) => e.stopPropagation()}>
              <div className="overlay-head">
                <span className="overlay-title">Architecture</span>
                <span className="figure-tools">
                  {toolbar}
                  <button className="icon-btn" onClick={() => setExpanded(false)} aria-label="Close" autoFocus>
                    <X size={16} />
                  </button>
                </span>
              </div>
              <ReactFlowProvider>
                <Canvas graph={graph} target={target} fresh={fresh} now={now} mode="full" dark={dark} onNodeClick={focusBasis} />
              </ReactFlowProvider>
            </div>
          </div>,
          document.body,
        )}
    </figure>
  );
}
