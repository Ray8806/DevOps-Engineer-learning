import type { Sim } from "@/lib/content/schema";
import { cacheConfig } from "@/lib/sim/config";
import { cacheP95, hitRate, HOP_MS, originPerSecond, type CacheState } from "@/lib/sim/cache";
import { Floater, GREEN, lerp, BLUE, type SimView } from "./parts";

type CacheSim = Extract<Sim, { kind: "cache" }>;

const CLIENT = { x: 34, y: 82 };
const EDGE = { x: 165, y: 82 };
const ORIGIN = { x: 296, y: 82 };
/** Files drawn in the edge's cache, most popular first. */
const SHOWN_FILES = 12;
const SLOW_MS = 1000;

function seconds(ms: number): string {
  return ms >= 1000 ? `${ms / 1000} 秒` : `${ms} 毫秒`;
}

export function cacheView(sim: CacheSim, stepIndex: number, state: CacheState): SimView {
  const step = sim.steps[stepIndex];
  const config = cacheConfig(sim, stepIndex);
  const o = config.origin;
  const limit = (o.capacity * 1000) / o.workMs;
  const hits = hitRate(state);
  const originRate = originPerSecond(state);
  const latency = cacheP95(state);
  const load = state.working.length + state.waiting.length;
  const rejecting = state.events.some((e) => e.kind === "503" && e.at > state.t - 400);
  const originTone =
    rejecting || state.waiting.length >= o.queueLimit
      ? "fill-danger-soft stroke-danger"
      : state.waiting.length > 0
        ? "fill-[#3a2a0c] stroke-[#fbbf24]"
        : "fill-surface stroke-muted";
  const countColor = rejecting ? "fill-danger" : state.waiting.length > 0 ? "fill-[#fbbf24]" : "fill-accent";
  const justCleared = config.invalidateAtMs !== undefined && state.invalidated && state.t - config.invalidateAtMs < 2500;

  const pills = [
    {
      label: "命中率",
      value: !config.cdn || hits === null ? "—" : `${Math.round(hits * 100)}%`,
      bad: config.cdn && hits !== null && hits < 0.5,
      hint: "最近 3 秒由 CDN 快取直接回答的比例",
    },
    {
      label: "打到來源",
      value: `${Math.round(originRate)} 個/秒`,
      bad: originRate > limit,
      hint: `最近 3 秒平均每秒打到來源伺服器的請求；它每秒最多處理約 ${limit} 個`,
    },
    {
      label: "p95",
      value: latency === null ? "—" : `${latency} ms`,
      bad: latency !== null && latency > SLOW_MS,
      hint: "95% 的請求在這個時間內拿到回應",
    },
    { label: "錯誤", value: String(state.errors), bad: state.errors > 0, hint: "503：來源伺服器排隊排滿而拒絕" },
  ];

  const scene = (
    <>
      {/* links */}
      {config.cdn ? (
        <>
          <line x1={CLIENT.x} y1={CLIENT.y} x2={EDGE.x} y2={EDGE.y} className="stroke-border" strokeWidth="1.5" strokeDasharray="3 4" />
          <line x1={EDGE.x} y1={EDGE.y} x2={ORIGIN.x} y2={ORIGIN.y} className="stroke-border" strokeWidth="1.5" strokeDasharray="3 4" />
        </>
      ) : (
        <line x1={CLIENT.x} y1={CLIENT.y} x2={ORIGIN.x} y2={ORIGIN.y} className="stroke-border" strokeWidth="1.5" strokeDasharray="3 4" />
      )}

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
        <text x={CLIENT.x} y={CLIENT.y + 32} textAnchor="middle" className="fill-muted text-[8px] tracking-wider">
          使用者
        </text>
        <text x={CLIENT.x} y={CLIENT.y + 43} textAnchor="middle" className="fill-accent font-mono text-[8px]">
          {config.requestsPerSecond} 個/秒
        </text>
        <text x={CLIENT.x} y={CLIENT.y + 54} textAnchor="middle" className="fill-muted text-[7px]">
          {`${config.files} 個檔案`}
        </text>
      </g>

      {/* edge */}
      {config.cdn ? (
        <g>
          <rect x={EDGE.x - 32} y={EDGE.y - 26} width="64" height="52" rx="8" className="fill-accent-soft stroke-accent" strokeWidth="1.5" />
          {Array.from({ length: SHOWN_FILES }, (_, k) => {
            const file = k + 1;
            const fresh = (state.cache[file] ?? -Infinity) > state.t;
            return (
              <rect
                key={file}
                x={EDGE.x - 25 + (k % 4) * 13}
                y={EDGE.y - 19 + Math.floor(k / 4) * 13}
                width="11"
                height="11"
                rx="2"
                className={fresh ? "fill-accent" : "fill-border"}
              />
            );
          })}
          <text x={EDGE.x} y={EDGE.y + 37} textAnchor="middle" className="fill-muted text-[8px] tracking-wider">
            CDN 邊緣節點
          </text>
          <text x={EDGE.x} y={EDGE.y + 48} textAnchor="middle" className="fill-accent font-mono text-[8px]">
            {`TTL ${seconds(config.ttlMs)}`}
          </text>
          {justCleared ? (
            <text x={EDGE.x} y={EDGE.y - 33} textAnchor="middle" className="fill-danger text-[8px] font-bold">
              快取已清除（invalidation）
            </text>
          ) : null}
        </g>
      ) : (
        <text x={EDGE.x} y={EDGE.y - 10} textAnchor="middle" className="fill-muted text-[8px]">
          沒有 CDN：每個請求都到來源伺服器
        </text>
      )}

      {/* origin */}
      <g>
        <rect x={ORIGIN.x - 20} y={ORIGIN.y - 18} width="40" height="36" rx="4" className={originTone} strokeWidth="1.5" />
        {Array.from({ length: Math.min(4, o.capacity) }, (_, r) => (
          <rect
            key={r}
            x={ORIGIN.x - 15}
            y={ORIGIN.y - 13 + r * 10}
            width="30"
            height="6"
            rx="1.5"
            className={r < state.working.length ? "fill-accent/70" : "fill-border"}
          />
        ))}
        <text x={ORIGIN.x + 36} y={ORIGIN.y + 2} textAnchor="middle" className={`${countColor} font-mono text-[15px] font-bold`}>
          {load}
        </text>
        <text x={ORIGIN.x + 36} y={ORIGIN.y + 12} textAnchor="middle" className="fill-muted text-[6.5px]">
          處理中
        </text>
        <text x={ORIGIN.x} y={ORIGIN.y + 29} textAnchor="middle" className="fill-muted text-[8px] tracking-wider">
          來源伺服器
        </text>
        <text x={ORIGIN.x} y={ORIGIN.y + 40} textAnchor="middle" className="fill-muted text-[7px]">
          {`每次 ${o.workMs} 毫秒・同時 ${o.capacity} 個`}
        </text>
      </g>

      {/* requests on the way */}
      {state.travelling.map((r) => {
        const p = Math.min(1, Math.max(0, 1 - (r.arrivesAt - state.t) / HOP_MS));
        const pos =
          r.to === "edge"
            ? lerp(CLIENT, { x: EDGE.x - 32, y: EDGE.y }, p)
            : lerp(config.cdn ? { x: EDGE.x + 32, y: EDGE.y } : CLIENT, { x: ORIGIN.x - 20, y: ORIGIN.y }, p);
        return <circle key={r.id} cx={pos.x} cy={pos.y} r="3" fill={BLUE} />;
      })}

      {/* answers from the cache, and rejections */}
      {state.events.map((e) => {
        const since = state.t - e.at;
        if (e.kind === "hit") {
          if (since >= HOP_MS) return null;
          const pos = lerp({ x: EDGE.x - 32, y: EDGE.y + 8 }, { x: CLIENT.x + 22, y: CLIENT.y + 8 }, since / HOP_MS);
          return <circle key={`h${e.id}`} cx={pos.x} cy={pos.y} r="3" fill={GREEN} />;
        }
        return (
          <Floater
            key={`x${e.id}`}
            x={ORIGIN.x - 26}
            y={ORIGIN.y - 22}
            age={since}
            lifeMs={600}
            text="503"
            className="fill-danger"
          />
        );
      })}

      {/* legend */}
      <g>
        <circle cx={13} cy={163} r="3" fill={BLUE} />
        <text x={20} y={166} className="fill-muted text-[7.5px]">
          請求
        </text>
        <circle cx={13} cy={175} r="3" fill={GREEN} />
        <text x={20} y={178} className="fill-muted text-[7.5px]">
          快取直接回答
        </text>
        {config.cdn ? (
          <>
            <rect x={70} y={158} width="9" height="9" rx="2" className="fill-accent" />
            <text x={83} y={166} className="fill-muted text-[7.5px]">
              熱門檔案有快取
            </text>
          </>
        ) : null}
      </g>
    </>
  );

  return {
    pills,
    chart: {
      label: "每秒打到來源的請求（最近 15 秒）",
      max: 30,
      grid: [10, 20, 30],
      gridLabel: "10 · 20 · 30 個/秒格線",
      format: (v) => `${Math.round(v)} 個/秒`,
      bad: (v) => v > limit,
      limit: { value: limit, label: "處理上限" },
    },
    current: originRate,
    scene,
    height: 188,
    summary: `${step.title}：命中率 ${hits === null || !config.cdn ? "—" : `${Math.round(hits * 100)}%`}，來源伺服器每秒 ${Math.round(originRate)} 個請求，錯誤 ${state.errors} 個`,
  };
}
