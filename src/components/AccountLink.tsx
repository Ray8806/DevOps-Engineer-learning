"use client";

import Link from "next/link";
import { authConfigured, useAccount } from "@/lib/auth/account";

/** "登入" or the account link in the header; nothing when sign-in is not configured. */
export function AccountLink() {
  const account = useAccount();
  if (!authConfigured) return null;
  const signedIn = account.user !== null;
  const dot =
    account.sync.state === "error" ? "bg-danger" : account.sync.state === "syncing" ? "bg-muted" : "bg-accent";
  return (
    <Link
      href="/account"
      className={`ml-1 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 sm:px-3 ${
        signedIn ? "text-muted hover:bg-surface-2 hover:text-text" : "bg-accent font-semibold text-surface hover:opacity-90"
      }`}
    >
      {signedIn ? (
        <>
          <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
          帳號
        </>
      ) : (
        "登入"
      )}
    </Link>
  );
}
