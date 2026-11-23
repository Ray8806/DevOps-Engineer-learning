import type { Sim } from "@/lib/content/schema";
import { stepConfig } from "@/lib/sim/config";
import {
  activeServers,
  currentRate,
  healthyCount,
  inService,
  p95,
  specOf,
  TRAVEL_MS,
  type SimState,
} from "@/lib/sim/engine";
import { AMBER, BLUE, Floater, lerp, spread, type SimView } from "./parts";

type LbSim = Extract<Sim, { kind: "lb" }>;

const CLIENT = { x: 34, y: 115 };
const BALANCER = { x: 170, y: 115 };
const SERVER_X = 300;
const KIND_COLOR = [BLUE, AMBER];
/** Above this, the p95 is drawn as a problem. */
const SLOW_MS = 1000;

export function lbView(sim: LbSim, stepIndex: number, state: SimState): SimView {
  const step = sim.steps[stepIndex];
  const config = stepConfig(sim, stepIndex);
  const scaling = config.autoscaling;
  const pool = activeServers(state);
  const serving = inService(state);
  const n = pool.length;
  const compact = n > 4;
  const yOf = (i: number) => spread(pool.indexOf(i), n, 38, 192);
  const hasBalancer = config.algorithm !== "none";
  const latency = p95(state);
  const errors = state.errors[502] + state.errors[503];
  const healthy = healthyCount(state);
  const starting = pool.filter((i) => state.servers[i].readyAt > state.t).length;
  const kindIndex = (id: string) => sim.kinds.findIndex((k) => k.id === id);
  const algorithmLabel =
    config.algorithm === "round_robin" ? "round robin" : config.algorithm === "least_outstanding" ? "least outstanding" : "";
  const boxH = compact ? 22 : 36;

  const pills = [
    {
      label: "p95",
      value: latency === null ? "—" : `${latency} ms`,
      bad: latency !== null && latency > SLOW_MS,
      hint: "95% 的請求在這個時間內完成",
    },
    { label: "錯誤", value: String(errors), bad: errors > 0, hint: "503：伺服器排隊排滿而拒絕；502：伺服器沒有回應" },
    ...(scaling
      ? [
          {
            label: "伺服器",
            value: `${serving.length} 台${starting ? `＋${starting}` : ""}`,
            bad: false,
            hint: "正在接流量的伺服器；＋後面是還在啟動的",
          },
          {
            label: "平均 CPU",
            value: `${Math.round(state.cpu * 100)}%`,
            bad: state.cpu > 0.85,
            hint: `自動擴展最近一次看到的平均使用率，目標是 ${Math.round(scaling.targetCpu * 100)}%`,
          },
        ]
      : [
          {
            label: "健康",
            value: `${healthy}/${serving.length}`,
            bad: healthy < serving.length,
            hint: "負載平衡器認為健康的伺服器數",
          },
        ]),
  ];

  const scene = (
    <>
      {/* links */}
      {pool.map((i) => {
        const from = hasBalancer ? BALANCER : CLIENT;
        return (
          <line
            key={i}
            x1={from.x}
            y1={from.y}
            x2={SERVER_X - 26}
            y2={yOf(i)}
            className={state.servers[i].down ? "stroke-danger" : "stroke-border"}
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
        <text x={CLIENT.x} y={CLIENT.y + 32} textAnchor="middle" className="fill-muted text-[8px] tracking-wider">
          使用者
        </text>
        <text x={CLIENT.x} y={CLIENT.y + 43} textAnchor="middle" className="fill-accent font-mono text-[8px]">
          {currentRate(config, state.t)} 個/秒
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

      {scaling ? (
        <text x={356} y={14} textAnchor="end" className="fill-muted text-[7px]">
          {`自動擴展 ${scaling.min}–${scaling.max} 台・目標 CPU ${Math.round(scaling.targetCpu * 100)}%`}
        </text>
      ) : null}

      {/* servers */}
      {pool.map((i, slot) => {
        const y = yOf(i);
        const srv = state.servers[i];
        const spec = specOf(config, i);
        const load = srv.working.length + srv.waiting.length;
        const warming = srv.readyAt > state.t;
        const rejecting = state.rejections.some((r) => r.server === i && r.code === 503 && r.at > state.t - 400);
        const tone =
          srv.down || rejecting || srv.waiting.length >= spec.queueLimit
            ? "fill-danger-soft stroke-danger"
            : srv.waiting.length > 0
              ? "fill-[#3a2a0c] stroke-[#fbbf24]"
              : "fill-surface stroke-muted";
        const countColor = srv.down || rejecting ? "fill-danger" : srv.waiting.length > 0 ? "fill-[#fbbf24]" : "fill-accent";
        const bars = compact ? 2 : 3;
        const status = srv.down ? "當機" : warming ? "啟動中" : srv.draining ? "移除中" : "處理中";
        return (
          <g key={i} opacity={warming ? 0.6 : srv.draining ? 0.4 : 1}>
            <rect
              x={SERVER_X - 26}
              y={y - boxH / 2}
              width="40"
              height={boxH}
              rx="4"
              className={tone}
              strokeWidth="1.5"
              strokeDasharray={warming ? "3 2" : undefined}
            />
            {Array.from({ length: bars }, (_, r) => (
              <rect
                key={r}
                x={SERVER_X - 21}
                y={y - boxH / 2 + 5 + r * (compact ? 7 : 10)}
                width="30"
                height={compact ? 4.5 : 6}
                rx="1.5"
                className={srv.down ? "fill-danger/40" : r < Math.min(bars, load) ? "fill-accent/70" : "fill-border"}
              />
            ))}
            {srv.down ? (
              <path
                d={`M${SERVER_X - 18},${y - 10} L${SERVER_X + 6},${y + 10} M${SERVER_X + 6},${y - 10} L${SERVER_X - 18},${y + 10}`}
                className="stroke-danger"
                strokeWidth="2.5"
              />
            ) : null}
            <text
              x={SERVER_X + 30}
              y={y + (compact ? 1 : 2)}
              textAnchor="middle"
              className={`${countColor} font-mono ${compact ? "text-[12px]" : "text-[15px]"} font-bold`}
            >
              {srv.down ? "✕" : warming ? "…" : load}
            </text>
            <text x={SERVER_X + 30} y={y + (compact ? 10 : 12)} textAnchor="middle" className="fill-muted text-[6.5px]">
              {status}
            </text>
            {compact ? null : (
              <text
                x={SERVER_X - 6}
                y={y + 27}
                textAnchor="middle"
                className={`text-[7px] tracking-wider ${srv.healthy ? "fill-muted" : "fill-danger"}`}
              >
                {`伺服器 ${slot + 1}${srv.healthy ? "" : "・不健康"}`}
              </text>
            )}
          </g>
        );
      })}

      {/* requests on the way */}
      {state.travelling.map((r) => {
        if (!pool.includes(r.server)) return null;
        const p = Math.min(1, (state.t - r.sentAt) / TRAVEL_MS);
        const target = { x: SERVER_X - 26, y: yOf(r.server) };
        const pos = hasBalancer
          ? p < 0.5
            ? lerp(CLIENT, BALANCER, p * 2)
            : lerp(BALANCER, target, (p - 0.5) * 2)
          : lerp(CLIENT, target, p);
        return <circle key={r.id} cx={pos.x} cy={pos.y} r="3.2" fill={KIND_COLOR[kindIndex(r.kind)] ?? KIND_COLOR[0]} />;
      })}

      {/* rejected requests */}
      {state.rejections.map((r) =>
        pool.includes(r.server) ? (
          <Floater
            key={r.id}
            x={SERVER_X - 34}
            y={yOf(r.server) - boxH / 2 - 4}
            age={state.t - r.at}
            lifeMs={800}
            text={String(r.code)}
            className="fill-danger"
          />
        ) : null,
      )}

      {/* legend */}
      {sim.kinds.map((k, i) => (
        <g key={k.id}>
          <circle cx={CLIENT.x - 18} cy={CLIENT.y + 58 + i * 12} r="3" fill={KIND_COLOR[i]} />
          <text x={CLIENT.x - 11} y={CLIENT.y + 61 + i * 12} className="fill-muted text-[8px]">
            {k.label} {k.workMs / 1000} 秒
          </text>
        </g>
      ))}
    </>
  );

  return {
    pills,
    chart: {
      label: "p95 回應時間（最近 15 秒）",
      max: 3000,
      grid: [1000, 2000, 3000],
      gridLabel: "1 s · 2 s · 3 s 格線",
      format: (v) => `${v} ms`,
      bad: (v) => v > SLOW_MS,
    },
    current: latency,
    scene,
    summary: `${step.title}：p95 ${latency ?? "—"} 毫秒，錯誤 ${errors} 個${scaling ? `，${serving.length} 台伺服器` : ""}`,
  };
}
