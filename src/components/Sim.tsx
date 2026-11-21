"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Sim as SimData } from "@/lib/content/schema";
import { stepConfig } from "@/lib/sim/config";
import { advance, healthyCount, initialState, p95, TRAVEL_MS, type SimState } from "@/lib/sim/engine";
import { useProgress } from "@/lib/progress/use-progress";

const W = 360;
const H = 230;
const CLIENT = { x: 34, y: 115 };
const BALANCER = { x: 170, y: 115 };
const SERVER_X = 300;
/** How much simulated time the chart shows. */
const CHART_MS = 15000;
const CHART_MAX = 3000;
/** Above this, the p95 is drawn as a problem. */
const SLOW_MS = 1000;
const KIND_COLOR = ["#7dd3fc", "#fbbf24"];

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function serverY(i: number, count: number): number {
  if (count === 1) return CLIENT.y;
  const top = 38;
  const bottom = 192;
  return top + ((bottom - top) * i) / (count - 1);
}

function lerp(a: { x: number; y: number }, b: { x: number; y: number }, p: number) {
  return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
}

function Pill({ label, value, bad, hint }: { label: string; value: string; bad: boolean; hint: string }) {
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

export function Sim({ sim }: { sim: SimData }) {
  const [progress] = useProgress();
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [live, setState] = useState<SimState>(() => initialState(stepConfig(sim, 0)));
  const [provider, setProvider] = useState<"aws" | "gcp" | null>(null);
  const [visible, setVisible] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const step = sim.steps[stepIndex];
  const config = stepConfig(sim, stepIndex);
  const shownProvider = provider ?? (progress.preferredProvider === "gcp" ? "gcp" : "aws");
  const snippet = step.config?.[shownProvider] ?? step.config?.aws ?? step.config?.gcp;
  const running = playing && visible && !reducedMotion;
  // Without motion, show where the step ends up instead of animating it.
  const outcome = useMemo(
    () => advance(stepConfig(sim, stepIndex), initialState(stepConfig(sim, stepIndex)), sim.steps[stepIndex].expect.afterMs),
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
      setState((s) => advance(config, s, dt));
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
    // config is derived from stepIndex.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, stepIndex]);

  function choose(i: number) {
    setStepIndex(i);
    setState(initialState(stepConfig(sim, i)));
    setPlaying(true);
  }

  function restart() {
    setState(initialState(config));
    setPlaying(true);
  }

  const n = config.servers.length;
  const hasBalancer = config.algorithm !== "none";
  const latency = p95(state);
  const errors = state.errors[502] + state.errors[503];
  const healthy = healthyCount(state);
  const kindIndex = (id: string) => sim.kinds.findIndex((k) => k.id === id);
  const algorithmLabel =
    config.algorithm === "round_robin" ? "round robin" : config.algorithm === "least_outstanding" ? "least outstanding" : "";

  const points = state.history.filter((h) => h.t > state.t - CHART_MS);
  const chartPath = points
    .filter((h) => h.p95 !== null)
    .map((h, i) => {
      const x = ((h.t - (state.t - CHART_MS)) / CHART_MS) * 300;
      const y = 60 - (Math.min(h.p95!, CHART_MAX) / CHART_MAX) * 56;
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

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

      <div className="grid grid-cols-3 gap-2 px-4 pt-3">
        <Pill
          label="p95"
          value={latency === null ? "—" : `${latency} ms`}
          bad={latency !== null && latency > SLOW_MS}
          hint="95% 的請求在這個時間內完成"
        />
        <Pill label="錯誤" value={String(errors)} bad={errors > 0} hint="503：伺服器排隊排滿而拒絕；502：伺服器沒有回應" />
        <Pill label="健康" value={`${healthy}/${n}`} bad={healthy < n} hint="負載平衡器認為健康的伺服器數" />
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full"
        role="img"
        aria-label={`${step.title}：p95 ${latency ?? "—"} 毫秒，錯誤 ${errors} 個`}
      >
        {/* links */}
        {Array.from({ length: n }, (_, i) => {
          const from = hasBalancer ? BALANCER : CLIENT;
          const down = state.servers[i].down;
          return (
            <line
              key={i}
              x1={from.x}
              y1={from.y}
              x2={SERVER_X - 26}
              y2={serverY(i, n)}
              className={down ? "stroke-danger" : "stroke-border"}
              strokeWidth="1.5"
              strokeDasharray="3 4"
            />
          );
        })}
        {hasBalancer ? (
          <line
            x1={CLIENT.x}
            y1={CLIENT.y}
            x2={BALANCER.x}
            y2={BALANCER.y}
            className="stroke-border"
            strokeWidth="1.5"
            strokeDasharray="3 4"
          />
        ) : null}

        {/* clients */}
        <g>
          <rect
            x={CLIENT.x - 22}
            y={CLIENT.y - 16}
            width="44"
            height="30"
            rx="4"
            className="fill-surface stroke-accent"
            strokeWidth="1.5"
          />
          <rect x={CLIENT.x - 6} y={CLIENT.y + 14} width="12" height="5" className="fill-accent" />
          <text x={CLIENT.x} y={CLIENT.y + 34} textAnchor="middle" className="fill-muted text-[8px] tracking-wider">
            使用者
          </text>
        </g>

        {/* balancer */}
        {hasBalancer ? (
          <g>
            <rect
              x={BALANCER.x - 20}
              y={BALANCER.y - 20}
              width="40"
              height="40"
              rx="9"
              className="fill-accent-soft stroke-accent"
              strokeWidth="1.5"
            />
            <path
              d={`M${BALANCER.x - 10},${BALANCER.y} H${BALANCER.x} M${BALANCER.x},${BALANCER.y} L${BALANCER.x + 10},${BALANCER.y - 9} M${BALANCER.x},${BALANCER.y} H${BALANCER.x + 11} M${BALANCER.x},${BALANCER.y} L${BALANCER.x + 10},${BALANCER.y + 9}`}
              className="stroke-accent"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
            />
            <text x={BALANCER.x} y={BALANCER.y - 27} textAnchor="middle" className="fill-accent font-mono text-[8px]">
              {algorithmLabel}
            </text>
            <text x={BALANCER.x} y={BALANCER.y + 34} textAnchor="middle" className="fill-muted text-[8px] tracking-wider">
              負載平衡器
            </text>
          </g>
        ) : null}

        {/* servers */}
        {Array.from({ length: n }, (_, i) => {
          const y = serverY(i, n);
          const srv = state.servers[i];
          const spec = config.servers[i];
          const load = srv.working.length + srv.waiting.length;
          const rejecting = state.rejections.some((r) => r.server === i && r.code === 503 && r.at > state.t - 400);
          const tone = srv.down
            ? "fill-danger-soft stroke-danger"
            : rejecting || srv.waiting.length >= spec.queueLimit
              ? "fill-danger-soft stroke-danger"
              : srv.waiting.length > 0
                ? "fill-[#3a2a0c] stroke-[#fbbf24]"
                : "fill-surface stroke-muted";
          const countColor = srv.down || rejecting ? "fill-danger" : srv.waiting.length > 0 ? "fill-[#fbbf24]" : "fill-accent";
          return (
            <g key={i}>
              <rect x={SERVER_X - 26} y={y - 18} width="40" height="36" rx="4" className={tone} strokeWidth="1.5" />
              {[0, 1, 2].map((r) => (
                <rect
                  key={r}
                  x={SERVER_X - 21}
                  y={y - 13 + r * 10}
                  width="30"
                  height="6"
                  rx="1.5"
                  className={srv.down ? "fill-danger/40" : r < Math.min(3, load) ? "fill-accent/70" : "fill-border"}
                />
              ))}
              {srv.down ? (
                <path
                  d={`M${SERVER_X - 18},${y - 10} L${SERVER_X + 6},${y + 10} M${SERVER_X + 6},${y - 10} L${SERVER_X - 18},${y + 10}`}
                  className="stroke-danger"
                  strokeWidth="2.5"
                />
              ) : null}
              <text x={SERVER_X + 30} y={y + 2} textAnchor="middle" className={`${countColor} font-mono text-[15px] font-bold`}>
                {srv.down ? "✕" : load}
              </text>
              <text x={SERVER_X + 30} y={y + 12} textAnchor="middle" className="fill-muted text-[6.5px]">
                {srv.down ? "當機" : "處理中"}
              </text>
              <text
                x={SERVER_X - 6}
                y={y + 27}
                textAnchor="middle"
                className={`text-[7px] tracking-wider ${srv.healthy ? "fill-muted" : "fill-danger"}`}
              >
                {`伺服器 ${i + 1}${srv.healthy ? "" : "・不健康"}`}
              </text>
            </g>
          );
        })}

        {/* requests on the way */}
        {state.travelling.map((r) => {
          const p = Math.min(1, (state.t - r.sentAt) / TRAVEL_MS);
          const target = { x: SERVER_X - 26, y: serverY(r.server, n) };
          const pos = hasBalancer
            ? p < 0.5
              ? lerp(CLIENT, BALANCER, p * 2)
              : lerp(BALANCER, target, (p - 0.5) * 2)
            : lerp(CLIENT, target, p);
          return <circle key={r.id} cx={pos.x} cy={pos.y} r="3.2" fill={KIND_COLOR[kindIndex(r.kind)] ?? KIND_COLOR[0]} />;
        })}

        {/* rejected requests */}
        {state.rejections.map((r) => {
          const age = (state.t - r.at) / 800;
          const y = serverY(r.server, n);
          return (
            <text
              key={r.id}
              x={SERVER_X - 34}
              y={y - 22 - age * 14}
              textAnchor="middle"
              className="fill-danger font-mono text-[8px] font-bold"
              opacity={1 - age}
            >
              {r.code}
            </text>
          );
        })}

        {/* legend */}
        {sim.kinds.map((k, i) => (
          <g key={k.id}>
            <circle cx={CLIENT.x - 18} cy={CLIENT.y + 50 + i * 12} r="3" fill={KIND_COLOR[i]} />
            <text x={CLIENT.x - 11} y={CLIENT.y + 53 + i * 12} className="fill-muted text-[8px]">
              {k.label} {k.workMs / 1000} 秒
            </text>
          </g>
        ))}
      </svg>

      <div className="border-t border-border px-4 pt-3">
        <div className="flex items-baseline justify-between text-[11px] tracking-wider text-muted">
          <span>p95 回應時間（最近 15 秒）</span>
          <span
            className={`font-mono text-xs font-bold ${latency !== null && latency > SLOW_MS ? "text-danger" : "text-accent"}`}
          >
            {latency === null ? "—" : `${latency} ms`}
          </span>
        </div>
        <svg viewBox="0 0 300 64" className="mt-1 block h-16 w-full" preserveAspectRatio="none" aria-hidden>
          {[1000, 2000, 3000].map((v) => (
            <line
              key={v}
              x1="0"
              x2="300"
              y1={60 - (v / CHART_MAX) * 56}
              y2={60 - (v / CHART_MAX) * 56}
              className="stroke-border"
              strokeWidth="0.6"
            />
          ))}
          <path
            d={chartPath}
            fill="none"
            className={latency !== null && latency > SLOW_MS ? "stroke-danger" : "stroke-accent"}
            strokeWidth="1.8"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="flex justify-between font-mono text-[9px] text-muted">
          <span>0</span>
          <span>1 s · 2 s · 3 s 格線</span>
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
