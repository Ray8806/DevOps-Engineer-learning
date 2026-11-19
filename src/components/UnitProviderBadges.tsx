"use client";

import type { Provider } from "@/lib/content/schema";
import { visibleProviders } from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";
import { ProviderBadge } from "./ProviderBadge";

/** The unit's services for the platforms the learner studies. */
export function UnitProviderBadges({ services }: { services: Partial<Record<Provider, string[]>> }) {
  const [progress] = useProgress();
  const available = (Object.keys(services) as Provider[]).filter((p) => services[p]);
  return (
    <>
      {visibleProviders(progress.preferredProvider, available).map((p) => (
        <ProviderBadge key={p} provider={p}>
          {services[p]!.join("、")}
        </ProviderBadge>
      ))}
    </>
  );
}
