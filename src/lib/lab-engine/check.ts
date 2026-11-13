import { checkView, type LabState } from "./state";

export interface StateCheck {
  type: "state";
  path: string[];
  exists?: boolean;
  equals?: unknown;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/** Looks up `path` in the check view using own properties only. */
function lookup(view: unknown, path: string[]): { found: boolean; value?: unknown } {
  let current = view;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return { found: false };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

export function passes(state: LabState, check: StateCheck): boolean {
  const result = lookup(checkView(state), check.path);
  if (check.exists !== undefined) return result.found === check.exists;
  return result.found && deepEqual(result.value, check.equals);
}

/**
 * Steps are done in order and stay done: starting from `completed` finished
 * steps, counts how many are finished now. A later command undoing an
 * earlier step's condition (e.g. renaming a file it asked for) keeps it done.
 */
export function advance(completed: number, state: LabState, steps: readonly { check: StateCheck }[]): number {
  let done = Math.min(completed, steps.length);
  while (done < steps.length && passes(state, steps[done].check)) done++;
  return done;
}
