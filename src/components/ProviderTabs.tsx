"use client";

import { useState, type ReactNode } from "react";
import type { Provider } from "@/lib/content/schema";
import { defaultProvider, visibleProviders } from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";
import { PROVIDER_LABEL } from "@/lib/providers";

/**
 * Tab group around <Provider> sections. The sections are rendered on the
 * server; this only sets `data-active`, and CSS hides the other sections.
 * With a main platform chosen, only that platform's tab is shown, plus a
 * button to look at the other platform; a click only affects this page.
 */
export function ProviderTabs({ providers, children }: { providers: Provider[]; children: ReactNode }) {
  const [progress] = useProgress();
  const [picked, setPicked] = useState<Provider | null>(null);
  const focused = visibleProviders(progress.preferredProvider, providers);
  const tabs = picked && !focused.includes(picked) ? providers : focused;
  const active = picked ?? defaultProvider(progress.preferredProvider, providers);
  const others = providers.filter((p) => !tabs.includes(p));

  return (
    <div className="provider-tabs rounded-xl border border-border bg-surface" data-active={active}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-1.5">
        <div role="tablist" aria-label="選擇雲端平台" className="flex gap-1">
          {tabs.map((p) => {
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
        {others.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPicked(p)}
            className="rounded-lg px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
          >
            也看看 {PROVIDER_LABEL[p]} 怎麼做
          </button>
        ))}
      </div>
      <div className="px-4 pb-5 sm:px-6">{children}</div>
    </div>
  );
}
