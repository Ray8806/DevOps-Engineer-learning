/** The parts of a signed-in user that the site shows. */
export interface AccountUser {
  id: string;
  email: string | null;
  /** Display name from the identity provider (Google, GitHub), if any. */
  name: string | null;
  /** How the user signed in, for example "google", "github" or "email". */
  provider: string | null;
}

/** The fields this module reads from a Supabase auth user. */
export interface AuthUserLike {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  app_metadata?: Record<string, unknown> | null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export function toAccountUser(user: AuthUserLike): AccountUser {
  const meta = user.user_metadata ?? {};
  return {
    id: user.id,
    email: text(user.email),
    // Google sets full_name and name; GitHub sets name, full_name or only user_name.
    name: text(meta.full_name) ?? text(meta.name) ?? text(meta.user_name) ?? null,
    provider: text(user.app_metadata?.provider),
  };
}

/** Short label for the header: the name, else the email, else a generic word. */
export function accountLabel(user: AccountUser): string {
  return user.name ?? user.email ?? "我的帳號";
}

/** One character for the avatar circle. */
export function accountInitial(user: AccountUser): string {
  const source = user.name ?? user.email ?? "";
  const first = Array.from(source)[0];
  return first ? first.toUpperCase() : "?";
}

const PROVIDER_LABEL: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  email: "Email 登入連結",
};

/** Human-readable sign-in method, or null when unknown. */
export function providerLabel(provider: string | null): string | null {
  if (!provider) return null;
  return PROVIDER_LABEL[provider] ?? provider;
}
