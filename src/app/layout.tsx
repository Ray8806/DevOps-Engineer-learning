import Link from "next/link";
import type { Metadata } from "next";
import { AchievementToast } from "@/components/Achievements";
import { SiteHeader } from "@/components/SiteHeader";
import { getContent } from "@/lib/content/loader";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "雲端工程師學院", template: "%s｜雲端工程師學院" },
  description: "從零開始學雲端：AWS 與 GCP 雙平台課程、動手實作與證照備考。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const challenges = getContent().challenges.map(({ id, track }) => ({ id, track }));
  return (
    <html lang="zh-Hant" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <SiteHeader />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">{children}</main>
        <footer className="border-t border-border px-4 py-6 text-center text-sm text-muted">
          <nav aria-label="頁尾導覽" className="mb-2 flex flex-wrap justify-center gap-x-4 gap-y-1">
            <Link href="/roadmap" className="hover:text-text">學習路線</Link>
            <Link href="/challenges" className="hover:text-text">闖關</Link>
            <Link href="/certs" className="hover:text-text">證照備考</Link>
            <Link href="/achievements" className="hover:text-text">成就</Link>
            <Link href="/services" className="hover:text-text">服務對照</Link>
          </nav>
          雲端工程師學院 · 課程內容為原創教材，與 AWS、Google Cloud 官方無關
        </footer>
        <AchievementToast challenges={challenges} />
      </body>
    </html>
  );
}
