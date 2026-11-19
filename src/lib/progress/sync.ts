import { mergeProgress, sameProgress } from "./merge";
import { EMPTY_PROGRESS, parseProgress, type Progress } from "./progress";
import type { ProgressStore } from "./store";

/** The account's copy of progress, e.g. a row in the database. */
export interface RemoteProgress {
  /** null when the account has no saved progress yet. */
  load(): Promise<Progress | null>;
  save(progress: Progress): Promise<void>;
}

export type SyncStatus =
  | { state: "idle" }
  | { state: "syncing" }
  | { state: "synced"; at: Date }
  | { state: "error"; message: string };

export interface ProgressSync {
  /** Syncs now; resolves when this sync (and any queued behind it) is done. */
  sync(): Promise<void>;
  /** Stops reacting to local changes. */
  stop(): void;
  status(): SyncStatus;
  onStatus(listener: () => void): () => void;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Where the progress of the last successful sync is kept, per account. */
export const baseKey = (accountId: string) => `cloud-academy:sync-base:v1:${accountId}`;

/**
 * Keeps a ProgressStore and the account's remote copy in step. Each sync
 * merges this device's progress with the remote one against the progress
 * of the last sync (see mergeProgress), saves the result to both sides,
 * and remembers it as the new base. Local changes are synced after
 * `debounceMs`; callers also sync when the page regains focus.
 */
export function createProgressSync(options: {
  store: ProgressStore;
  remote: RemoteProgress;
  accountId: string;
  storage?: () => StorageLike | undefined;
  debounceMs?: number;
}): ProgressSync {
  const { store, remote, accountId, debounceMs = 1500 } = options;
  const storage = () => {
    try {
      return options.storage?.();
    } catch {
      return undefined;
    }
  };
  let base: Progress | null = null;
  try {
    const raw = storage()?.getItem(baseKey(accountId));
    if (raw) base = parseProgress(raw);
  } catch {
    base = null;
  }

  let status: SyncStatus = { state: "idle" };
  const listeners = new Set<() => void>();
  const setStatus = (next: SyncStatus) => {
    status = next;
    listeners.forEach((l) => l());
  };

  let running: Promise<void> | null = null;
  let again = false;
  let applying = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function once() {
    setStatus({ state: "syncing" });
    try {
      const theirs = (await remote.load()) ?? EMPTY_PROGRESS;
      const mine = store.get();
      const merged = mergeProgress(base ?? EMPTY_PROGRESS, mine, theirs);
      if (!sameProgress(merged, mine)) {
        applying = true;
        try {
          store.update(() => merged);
        } finally {
          applying = false;
        }
      }
      if (!sameProgress(merged, theirs)) await remote.save(merged);
      base = merged;
      try {
        storage()?.setItem(baseKey(accountId), JSON.stringify(merged));
      } catch {
        // The base only makes later merges more precise; without it they still work.
      }
      setStatus({ state: "synced", at: new Date() });
    } catch (err) {
      setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function sync(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await once();
      } while (again && !stopped);
      running = null;
    })();
    return running;
  }

  const unsubscribe = store.subscribe(() => {
    if (applying || stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void sync(), debounceMs);
  });

  return {
    sync,
    stop() {
      stopped = true;
      clearTimeout(timer);
      unsubscribe();
    },
    status: () => status,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
