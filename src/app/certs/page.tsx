import type { Metadata } from "next";
import Link from "next/link";
import { ProviderBadge } from "@/components/ProviderBadge";
import { LEVEL_LABEL } from "@/lib/certs";
import { getContent } from "@/lib/content/loader";
import { CERT_IDS } from "@/lib/content/schema";

export const metadata: Metadata = { title: "證照備考" };

export default function CertsPage() {
  const content = getContent();
  // Listed in the order the ids are declared: AWS then GCP, entry level first.
  const certs = CERT_IDS.map((id) => content.certs.get(id)).filter((c) => c !== undefined);

  return (
    <div>
      <h1 className="text-3xl font-extrabold tracking-tight">證照備考</h1>
      <p className="mt-2 max-w-2xl text-muted">
        依官方考試範圍整理的原創練習題。每一題都有逐一選項的解析，可以依範圍練習。
      </p>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2">
        {certs.map((cert) => (
          <li key={cert.id}>
            <Link
              href={`/certs/${cert.id}`}
              className="flex h-full flex-col rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent"
            >
              <div className="flex items-center gap-2">
                <ProviderBadge provider={cert.provider} />
                <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-muted">
                  {LEVEL_LABEL[cert.level]}
                </span>
              </div>
              <h2 className="mt-3 text-lg font-bold">{cert.name}</h2>
              <p className="mt-1 flex-1 text-sm text-muted">{cert.summary}</p>
              <p className="mt-4 text-xs font-semibold text-muted">
                {cert.domains.length} 個考試範圍 · {content.certQuestions.get(cert.id)?.length ?? 0} 題練習題
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
