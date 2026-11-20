import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonical, mergeProgress, sameProgress } from "./merge";
import { EMPTY_PROGRESS, recordChallengeRun, recordLabDone, recordQuizAttempt, setPreferredProvider, setUnitRead, type Progress } from "./progress";
import { createLocalProgressStore } from "./store";
import { baseKey, createProgressSync, type RemoteProgress } from "./sync";

const E = EMPTY_PROGRESS;
const read = (p: Progress, unit: string) => p.units[unit]?.read ?? false;

describe("mergeProgress", () => {
  it("combines progress from two devices that never synced", () => {
    const a = setUnitRead(recordLabDone(E, "u1", "lab-a"), "u1", true);
    const b = recordLabDone(recordQuizAttempt(E, "u1", [{ questionId: "q1", correct: true }]), "u1", "lab-b");
    const m = mergeProgress(E, a, b);
    expect(m.units.u1).toEqual({ read: true, quizScore: 1, labsDone: ["lab-a", "lab-b"] });
    expect(m.questions.q1).toEqual({ attempts: 1, lastCorrect: true });
    expect(sameProgress(mergeProgress(E, b, a), m)).toBe(true);
  });

  it("keeps a change made on one side, including undoing something", () => {
    const base = setUnitRead(E, "u1", true);
    // This device marked the lesson unread; the account still has the old state.
    const local = setUnitRead(base, "u1", false);
    expect(read(mergeProgress(base, local, base), "u1")).toBe(false);
    // The other device did it; this device is unchanged.
    expect(read(mergeProgress(base, base, local), "u1")).toBe(false);
  });

  it("keeps the most progress when both sides changed the same thing", () => {
    const base = recordQuizAttempt(E, "u1", [{ questionId: "q1", correct: false }]);
    const local = recordQuizAttempt(base, "u1", [{ questionId: "q1", correct: true }]);
    const remote = recordQuizAttempt(recordQuizAttempt(base, "u1", [{ questionId: "q1", correct: false }]), "u1", [{ questionId: "q1", correct: false }]);
    const m = mergeProgress(base, local, remote);
    expect(m.units.u1.quizScore).toBe(1);
    expect(m.questions.q1).toEqual({ attempts: 3, lastCorrect: false });
  });

  it("keeps the most challenge runs and the earliest clear", () => {
    const local = recordChallengeRun(recordChallengeRun(E, "c1", false), "c1", true);
    const remote = recordChallengeRun(recordChallengeRun(recordChallengeRun(E, "c1", false), "c1", false), "c1", false);
    const m = mergeProgress(E, local, remote);
    expect(m.challenges.c1).toEqual({ runs: 3, clearedOnRun: 2 });
    expect(mergeProgress(E, E, local).challenges.c1).toEqual({ runs: 2, clearedOnRun: 2 });
  });

  it("prefers a chosen platform over the default", () => {
    const aws = setPreferredProvider(E, "aws");
    const gcp = setPreferredProvider(E, "gcp");
    expect(mergeProgress(E, E, aws).preferredProvider).toBe("aws");
    expect(mergeProgress(E, aws, E).preferredProvider).toBe("aws");
    expect(mergeProgress(E, aws, gcp).preferredProvider).toBe("aws");
    expect(mergeProgress(aws, aws, gcp).preferredProvider).toBe("gcp");
  });

  it("adds exam results from both sides once", () => {
    const e1 = { certId: "clf-c02", date: "2026-11-01", score: 0.7, byDomain: {} };
    const e2 = { certId: "clf-c02", date: "2026-11-02", score: 0.8, byDomain: {} };
    const m = mergeProgress(E, { ...E, exams: [e2] }, { ...E, exams: [e1, e2] });
    expect(m.exams).toEqual([e1, e2]);
  });

  it("compares progress ignoring key order", () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

/** One "server" row shared by several fake devices. */
function server() {
  let row: Progress | null = null;
  const remote: RemoteProgress & { saves: number } = {
    saves: 0,
    load: async () => (row ? structuredClone(row) : null),
    save: async (p) => {
      remote.saves++;
      row = structuredClone(p);
    },
  };
  return { remote, row: () => row };
}

function device(remote: RemoteProgress) {
  const storage = memoryStorage();
  const store = createLocalProgressStore(() => storage);
  const sync = createProgressSync({ store, remote, accountId: "user-1", storage: () => storage, debounceMs: 1000 });
  return { storage, store, sync };
}

describe("createProgressSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uploads this device's progress on the first sync and remembers the base", async () => {
    const s = server();
    const a = device(s.remote);
    a.store.update((p) => setUnitRead(p, "u1", true));
    await a.sync.sync();
    expect(read(s.row()!, "u1")).toBe(true);
    expect(a.sync.status().state).toBe("synced");
    expect(a.storage.data.has(baseKey("user-1"))).toBe(true);
  });

  it("brings two devices to the same progress", async () => {
    const s = server();
    const a = device(s.remote);
    const b = device(s.remote);
    a.store.update((p) => setUnitRead(p, "u1", true));
    b.store.update((p) => recordLabDone(p, "u2", "lab"));
    await a.sync.sync();
    await b.sync.sync();
    await a.sync.sync();
    expect(sameProgress(a.store.get(), b.store.get())).toBe(true);
    expect(read(a.store.get(), "u1")).toBe(true);
    expect(a.store.get().units.u2.labsDone).toEqual(["lab"]);

    // Marking unread on one device reaches the other instead of coming back.
    b.store.update((p) => setUnitRead(p, "u1", false));
    await b.sync.sync();
    await a.sync.sync();
    expect(read(a.store.get(), "u1")).toBe(false);
    await b.sync.sync();
    expect(read(b.store.get(), "u1")).toBe(false);
  });

  it("syncs local changes after a pause, once", async () => {
    const s = server();
    const a = device(s.remote);
    await a.sync.sync();
    const saves = s.remote.saves;
    a.store.update((p) => setUnitRead(p, "u1", true));
    a.store.update((p) => setUnitRead(p, "u2", true));
    await vi.advanceTimersByTimeAsync(999);
    expect(s.remote.saves).toBe(saves);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.remote.saves).toBe(saves + 1);
    expect(read(s.row()!, "u2")).toBe(true);
    a.sync.stop();
    a.store.update((p) => setUnitRead(p, "u3", true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(read(s.row()!, "u3")).toBe(false);
  });

  it("reports errors and keeps local progress", async () => {
    const a = device({ load: async () => Promise.reject(new Error("offline")), save: async () => {} });
    a.store.update((p) => setUnitRead(p, "u1", true));
    await a.sync.sync();
    expect(a.sync.status()).toEqual({ state: "error", message: "offline" });
    expect(read(a.store.get(), "u1")).toBe(true);
  });
});
