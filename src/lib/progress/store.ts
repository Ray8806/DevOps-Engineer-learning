import { EMPTY_PROGRESS, parseProgress, type Progress } from "./progress";

/**
 * Where progress is kept. Stage 7 adds a synced implementation behind the
 * same interface; UI code only talks to this.
 */
export interface ProgressStore {
  /** Current progress. Returns the same object until something changes. */
  get(): Progress;
  update(change: (current: Progress) => Progress): void;
  subscribe(listener: () => void): () => void;
}

export const STORAGE_KEY = "cloud-academy:progress:v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * Progress in localStorage (or any Storage-like object).
 * If storage is unavailable, progress still works for the current page.
 */
export function createLocalProgressStore(getStorage: () => StorageLike | undefined): ProgressStore {
  const listeners = new Set<() => void>();
  let lastRaw: string | null | undefined;
  let snapshot: Progress = EMPTY_PROGRESS;
  /** Set when storage can't be used, so the session keeps its own copy. */
  let memoryOnly = false;

  function storage(): StorageLike | undefined {
    try {
      return getStorage();
    } catch {
      return undefined;
    }
  }

  function get(): Progress {
    if (memoryOnly) return snapshot;
    let raw: string | null = null;
    try {
      raw = storage()?.getItem(STORAGE_KEY) ?? null;
    } catch {
      memoryOnly = true;
      return snapshot;
    }
    if (raw !== lastRaw) {
      lastRaw = raw;
      snapshot = parseProgress(raw);
    }
    return snapshot;
  }

  return {
    get,
    update(change) {
      const next = change(get());
      const raw = JSON.stringify(next);
      try {
        const s = storage();
        if (!s) throw new Error("no storage");
        s.setItem(STORAGE_KEY, raw);
        lastRaw = raw;
      } catch {
        memoryOnly = true;
      }
      snapshot = next;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
