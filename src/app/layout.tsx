import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "雲端工程師學院", template: "%s｜雲端工程師學院" },
  description: "從零開始學雲端：AWS 與 GCP 雙平台課程、動手實作與證照備考。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-Hant" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <SiteHeader />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">{children}</main>
        <footer className="border-t border-border py-6 text-center text-sm text-muted">
          雲端工程師學院 · 課程內容為原創教材，與 AWS、Google Cloud 官方無關
        </footer>
      </body>
    </html>
  );
}
