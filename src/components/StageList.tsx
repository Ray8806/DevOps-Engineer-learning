import Link from "next/link";
import type { Content } from "@/lib/content/loader";
import { PROVIDERS } from "@/lib/content/schema";
import { ProviderBadge } from "./lesson-components";

export function StageList({ content }: { content: Content }) {
  return (
    <ol className="space-y-8">
      {content.stages.map((stage) => (
        <li key={stage.id}>
          <div className="flex items-baseline gap-3">
            <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs font-bold text-muted">
              階段 {stage.id}
            </span>
            <h2 className="text-xl font-bold">{stage.title}</h2>
          </div>
          <p className="mt-1 text-muted">{stage.description}</p>
          {stage.units.length === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted">
              內容準備中
            </p>
          ) : (
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {stage.units.map((id) => {
                const { meta } = content.units.get(id)!;
                return (
                  <li key={id}>
                    <Link
                      href={`/units/${id}`}
                      className="block h-full rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent"
                    >
                      <h3 className="font-bold">{meta.title}</h3>
                      <p className="mt-1 text-sm text-muted">{meta.summary}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {PROVIDERS.filter((p) => meta.providers[p]).map((p) => (
                          <ProviderBadge key={p} provider={p}>
                            {meta.providers[p]!.services.join("、")}
                          </ProviderBadge>
                        ))}
                        <span className="text-xs text-muted">約 {meta.estimatedMinutes} 分鐘</span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}
