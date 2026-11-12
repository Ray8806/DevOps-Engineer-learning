"use client";

import { useSyncExternalStore } from "react";
import type { Provider } from "@/lib/content/schema";

// Stage 2 moves this into the Progress store (Progress.preferredProvider).
const KEY = "cloud-academy:preferred-provider";
const listeners = new Set<() => void>();

function read(): Provider {
  try {
    return window.localStorage.getItem(KEY) === "gcp" ? "gcp" : "aws";
  } catch {
    return "aws";
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function setPreferredProvider(provider: Provider) {
  try {
    window.localStorage.setItem(KEY, provider);
  } catch {
    // Storage unavailable (private mode): the choice lasts for this page only.
  }
  listeners.forEach((l) => l());
}

/** The learner's main platform, shared by every tab group on the page. */
export function usePreferredProvider(): Provider {
  return useSyncExternalStore(subscribe, read, () => "aws");
}
