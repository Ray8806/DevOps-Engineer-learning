import type { Sim } from "@/lib/content/schema";
import { advanceCache, cacheP95, hitRate, initialCacheState, originPerSecond, type CacheConfig, type CacheState } from "./cache";
import { advance, healthyCount, inService, initialState, p95, type SimConfig, type SimState } from "./engine";
import { advanceQueue, backlog, initialQueueState, oldestAgeMs, type QueueConfig, type QueueState } from "./queue";

type LbSim = Extract<Sim, { kind: "lb" }>;
type QueueSim = Extract<Sim, { kind: "queue" }>;
type CacheSim = Extract<Sim, { kind: "cache" }>;

/** The engine settings for one step of a load-balancer simulation. */
export function stepConfig(sim: LbSim, index: number): SimConfig {
  const step = sim.steps[index];
  return {
    kinds: sim.kinds,
    sequence: sim.sequence,
    requestsPerSecond: sim.requestsPerSecond,
    rateChanges: step.rateChanges,
    algorithm: step.algorithm,
    servers: step.servers,
    healthCheck: step.healthCheck,
    autoscaling: step.autoscaling,
  };
}

export function queueConfig(sim: QueueSim, index: number): QueueConfig {
  const step = sim.steps[index];
  return {
    publishPerSecond: sim.publishPerSecond,
    workMs: sim.workMs,
    consumers: step.consumers,
    poisonEvery: step.poisonEvery,
    visibilityTimeoutMs: step.visibilityTimeoutMs,
    maxReceiveCount: step.maxReceiveCount,
  };
}

export function cacheConfig(sim: CacheSim, index: number): CacheConfig {
  const step = sim.steps[index];
  return {
    requestsPerSecond: sim.requestsPerSecond,
    files: sim.files,
    origin: sim.origin,
    cdn: step.cdn,
    ttlMs: step.ttlMs,
    invalidateAtMs: step.invalidateAtMs,
  };
}

export type AnySimState = SimState | QueueState | CacheState;

export function initialSimState(sim: Sim, index: number): AnySimState {
  if (sim.kind === "lb") return initialState(stepConfig(sim, index));
  if (sim.kind === "queue") return initialQueueState(queueConfig(sim, index));
  return initialCacheState();
}

export function advanceSim(sim: Sim, index: number, state: AnySimState, ms: number): AnySimState {
  if (sim.kind === "lb") return advance(stepConfig(sim, index), state as SimState, ms);
  if (sim.kind === "queue") return advanceQueue(queueConfig(sim, index), state as QueueState, ms);
  return advanceCache(cacheConfig(sim, index), state as CacheState, ms);
}

/** A named metric of the current state, as used by `expect.checks` and the on-screen pills. */
export function simMetric(sim: Sim, state: AnySimState, metric: string): number | null {
  if (sim.kind === "lb") {
    const s = state as SimState;
    if (metric === "p95") return p95(s);
    if (metric === "errors") return s.errors[502] + s.errors[503];
    if (metric === "servers") return inService(s).length;
    if (metric === "healthy") return healthyCount(s);
  } else if (sim.kind === "queue") {
    const s = state as QueueState;
    if (metric === "backlog") return backlog(s);
    if (metric === "oldestAgeMs") return oldestAgeMs(s);
    if (metric === "dlq") return s.dlq;
    if (metric === "redeliveries") return s.redeliveries;
    if (metric === "processed") return s.processed;
  } else {
    const s = state as CacheState;
    if (metric === "hitRate") return hitRate(s);
    if (metric === "originPerSecond") return originPerSecond(s);
    if (metric === "p95") return cacheP95(s);
    if (metric === "errors") return s.errors;
  }
  throw new Error(`unknown metric "${metric}" for a ${sim.kind} simulation`);
}
