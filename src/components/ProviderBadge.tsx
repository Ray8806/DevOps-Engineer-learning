import type { ReactNode } from "react";
import type { Provider } from "@/lib/content/schema";
import { PROVIDER_LABEL } from "@/lib/providers";

export function ProviderBadge({ provider, children }: { provider: Provider; children?: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        provider === "aws" ? "bg-aws-soft text-aws" : "bg-gcp-soft text-gcp"
      }`}
    >
      {PROVIDER_LABEL[provider]}
      {children ? <span className="font-normal">· {children}</span> : null}
    </span>
  );
}
