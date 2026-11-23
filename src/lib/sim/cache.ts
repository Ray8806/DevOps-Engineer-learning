/**
 * A CDN in front of an origin server, for lessons: clients ask for files,
 * popular files more often. With a CDN, an edge location answers from its
 * cache when it has a fresh copy (a hit) and asks the origin otherwise (a
 * miss), then keeps the answer for the TTL. The origin works on a few
 * requests at a time with a waiting line behind them, 503 when full. Pure and
 * deterministic, like engine.ts.
 */

export interface CacheConfig {
  requestsPerSecond: number;
  /** Number of different files; file 1 is the most popular. */
  files: number;
  cdn: boolean;
  /** How long the edge keeps a copy (Cache-Control max-age). */
  ttlMs: number;
  /** The whole cache is cleared at this time (an invalidation). */
  invalidateAtMs?: number;
  origin: { capacity: number; queueLimit: number; workMs: number };
}

/** Time from client to edge (or to the origin without a CDN), and from edge to origin. */
export const HOP_MS = 300;
/** Time an edge takes to answer from its cache. */
export const HIT_MS = 30;
const TICK_MS = 10;
const SAMPLE_MS = 250;
export const RATE_WINDOW_MS = 3000;

export interface CacheRequest {
  id: number;
  file: number;
  startedAt: number;
  /** When it reaches the next place: the edge, or the origin. */
  arrivesAt: number;
  to: "edge" | "origin";
}

interface OriginJob {
  id: number;
  file: number;
  startedAt: number;
  doneAt?: number;
}

export interface CacheState {
  t: number;
  carryMs: number;
  nextId: number;
  nextArrivalAt: number;
  rng: number;
  travelling: CacheRequest[];
  /** file -> time the cached copy expires */
  cache: Record<number, number>;
  working: OriginJob[];
  waiting: OriginJob[];
  invalidated: boolean;
  hits: number[];
  misses: number[];
  originArrivals: number[];
  finished: { at: number; latencyMs: number }[];
  errors: number;
  events: { id: number; kind: "hit" | "503"; at: number }[];
  /** Chart samples: requests per second reaching the origin. */
  history: { t: number; v: number | null }[];
  nextSampleAt: number;
}

export function initialCacheState(): CacheState {
  return {
    t: 0,
    carryMs: 0,
    nextId: 1,
    nextArrivalAt: 0,
    rng: 12345,
    travelling: [],
    cache: {},
    working: [],
    waiting: [],
    invalidated: false,
    hits: [],
    misses: [],
    originArrivals: [],
    finished: [],
    errors: 0,
    events: [],
    history: [],
    nextSampleAt: SAMPLE_MS,
  };
}

/** Picks a file with Zipf-like popularity (file k is asked for about 1/k as often as file 1). */
function pickFile(s: CacheState, files: number): number {
  s.rng = (Math.imul(s.rng, 1103515245) + 12345) >>> 0;
  const u = (s.rng >>> 8) / 2 ** 24;
  let total = 0;
  for (let k = 1; k <= files; k++) total += 1 / k;
  let acc = 0;
  for (let k = 1; k <= files; k++) {
    acc += 1 / k / total;
    if (u < acc) return k;
  }
  return files;
}

export function hitRate(state: CacheState): number | null {
  const since = state.t - RATE_WINDOW_MS;
  const h = state.hits.filter((x) => x > since).length;
  const m = state.misses.filter((x) => x > since).length;
  return h + m ? h / (h + m) : null;
}

export function originPerSecond(state: CacheState): number {
  return state.originArrivals.filter((x) => x > state.t - RATE_WINDOW_MS).length / (RATE_WINDOW_MS / 1000);
}

export function cacheP95(state: CacheState): number | null {
  const values = state.finished.filter((f) => f.at > state.t - RATE_WINDOW_MS).map((f) => f.latencyMs);
  if (!values.length) return null;
  const sorted = values.sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function clone(state: CacheState): CacheState {
  return {
    ...state,
    travelling: [...state.travelling],
    cache: { ...state.cache },
    working: state.working.map((j) => ({ ...j })),
    waiting: state.waiting.map((j) => ({ ...j })),
    hits: [...state.hits],
    misses: [...state.misses],
    originArrivals: [...state.originArrivals],
    finished: [...state.finished],
    events: [...state.events],
    history: [...state.history],
  };
}

function tick(config: CacheConfig, s: CacheState) {
  const t = s.t;
  const o = config.origin;

  if (config.invalidateAtMs !== undefined && !s.invalidated && t >= config.invalidateAtMs) {
    s.cache = {};
    s.invalidated = true;
  }

  // The origin finishes work; with a CDN the edge keeps the answer.
  const still: OriginJob[] = [];
  for (const job of s.working) {
    if (job.doneAt! <= t) {
      // The answer travels back through the edge (or straight to the client).
      s.finished.push({ at: t, latencyMs: t - job.startedAt + (config.cdn ? 2 * HOP_MS : HOP_MS) });
      if (config.cdn) s.cache[job.file] = t + config.ttlMs;
    } else still.push(job);
  }
  s.working = still;
  while (s.working.length < o.capacity && s.waiting.length) {
    s.working.push({ ...s.waiting.shift()!, doneAt: t + o.workMs });
  }

  // Requests arrive at the edge or the origin.
  const arrived = s.travelling.filter((r) => r.arrivesAt <= t);
  s.travelling = s.travelling.filter((r) => r.arrivesAt > t);
  for (const r of arrived) {
    if (r.to === "edge") {
      if ((s.cache[r.file] ?? -Infinity) > t) {
        s.hits.push(t);
        s.finished.push({ at: t, latencyMs: t - r.startedAt + HIT_MS + HOP_MS });
        s.events.push({ id: r.id, kind: "hit", at: t });
      } else {
        s.misses.push(t);
        s.travelling.push({ ...r, to: "origin", arrivesAt: t + HOP_MS });
      }
      continue;
    }
    s.originArrivals.push(t);
    const job: OriginJob = { id: r.id, file: r.file, startedAt: r.startedAt };
    if (s.working.length < o.capacity) s.working.push({ ...job, doneAt: t + o.workMs });
    else if (s.waiting.length < o.queueLimit) s.waiting.push(job);
    else {
      s.errors++;
      s.events.push({ id: r.id, kind: "503", at: t });
    }
  }

  // New requests.
  while (t >= s.nextArrivalAt) {
    const file = pickFile(s, config.files);
    s.travelling.push({ id: s.nextId++, file, startedAt: s.nextArrivalAt, arrivesAt: s.nextArrivalAt + HOP_MS, to: config.cdn ? "edge" : "origin" });
    s.nextArrivalAt += 1000 / config.requestsPerSecond;
  }

  const since = t - RATE_WINDOW_MS;
  s.hits = s.hits.filter((x) => x > since);
  s.misses = s.misses.filter((x) => x > since);
  s.originArrivals = s.originArrivals.filter((x) => x > since);
  s.finished = s.finished.filter((f) => f.at > since);
  s.events = s.events.filter((e) => e.at > t - 600);
  if (t >= s.nextSampleAt) {
    s.history.push({ t, v: originPerSecond(s) });
    s.nextSampleAt += SAMPLE_MS;
  }
}

export function advanceCache(config: CacheConfig, state: CacheState, ms: number): CacheState {
  const s = clone(state);
  s.carryMs += ms;
  while (s.carryMs >= TICK_MS) {
    s.carryMs -= TICK_MS;
    s.t += TICK_MS;
    tick(config, s);
  }
  return s;
}
