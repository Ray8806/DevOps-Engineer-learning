import { EMPTY_PROGRESS, type Progress, type UnitProgress } from "./progress";

/** JSON with object keys sorted, so equal data always gives the same text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const sameProgress = (a: Progress, b: Progress) => canonical(a) === canonical(b);

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * Three-way merge of one value: whichever side changed since the last sync
 * wins; when both changed differently, `resolve` decides.
 */
function pick<T>(base: T, local: T, remote: T, resolve: (local: T, remote: T) => T): T {
  if (same(local, remote)) return local;
  if (same(local, base)) return remote;
  if (same(remote, base)) return local;
  return resolve(local, remote);
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();
const EMPTY_UNIT: UnitProgress = { read: false, labsDone: [] };

function mergeUnit(base: UnitProgress, local: UnitProgress, remote: UnitProgress): UnitProgress {
  const quizScore = pick(base.quizScore, local.quizScore, remote.quizScore, (l, r) => Math.max(l ?? 0, r ?? 0));
  // Lab completions merge as sets: a lab finished on one device and one removed
  // on another both carry over.
  const removed = (side: string[]) => base.labsDone.filter((id) => !side.includes(id));
  const gone = new Set([...removed(local.labsDone), ...removed(remote.labsDone)]);
  const labsDone = union(local.labsDone, remote.labsDone).filter((id) => !gone.has(id));
  return {
    read: pick(base.read, local.read, remote.read, (l, r) => l || r),
    ...(quizScore === undefined ? {} : { quizScore }),
    labsDone,
  };
}

/**
 * Merges this device's progress with the account's, given the progress both
 * had at the last sync (`base`; empty before the first sync). A change made on
 * only one side is kept, including undoing something (e.g. marking a lesson
 * unread). When both sides changed the same thing, the result keeps the most
 * progress: read, the higher quiz score, the answer with more attempts.
 */
export function mergeProgress(base: Progress, local: Progress, remote: Progress): Progress {
  const units: Progress["units"] = {};
  for (const id of new Set([...Object.keys(local.units), ...Object.keys(remote.units)])) {
    const merged = mergeUnit(base.units[id] ?? EMPTY_UNIT, local.units[id] ?? EMPTY_UNIT, remote.units[id] ?? EMPTY_UNIT);
    if (merged.read || merged.quizScore !== undefined || merged.labsDone.length) units[id] = merged;
  }

  const questions: Progress["questions"] = {};
  for (const id of new Set([...Object.keys(local.questions), ...Object.keys(remote.questions)])) {
    const l = local.questions[id];
    const r = remote.questions[id];
    const merged = pick(base.questions[id], l, r, (a, b) => (!a ? b : !b ? a : b.attempts > a.attempts ? b : a));
    if (merged) questions[id] = merged;
  }

  // Runs only grow; the earliest clearing run wins.
  const challenges: Progress["challenges"] = {};
  for (const id of new Set([...Object.keys(local.challenges), ...Object.keys(remote.challenges)])) {
    const l = local.challenges[id];
    const r = remote.challenges[id];
    const runs = Math.max(l?.runs ?? 0, r?.runs ?? 0);
    const cleared = [l?.clearedOnRun, r?.clearedOnRun].filter((n): n is number => n !== undefined);
    challenges[id] = cleared.length ? { runs, clearedOnRun: Math.min(...cleared) } : { runs };
  }

  // Exam results are only ever added.
  const exams = [...local.exams];
  for (const e of remote.exams) if (!exams.some((x) => same(x, e))) exams.push(e);
  exams.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    preferredProvider: pick(base.preferredProvider, local.preferredProvider, remote.preferredProvider, (l, r) =>
      // A device still on the default has not really chosen.
      l === EMPTY_PROGRESS.preferredProvider ? r : l,
    ),
    units,
    questions,
    challenges,
    exams,
  };
}
