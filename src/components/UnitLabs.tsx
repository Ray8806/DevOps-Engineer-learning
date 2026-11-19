"use client";

import type { ContentProvider } from "@/lib/content/schema";
import { providerMatches } from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";
import { LabCard } from "./LabCard";

type LabSummary = { id: string; title: string; description: string; provider: ContentProvider; estimatedMinutes: number };

/** Labs for the main platform; the other platform's labs are folded away as optional. */
export function UnitLabs({ unitId, labs }: { unitId: string; labs: LabSummary[] }) {
  const [progress] = useProgress();
  const mine = labs.filter((l) => providerMatches(l.provider, progress.preferredProvider));
  const others = labs.filter((l) => !mine.includes(l));
  return (
    <>
      {mine.map((lab) => (
        <li key={lab.id}>
          <LabCard unitId={unitId} lab={lab} />
        </li>
      ))}
      {others.length ? (
        <li className="sm:col-span-2">
          <details className="rounded-xl border border-dashed border-border px-4 py-3">
            <summary className="cursor-pointer text-sm text-muted">其他平台的 Lab（選修，{others.length} 個）</summary>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {others.map((lab) => (
                <li key={lab.id}>
                  <LabCard unitId={unitId} lab={lab} />
                </li>
              ))}
            </ul>
          </details>
        </li>
      ) : null}
    </>
  );
}
