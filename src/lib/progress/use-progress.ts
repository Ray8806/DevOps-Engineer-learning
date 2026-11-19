"use client";

import { useSyncExternalStore } from "react";
import { EMPTY_PROGRESS, type Progress } from "./progress";
import { createLocalProgressStore, STORAGE_KEY } from "./store";

/** The one progress store of this browser tab; account sync writes through it too. */
export const progressStore = createLocalProgressStore(() => (typeof window === "undefined" ? undefined : window.localStorage));

function subscribe(listener: () => void) {
  const unsubscribe = progressStore.subscribe(listener);
  // Another tab changed progress.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    unsubscribe();
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Current progress and a function to change it.
 * Renders empty progress on the server and during hydration.
 */
export function useProgress(): [Progress, (change: (current: Progress) => Progress) => void] {
  const progress = useSyncExternalStore(subscribe, progressStore.get, () => EMPTY_PROGRESS);
  return [progress, progressStore.update];
}
