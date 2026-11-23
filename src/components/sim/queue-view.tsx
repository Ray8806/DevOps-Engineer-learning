import type { Sim } from "@/lib/content/schema";
import { queueConfig } from "@/lib/sim/config";
import { backlog, DELIVER_MS, oldestAgeMs, PUBLISH_MS, type QueueState } from "@/lib/sim/queue";
import { BLUE, Floater, GREEN, lerp, RED, spread, type SimView } from "./parts";

type QueueSim = Extract<Sim, { kind: "queue" }>;

const PRODUCER = { x: 34, y: 105 };
/** The queue box. */
const Q = { x: 150, y: 105, w: 104, h: 64 };
const DLQ = { x: 150, y: 192, w: 72, h: 26 };
const CONSUMER_X = 288;
const CELL = 7;
const GAP = 2;
const COLS = Math.floor((Q.w - 8) / (CELL + GAP));
const ROWS = Math.floor((Q.h - 8) / (CELL + GAP));
/** Above this many messages waiting, the backlog is drawn as a problem. */
const BACKLOG_BAD = 20;

export function queueView(sim: QueueSim, stepIndex: number, state: QueueState): SimView {
  const step = sim.steps[stepIndex];
  const config = queueConfig(sim, stepIndex);
  const n = state.consumers.length;
  const boxH = n > 4 ? 22 : 30;
  const yOf = (i: number) => spread(i, n, 38, 172);
  const waiting = backlog(state);
  const age = oldestAgeMs(state);
  const hasDlq = config.maxReceiveCount !== undefined;

  // In flight first: they were received earlier, so they are usually the oldest.
  const cells = [...state.inFlight.map((m) => ({ ...m, taken: true })), ...state.visible.map((m) => ({ ...m, taken: false }))];
  const shown = cells.slice(0, COLS * ROWS);
  const left = { x: Q.x - Q.w / 2, y: Q.y };
  const right = { x: Q.x + Q.w / 2, y: Q.y };

  const pills = [
    { label: "積壓", value: `${waiting} 則`, bad: waiting > BACKLOG_BAD, hint: "還沒被刪除的訊息：等著被取走的，加上正在處理的" },
    {
      label: "最舊訊息",
      value: `${(age / 1000).toFixed(1)} 秒`,
      bad: age > 10000,
      hint: "最舊一則訊息在佇列裡待了多久（SQS：ApproximateAgeOfOldestMessage）",
    },
    {
      label: "重新投遞",
      value: String(state.redeliveries),
      bad: false,
      hint: "處理失敗、可見性逾時後再次被取走的次數",
    },
    { label: "DLQ", value: hasDlq ? `${state.dlq} 則` : "—", bad: false, hint: "被移到 dead-letter 佇列的訊息數" },
  ];

  const scene = (
    <>
      {/* links */}
      <line
        x1={PRODUCER.x + 22}
        y1={PRODUCER.y}
        x2={left.x}
        y2={left.y}
        className="stroke-border"
        strokeWidth="1.5"
        strokeDasharray="3 4"
      />
      {state.consumers.map((_, i) => (
        <line
          key={i}
          x1={right.x}
          y1={right.y}
          x2={CONSUMER_X - 22}
          y2={yOf(i)}
          className="stroke-border"
          strokeWidth="1.5"
          strokeDasharray="3 4"
        />
      ))}
      <line
        x1={Q.x}
        y1={Q.y + Q.h / 2}
        x2={DLQ.x}
        y2={DLQ.y - DLQ.h / 2}
        className={hasDlq ? "stroke-danger" : "stroke-border"}
        strokeWidth="1.5"
        strokeDasharray="3 4"
        opacity={hasDlq ? 0.8 : 0.4}
      />

      {/* producer */}
      <g>
        <rect
          x={PRODUCER.x - 22}
          y={PRODUCER.y - 16}
          width="44"
          height="30"
          rx="4"
          className="fill-surface stroke-accent"
          strokeWidth="1.5"
        />
        <path
          d={`M${PRODUCER.x - 12},${PRODUCER.y - 6} h24 M${PRODUCER.x - 12},${PRODUCER.y} h18 M${PRODUCER.x - 12},${PRODUCER.y + 6} h21`}
          className="stroke-accent"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <text x={PRODUCER.x} y={PRODUCER.y + 28} textAnchor="middle" className="fill-muted text-[8px] tracking-wider">
          生產者
        </text>
        <text x={PRODUCER.x} y={PRODUCER.y + 39} textAnchor="middle" className="fill-accent font-mono text-[8px]">
          {config.publishPerSecond} 則/秒
        </text>
      </g>

      {/* queue */}
      <g>
        <rect
          x={Q.x - Q.w / 2}
          y={Q.y - Q.h / 2}
          width={Q.w}
          height={Q.h}
          rx="6"
          className={waiting > BACKLOG_BAD ? "fill-danger-soft stroke-danger" : "fill-accent-soft stroke-accent"}
          strokeWidth="1.5"
        />
        {shown.map((m, k) => {
          const x = Q.x - Q.w / 2 + 4 + (k % COLS) * (CELL + GAP) + GAP / 2;
          const y = Q.y - Q.h / 2 + 4 + Math.floor(k / COLS) * (CELL + GAP) + GAP / 2;
          const color = m.poison ? RED : BLUE;
          return m.taken ? (
            <rect key={m.id} x={x + 0.5} y={y + 0.5} width={CELL - 1} height={CELL - 1} rx="1" fill="none" stroke={color} strokeWidth="1" />
          ) : (
            <rect key={m.id} x={x} y={y} width={CELL} height={CELL} rx="1" fill={color} />
          );
        })}
        {cells.length > shown.length ? (
          <text x={Q.x + Q.w / 2 - 3} y={Q.y - Q.h / 2 - 3} textAnchor="end" className="fill-danger font-mono text-[8px] font-bold">
            +{cells.length - shown.length}
          </text>
        ) : null}
        <text x={Q.x} y={Q.y - Q.h / 2 - 15} textAnchor="middle" className="fill-muted text-[8px] tracking-wider">
          佇列
        </text>
        <text x={Q.x} y={Q.y - Q.h / 2 - 5} textAnchor="middle" className="fill-muted text-[7px]">
          {`可見性逾時 ${config.visibilityTimeoutMs / 1000} 秒`}
        </text>
      </g>

      {/* dead-letter queue */}
      <g opacity={hasDlq ? 1 : 0.5}>
        <rect
          x={DLQ.x - DLQ.w / 2}
          y={DLQ.y - DLQ.h / 2}
          width={DLQ.w}
          height={DLQ.h}
          rx="5"
          className={hasDlq ? "fill-danger-soft stroke-danger" : "fill-surface stroke-border"}
          strokeWidth="1.5"
          strokeDasharray={hasDlq ? undefined : "3 3"}
        />
        <text
          x={DLQ.x}
          y={DLQ.y + 3.5}
          textAnchor="middle"
          className={`font-mono text-[10px] font-bold ${hasDlq ? "fill-danger" : "fill-muted"}`}
        >
          {hasDlq ? state.dlq : "未設定"}
        </text>
        <text x={DLQ.x + DLQ.w / 2 + 5} y={DLQ.y - 2} className="fill-muted text-[7px]">
          dead-letter 佇列
        </text>
        <text x={DLQ.x + DLQ.w / 2 + 5} y={DLQ.y + 8} className="fill-muted text-[7px]">
          {hasDlq ? `收到 ${config.maxReceiveCount} 次後移入` : "失敗的訊息會一直重來"}
        </text>
      </g>

      {/* consumers */}
      <text x={CONSUMER_X} y={14} textAnchor="middle" className="fill-muted text-[7px]">
        {`消費者・每則 ${config.workMs / 1000} 秒`}
      </text>
      {state.consumers.map((c, i) => {
        const y = yOf(i);
        const progress = c.message ? Math.min(1, (state.t - c.receivedAt) / Math.max(1, c.doneAt - c.receivedAt)) : 0;
        return (
          <g key={i}>
            <rect
              x={CONSUMER_X - 22}
              y={y - boxH / 2}
              width="44"
              height={boxH}
              rx="4"
              className={c.message ? "fill-surface stroke-accent" : "fill-surface stroke-muted"}
              strokeWidth="1.5"
            />
            <rect x={CONSUMER_X - 16} y={y - 3} width="32" height="6" rx="1.5" className="fill-border" />
            {c.message ? (
              <rect x={CONSUMER_X - 16} y={y - 3} width={32 * progress} height="6" rx="1.5" fill={c.message.poison ? RED : BLUE} />
            ) : null}
            <text x={CONSUMER_X + 27} y={y + 3} className="fill-muted text-[7px]">
              {c.message ? `#${i + 1}` : `#${i + 1} 閒置`}
            </text>
          </g>
        );
      })}

      {/* messages being published */}
      {state.publishing.map((m) => {
        const pos = lerp({ x: PRODUCER.x + 22, y: PRODUCER.y }, left, Math.min(1, (state.t - m.sentAt) / PUBLISH_MS));
        return <circle key={m.id} cx={pos.x} cy={pos.y} r="3.2" fill={m.poison ? RED : BLUE} />;
      })}

      {/* messages being delivered */}
      {state.consumers.map((c, i) => {
        if (!c.message || state.t - c.receivedAt >= DELIVER_MS) return null;
        const pos = lerp(right, { x: CONSUMER_X - 22, y: yOf(i) }, (state.t - c.receivedAt) / DELIVER_MS);
        return <circle key={`d${c.message.id}`} cx={pos.x} cy={pos.y} r="3.2" fill={c.message.poison ? RED : BLUE} />;
      })}

      {/* results */}
      {state.events.map((e) => {
        const since = state.t - e.at;
        if (e.kind === "dlq") {
          if (since > 500) return null;
          const pos = lerp({ x: Q.x, y: Q.y + Q.h / 2 }, { x: DLQ.x, y: DLQ.y - DLQ.h / 2 }, since / 500);
          return <circle key={`e${e.id}-${e.at}`} cx={pos.x} cy={pos.y} r="3.2" fill={RED} />;
        }
        const done = e.kind === "done";
        return (
          <Floater
            key={`e${e.id}-${e.at}`}
            x={CONSUMER_X + 63}
            y={yOf(e.consumer) + 3}
            age={since}
            lifeMs={900}
            text={done ? "✓" : "✕"}
            className={done ? "fill-[#4ade80]" : "fill-danger"}
          />
        );
      })}

      {/* legend */}
      <g>
        <rect x={10} y={168} width="7" height="7" rx="1" fill={BLUE} />
        <text x={21} y={174} className="fill-muted text-[7.5px]">
          等待中
        </text>
        <rect x={10.5} y={180.5} width="6" height="6" rx="1" fill="none" stroke={BLUE} />
        <text x={21} y={186} className="fill-muted text-[7.5px]">
          處理中（看不見）
        </text>
        <rect x={10} y={192} width="7" height="7" rx="1" fill={RED} />
        <text x={21} y={198} className="fill-muted text-[7.5px]">
          有毒訊息（必定失敗）
        </text>
        <circle cx={13.5} cy={207.5} r="3" fill={GREEN} />
        <text x={21} y={210} className="fill-muted text-[7.5px]">
          ✓ 處理完並刪除
        </text>
      </g>
    </>
  );

  return {
    pills,
    chart: {
      label: "積壓訊息數（最近 15 秒）",
      max: 60,
      grid: [20, 40, 60],
      gridLabel: "20 · 40 · 60 則格線",
      format: (v) => `${v} 則`,
      bad: (v) => v > BACKLOG_BAD,
    },
    current: waiting,
    scene,
    summary: `${step.title}：積壓 ${waiting} 則，最舊訊息 ${(age / 1000).toFixed(1)} 秒${hasDlq ? `，dead-letter 佇列 ${state.dlq} 則` : ""}`,
  };
}
