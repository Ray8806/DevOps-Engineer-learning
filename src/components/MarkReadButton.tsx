"use client";

import Link from "next/link";
import { isQuizPassed, isUnitRead, setUnitRead } from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";

export function MarkReadButton({ unitId }: { unitId: string }) {
  const [progress, update] = useProgress();
  const read = isUnitRead(progress, unitId);
  const quizPassed = isQuizPassed(progress, unitId);

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${
        read ? "border-accent bg-accent-soft" : "border-border bg-surface"
      }`}
    >
      <p className="font-semibold" role="status">
        {!read ? "讀完了嗎？" : quizPassed ? "你已完成這個單元" : "課文已讀完，通過單元測驗就完成這個單元"}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {read ? (
          <Link
            href={quizPassed ? "/roadmap" : `/units/${unitId}/quiz`}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-surface hover:opacity-90"
          >
            {quizPassed ? "回到學習路線" : "前往測驗"}
          </Link>
        ) : null}
        <button
          type="button"
          aria-pressed={read}
          onClick={() => update((p) => setUnitRead(p, unitId, !read))}
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
