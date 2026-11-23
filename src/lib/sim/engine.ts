/**
 * A small, deterministic traffic simulation for lessons: clients send
 * requests, an optional load balancer picks a server, and each server works
 * on a few requests at a time with a waiting line behind them. Pure: `advance`
 * returns a new state and never changes the one passed in, so the same step
 * always produces the same numbers, in the browser and in tests.
 */

export type Algorithm = "none" | "round_robin" | "least_outstanding";

export interface RequestKind {
  id: string;
  label: string;
  /** Time a server spends on one request of this kind. */
  workMs: number;
}

export interface ServerSpec {
  /** Requests worked on at the same time. */
  capacity: number;
  /** Requests that may wait; more are rejected with 503. */
  queueLimit: number;
  /** The server stops answering at this time (ms from the start). */
  failsAtMs?: number;
}

export interface HealthCheckSpec {
  intervalMs: number;
  /** Consecutive failed checks before the balancer stops using a server. */
  unhealthyThreshold: number;
}

export interface AutoscalingSpec {
  min: number;
  max: number;
  /** Target average CPU, 0–1: share of each server's capacity in use. */
  targetCpu: number;
  /** How often the autoscaler looks at the average CPU. */
  evaluationMs: number;
  /** Time before a new server takes traffic. */
  warmupMs: number;
  /** Time after scaling out before removing a server. */
  scaleInCooldownMs: number;
}

export interface SimConfig {
  kinds: readonly RequestKind[];
  /** Kinds of successive requests, repeated in order. */
  sequence: readonly string[];
  requestsPerSecond: number;
  /** Later changes to the request rate. */
  rateChanges?: readonly { atMs: number; requestsPerSecond: number }[];
  algorithm: Algorithm;
  /** With autoscaling, servers[0] is the template for every server. */
  servers: readonly ServerSpec[];
  healthCheck?: HealthCheckSpec;
  autoscaling?: AutoscalingSpec;
}

/** Time a request spends travelling to its server, drawn as a moving dot. */
export const TRAVEL_MS = 600;
/** p95 is taken over requests finished in this recent window. */
export const WINDOW_MS = 3000;
export const SAMPLE_MS = 250;
const TICK_MS = 10;

export interface Travelling {
  id: number;
  kind: string;
  server: number;
  sentAt: number;
}

interface Job {
  id: number;
  kind: string;
  arrivedAt: number;
  doneAt?: number;
}

export interface ServerState {
  working: Job[];
  waiting: Job[];
  down: boolean;
  /** As the load balancer sees it. */
  healthy: boolean;
  failedChecks: number;
  /** Starting up until this time; takes no traffic before it. */
  readyAt: number;
  /** Being removed: takes no new traffic and is dropped once empty. */
  draining: boolean;
  removed: boolean;
  /** Sum of the share of capacity in use, per tick, since the last evaluation. */
  busy: number;
}

export interface Rejection {
  id: number;
  kind: string;
  server: number;
  at: number;
  code: 502 | 503;
}

export interface SimState {
  t: number;
  /** Time passed in but not yet simulated (less than one tick). */
  carryMs: number;
  nextId: number;
  nextArrivalAt: number;
  sequenceIndex: number;
  rrIndex: number;
  nextCheckAt: number;
  servers: ServerState[];
  travelling: Travelling[];
  /** Latency (ms) and finish time of recently finished requests. */
  finished: { at: number; latencyMs: number }[];
  /** Recent rejections, kept briefly so they can be drawn. */
  rejections: Rejection[];
  served: number;
  errors: { 502: number; 503: number };
  /** Chart samples: p95 over time. */
  history: { t: number; v: number | null }[];
  nextSampleAt: number;
  nextEvaluationAt: number;
  lastScaleOutAt: number;
  /** Average CPU at the last autoscaler evaluation, 0–1. */
  cpu: number;
  busyTicks: number;
}

export function initialState(config: SimConfig): SimState {
  return {
    t: 0,
    carryMs: 0,
    nextId: 1,
    nextArrivalAt: 0,
    sequenceIndex: 0,
    rrIndex: 0,
    nextCheckAt: config.healthCheck?.intervalMs ?? Infinity,
    servers: Array.from({ length: config.autoscaling ? config.autoscaling.min : config.servers.length }, () => newServer(0)),
    travelling: [],
    finished: [],
    rejections: [],
    served: 0,
    errors: { 502: 0, 503: 0 },
    history: [],
    nextSampleAt: SAMPLE_MS,
    nextEvaluationAt: config.autoscaling?.evaluationMs ?? Infinity,
    lastScaleOutAt: -Infinity,
    cpu: 0,
    busyTicks: 0,
  };
}

function newServer(readyAt: number): ServerState {
  return { working: [], waiting: [], down: false, healthy: true, failedChecks: 0, readyAt, draining: false, removed: false, busy: 0 };
}

export function specOf(config: SimConfig, i: number): ServerSpec {
  return config.autoscaling ? config.servers[0] : config.servers[i];
}

/** Servers still part of the pool (starting, running or draining). */
export function activeServers(state: SimState): number[] {
  return state.servers.flatMap((s, i) => (s.removed ? [] : [i]));
}

/** Servers taking traffic. */
export function inService(state: SimState): number[] {
  return state.servers.flatMap((s, i) => (!s.removed && !s.draining && s.readyAt <= state.t ? [i] : []));
}

export function currentRate(config: SimConfig, t: number): number {
  let rate = config.requestsPerSecond;
  for (const c of config.rateChanges ?? []) if (t >= c.atMs) rate = c.requestsPerSecond;
  return rate;
}

/** In-progress requests a balancer counts for a server: working, waiting and on the way. */
export function outstanding(state: SimState, server: number): number {
  const s = state.servers[server];
  return s.working.length + s.waiting.length + state.travelling.filter((r) => r.server === server).length;
}

function pickServer(config: SimConfig, state: SimState): number {
  const all = inService(state);
  if (config.algorithm === "none") return 0;
  // Like ALB: only healthy targets, unless none are healthy.
  const healthy = all.filter((i) => state.servers[i].healthy);
  const candidates = healthy.length ? healthy : all;
  if (config.algorithm === "round_robin") {
    const pick = candidates[state.rrIndex % candidates.length];
    state.rrIndex++;
    return pick;
  }
  let best = candidates[0];
  for (const i of candidates) if (outstanding(state, i) < outstanding(state, best)) best = i;
  return best;
}

export function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export function p95(state: SimState): number | null {
  return percentile95(state.finished.filter((f) => f.at > state.t - WINDOW_MS).map((f) => f.latencyMs));
}

function clone(state: SimState): SimState {
  return {
    ...state,
    servers: state.servers.map((s) => ({
      ...s,
      working: s.working.map((j) => ({ ...j })),
      waiting: s.waiting.map((j) => ({ ...j })),
    })),
    travelling: [...state.travelling],
    finished: [...state.finished],
    rejections: [...state.rejections],
    errors: { ...state.errors },
    history: [...state.history],
  };
}

function tick(config: SimConfig, s: SimState) {
  const t = s.t;
  const workOf = (kind: string) => config.kinds.find((k) => k.id === kind)?.workMs ?? 0;

  // Servers that fail now drop everything they hold.
  s.servers.forEach((server, i) => {
    const spec = specOf(config, i);
    if (!server.down && spec.failsAtMs !== undefined && t >= spec.failsAtMs) {
      server.down = true;
      for (const job of [...server.working, ...server.waiting]) {
        s.rejections.push({ id: job.id, kind: job.kind, server: i, at: t, code: 502 });
        s.errors[502]++;
      }
      server.working = [];
      server.waiting = [];
    }
  });

  // Finish work and start waiting jobs.
  s.servers.forEach((server) => {
    const still: Job[] = [];
    for (const job of server.working) {
      if (job.doneAt !== undefined && job.doneAt <= t) {
        s.finished.push({ at: t, latencyMs: t - job.arrivedAt });
        s.served++;
      } else still.push(job);
    }
    server.working = still;
  });
  s.servers.forEach((server, i) => {
    const spec = specOf(config, i);
    while (!server.down && server.working.length < spec.capacity && server.waiting.length) {
      const job = server.waiting.shift()!;
      server.working.push({ ...job, doneAt: t + workOf(job.kind) });
    }
  });

  // Requests reach their server.
  const arrived = s.travelling.filter((r) => r.sentAt + TRAVEL_MS <= t);
  s.travelling = s.travelling.filter((r) => r.sentAt + TRAVEL_MS > t);
  for (const r of arrived) {
    const spec = specOf(config, r.server);
    const server = s.servers[r.server];
    const job: Job = { id: r.id, kind: r.kind, arrivedAt: t };
    if (server.down) {
      s.rejections.push({ id: r.id, kind: r.kind, server: r.server, at: t, code: 502 });
      s.errors[502]++;
    } else if (server.working.length < spec.capacity) {
      server.working.push({ ...job, doneAt: t + workOf(r.kind) });
    } else if (server.waiting.length < spec.queueLimit) {
      server.waiting.push(job);
    } else {
      s.rejections.push({ id: r.id, kind: r.kind, server: r.server, at: t, code: 503 });
      s.errors[503]++;
    }
  }

  // Health checks.
  if (config.healthCheck && t >= s.nextCheckAt) {
    s.nextCheckAt += config.healthCheck.intervalMs;
    for (const server of s.servers) {
      if (server.down) {
        server.failedChecks++;
        if (server.failedChecks >= config.healthCheck.unhealthyThreshold) server.healthy = false;
      } else {
        server.failedChecks = 0;
        server.healthy = true;
      }
    }
  }

  // New requests.
  while (t >= s.nextArrivalAt) {
    const kind = config.sequence[s.sequenceIndex % config.sequence.length];
    s.sequenceIndex++;
    const server = pickServer(config, s);
    s.travelling.push({ id: s.nextId++, kind, server, sentAt: s.nextArrivalAt });
    s.nextArrivalAt += 1000 / currentRate(config, s.nextArrivalAt);
  }

  if (config.autoscaling) autoscale(config, config.autoscaling, s);

  // Keep only what is still needed.
  s.finished = s.finished.filter((f) => f.at > t - WINDOW_MS);
  s.rejections = s.rejections.filter((r) => r.at > t - 800);
  if (t >= s.nextSampleAt) {
    s.history.push({ t, v: p95(s) });
    s.nextSampleAt += SAMPLE_MS;
  }
}

/** Runs the simulation forward by `ms`. */
export function advance(config: SimConfig, state: SimState, ms: number): SimState {
  const s = clone(state);
  // Animation frames are not a whole number of ticks; keep the remainder for the next call.
  s.carryMs += ms;
  while (s.carryMs >= TICK_MS) {
    s.carryMs -= TICK_MS;
    s.t += TICK_MS;
    tick(config, s);
  }
  return s;
}

export function healthyCount(state: SimState): number {
  return inService(state).filter((i) => state.servers[i].healthy).length;
}

/**
 * Target tracking: keep the average CPU near the target. Like the
 * autoscalers, it adds servers in proportion to how far above target the
 * average is, and removes them one at a time after a cooldown.
 */
function autoscale(config: SimConfig, as: AutoscalingSpec, s: SimState) {
  const capacity = config.servers[0].capacity;
  for (const i of inService(s)) s.servers[i].busy += s.servers[i].working.length / capacity;
  s.busyTicks++;
  // Drained servers leave the pool.
  s.servers.forEach((server, i) => {
    if (server.draining && !server.working.length && !server.waiting.length && !s.travelling.some((r) => r.server === i)) {
      server.removed = true;
    }
  });
  if (s.t < s.nextEvaluationAt) return;
  s.nextEvaluationAt += as.evaluationMs;

  const serving = inService(s);
  const cpu = serving.length ? serving.reduce((sum, i) => sum + s.servers[i].busy, 0) / (serving.length * s.busyTicks) : 0;
  s.cpu = cpu;
  for (const server of s.servers) server.busy = 0;
  s.busyTicks = 0;

  const pool = s.servers.filter((x) => !x.removed && !x.draining);
  const starting = pool.filter((x) => x.readyAt > s.t).length;
  const desired = Math.min(as.max, Math.max(as.min, Math.ceil((serving.length * cpu) / as.targetCpu)));
  if (desired > pool.length) {
    for (let n = pool.length; n < desired; n++) s.servers.push(newServer(s.t + as.warmupMs));
    s.lastScaleOutAt = s.t;
  } else if (desired < pool.length && starting === 0 && s.t - s.lastScaleOutAt >= as.scaleInCooldownMs) {
    const last = s.servers.findLastIndex((x) => !x.removed && !x.draining);
    s.servers[last].draining = true;
    s.lastScaleOutAt = s.t;
  }
}
