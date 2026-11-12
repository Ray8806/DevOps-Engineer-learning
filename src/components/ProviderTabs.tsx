"use client";

import { useState, type ReactNode } from "react";
import type { Provider } from "@/lib/content/schema";
import { PROVIDER_LABEL } from "@/lib/providers";
import { setPreferredProvider, usePreferredProvider } from "@/lib/use-preferred-provider";

/**
 * Tab group around <Provider> sections. The sections are rendered on the
 * server; this only sets `data-active`, and CSS hides the other sections.
 */
export function ProviderTabs({ providers, children }: { providers: Provider[]; children: ReactNode }) {
  const preferred = usePreferredProvider();
  // Storage can be unavailable; keep the click working for this page anyway.
  const [local, setLocal] = useState<Provider | null>(null);
  const wanted = local ?? preferred;
  const active = providers.includes(wanted) ? wanted : providers[0];

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
              onClick={() => {
                setLocal(p);
                setPreferredProvider(p);
              }}
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
