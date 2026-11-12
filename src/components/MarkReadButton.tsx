"use client";

import Link from "next/link";
import { isUnitDone, setUnitRead } from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";

export function MarkReadButton({ unitId }: { unitId: string }) {
  const [progress, update] = useProgress();
  const done = isUnitDone(progress, unitId);

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${
        done ? "border-accent bg-accent-soft" : "border-border bg-surface"
      }`}
    >
      <p className="font-semibold" role="status">
        {done ? "你已完成這個單元" : "讀完了嗎？"}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {done ? (
          <Link href="/roadmap" className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-surface hover:opacity-90">
            回到學習路線
          </Link>
        ) : null}
        <button
          type="button"
          aria-pressed={done}
          onClick={() => update((p) => setUnitRead(p, unitId, !done))}
          className={
            done
              ? "rounded-lg px-4 py-2 text-sm font-semibold text-muted hover:text-text"
              : "rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-surface hover:opacity-90"
          }
        >
          {done ? "取消標記" : "標記為已完成"}
        </button>
      </div>
    </div>
  );
}
