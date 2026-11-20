"use client";

import Link from "next/link";
import { authConfigured, useAccount } from "@/lib/auth/account";
import { accountInitial, accountLabel } from "@/lib/auth/profile";

/** "登入", or the signed-in account (initial, name and sync dot); nothing when sign-in is not configured. */
export function AccountLink() {
  const account = useAccount();
  if (!authConfigured) return null;
  const user = account.user;
  if (!user) {
    return (
      <Link href="/account" className="ml-1 rounded-md bg-accent px-2.5 py-1.5 font-semibold text-surface hover:opacity-90 sm:px-3">
        登入
      </Link>
    );
  }
  const label = accountLabel(user);
  const dot =
    account.sync.state === "error" ? "bg-danger" : account.sync.state === "syncing" ? "bg-muted" : "bg-accent";
  return (
    <Link
      href="/account"
      title={user.email ?? label}
      aria-label={`帳號：${label}`}
      className="ml-1 flex items-center gap-2 rounded-md px-2 py-1 text-muted hover:bg-surface-2 hover:text-text"
    >
      <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-accent-2 text-xs font-bold text-bg">
        {accountInitial(user)}
        <span aria-hidden className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg ${dot}`} />
      </span>
      <span className="max-w-[10rem] truncate max-md:hidden">{label}</span>
    </Link>
  );
}
