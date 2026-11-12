import { describe, expect, it } from "vitest";
import {
  EMPTY_PROGRESS,
  countDone,
  defaultProvider,
  matchesProvider,
  missingPrerequisites,
  isLabDone,
  isUnitDone,
  parseProgress,
  quizScore,
  recordAnswers,
  recordLabDone,
  recordQuizAttempt,
  remainingLabs,
  requiredLabs,
  setPreferredProvider,
  setUnitRead,
  unitStatus,
  type Progress,
  type UnitRef,
} from "./progress";
import { STORAGE_KEY, createLocalProgressStore } from "./store";

const iam: UnitRef = { id: "iam", prerequisites: [], providers: ["aws", "gcp"], labs: [] };
const s3: UnitRef = { id: "s3-deep-dive", prerequisites: ["iam"], providers: ["aws"], labs: [] };
const linux: UnitRef = { id: "linux", prerequisites: [], providers: [], labs: [] };
/** A unit with one lab per platform and one general lab. */
const storage: UnitRef = {
  id: "storage",
  prerequisites: [],
  providers: ["aws", "gcp"],
  labs: [
    { id: "lab-aws", provider: "aws" },
    { id: "lab-gcp", provider: "gcp" },
    { id: "lab-general", provider: "general" },
  ],
};
const all = [iam, s3, linux, storage];
const find = (id: string) => all.find((u) => u.id === id);

const attempt = (...correct: boolean[]) => correct.map((c, i) => ({ questionId: `q${i + 1}`, correct: c }));

/** Lesson read and quiz passed. */
function complete(progress: Progress, unitId: string): Progress {
  return recordQuizAttempt(setUnitRead(progress, unitId, true), unitId, attempt(true));
}

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("progress updates", () => {
  it("marks a unit read without mutating the previous progress", () => {
    const next = setUnitRead(EMPTY_PROGRESS, "iam", true);
    expect(next.units.iam.read).toBe(true);
    expect(EMPTY_PROGRESS.units.iam).toBeUndefined();
  });

  it("keeps other unit fields when toggling read", () => {
    const start = { ...EMPTY_PROGRESS, units: { iam: { read: true, quizScore: 0.8, labsDone: ["lab-a"] } } };
    expect(setUnitRead(start, "iam", false).units.iam).toEqual({ read: false, quizScore: 0.8, labsDone: ["lab-a"] });
  });
});

describe("unit status", () => {
  it("is available with no prerequisites, locked until prerequisites are done", () => {
    expect(unitStatus(EMPTY_PROGRESS, iam, find)).toBe("available");
    expect(unitStatus(EMPTY_PROGRESS, s3, find)).toBe("locked");
    expect(missingPrerequisites(EMPTY_PROGRESS, s3, find)).toEqual(["iam"]);

    const afterIam = complete(EMPTY_PROGRESS, "iam");
    expect(unitStatus(afterIam, iam, find)).toBe("done");
    expect(unitStatus(afterIam, s3, find)).toBe("available");
  });

  it("needs both the lesson and a passed quiz to be done", () => {
    const readOnly = setUnitRead(EMPTY_PROGRESS, "iam", true);
    expect(unitStatus(readOnly, iam, find)).toBe("in-progress");
    expect(unitStatus(readOnly, s3, find)).toBe("locked");

    const quizOnly = recordQuizAttempt(EMPTY_PROGRESS, "iam", attempt(true));
    expect(unitStatus(quizOnly, iam, find)).toBe("in-progress");

    const failedQuiz = recordQuizAttempt(readOnly, "iam", attempt(true, false));
    expect(unitStatus(failedQuiz, iam, find)).toBe("in-progress");

    expect(isUnitDone(recordQuizAttempt(readOnly, "iam", attempt(true)), iam)).toBe(true);
  });

  it("passes at exactly 80% and fails just below", () => {
    const read = setUnitRead(EMPTY_PROGRESS, "iam", true);
    expect(isUnitDone(recordQuizAttempt(read, "iam", attempt(true, true, true, true, false)), iam)).toBe(true);
    expect(isUnitDone(recordQuizAttempt(read, "iam", attempt(true, true, true, false, false)), iam)).toBe(false);
  });

  it("locks a unit again when its prerequisite is un-marked", () => {
    const p = setUnitRead(complete(EMPTY_PROGRESS, "iam"), "iam", false);
    expect(unitStatus(p, s3, find)).toBe("locked");
  });

  it("ignores a prerequisite id that does not exist", () => {
    const orphan: UnitRef = { id: "orphan", prerequisites: ["ghost"], providers: [], labs: [] };
    expect(unitStatus(EMPTY_PROGRESS, orphan, find)).toBe("available");
  });

  it("counts done units", () => {
    const p = complete(EMPTY_PROGRESS, "iam");
    expect(countDone(p, [iam, s3, linux])).toEqual({ done: 1, total: 3 });
  });
});

describe("practice answers", () => {
  it("records question history without touching any unit", () => {
    const p = recordAnswers(recordAnswers(EMPTY_PROGRESS, attempt(true, false)), attempt(false, false));
    expect(p.questions).toEqual({
      q1: { attempts: 2, lastCorrect: false },
      q2: { attempts: 2, lastCorrect: false },
    });
    expect(p.units).toEqual({});
    expect(recordAnswers(EMPTY_PROGRESS, [])).toBe(EMPTY_PROGRESS);
    expect(EMPTY_PROGRESS.questions).toEqual({});
  });
});

describe("labs", () => {
  const lessonAndQuiz = complete(EMPTY_PROGRESS, "storage");
  const withLabs = (p: Progress, ...ids: string[]) => ids.reduce((acc, id) => recordLabDone(acc, "storage", id), p);

  it("a unit with labs is not done until every required lab is finished", () => {
    expect(isUnitDone(lessonAndQuiz, storage)).toBe(false);
    expect(remainingLabs(lessonAndQuiz, storage).map((l) => l.id)).toEqual(["lab-aws", "lab-gcp", "lab-general"]);
    expect(isUnitDone(withLabs(lessonAndQuiz, "lab-aws", "lab-gcp"), storage)).toBe(false);
    expect(isUnitDone(withLabs(lessonAndQuiz, "lab-aws", "lab-gcp", "lab-general"), storage)).toBe(true);
  });

  it("with a main platform, only that platform's labs and general labs are required", () => {
    const gcp = setPreferredProvider(lessonAndQuiz, "gcp");
    expect(requiredLabs(gcp, storage).map((l) => l.id)).toEqual(["lab-gcp", "lab-general"]);
    expect(isUnitDone(withLabs(gcp, "lab-gcp", "lab-general"), storage)).toBe(true);
    // The same progress is not enough once the learner switches back to both.
    expect(isUnitDone(setPreferredProvider(withLabs(gcp, "lab-gcp", "lab-general"), "both"), storage)).toBe(false);
  });

  it("labs alone do not finish a unit, but they mark it as started", () => {
    const labsOnly = withLabs(EMPTY_PROGRESS, "lab-aws", "lab-gcp", "lab-general");
    expect(isUnitDone(labsOnly, storage)).toBe(false);
    expect(unitStatus(labsOnly, storage, find)).toBe("in-progress");
  });

  it("recording the same lab twice changes nothing, and other fields are kept", () => {
    const once = recordLabDone(lessonAndQuiz, "storage", "lab-aws");
    expect(recordLabDone(once, "storage", "lab-aws")).toBe(once);
    expect(once.units.storage).toEqual({ read: true, quizScore: 1, labsDone: ["lab-aws"] });
    expect(isLabDone(once, "storage", "lab-aws")).toBe(true);
    expect(isLabDone(once, "storage", "lab-gcp")).toBe(false);
    expect(lessonAndQuiz.units.storage.labsDone).toEqual([]);
  });
});

describe("quiz attempts", () => {
  it("stores the score and per-question history", () => {
    const p = recordQuizAttempt(EMPTY_PROGRESS, "iam", attempt(true, false));
    expect(quizScore(p, "iam")).toBe(0.5);
    expect(p.questions).toEqual({
      q1: { attempts: 1, lastCorrect: true },
      q2: { attempts: 1, lastCorrect: false },
    });
  });

  it("keeps the best score but updates history on a worse retake", () => {
    const first = recordQuizAttempt(EMPTY_PROGRESS, "iam", attempt(true, true));
    const second = recordQuizAttempt(first, "iam", attempt(false, true));
    expect(quizScore(second, "iam")).toBe(1);
    expect(second.questions.q1).toEqual({ attempts: 2, lastCorrect: false });
  });

  it("raises the score on a better retake and keeps the read flag", () => {
    const first = recordQuizAttempt(setUnitRead(EMPTY_PROGRESS, "iam", true), "iam", attempt(false, false));
    const second = recordQuizAttempt(first, "iam", attempt(true, true));
    expect(quizScore(second, "iam")).toBe(1);
    expect(second.units.iam.read).toBe(true);
  });

  it("ignores an attempt with no questions and does not mutate its input", () => {
    expect(recordQuizAttempt(EMPTY_PROGRESS, "iam", [])).toBe(EMPTY_PROGRESS);
    recordQuizAttempt(EMPTY_PROGRESS, "iam", attempt(true));
    expect(EMPTY_PROGRESS.units).toEqual({});
    expect(EMPTY_PROGRESS.questions).toEqual({});
  });
});

describe("provider filter", () => {
  it("shows everything for 'both'", () => {
    expect([iam, s3, linux].every((u) => matchesProvider(u, "both"))).toBe(true);
  });

  it("hides units that lack the chosen provider but keeps neutral units", () => {
    expect(matchesProvider(s3, "gcp")).toBe(false);
    expect(matchesProvider(iam, "gcp")).toBe(true);
    expect(matchesProvider(linux, "gcp")).toBe(true);
  });

  it("picks the lesson tab from the preference, falling back to the first available", () => {
    expect(defaultProvider("gcp", ["aws", "gcp"])).toBe("gcp");
    expect(defaultProvider("both", ["aws", "gcp"])).toBe("aws");
    expect(defaultProvider("gcp", ["aws"])).toBe("aws");
    expect(defaultProvider("aws", [])).toBeUndefined();
  });
});

describe("parseProgress", () => {
  it("returns empty progress for missing, corrupt or wrongly shaped data", () => {
    expect(parseProgress(null)).toEqual(EMPTY_PROGRESS);
    expect(parseProgress("{ not json")).toEqual(EMPTY_PROGRESS);
    expect(parseProgress('{"preferredProvider":"azure"}')).toEqual(EMPTY_PROGRESS);
    expect(parseProgress('"a string"')).toEqual(EMPTY_PROGRESS);
  });

  it("fills in fields missing from older saved data", () => {
    expect(parseProgress('{"units":{"iam":{"read":true}}}')).toEqual({
      ...EMPTY_PROGRESS,
      units: { iam: { read: true, labsDone: [] } },
    });
  });
});

describe("local progress store", () => {
  it("persists updates so a new store over the same storage sees them", () => {
    const storage = fakeStorage();
    const store = createLocalProgressStore(() => storage);
    store.update((p) => setUnitRead(p, "iam", true));
    store.update((p) => setPreferredProvider(p, "gcp"));

    const reloaded = createLocalProgressStore(() => storage).get();
    expect(reloaded.units.iam.read).toBe(true);
    expect(reloaded.preferredProvider).toBe("gcp");
  });

  it("returns a stable snapshot until something changes, then notifies", () => {
    const storage = fakeStorage();
    const store = createLocalProgressStore(() => storage);
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    const before = store.get();
    expect(store.get()).toBe(before);

    store.update((p) => setUnitRead(p, "iam", true));
    expect(calls).toBe(1);
    expect(store.get()).not.toBe(before);

    unsubscribe();
    store.update((p) => setUnitRead(p, "iam", false));
    expect(calls).toBe(1);
  });

  it("picks up changes written by another tab", () => {
    const storage = fakeStorage();
    const store = createLocalProgressStore(() => storage);
    expect(store.get().units.iam).toBeUndefined();
    storage.setItem(STORAGE_KEY, JSON.stringify(setUnitRead(EMPTY_PROGRESS, "iam", true)));
    expect(store.get().units.iam.read).toBe(true);
  });

  it("starts empty when stored data is corrupt", () => {
    const storage = fakeStorage({ [STORAGE_KEY]: "garbage" });
    const store = createLocalProgressStore(() => storage);
    expect(store.get()).toEqual(EMPTY_PROGRESS);
  });

  it("keeps working in memory when storage is missing or throws", () => {
    for (const getStorage of [
      () => undefined,
      () => {
        throw new Error("blocked");
      },
      () => ({
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ]) {
      const store = createLocalProgressStore(getStorage);
      store.update((p) => setUnitRead(p, "iam", true));
      expect(store.get().units.iam.read).toBe(true);
    }
  });
});
