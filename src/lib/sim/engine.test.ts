import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content/loader";
import { advance, healthyCount, initialState, outstanding, p95, percentile95, TRAVEL_MS, type SimConfig } from "./engine";
import { stepConfig } from "./config";

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
        const cfg = stepConfig(sim, i);
        const s = advance(cfg, initialState(cfg), step.expect.afterMs);
        const latency = p95(s) ?? 0;
        const errors = s.errors[502] + s.errors[503];
        const e = step.expect;
        if (e.p95MaxMs !== undefined) expect(latency).toBeLessThanOrEqual(e.p95MaxMs);
        if (e.p95MinMs !== undefined) expect(latency).toBeGreaterThanOrEqual(e.p95MinMs);
        if (e.errorsMax !== undefined) expect(errors).toBeLessThanOrEqual(e.errorsMax);
        if (e.errorsMin !== undefined) expect(errors).toBeGreaterThanOrEqual(e.errorsMin);
      });
    });
  }
});
