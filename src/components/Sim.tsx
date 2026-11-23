"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Sim as SimData } from "@/lib/content/schema";
import { advanceSim, initialSimState, type AnySimState } from "@/lib/sim/config";
import type { SimState } from "@/lib/sim/engine";
import type { QueueState } from "@/lib/sim/queue";
import type { CacheState } from "@/lib/sim/cache";
import { useProgress } from "@/lib/progress/use-progress";
import { cacheView } from "./sim/cache-view";
import { lbView } from "./sim/lb-view";
import { Pill, type SimView } from "./sim/parts";
import { queueView } from "./sim/queue-view";

const W = 360;
const H = 230;
/** How much simulated time the chart shows. */
const CHART_MS = 15000;

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function viewOf(sim: SimData, stepIndex: number, state: AnySimState): SimView {
  if (sim.kind === "lb") return lbView(sim, stepIndex, state as SimState);
  if (sim.kind === "queue") return queueView(sim, stepIndex, state as QueueState);
  return cacheView(sim, stepIndex, state as CacheState);
}

export function Sim({ sim }: { sim: SimData }) {
  const [progress] = useProgress();
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [live, setState] = useState<AnySimState>(() => initialSimState(sim, 0));
  const [provider, setProvider] = useState<"aws" | "gcp" | null>(null);
  const [visible, setVisible] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const step = sim.steps[stepIndex];
  const shownProvider = provider ?? (progress.preferredProvider === "gcp" ? "gcp" : "aws");
  const snippet = step.config?.[shownProvider] ?? step.config?.aws ?? step.config?.gcp;
  const running = playing && visible && !reducedMotion;
  // Without motion, show where the step ends up instead of animating it.
  const outcome = useMemo(
    () => advanceSim(sim, stepIndex, initialSimState(sim, stepIndex), sim.steps[stepIndex].expect.afterMs),
    [sim, stepIndex],
  );
  const state = reducedMotion ? outcome : live;

  // Only animate while the simulation is on screen.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!running) return;
    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      // Cap the step so a background tab does not jump ahead in one go.
      const dt = Math.min(now - last, 100);
      last = now;
      setState((s) => advanceSim(sim, stepIndex, s, dt));
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [running, sim, stepIndex]);

  function choose(i: number) {
    setStepIndex(i);
    setState(initialSimState(sim, i));
    setPlaying(true);
  }

  function restart() {
    setState(initialSimState(sim, stepIndex));
    setPlaying(true);
  }

  const view = viewOf(sim, stepIndex, state);
  const { chart } = view;
  const toY = (v: number) => 60 - (Math.min(v, chart.max) / chart.max) * 56;
  const chartPath = state.history
    .filter((h) => h.t > state.t - CHART_MS && h.v !== null)
    .map((h, i) => {
      const x = ((h.t - (state.t - CHART_MS)) / CHART_MS) * 300;
      return `${i ? "L" : "M"}${x.toFixed(1)},${toY(h.v!).toFixed(1)}`;
    })
    .join(" ");
  const currentBad = view.current !== null && chart.bad(view.current);

  return (
    <figure
      ref={boxRef}
      className="not-prose my-8 overflow-hidden rounded-xl bg-surface ring-1 ring-border"
      aria-label={`模擬：${sim.title}`}
    >
      <div className="border-b border-border px-4 pt-4 pb-3">
        <figcaption className="text-sm font-semibold text-accent">即時模擬：{sim.title}</figcaption>
        <div role="tablist" aria-label="步驟" className="mt-3 flex flex-wrap gap-2">
          {sim.steps.map((s, i) => (
            <button
              key={s.title}
              type="button"
              role="tab"
              aria-selected={i === stepIndex}
              onClick={() => choose(i)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${
                i === stepIndex ? "bg-accent text-surface ring-accent" : "bg-surface-2 text-muted ring-border hover:text-text"
              }`}
            >
              {i + 1}. {s.title}
            </button>
          ))}
        </div>
      </div>

      <div className={`grid gap-2 px-4 pt-3 ${view.pills.length === 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
        {view.pills.map((p) => (
          <Pill key={p.label} {...p} />
        ))}
      </div>

      <svg viewBox={`0 0 ${W} ${view.height ?? H}`} className="block w-full" role="img" aria-label={view.summary}>
        {view.scene}
      </svg>

      <div className="border-t border-border px-4 pt-3">
        <div className="flex items-baseline justify-between text-[11px] tracking-wider text-muted">
          <span>{chart.label}</span>
          <span className={`font-mono text-xs font-bold ${currentBad ? "text-danger" : "text-accent"}`}>
            {view.current === null ? "—" : chart.format(view.current)}
          </span>
        </div>
        <svg viewBox="0 0 300 64" className="mt-1 block h-16 w-full" preserveAspectRatio="none" aria-hidden>
          {chart.grid.map((v) => (
            <line key={v} x1="0" x2="300" y1={toY(v)} y2={toY(v)} className="stroke-border" strokeWidth="0.6" />
          ))}
          {chart.limit ? (
            <line
              x1="0"
              x2="300"
              y1={toY(chart.limit.value)}
              y2={toY(chart.limit.value)}
              className="stroke-danger"
              strokeWidth="1"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          <path
            d={chartPath}
            fill="none"
            className={currentBad ? "stroke-danger" : "stroke-accent"}
            strokeWidth="1.8"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="flex justify-between font-mono text-[9px] text-muted">
          <span>0</span>
          {chart.limit ? (
            <span className="text-danger">
              - - {chart.limit.label} {chart.format(chart.limit.value)}
            </span>
          ) : null}
          <span>{chart.gridLabel}</span>
        </div>
      </div>

      <div className="space-y-3 px-4 py-4">
        <p className="text-sm leading-relaxed">{step.caption}</p>
        {snippet ? (
          <div className="overflow-hidden rounded-lg ring-1 ring-border">
            <div className="flex items-center gap-1 bg-surface-2 px-2 py-1">
              {(["aws", "gcp"] as const)
                .filter((p) => step.config?.[p])
                .map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setProvider(p)}
                    aria-pressed={shownProvider === p}
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold ${shownProvider === p ? "bg-surface text-text" : "text-muted hover:text-text"}`}
                  >
                    {p === "aws" ? "AWS" : "Google Cloud"}
                  </button>
                ))}
            </div>
            <pre className="overflow-x-auto bg-[var(--code-bg)] p-3 font-mono text-[12px] leading-relaxed text-[#d5dbe5]">
              {snippet}
            </pre>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {reducedMotion ? (
            <p className="text-xs text-muted">
              已依你的「減少動態效果」設定，直接顯示這一步跑 {step.expect.afterMs / 1000} 秒後的結果。
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-semibold ring-1 ring-border hover:ring-accent"
            >
              {playing ? "❚❚ 暫停" : "▶ 繼續"}
            </button>
          )}
          {reducedMotion ? null : (
            <button
              type="button"
              onClick={restart}
              className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-semibold ring-1 ring-border hover:ring-accent"
            >
              ↺ 重新開始
            </button>
          )}
          <span className="self-center font-mono text-[11px] text-muted">{(state.t / 1000).toFixed(1)} 秒</span>
        </div>
      </div>
    </figure>
  );
}
