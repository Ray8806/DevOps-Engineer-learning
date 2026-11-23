/**
 * A message queue with consumers, for lessons: producers publish messages,
 * each consumer handles one message at a time, and a message it does not
 * finish (it fails) becomes visible again after the visibility timeout (Pub/Sub:
 * ack deadline). With a dead-letter queue, a message received more than
 * `maxReceiveCount` times is moved there instead. Pure and deterministic,
 * like engine.ts.
 */

export interface QueueConfig {
  publishPerSecond: number;
  /** Time a consumer spends on one message. */
  workMs: number;
  consumers: number;
  /** Every n-th message always fails (a "poison" message); unset for none. */
  poisonEvery?: number;
  visibilityTimeoutMs: number;
  /** Move a message to the dead-letter queue after this many receives; unset for no dead-letter queue. */
  maxReceiveCount?: number;
}

/** Time a message takes from producer to queue, and from queue to consumer, drawn as dots. */
export const PUBLISH_MS = 500;
export const DELIVER_MS = 300;
/** A poison message fails quickly (for example, it cannot be parsed). */
export const FAIL_MS = 100;
const TICK_MS = 10;
const SAMPLE_MS = 250;

export interface Message {
  id: number;
  poison: boolean;
  publishedAt: number;
  receives: number;
  /** While received: when it becomes visible again if not deleted. */
  visibleAt: number;
}

export interface Consumer {
  message: Message | null;
  receivedAt: number;
  doneAt: number;
}

export interface QueueState {
  t: number;
  carryMs: number;
  nextId: number;
  nextPublishAt: number;
  publishing: { id: number; poison: boolean; sentAt: number }[];
  /** Waiting to be received, oldest first. */
  visible: Message[];
  /** Received and not yet deleted. */
  inFlight: Message[];
  consumers: Consumer[];
  processed: number;
  /** Times a message was received again after a failure. */
  redeliveries: number;
  dlq: number;
  /** Recent events, kept briefly so they can be drawn. */
  events: { id: number; kind: "done" | "failed" | "dlq"; consumer: number; at: number }[];
  /** Chart samples: backlog (visible + in flight) over time. */
  history: { t: number; v: number | null }[];
  nextSampleAt: number;
}

export function initialQueueState(config: QueueConfig): QueueState {
  return {
    t: 0,
    carryMs: 0,
    nextId: 1,
    nextPublishAt: 0,
    publishing: [],
    visible: [],
    inFlight: [],
    consumers: Array.from({ length: config.consumers }, () => ({ message: null, receivedAt: 0, doneAt: 0 })),
    processed: 0,
    redeliveries: 0,
    dlq: 0,
    events: [],
    history: [],
    nextSampleAt: SAMPLE_MS,
  };
}

export function backlog(state: QueueState): number {
  return state.visible.length + state.inFlight.length;
}

/** Age of the oldest message not yet deleted (SQS ApproximateAgeOfOldestMessage). */
export function oldestAgeMs(state: QueueState): number {
  const times = [...state.visible, ...state.inFlight].map((m) => m.publishedAt);
  return times.length ? state.t - Math.min(...times) : 0;
}

function clone(state: QueueState): QueueState {
  const copy = (m: Message) => ({ ...m });
  return {
    ...state,
    publishing: [...state.publishing],
    visible: state.visible.map(copy),
    inFlight: state.inFlight.map(copy),
    consumers: state.consumers.map((c) => ({ ...c, message: c.message ? copy(c.message) : null })),
    events: [...state.events],
    history: [...state.history],
  };
}

function tick(config: QueueConfig, s: QueueState) {
  const t = s.t;

  // Published messages reach the queue.
  for (const p of s.publishing.filter((m) => m.sentAt + PUBLISH_MS <= t)) {
    s.visible.push({ id: p.id, poison: p.poison, publishedAt: p.sentAt, receives: 0, visibleAt: 0 });
  }
  s.publishing = s.publishing.filter((m) => m.sentAt + PUBLISH_MS > t);

  // Messages not deleted in time become visible again.
  const expired = s.inFlight.filter((m) => m.visibleAt <= t);
  s.inFlight = s.inFlight.filter((m) => m.visibleAt > t);
  for (const m of expired) s.visible.push(m);

  // Consumers finish: success deletes the message, failure leaves it to time out.
  s.consumers.forEach((c, i) => {
    if (!c.message || c.doneAt > t) return;
    if (c.message.poison) {
      s.events.push({ id: c.message.id, kind: "failed", consumer: i, at: t });
    } else {
      s.inFlight = s.inFlight.filter((m) => m.id !== c.message!.id);
      s.processed++;
      s.events.push({ id: c.message.id, kind: "done", consumer: i, at: t });
    }
    c.message = null;
  });

  // Idle consumers receive the oldest visible message.
  s.consumers.forEach((c, i) => {
    while (!c.message && s.visible.length) {
      const m = s.visible.shift()!;
      m.receives++;
      if (m.receives > 1) s.redeliveries++;
      if (config.maxReceiveCount !== undefined && m.receives > config.maxReceiveCount) {
        s.dlq++;
        s.events.push({ id: m.id, kind: "dlq", consumer: i, at: t });
        continue;
      }
      m.visibleAt = t + config.visibilityTimeoutMs;
      s.inFlight.push(m);
      c.message = { ...m };
      c.receivedAt = t;
      c.doneAt = t + (m.poison ? Math.min(FAIL_MS, config.workMs) : config.workMs);
    }
  });

  // Producers publish.
  while (t >= s.nextPublishAt) {
    const id = s.nextId++;
    s.publishing.push({ id, poison: config.poisonEvery !== undefined && id % config.poisonEvery === 0, sentAt: s.nextPublishAt });
    s.nextPublishAt += 1000 / config.publishPerSecond;
  }

  s.events = s.events.filter((e) => e.at > t - 900);
  if (t >= s.nextSampleAt) {
    s.history.push({ t, v: backlog(s) });
    s.nextSampleAt += SAMPLE_MS;
  }
}

export function advanceQueue(config: QueueConfig, state: QueueState, ms: number): QueueState {
  const s = clone(state);
  s.carryMs += ms;
  while (s.carryMs >= TICK_MS) {
    s.carryMs -= TICK_MS;
    s.t += TICK_MS;
    tick(config, s);
  }
  return s;
}
