import type { SupabaseClient } from "@supabase/supabase-js";

// Referenced literally so Next.js inlines them into the browser bundle at build time.
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** True when the site was built with Supabase settings; otherwise sign-in is hidden. */
export const authConfigured = Boolean(URL && ANON_KEY);

let client: Promise<SupabaseClient> | null = null;

/**
 * The browser's Supabase client, or null when sign-in is not configured.
 * The library is loaded on first use, so it stays out of every page's
 * initial JavaScript.
 */
export function supabase(): Promise<SupabaseClient | null> {
  if (!authConfigured || typeof window === "undefined") return Promise.resolve(null);
  client ??= import("@supabase/supabase-js").then(({ createClient }) =>
    createClient(URL!, ANON_KEY!, {
      auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    }),
  );
  return client;
}
