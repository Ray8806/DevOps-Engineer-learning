import { z } from "zod";
import type { ContentProvider, Provider } from "@/lib/content/schema";

/**
 * Learner progress. Pure data + pure functions only, so the same logic works
 * with any ProgressStore (localStorage now, a synced backend later).
 */
export const PreferredProviderSchema = z.enum(["aws", "gcp", "both"]);
export type PreferredProvider = z.infer<typeof PreferredProviderSchema>;

const UnitProgressSchema = z.object({
  read: z.boolean().default(false),
  quizScore: z.number().min(0).max(1).optional(),
  labsDone: z.array(z.string()).default([]),
});
export type UnitProgress = z.infer<typeof UnitProgressSchema>;

export const ProgressSchema = z.object({
  preferredProvider: PreferredProviderSchema.default("both"),
  units: z.record(z.string(), UnitProgressSchema).default({}),
  questions: z
    .record(z.string(), z.object({ attempts: z.number().int().min(0), lastCorrect: z.boolean() }))
    .default({}),
  exams: z
    .array(
      z.object({
        certId: z.string(),
        date: z.string(),
        score: z.number(),
        byDomain: z.record(z.string(), z.number()),
      }),
    )
    .default([]),
});
export type Progress = z.infer<typeof ProgressSchema>;

export const EMPTY_PROGRESS: Progress = ProgressSchema.parse({});

/** Parses stored JSON; anything unreadable or malformed becomes empty progress. */
export function parseProgress(raw: string | null): Progress {
  if (!raw) return EMPTY_PROGRESS;
  try {
    const result = ProgressSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : EMPTY_PROGRESS;
  } catch {
    return EMPTY_PROGRESS;
  }
}

// ------------------------------------------------------------------ updates

export function setPreferredProvider(progress: Progress, preferredProvider: PreferredProvider): Progress {
  return { ...progress, preferredProvider };
}

type AnswerResult = { questionId: string; correct: boolean };

/** Records per-question history (attempt count and last result). */
export function recordAnswers(progress: Progress, results: readonly AnswerResult[]): Progress {
  if (results.length === 0) return progress;
  const questions = { ...progress.questions };
  for (const r of results) {
    questions[r.questionId] = { attempts: (questions[r.questionId]?.attempts ?? 0) + 1, lastCorrect: r.correct };
  }
  return { ...progress, questions };
}

/**
 * Records one finished unit quiz attempt: per-question history, and the
 * unit's best score so far (a worse retake never lowers it).
 */
export function recordQuizAttempt(progress: Progress, unitId: string, results: readonly AnswerResult[]): Progress {
  if (results.length === 0) return progress;
  const withAnswers = recordAnswers(progress, results);
  const current = progress.units[unitId] ?? { read: false, labsDone: [] };
  const score = results.filter((r) => r.correct).length / results.length;
  const quizScore = Math.max(current.quizScore ?? 0, score);
  return { ...withAnswers, units: { ...progress.units, [unitId]: { ...current, quizScore } } };
}

/** Marks a lab as completed. Completing it again changes nothing. */
export function recordLabDone(progress: Progress, unitId: string, labId: string): Progress {
  const current = progress.units[unitId] ?? { read: false, labsDone: [] };
  if (current.labsDone.includes(labId)) return progress;
  return {
    ...progress,
    units: { ...progress.units, [unitId]: { ...current, labsDone: [...current.labsDone, labId] } },
  };
}

export function setUnitRead(progress: Progress, unitId: string, read: boolean): Progress {
  const current = progress.units[unitId] ?? { read: false, labsDone: [] };
  return { ...progress, units: { ...progress.units, [unitId]: { ...current, read } } };
}

// ------------------------------------------------------------------ queries

export interface LabRef {
  id: string;
  provider: ContentProvider;
}

/** The minimum progress logic needs to know about a unit. */
export interface UnitRef {
  id: string;
  prerequisites: string[];
  providers: Provider[];
  labs: LabRef[];
}

/** Looks a unit up by id (for prerequisites). */
export type FindUnit = (id: string) => UnitRef | undefined;

export type UnitStatus = "done" | "in-progress" | "available" | "locked";

/** Fraction of quiz questions needed to pass a unit's quiz. */
export const QUIZ_PASS_SCORE = 0.8;

/** General content always matches; platform content must match the main platform. */
export function providerMatches(provider: ContentProvider, preferred: PreferredProvider): boolean {
  return preferred === "both" || provider === "general" || provider === preferred;
}

/** Provider-neutral units (no providers) are shown under every filter. */
export function matchesProvider(unit: Pick<UnitRef, "providers">, preferred: PreferredProvider): boolean {
  if (preferred === "both" || unit.providers.length === 0) return true;
  return unit.providers.includes(preferred);
}

export function isUnitRead(progress: Progress, unitId: string): boolean {
  return progress.units[unitId]?.read === true;
}

/** Best quiz score so far (0 to 1), or undefined if never attempted. */
export function quizScore(progress: Progress, unitId: string): number | undefined {
  return progress.units[unitId]?.quizScore;
}

export function isQuizPassed(progress: Progress, unitId: string): boolean {
  return (quizScore(progress, unitId) ?? 0) >= QUIZ_PASS_SCORE;
}

export function isLabDone(progress: Progress, unitId: string, labId: string): boolean {
  return progress.units[unitId]?.labsDone.includes(labId) === true;
}

/**
 * Labs that count towards finishing the unit: general ones plus those for
 * the learner's main platform (all of them for "both").
 */
export function requiredLabs(progress: Progress, unit: UnitRef): LabRef[] {
  return unit.labs.filter((lab) => providerMatches(lab.provider, progress.preferredProvider));
}

export function remainingLabs(progress: Progress, unit: UnitRef): LabRef[] {
  return requiredLabs(progress, unit).filter((lab) => !isLabDone(progress, unit.id, lab.id));
}

/** A unit is done once its lesson is read, its quiz is passed and its required labs are finished. */
export function isUnitDone(progress: Progress, unit: UnitRef): boolean {
  return isUnitRead(progress, unit.id) && isQuizPassed(progress, unit.id) && remainingLabs(progress, unit).length === 0;
}

function isStarted(progress: Progress, unitId: string): boolean {
  const u = progress.units[unitId];
  return u !== undefined && (u.read || u.quizScore !== undefined || u.labsDone.length > 0);
}

/** Prerequisites the learner has not finished yet. Unknown ids are ignored. */
export function missingPrerequisites(progress: Progress, unit: UnitRef, find: FindUnit): string[] {
  return unit.prerequisites.filter((id) => {
    const pre = find(id);
    return pre !== undefined && !isUnitDone(progress, pre);
  });
}

export function unitStatus(progress: Progress, unit: UnitRef, find: FindUnit): UnitStatus {
  if (isUnitDone(progress, unit)) return "done";
  if (isStarted(progress, unit.id)) return "in-progress";
  return missingPrerequisites(progress, unit, find).length > 0 ? "locked" : "available";
}

export function countDone(progress: Progress, units: UnitRef[]): { done: number; total: number } {
  return { done: units.filter((u) => isUnitDone(progress, u)).length, total: units.length };
}

/** Which provider tab a lesson opens on. */
export function defaultProvider(preferred: PreferredProvider, available: Provider[]): Provider | undefined {
  return preferred !== "both" && available.includes(preferred) ? preferred : available[0];
}
