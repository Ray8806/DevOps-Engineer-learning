"use client";

import Link from "next/link";
import type { Provider } from "@/lib/content/schema";
import {
  QUIZ_PASS_SCORE,
  countDone,
  isLabDone,
  isUnitRead,
  matchesProvider,
  missingPrerequisites,
  quizScore,
  requiredLabs,
  setPreferredProvider,
  unitStatus,
  type PreferredProvider,
  type UnitRef,
  type UnitStatus,
} from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";
import { ProviderBadge } from "./ProviderBadge";

export interface RoadmapUnit extends UnitRef {
  title: string;
  summary: string;
  estimatedMinutes: number;
  services: Partial<Record<Provider, string[]>>;
}

export interface RoadmapStage {
  id: number;
  title: string;
  description: string;
  units: RoadmapUnit[];
}

const FILTERS: { value: PreferredProvider; label: string }[] = [
  { value: "both", label: "兩者" },
  { value: "aws", label: "AWS" },
  { value: "gcp", label: "GCP" },
];

const STATUS_LABEL: Record<UnitStatus, string> = {
  done: "已完成",
  "in-progress": "進行中",
  available: "可以開始",
  locked: "尚未解鎖",
};

function StatusIcon({ status }: { status: UnitStatus }) {
  const base = "grid h-7 w-7 shrink-0 place-items-center rounded-full border-2";
  if (status === "done") {
    return (
      <span className={`${base} border-accent bg-accent text-surface`}>
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === "locked") {
    return (
      <span className={`${base} border-border bg-surface-2 text-muted`}>
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
          <path d="M5 7V5a3 3 0 016 0v2h.5A1.5 1.5 0 0113 8.5v4a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 12.5v-4A1.5 1.5 0 014.5 7H5zm1.5 0h3V5a1.5 1.5 0 00-3 0v2z" />
        </svg>
      </span>
    );
  }
  if (status === "in-progress") {
    return (
      <span className={`${base} border-accent bg-surface`}>
        <span className="h-2.5 w-2.5 rounded-full bg-accent" />
      </span>
    );
  }
  return <span className={`${base} border-accent bg-surface`} />;
}

function ProgressBar({ done, total, label }: { done: number; total: number; label: string }) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
    >
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Roadmap({ stages }: { stages: RoadmapStage[] }) {
  const [progress, update] = useProgress();
  const preferred = progress.preferredProvider;
  const allUnits = new Map(stages.flatMap((s) => s.units).map((u) => [u.id, u]));
  const findUnit = (id: string) => allUnits.get(id);

  /** What is still open in a started unit, e.g. "課文已讀 · 測驗 60%（需 80%） · Lab 1/2". */
  function stepSummary(unit: RoadmapUnit): string {
    const unitId = unit.id;
    const best = quizScore(progress, unitId);
    const labs = requiredLabs(progress, unit);
    const labsDone = labs.filter((lab) => isLabDone(progress, unitId, lab.id)).length;
    const quiz =
      best === undefined
        ? "測驗未作答"
        : best >= QUIZ_PASS_SCORE
          ? "測驗已通過"
          : `測驗 ${Math.round(best * 100)}%（需 ${Math.round(QUIZ_PASS_SCORE * 100)}%）`;
    const parts = [isUnitRead(progress, unitId) ? "課文已讀" : "課文未讀", quiz];
    if (labs.length > 0) parts.push(`Lab ${labsDone}/${labs.length}`);
    return parts.join(" · ");
  }

  const visibleStages = stages.map((stage) => ({
    ...stage,
    hidden: stage.units.filter((u) => !matchesProvider(u, preferred)).length,
    units: stage.units.filter((u) => matchesProvider(u, preferred)),
  }));
  const overall = countDone(progress, visibleStages.flatMap((s) => s.units));

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <fieldset>
          <legend className="text-sm font-semibold">主要平台</legend>
          <div className="mt-2 inline-flex rounded-lg border border-border bg-surface-2 p-1">
            {FILTERS.map((f) => (
              <label
                key={f.value}
                className={`cursor-pointer rounded-md px-4 py-1.5 text-sm font-semibold transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                  preferred === f.value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"
                }`}
              >
                <input
                  type="radio"
                  name="preferred-provider"
                  value={f.value}
                  checked={preferred === f.value}
                  onChange={() => update((p) => setPreferredProvider(p, f.value))}
                  className="sr-only"
                />
                {f.label}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">決定路線圖顯示哪些單元，以及課文預設開啟哪個平台的分頁。</p>
        </fieldset>
        <div className="w-full sm:w-64">
          <p className="flex items-baseline justify-between text-sm">
            <span className="font-semibold">整體進度</span>
            <span className="text-muted" data-testid="overall-count">
              {overall.done} / {overall.total} 個單元
            </span>
          </p>
          <div className="mt-2">
            <ProgressBar done={overall.done} total={overall.total} label="整體進度" />
          </div>
        </div>
      </div>

      <ol className="mt-8">
        {visibleStages.map((stage, index) => {
          const count = countDone(progress, stage.units);
          const stageDone = count.total > 0 && count.done === count.total;
          const last = index === visibleStages.length - 1;
          return (
            <li key={stage.id} className="relative pb-10 pl-12 last:pb-0">
              {/* Spine connecting the stages */}
              {!last ? <span aria-hidden className="absolute bottom-0 left-[15px] top-8 w-0.5 bg-border" /> : null}
              <span
                aria-hidden
                className={`absolute left-0 top-0 grid h-8 w-8 place-items-center rounded-full text-sm font-bold ${
                  stageDone ? "bg-accent text-surface" : "border-2 border-border bg-surface text-muted"
                }`}
              >
                {stage.id}
              </span>

              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <h2 className="text-xl font-bold">
                  <span className="sr-only">階段 {stage.id}：</span>
                  {stage.title}
                </h2>
                {count.total > 0 ? (
                  <span className="text-sm text-muted">
                    {count.done} / {count.total} 完成
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-muted">{stage.description}</p>

              {stage.units.length === 0 ? (
                <p className="mt-3 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted">
                  {stage.hidden > 0 ? `這個階段的 ${stage.hidden} 個單元不屬於所選平台` : "內容準備中"}
                </p>
              ) : (
                <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                  {stage.units.map((unit) => {
                    const status = unitStatus(progress, unit, findUnit);
                    const missing = missingPrerequisites(progress, unit, findUnit);
                    return (
                      <li key={unit.id}>
                        <Link
                          href={`/units/${unit.id}`}
                          data-status={status}
                          className={`flex h-full gap-3 rounded-xl border bg-surface p-4 transition-colors hover:border-accent ${
                            status === "done" ? "border-accent" : "border-border"
                          } ${status === "locked" ? "opacity-70" : ""}`}
                        >
                          <StatusIcon status={status} />
                          <div className="min-w-0">
                            <h3 className="font-bold">{unit.title}</h3>
                            <p className="mt-1 text-sm text-muted">{unit.summary}</p>
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              {unit.providers.map((p) => (
                                <ProviderBadge key={p} provider={p}>
                                  {unit.services[p]?.join("、")}
                                </ProviderBadge>
                              ))}
                              <span className="text-xs text-muted">約 {unit.estimatedMinutes} 分鐘</span>
                            </div>
                            <p className="mt-2 text-xs font-semibold text-muted">
                              {status === "locked"
                                ? `建議先完成：${missing.map((id) => allUnits.get(id)?.title ?? id).join("、")}`
                                : status === "in-progress"
                                  ? `${STATUS_LABEL[status]}：${stepSummary(unit)}`
                                  : STATUS_LABEL[status]}
                            </p>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
