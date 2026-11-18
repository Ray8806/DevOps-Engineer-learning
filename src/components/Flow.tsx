"use client";

import { useEffect, useId, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { Flow as FlowData } from "@/lib/content/schema";
import { NODE_H, NODE_W, layoutFlow, stepView, type EdgeState, type NodeState, type Orientation } from "@/lib/flow/layout";

/** How long each step stays on screen while playing. */
const STEP_MS = 2600;

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const NODE_CLASS: Record<NodeState, { box: string; text: string; group: string }> = {
  idle: { box: "fill-surface stroke-border", text: "fill-text", group: "" },
  upcoming: { box: "fill-surface stroke-border", text: "fill-muted", group: "opacity-45" },
  seen: { box: "fill-surface stroke-muted", text: "fill-text", group: "" },
  active: { box: "fill-accent-soft stroke-accent", text: "fill-text", group: "" },
  failed: { box: "fill-danger-soft stroke-danger", text: "fill-text", group: "" },
};

const EDGE_CLASS: Record<EdgeState, string> = {
  idle: "stroke-muted",
  upcoming: "stroke-border [stroke-dasharray:5_5]",
  done: "stroke-muted",
  active: "stroke-accent",
  failed: "stroke-danger",
};

const MARKER_CLASS: Record<EdgeState, string> = {
  idle: "fill-muted",
  upcoming: "fill-border",
  done: "fill-muted",
  active: "fill-accent",
  failed: "fill-danger",
};

function Diagram({ flow, index, orientation, reduced, className }: { flow: FlowData; index: number; orientation: Orientation; reduced: boolean; className: string }) {
  const layout = layoutFlow(flow, orientation);
  const view = stepView(flow, index);
  const marker = `flow-${useId().replace(/[^a-zA-Z0-9]/g, "")}-${orientation}`;
  const moving = view.moving ? layout.edges.find((e) => e.key === view.moving)! : null;
  // A failed step stops partway along its edge.
  const reach = view.failed ? 0.55 : 1;
  const token = moving
    ? {
        x: moving.x1,
        y: moving.y1,
        dx: (moving.x2 - moving.x1) * reach,
        dy: (moving.y2 - moving.y1) * reach,
      }
    : null;

  return (
    // Never drawn larger than its own size, so small diagrams keep readable proportions.
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className={className} style={{ maxWidth: layout.width }} aria-hidden="true">
      <defs>
        {(Object.keys(MARKER_CLASS) as EdgeState[]).map((state) => (
          <marker key={state} id={`${marker}-${state}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className={MARKER_CLASS[state]} />
          </marker>
        ))}
      </defs>
      {layout.edges.map((e) => {
        const state = view.edges[e.key];
        return (
          <line
            key={e.key}
            x1={e.x1}
            y1={e.y1}
            x2={e.x2}
            y2={e.y2}
            strokeWidth={state === "active" || state === "failed" ? 3 : 2}
            className={`transition-[stroke] duration-300 ${EDGE_CLASS[state]}`}
            markerEnd={`url(#${marker}-${state})`}
          />
        );
      })}
      {layout.nodes.map((n) => {
        const cls = NODE_CLASS[view.nodes[n.id]];
        return (
          <g key={n.id} className={`transition-opacity duration-300 ${cls.group}`}>
            <rect
              x={n.x - NODE_W / 2}
              y={n.y - NODE_H / 2}
              width={NODE_W}
              height={NODE_H}
              rx={10}
              strokeWidth={view.nodes[n.id] === "active" || view.nodes[n.id] === "failed" ? 2.5 : 1.5}
              className={`transition-colors duration-300 ${cls.box}`}
            />
            <text x={n.x} y={n.detail ? n.y - 3 : n.y + 5} textAnchor="middle" className={`text-[16px] font-semibold ${cls.text}`}>
              {n.label}
            </text>
            {n.detail ? (
              <text x={n.x} y={n.y + 16} textAnchor="middle" className="fill-muted text-[12.5px]">
                {n.detail}
              </text>
            ) : null}
          </g>
        );
      })}
      {token ? (
        <g key={`${index}-${orientation}`}>
          <circle
            cx={reduced ? token.x + token.dx : token.x}
            cy={reduced ? token.y + token.dy : token.y}
            r={7}
            className={`${view.failed ? "fill-danger" : "fill-accent"} ${reduced ? "" : "flow-token"} stroke-surface`}
            strokeWidth={2}
            style={{ "--dx": `${token.dx}px`, "--dy": `${token.dy}px` } as CSSProperties}
          />
          {view.failed ? (
            <text x={token.x + token.dx} y={token.y + token.dy - 14} textAnchor="middle" className={`fill-danger text-[18px] font-bold ${reduced ? "" : "flow-fail-mark"}`}>
              ✕
            </text>
          ) : null}
        </g>
      ) : null}
    </svg>
  );
}

/**
 * A step-by-step animated diagram. Starts on an overview; "播放" steps
 * through on a timer, and the buttons move one step at a time. The step
 * text below the diagram is the accessible description.
 */
export function Flow({ flow }: { flow: FlowData }) {
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  const total = flow.steps.length;
  const atEnd = index >= total - 1;
  // Playing stops by itself on the last step.
  const running = playing && !atEnd;

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setIndex((i) => i + 1), index < 0 ? 300 : STEP_MS);
    return () => clearTimeout(timer);
  }, [running, index]);

  const go = (next: number) => {
    setPlaying(false);
    setIndex(Math.max(-1, Math.min(total - 1, next)));
  };
  const step = index >= 0 ? flow.steps[index] : null;
  const button = "rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-semibold hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-surface";

  return (
    <figure className="rounded-xl border border-border bg-surface p-4 sm:p-5" data-testid="flow" data-flow={flow.id}>
      <figcaption className="text-sm font-bold">動畫：{flow.title}</figcaption>
      <div className="mt-3">
        <Diagram flow={flow} index={index} orientation="wide" reduced={reduced} className="mx-auto hidden h-auto w-full sm:block" />
        <Diagram flow={flow} index={index} orientation="narrow" reduced={reduced} className="mx-auto h-auto w-full sm:hidden" />
      </div>
      <div
        aria-live="polite"
        className={`mt-3 min-h-[4.5rem] rounded-lg px-3 py-2 text-[0.95rem] ${step?.status === "fail" ? "bg-danger-soft" : "bg-surface-2"}`}
      >
        {step ? (
          <>
            <span className={`mr-2 text-sm font-bold ${step.status === "fail" ? "text-danger" : "text-accent"}`}>
              步驟 {index + 1} / {total}
            </span>
            {step.text}
          </>
        ) : (
          <span className="text-muted">按「播放」看完整流程，或用「下一步」自己控制速度。共 {total} 步。</span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={`${button} !border-accent !bg-accent !text-surface hover:opacity-90`}
          onClick={() => {
            if (running) return setPlaying(false);
            if (atEnd) setIndex(-1);
            setPlaying(true);
          }}
        >
          {running ? "暫停" : atEnd ? "重新播放" : "播放"}
        </button>
        <button type="button" className={button} onClick={() => go(index - 1)} disabled={index < 0}>
          上一步
        </button>
        <button type="button" className={button} onClick={() => go(index + 1)} disabled={atEnd}>
          下一步
        </button>
        <button type="button" className={button} onClick={() => go(-1)} disabled={index < 0}>
          回到總覽
        </button>
      </div>
    </figure>
  );
}
