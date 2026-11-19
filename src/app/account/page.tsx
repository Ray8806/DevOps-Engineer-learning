import type { Metadata } from "next";
import { AccountPanel } from "@/components/AccountPanel";

export const metadata: Metadata = { title: "帳號" };

export default function AccountPage() {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold">帳號</h1>
      <p className="mt-2 text-muted">登入後，閱讀、測驗和 Lab 的進度會存到你的帳號，在其他裝置登入也看得到。</p>
      <div className="mt-6">
        <AccountPanel />
      </div>
    </div>
  );
}
