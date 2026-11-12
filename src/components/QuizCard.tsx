"use client";

import Link from "next/link";
import { QUIZ_PASS_SCORE, quizScore } from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";

export function QuizCard({ unitId, questionCount }: { unitId: string; questionCount: number }) {
  const [progress] = useProgress();
  const best = quizScore(progress, unitId);
  const passed = (best ?? 0) >= QUIZ_PASS_SCORE;

  return (
    <Link
      href={`/units/${unitId}/quiz`}
      className={`block h-full rounded-xl border bg-surface p-4 transition-colors hover:border-accent ${
        passed ? "border-accent" : "border-border"
      }`}
    >
      <h3 className="font-bold">單元測驗</h3>
      <p className="mt-1 text-sm text-muted">共 {questionCount} 題，每個選項都有解析。</p>
      <p className={`mt-3 text-xs font-semibold ${passed ? "text-accent" : "text-muted"}`}>
        {best === undefined
          ? "開始測驗"
          : `最高分 ${Math.round(best * 100)}%，${passed ? "已通過" : `未達 ${Math.round(QUIZ_PASS_SCORE * 100)}%，再試一次`}`}
      </p>
    </Link>
  );
}
