"use client";

import Link from "next/link";
import { isQuizPassed, isUnitRead, remainingLabs, setUnitRead, type UnitRef } from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";

/** Marks the lesson as read and points at whatever the unit still needs. */
export function MarkReadButton({ unit }: { unit: UnitRef }) {
  const [progress, update] = useProgress();
  const read = isUnitRead(progress, unit.id);
  const quizPassed = isQuizPassed(progress, unit.id);
  const labsLeft = remainingLabs(progress, unit);

  const next = !quizPassed
    ? { message: "課文已讀完，接著做單元測驗", href: `/units/${unit.id}/quiz`, label: "前往測驗" }
    : labsLeft.length > 0
      ? { message: `課文和測驗都完成了，還有 ${labsLeft.length} 個 Lab`, href: `/units/${unit.id}/labs/${labsLeft[0].id}`, label: "前往 Lab" }
      : { message: "你已完成這個單元", href: "/roadmap", label: "回到學習路線" };

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${
        read ? "border-accent bg-accent-soft" : "border-border bg-surface"
      }`}
    >
      <p className="font-semibold" role="status">
        {read ? next.message : "讀完了嗎？"}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {read ? (
          <Link href={next.href} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-surface hover:opacity-90">
            {next.label}
          </Link>
        ) : null}
        <button
          type="button"
          aria-pressed={read}
          onClick={() => update((p) => setUnitRead(p, unit.id, !read))}
          className={
            read
              ? "rounded-lg px-4 py-2 text-sm font-semibold text-muted hover:text-text"
              : "rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-surface hover:opacity-90"
          }
        >
          {read ? "取消標記" : "標記課文已讀完"}
        </button>
      </div>
    </div>
  );
}
