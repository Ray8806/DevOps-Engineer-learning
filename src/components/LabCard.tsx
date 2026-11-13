"use client";

import Link from "next/link";
import type { ContentProvider } from "@/lib/content/schema";
import { isLabDone, providerMatches } from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";
import { ProviderBadge } from "./ProviderBadge";

export function LabCard({
  unitId,
  lab,
}: {
  unitId: string;
  lab: { id: string; title: string; description: string; provider: ContentProvider; estimatedMinutes: number };
}) {
  const [progress] = useProgress();
  const done = isLabDone(progress, unitId, lab.id);
  const required = providerMatches(lab.provider, progress.preferredProvider);

  return (
    <Link
      href={`/units/${unitId}/labs/${lab.id}`}
      className={`block h-full rounded-xl border bg-surface p-4 transition-colors hover:border-accent ${
        done ? "border-accent" : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-bold">Lab：{lab.title}</h3>
        {lab.provider !== "general" ? <ProviderBadge provider={lab.provider} /> : null}
      </div>
      <p className="mt-1 text-sm text-muted">
        {lab.description}（約 {lab.estimatedMinutes} 分鐘）
      </p>
      <p className={`mt-3 text-xs font-semibold ${done ? "text-accent" : "text-muted"}`}>
        {done ? "已完成" : required ? "開始實作" : "選修：不屬於你的主要平台"}
      </p>
    </Link>
  );
}
