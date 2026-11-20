import { describe, expect, it } from "vitest";
import { badges, levelFor, previousDay, streak, totalXp, XP } from "./achievements";
import { mergeProgress } from "./merge";
import {
  EMPTY_PROGRESS,
  isLearningChange,
  localDay,
  recordActiveDay,
  recordAnswers,
  recordChallengeRun,
  recordLabDone,
  recordQuizAttempt,
  setPreferredProvider,
  setUnitRead,
} from "./progress";

const E = EMPTY_PROGRESS;
const challenges = [
  { id: "b1", track: "basics" },
  { id: "a1", track: "aws" },
  { id: "g1", track: "gcp" },
  { id: "g2", track: "gcp" },
];
const ctx = { challenges, today: "2026-11-20" };
const earned = (p: typeof E) => badges(p, ctx).filter((b) => b.earned).map((b) => b.id);

describe("totalXp", () => {
  it("is zero for a new learner", () => {
    expect(totalXp(E)).toBe(0);
  });

  it("adds up reading, quizzes, labs, challenges and correct answers", () => {
    let p = setUnitRead(E, "u1", true);
    p = recordQuizAttempt(p, "u1", [
      { questionId: "q1", correct: true },
      { questionId: "q2", correct: true },
    ]);
    p = recordLabDone(p, "u1", "lab");
    p = recordChallengeRun(p, "a1", true); // first try: 3 stars
    expect(totalXp(p)).toBe(XP.unitRead + XP.quizPassed + XP.labDone + XP.challengeCleared + 3 * XP.challengeStar + 2 * XP.correctAnswer);
  });

  it("does not count a failed quiz or an uncleared challenge", () => {
    let p = recordQuizAttempt(E, "u1", [{ questionId: "q1", correct: false }]);
    p = recordChallengeRun(p, "a1", false);
    expect(totalXp(p)).toBe(0);
  });
});

describe("levelFor", () => {
  it("starts at level 1 and moves up at each threshold", () => {
    expect(levelFor(0)).toEqual({ level: 1, title: "雲端新手", intoLevel: 0, levelSpan: 100 });
    expect(levelFor(99).level).toBe(1);
    expect(levelFor(100)).toMatchObject({ level: 2, intoLevel: 0, levelSpan: 150 });
    expect(levelFor(260)).toMatchObject({ level: 3, intoLevel: 10 });
  });

  it("stops at the top level", () => {
    expect(levelFor(99999)).toMatchObject({ level: 10, levelSpan: null });
  });
});

describe("streak", () => {
  it("counts consecutive days ending today", () => {
    expect(streak(["2026-11-18", "2026-11-19", "2026-11-20"], "2026-11-20")).toEqual({ current: 3, best: 3, activeToday: true });
  });

  it("keeps yesterday's streak alive until today ends", () => {
    expect(streak(["2026-11-18", "2026-11-19"], "2026-11-20")).toEqual({ current: 2, best: 2, activeToday: false });
  });

  it("resets after a missed day but remembers the best", () => {
    expect(streak(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-19"], "2026-11-21")).toEqual({
      current: 0,
      best: 3,
      activeToday: false,
    });
  });

  it("crosses month and year boundaries", () => {
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
    expect(previousDay("2027-01-01")).toBe("2026-12-31");
    expect(streak(["2026-12-31", "2027-01-01"], "2027-01-01").current).toBe(2);
  });
});

describe("activity", () => {
  it("records each day once, sorted", () => {
    let p = recordActiveDay(E, "2026-11-20");
    p = recordActiveDay(p, "2026-11-19");
    expect(recordActiveDay(p, "2026-11-20")).toBe(p);
    expect(p.activeDays).toEqual(["2026-11-19", "2026-11-20"]);
  });

  it("treats learning, not settings, as activity", () => {
    expect(isLearningChange(E, setUnitRead(E, "u1", true))).toBe(true);
    expect(isLearningChange(E, recordAnswers(E, [{ questionId: "q", correct: true }]))).toBe(true);
    expect(isLearningChange(E, setPreferredProvider(E, "aws"))).toBe(false);
  });

  it("formats the local day", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("merges active days from both devices", () => {
    const a = recordActiveDay(E, "2026-11-19");
    const b = recordActiveDay(E, "2026-11-20");
    expect(mergeProgress(E, a, b).activeDays).toEqual(["2026-11-19", "2026-11-20"]);
  });
});

describe("badges", () => {
  it("has none for a new learner and shows progress toward each", () => {
    expect(earned(E)).toEqual([]);
    const bookworm = badges(E, ctx).find((b) => b.id === "bookworm");
    expect(bookworm).toMatchObject({ current: 0, target: 10, earned: false });
  });

  it("awards the first steps", () => {
    const p = recordLabDone(setUnitRead(E, "u1", true), "u1", "lab");
    expect(earned(p)).toEqual(["first-unit", "first-lab"]);
  });

  it("awards challenge badges by track and stars", () => {
    let p = recordChallengeRun(E, "a1", true);
    expect(earned(p)).toEqual(["first-clear", "flawless", "track-aws"]);
    p = recordChallengeRun(recordChallengeRun(p, "g1", false), "g1", true);
    expect(earned(p)).toContain("multi-cloud");
    expect(earned(p)).not.toContain("track-gcp");
    p = recordChallengeRun(p, "g2", true);
    expect(earned(p)).toContain("track-gcp");
    expect(earned(p)).not.toContain("perfectionist"); // g1 took two runs
  });

  it("awards streak badges by the best streak", () => {
    let p = E;
    for (const d of ["2026-11-10", "2026-11-11", "2026-11-12"]) p = recordActiveDay(p, d);
    expect(earned(p)).toContain("streak-3");
    expect(earned(p)).not.toContain("streak-7");
  });

  it("hides track badges for tracks without levels", () => {
    expect(badges(E, { challenges: [], today: ctx.today }).some((b) => b.id.startsWith("track-") || b.id === "perfectionist")).toBe(false);
  });
});

describe("badge titles", () => {
  it("spaces Latin names from Chinese text", () => {
    const titles = Object.fromEntries(badges(E, ctx).map((b) => [b.id, `${b.title}｜${b.description}`]));
    expect(titles["track-aws"]).toBe("AWS 路線全破｜通過 AWS 路線的所有關卡");
    expect(titles["track-gcp"]).toBe("Google Cloud 路線全破｜通過 Google Cloud 路線的所有關卡");
    expect(titles["track-basics"]).toBe("基礎路線全破｜通過基礎路線的所有關卡");
  });
});
