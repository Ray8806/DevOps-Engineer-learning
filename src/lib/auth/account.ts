"use client";

import { useSyncExternalStore } from "react";
import { EMPTY_PROGRESS } from "@/lib/progress/progress";
import { baseKey, createProgressSync, type ProgressSync, type SyncStatus } from "@/lib/progress/sync";
import { progressStore } from "@/lib/progress/use-progress";
import { supabaseRemote } from "./remote";
import { authConfigured, supabase } from "./supabase";

export type OAuthProvider = "google" | "github";

export interface AccountState {
  /** False until the saved session has been checked. */
  ready: boolean;
  user: { id: string; email: string | null } | null;
  sync: SyncStatus;
}

const SERVER_STATE: AccountState = { ready: false, user: null, sync: { state: "idle" } };

let state: AccountState = SERVER_STATE;
let started = false;
let sync: ProgressSync | null = null;
let stopSyncStatus: (() => void) | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<AccountState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const localStorageOrUndefined = () => (typeof window === "undefined" ? undefined : window.localStorage);

function onFocus() {
  if (document.visibilityState === "visible") void sync?.sync();
}

/** Starts or stops syncing when the signed-in user changes. */
function switchUser(user: AccountState["user"]) {
  if (user?.id === state.user?.id && state.ready) return;
  stopSyncStatus?.();
  sync?.stop();
  sync = null;
  stopSyncStatus = null;
  window.removeEventListener("focus", onFocus);
  document.removeEventListener("visibilitychange", onFocus);
  set({ ready: true, user, sync: { state: "idle" } });
  const client = supabase();
  if (!user || !client) return;
  sync = createProgressSync({ store: progressStore, remote: supabaseRemote(client, user.id), accountId: user.id, storage: localStorageOrUndefined });
  const current = sync;
  stopSyncStatus = current.onStatus(() => set({ sync: current.status() }));
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  void current.sync();
}

function start() {
  if (started) return;
  started = true;
  const client = supabase();
  if (!client) {
    set({ ready: true });
    return;
  }
  client.auth.onAuthStateChange((_event, session) => {
    const user = session?.user ? { id: session.user.id, email: session.user.email ?? null } : null;
    // Supabase calls this inside its own lock; other auth calls must wait until it returns.
    setTimeout(() => switchUser(user), 0);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  start();
  return () => listeners.delete(listener);
}

/** Signed-in user and sync status. Sign-in is hidden when `authConfigured` is false. */
export function useAccount(): AccountState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}

export { authConfigured };

/** Where sign-in links and OAuth send the browser back to. */
const returnUrl = () => `${window.location.origin}/account`;

export async function signInWithEmail(email: string): Promise<void> {
  const client = supabase();
  if (!client) throw new Error("not configured");
  const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: returnUrl() } });
  if (error) throw new Error(error.message);
}

export async function signInWithProvider(provider: OAuthProvider): Promise<void> {
  const client = supabase();
  if (!client) throw new Error("not configured");
  const { error } = await client.auth.signInWithOAuth({ provider, options: { redirectTo: returnUrl() } });
  if (error) throw new Error(error.message);
}

export function syncNow(): Promise<void> {
  return sync?.sync() ?? Promise.resolve();
}

/**
 * Signs out. Progress stays on this device unless `clearDevice` is set
 * (for shared computers); the account keeps its copy either way.
 */
export async function signOut(clearDevice: boolean): Promise<void> {
  const client = supabase();
  const userId = state.user?.id;
  await sync?.sync();
  switchUser(null);
  if (client) await client.auth.signOut();
  if (clearDevice) {
    progressStore.update(() => EMPTY_PROGRESS);
    if (userId) {
      try {
        localStorage.removeItem(baseKey(userId));
      } catch {
        // Nothing to clear.
      }
    }
  }
}
