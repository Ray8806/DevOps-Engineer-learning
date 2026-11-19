"use client";

import { useState, type FormEvent } from "react";
import {
  authConfigured,
  signInWithEmail,
  signInWithProvider,
  signOut,
  syncNow,
  useAccount,
  type OAuthProvider,
} from "@/lib/auth/account";
import type { SyncStatus } from "@/lib/progress/sync";

const card = "rounded-xl border border-border bg-surface p-5";
const secondary = "w-full rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-semibold hover:bg-surface-2 disabled:opacity-50";

function syncText(s: SyncStatus): string {
  switch (s.state) {
    case "syncing":
      return "同步中…";
    case "synced":
      return `已同步（${s.at.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}）`;
    case "error":
      return `同步失敗：${s.message}。進度仍保存在這台裝置，稍後會再試。`;
    default:
      return "準備同步…";
  }
}

function SignInForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const onEmail = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await signInWithEmail(email.trim());
      setSent(email.trim());
    });
  };
  const oauth = (p: OAuthProvider) => void run(() => signInWithProvider(p));

  return (
    <div className={card}>
      <div className="grid gap-2">
        <button type="button" className={secondary} disabled={busy} onClick={() => oauth("google")}>
          使用 Google 帳號登入
        </button>
        <button type="button" className={secondary} disabled={busy} onClick={() => oauth("github")}>
          使用 GitHub 帳號登入
        </button>
      </div>
      <p className="my-4 text-center text-sm text-muted">或用 Email 收登入連結</p>
      {sent ? (
        <p role="status" className="rounded-lg bg-accent-soft px-3 py-2 text-sm">
          登入連結已寄到 <strong>{sent}</strong>。請用<strong>這個瀏覽器</strong>打開信裡的連結完成登入。
        </p>
      ) : (
        <form onSubmit={onEmail} className="grid gap-2">
          <label htmlFor="email" className="text-sm font-semibold">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-border bg-bg px-3 py-2"
            placeholder="you@example.com"
          />
          <button type="submit" disabled={busy} className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-surface hover:opacity-90 disabled:opacity-50">
            寄送登入連結
          </button>
        </form>
      )}
      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          登入失敗：{error}
        </p>
      ) : null}
      <p className="mt-4 text-xs text-muted">第一次登入時，這台裝置上已有的進度會合併到帳號裡，不會遺失。</p>
    </div>
  );
}

function SignedIn({ email, sync }: { email: string | null; sync: SyncStatus }) {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={card}>
      <p className="text-sm text-muted">已登入</p>
      <p className="font-semibold break-all">{email ?? "（沒有 Email 的帳號）"}</p>
      <p role="status" className={`mt-4 rounded-lg px-3 py-2 text-sm ${sync.state === "error" ? "bg-danger-soft text-danger" : "bg-surface-2"}`}>
        {syncText(sync)}
      </p>
      <div className="mt-4 grid gap-2">
        <button type="button" className={secondary} disabled={busy || sync.state === "syncing"} onClick={() => void run(syncNow)}>
          立即同步
        </button>
        <button type="button" className={secondary} disabled={busy} onClick={() => void run(() => signOut(false))}>
          登出
        </button>
        <button type="button" className={`${secondary} text-danger`} disabled={busy} onClick={() => void run(() => signOut(true))}>
          登出並清除這台裝置的進度
        </button>
      </div>
      <p className="mt-3 text-xs text-muted">在公用電腦上請選「登出並清除」，帳號裡的進度不會受影響。</p>
    </div>
  );
}

export function AccountPanel() {
  const account = useAccount();
  if (!authConfigured) {
    return <p className={card}>這個網站還沒有設定登入功能。進度仍會保存在這台裝置的瀏覽器裡。</p>;
  }
  if (!account.ready) return <p className={`${card} text-muted`}>載入中…</p>;
  return account.user ? <SignedIn email={account.user.email} sync={account.sync} /> : <SignInForm />;
}
