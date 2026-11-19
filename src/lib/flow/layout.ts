import type { Flow } from "@/lib/content/schema";

/** Grid cell and node box sizes, in SVG user units. */
export const CELL_W = 170;
export const CELL_H = 100;
export const NODE_W = 128;
export const NODE_H = 58;
/** Gap between the two lines of an edge used in both directions. */
const PAIR_OFFSET = 7;

export type Orientation = "wide" | "narrow";

export interface PlacedNode {
  id: string;
  label: string;
  detail?: string;
  /** Centre of the box. */
  x: number;
  y: number;
}

export interface Edge {
  /** "from>to" */
  key: string;
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Layout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: Edge[];
}

export const edgeKey = (from: string, to: string) => `${from}>${to}`;

/**
 * Where the segment from the centre of one box towards a point leaves the
 * box, so edges start and end at the box border instead of its centre.
 */
function exitPoint(cx: number, cy: number, tx: number, ty: number, pad: number) {
  const dx = tx - cx;
  const dy = ty - cy;
  const hw = NODE_W / 2 + pad;
  const hh = NODE_H / 2 + pad;
  const t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * Places nodes on the grid. Narrow screens swap columns and rows so a flow
 * that runs left to right on a desktop runs top to bottom on a phone.
 */
export function layoutFlow(flow: Flow, orientation: Orientation): Layout {
  const pos = (n: Flow["nodes"][number]) => (orientation === "wide" ? { c: n.col, r: n.row } : { c: n.row, r: n.col });
  const cols = Math.max(...flow.nodes.map((n) => pos(n).c)) + 1;
  const rows = Math.max(...flow.nodes.map((n) => pos(n).r)) + 1;
  const nodes = flow.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    detail: n.detail,
    x: pos(n).c * CELL_W + CELL_W / 2,
    y: pos(n).r * CELL_H + CELL_H / 2,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const keys = new Set<string>();
  for (const s of flow.steps) if (s.to !== undefined) keys.add(edgeKey(s.from, s.to));

  const edges: Edge[] = [...keys].map((key) => {
    const [from, to] = key.split(">");
    const a = byId.get(from)!;
    const b = byId.get(to)!;
    // An edge also used in the other direction is shifted to its right-hand side.
    let ox = 0;
    let oy = 0;
    if (keys.has(edgeKey(to, from))) {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      ox = (-(b.y - a.y) / len) * PAIR_OFFSET;
      oy = ((b.x - a.x) / len) * PAIR_OFFSET;
    }
    const start = exitPoint(a.x + ox, a.y + oy, b.x + ox, b.y + oy, 2);
    const end = exitPoint(b.x + ox, b.y + oy, a.x + ox, a.y + oy, 5);
    return { key, from, to, x1: start.x, y1: start.y, x2: end.x, y2: end.y };
  });

  return { width: cols * CELL_W, height: rows * CELL_H, nodes, edges };
}

export type NodeState = "idle" | "upcoming" | "seen" | "active" | "failed";
export type EdgeState = "idle" | "upcoming" | "done" | "active" | "failed";

export interface StepView {
  nodes: Record<string, NodeState>;
  edges: Record<string, EdgeState>;
  /** The edge the token travels along in this step, if any. */
  moving: string | null;
  failed: boolean;
}

/**
 * What each node and edge looks like at a step. Step -1 is the overview
 * before playing: everything plain. Afterwards, parts the flow has not
 * reached yet are faded, so the diagram fills in as the steps play.
 */
export function stepView(flow: Flow, index: number): StepView {
  const nodes: Record<string, NodeState> = {};
  const edges: Record<string, EdgeState> = {};
  const overview = index < 0;
  for (const n of flow.nodes) nodes[n.id] = overview ? "idle" : "upcoming";
  for (const s of flow.steps) if (s.to !== undefined) edges[edgeKey(s.from, s.to)] = overview ? "idle" : "upcoming";
  if (overview) return { nodes, edges, moving: null, failed: false };

  const last = Math.min(index, flow.steps.length - 1);
  for (let i = 0; i < last; i++) {
    const s = flow.steps[i];
    nodes[s.from] = "seen";
    if (s.to !== undefined) {
      nodes[s.to] = "seen";
      edges[edgeKey(s.from, s.to)] = "done";
    }
  }
  const step = flow.steps[last];
  const failed = step.status === "fail";
  nodes[step.from] = step.to === undefined && failed ? "failed" : "active";
  if (step.to !== undefined) {
    nodes[step.to] = failed ? "failed" : "active";
    edges[edgeKey(step.from, step.to)] = failed ? "failed" : "active";
  }
  return { nodes, edges, moving: step.to === undefined ? null : edgeKey(step.from, step.to), failed };
}
