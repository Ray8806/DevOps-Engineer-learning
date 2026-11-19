import type { SupabaseClient } from "@supabase/supabase-js";
import { ProgressSchema, type Progress } from "@/lib/progress/progress";
import type { RemoteProgress } from "@/lib/progress/sync";

/**
 * Progress stored in the `progress` table: one row per user, the whole
 * Progress object as JSON. Row-level security limits each user to their own
 * row (see supabase/migrations).
 */
export function supabaseRemote(client: SupabaseClient, userId: string): RemoteProgress {
  return {
    async load() {
      const { data, error } = await client.from("progress").select("data").eq("user_id", userId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const parsed = ProgressSchema.safeParse(data.data);
      return parsed.success ? parsed.data : null;
    },
    async save(progress: Progress) {
      const { error } = await client
        .from("progress")
        .upsert({ user_id: userId, data: progress, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (error) throw new Error(error.message);
    },
  };
}
