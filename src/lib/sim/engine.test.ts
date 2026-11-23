import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content/loader";
import { advance, healthyCount, initialState, outstanding, percentile95, TRAVEL_MS, type SimConfig } from "./engine";
import { advanceSim, initialSimState, simMetric } from "./config";
import { advanceQueue, backlog, initialQueueState, PUBLISH_MS, type QueueConfig } from "./queue";
import { advanceCache, HOP_MS, hitRate, initialCacheState, type CacheConfig } from "./cache";

const kinds = [
  { id: "light", label: "輕", workMs: 100 },
  { id: "heavy", label: "重", workMs: 1000 },
];
const server = { capacity: 1, queueLimit: 2 };
const base: SimConfig = { kinds, sequence: ["light"], requestsPerSecond: 4, algorithm: "round_robin", servers: [server, server] };

describe("engine", () => {
  it("does not change the state it is given", () => {
    const s0 = initialState(base);
    const copy = JSON.stringify(s0);
    advance(base, s0, 2000);
    expect(JSON.stringify(s0)).toBe(copy);
  });

  it("is deterministic", () => {
    const a = advance(base, initialState(base), 5000);
    const b = advance(base, advance(base, initialState(base), 2500), 2500);
    expect(a.served).toBe(b.served);
    expect(a.history).toEqual(b.history);
  });

  it("keeps time that is not a whole tick", () => {
    let s = initialState(base);
    for (let i = 0; i < 60; i++) s = advance(base, s, 1000 / 60);
    expect(s.t).toBeGreaterThanOrEqual(990);
    expect(s.t).toBeLessThanOrEqual(1000);
  });

  it("round robin alternates between servers", () => {
    // Requests leave at 0, 250 and 500 ms and are all still on the way at 550 ms.
    const s = advance(base, initialState(base), 550);
    expect(s.travelling.map((r) => r.server)).toEqual([0, 1, 0]);
  });

  it("least outstanding picks the server with the fewest requests in progress", () => {
    const cfg: SimConfig = {
      ...base,
      algorithm: "least_outstanding",
      sequence: ["heavy", "light", "light"],
      requestsPerSecond: 4,
    };
    // The heavy request (on its way to server 0) counts as in progress, so the next one goes to server 1;
    // then both have one, and the tie goes to the first server.
    const s = advance(cfg, initialState(cfg), 550);
    expect(s.travelling.map((r) => r.server)).toEqual([0, 1, 0]);
    expect(outstanding(s, 0)).toBe(2);
    expect(outstanding(s, 1)).toBe(1);
  });

  it("rejects with 503 when the waiting line is full", () => {
    const cfg: SimConfig = { ...base, algorithm: "none", sequence: ["heavy"], requestsPerSecond: 10, servers: [server] };
    const s = advance(cfg, initialState(cfg), 3000);
    expect(s.errors[503]).toBeGreaterThan(0);
    expect(s.servers[0].waiting.length).toBeLessThanOrEqual(server.queueLimit);
  });

  it("stops sending to a failed server once health checks mark it unhealthy", () => {
    const cfg: SimConfig = {
      ...base,
      servers: [server, { ...server, failsAtMs: 1000 }],
      healthCheck: { intervalMs: 500, unhealthyThreshold: 2 },
    };
    let s = advance(cfg, initialState(cfg), 1000);
    expect(healthyCount(s)).toBe(2);
    s = advance(cfg, s, 1100);
    expect(healthyCount(s)).toBe(1);
    const errorsThen = s.errors[502];
    expect(errorsThen).toBeGreaterThan(0);
    // Requests already on the way still fail; after that, none do.
    s = advance(cfg, s, TRAVEL_MS + 100);
    const settled = s.errors[502];
    s = advance(cfg, s, 3000);
    expect(s.errors[502]).toBe(settled);
  });

  it("takes the 95th percentile", () => {
    expect(percentile95([])).toBeNull();
    expect(percentile95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(percentile95([5])).toBe(5);
  });
});

describe("autoscaling", () => {
  const cfg: SimConfig = {
    ...base,
    algorithm: "least_outstanding",
    sequence: ["heavy"],
    requestsPerSecond: 4,
    servers: [{ capacity: 1, queueLimit: 10 }],
    autoscaling: { min: 1, max: 4, targetCpu: 0.5, evaluationMs: 1000, warmupMs: 2000, scaleInCooldownMs: 1000 },
  };

  it("adds servers that take traffic only after warming up", () => {
    let s = advance(cfg, initialState(cfg), 2000);
    expect(s.servers.length).toBeGreaterThan(1);
    const added = s.servers.length - 1;
    expect(s.servers.slice(1).every((x) => x.readyAt > s.t)).toBe(true);
    expect(s.travelling.every((r) => r.server === 0)).toBe(true);
    s = advance(cfg, s, 2500);
    expect(s.servers.slice(1, 1 + added).every((x) => x.readyAt <= s.t)).toBe(true);
  });

  it("never goes above max or below min", () => {
    let s = initialState(cfg);
    for (let i = 0; i < 30; i++) {
      s = advance(cfg, s, 1000);
      const pool = s.servers.filter((x) => !x.removed && !x.draining).length;
      expect(pool).toBeGreaterThanOrEqual(1);
      expect(pool).toBeLessThanOrEqual(4);
    }
  });
});

describe("queue", () => {
  const q: QueueConfig = { publishPerSecond: 2, workMs: 200, consumers: 1, visibilityTimeoutMs: 1000 };

  it("does not change the state it is given", () => {
    const s0 = advanceQueue(q, initialQueueState(q), 1000);
    const copy = JSON.stringify(s0);
    advanceQueue(q, s0, 2000);
    expect(JSON.stringify(s0)).toBe(copy);
  });

  it("deletes messages that were handled", () => {
    const s = advanceQueue(q, initialQueueState(q), 5000);
    expect(s.processed).toBeGreaterThanOrEqual(8);
    expect(backlog(s)).toBeLessThanOrEqual(2);
  });

  it("delivers a failed message again after the visibility timeout", () => {
    const cfg = { ...q, poisonEvery: 1 };
    // The first message arrives at PUBLISH_MS, fails, and is visible again a second later.
    let s = advanceQueue(cfg, initialQueueState(cfg), PUBLISH_MS + 500);
    expect(s.redeliveries).toBe(0);
    s = advanceQueue(cfg, s, 600);
    expect(s.redeliveries).toBeGreaterThan(0);
    expect(s.processed).toBe(0);
  });

  it("moves a message to the dead-letter queue after maxReceiveCount receives", () => {
    const cfg = { ...q, publishPerSecond: 0.1, poisonEvery: 1, maxReceiveCount: 3 };
    // Received at PUBLISH_MS and after each of three timeouts; the fourth receive moves it.
    let s = advanceQueue(cfg, initialQueueState(cfg), PUBLISH_MS + 2 * cfg.visibilityTimeoutMs + 100);
    expect(s.dlq).toBe(0);
    s = advanceQueue(cfg, s, cfg.visibilityTimeoutMs);
    expect(s.dlq).toBe(1);
    expect(backlog(s)).toBe(0);
  });
});

describe("cache", () => {
  const c: CacheConfig = { requestsPerSecond: 10, files: 1, cdn: true, ttlMs: 2000, origin: { capacity: 5, queueLimit: 5, workMs: 100 } };

  it("does not change the state it is given", () => {
    const s0 = advanceCache(c, initialCacheState(), 1000);
    const copy = JSON.stringify(s0);
    advanceCache(c, s0, 2000);
    expect(JSON.stringify(s0)).toBe(copy);
  });

  it("answers from the cache until the copy expires", () => {
    // One file: after the first miss is answered, requests hit.
    const s = advanceCache(c, initialCacheState(), 2 * HOP_MS + 1500);
    expect(hitRate(s)).toBeGreaterThan(0.5);
    const noTtl = advanceCache({ ...c, ttlMs: 0 }, initialCacheState(), 2 * HOP_MS + 1500);
    expect(hitRate(noTtl)).toBe(0);
  });

  it("sends everything to the origin without a CDN", () => {
    const s = advanceCache({ ...c, cdn: false }, initialCacheState(), 3000);
    expect(s.hits.length).toBe(0);
    expect(s.originArrivals.length).toBeGreaterThan(20);
  });
});

describe("every lesson simulation", () => {
  const { units } = loadContent();
  const sims = [...units.values()].flatMap((u) => u.sims.map((sim) => ({ unit: u.meta.id, sim })));

  it("exists", () => {
    expect(sims.length).toBeGreaterThan(0);
  });

  // Each step's caption makes a claim; the engine has to back it up.
  for (const { unit, sim } of sims) {
    sim.steps.forEach((step, i) => {
      it(`${unit}/${sim.id} step ${i + 1}: ${step.title}`, () => {
        const state = advanceSim(sim, i, initialSimState(sim, i), step.expect.afterMs);
        for (const check of step.expect.checks) {
          const value = simMetric(sim, state, check.metric) ?? 0;
          if (check.min !== undefined) expect(value, check.metric).toBeGreaterThanOrEqual(check.min);
          if (check.max !== undefined) expect(value, check.metric).toBeLessThanOrEqual(check.max);
        }
      });
    });
  }
});
