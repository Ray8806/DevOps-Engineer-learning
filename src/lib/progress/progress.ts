import { z } from "zod";
import type { Provider } from "@/lib/content/schema";

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

export function setUnitRead(progress: Progress, unitId: string, read: boolean): Progress {
  const current = progress.units[unitId] ?? { read: false, labsDone: [] };
  return { ...progress, units: { ...progress.units, [unitId]: { ...current, read } } };
}

// ------------------------------------------------------------------ queries

/** The minimum a roadmap needs to know about a unit. */
export interface UnitRef {
  id: string;
  prerequisites: string[];
  providers: Provider[];
}

export type UnitStatus = "done" | "available" | "locked";

/**
 * A unit is done once its lesson is marked as read.
 * Later stages extend this with the unit's quiz and labs.
 */
export function isUnitDone(progress: Progress, unitId: string): boolean {
  return progress.units[unitId]?.read === true;
}

/** Prerequisites the learner has not finished yet. */
export function missingPrerequisites(progress: Progress, unit: UnitRef): string[] {
  return unit.prerequisites.filter((id) => !isUnitDone(progress, id));
}

export function unitStatus(progress: Progress, unit: UnitRef): UnitStatus {
  if (isUnitDone(progress, unit.id)) return "done";
  return missingPrerequisites(progress, unit).length > 0 ? "locked" : "available";
}

/** Provider-neutral units (no providers) are shown under every filter. */
export function matchesProvider(unit: UnitRef, preferred: PreferredProvider): boolean {
  if (preferred === "both" || unit.providers.length === 0) return true;
  return unit.providers.includes(preferred);
}

export function countDone(progress: Progress, units: UnitRef[]): { done: number; total: number } {
  return { done: units.filter((u) => isUnitDone(progress, u.id)).length, total: units.length };
}

/** Which provider tab a lesson opens on. */
export function defaultProvider(preferred: PreferredProvider, available: Provider[]): Provider | undefined {
  return preferred !== "both" && available.includes(preferred) ? preferred : available[0];
}
