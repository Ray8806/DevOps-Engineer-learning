"use client";

import { useState, type ReactNode } from "react";
import type { Provider } from "@/lib/content/schema";
import { defaultProvider } from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";
import { PROVIDER_LABEL } from "@/lib/providers";

/**
 * Tab group around <Provider> sections. The sections are rendered on the
 * server; this only sets `data-active`, and CSS hides the other sections.
 * Opens on the learner's main platform; a click only affects this page.
 */
export function ProviderTabs({ providers, children }: { providers: Provider[]; children: ReactNode }) {
  const [progress] = useProgress();
  const [picked, setPicked] = useState<Provider | null>(null);
  const active = picked ?? defaultProvider(progress.preferredProvider, providers);

  return (
    <div className="provider-tabs rounded-xl border border-border bg-surface" data-active={active}>
      <div role="tablist" aria-label="選擇雲端平台" className="flex gap-1 border-b border-border p-1.5">
        {providers.map((p) => {
          const selected = p === active;
          return (
            <button
              key={p}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setPicked(p)}
              className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors ${
                selected
                  ? p === "aws"
                    ? "bg-aws-soft text-aws"
                    : "bg-gcp-soft text-gcp"
                  : "text-muted hover:bg-surface-2"
              }`}
            >
              {PROVIDER_LABEL[p]}
            </button>
          );
        })}
      </div>
      <div className="px-4 pb-5 sm:px-6">{children}</div>
    </div>
  );
}
