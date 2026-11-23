import type { ReactNode } from "react";

/** Small pieces shared by the simulation views. */

export interface PillData {
  label: string;
  value: string;
  bad: boolean;
  hint: string;
}

export interface ChartSpec {
  label: string;
  /** Top of the chart's scale. */
  max: number;
  /** Horizontal grid lines, in chart units. */
  grid: number[];
  gridLabel: string;
  format: (v: number) => string;
  bad: (v: number) => boolean;
  /** An optional dashed reference line, such as a capacity limit. */
  limit?: { value: number; label: string };
}

export type Point = { x: number; y: number };

export function lerp(a: Point, b: Point, p: number): Point {
  return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
}

/** Evenly spaced positions between top and bottom (centered when there is one). */
export function spread(i: number, count: number, top: number, bottom: number): number {
  if (count <= 1) return (top + bottom) / 2;
  return top + ((bottom - top) * i) / (count - 1);
}

export const BLUE = "#7dd3fc";
export const AMBER = "#fbbf24";
export const GREEN = "#4ade80";
export const RED = "#ff7b7b";

export function Pill({ label, value, bad, hint }: PillData) {
  return (
    <div
      className="flex items-baseline justify-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs ring-1 ring-border"
      title={hint}
    >
      <span className="text-muted">{label}</span>
      <span className={`font-mono text-sm font-bold tabular-nums ${bad ? "text-danger" : "text-accent"}`}>{value}</span>
    </div>
  );
}

/** A labelled box drawn in a diagram. */
export function Box({
  x,
  y,
  w,
  h,
  label,
  sub,
  tone = "fill-surface stroke-muted",
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <g>
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx="6" className={tone} strokeWidth="1.5" />
      <text x={x} y={y + h / 2 + 11} textAnchor="middle" className="fill-muted text-[8px] tracking-wider">
        {label}
      </text>
      {sub ? (
        <text x={x} y={y + h / 2 + 21} textAnchor="middle" className="fill-muted text-[7px]">
          {sub}
        </text>
      ) : null}
    </g>
  );
}

/** What a simulation view draws for the current state. */
export interface SimView {
  pills: PillData[];
  chart: ChartSpec;
  /** The latest value of the charted metric. */
  current: number | null;
  scene: ReactNode;
  /** Height of the scene's viewBox when it is not the default. */
  height?: number;
  /** Text for screen readers describing the current state. */
  summary: string;
}

/** A floating label that rises and fades over `lifeMs`. */
export function Floater({ x, y, age, lifeMs, text, className }: { x: number; y: number; age: number; lifeMs: number; text: string; className: string }) {
  const p = Math.min(1, age / lifeMs);
  return (
    <text x={x} y={y - p * 14} textAnchor="middle" className={`font-mono text-[8px] font-bold ${className}`} opacity={1 - p}>
      {text}
    </text>
  );
}
