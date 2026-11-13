import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CertPractice, type PracticeDomain } from "@/components/CertPractice";
import { ProviderBadge } from "@/components/ProviderBadge";
import { LEVEL_LABEL, examFacts } from "@/lib/certs";
import { getContent } from "@/lib/content/loader";

export function generateStaticParams() {
  return [...getContent().certs.keys()].map((id) => ({ id }));
}

export async function generateMetadata({ params }: PageProps<"/certs/[id]">): Promise<Metadata> {
  const cert = getContent().certs.get((await params).id);
  return cert ? { title: cert.name, description: cert.summary } : {};
}

export default async function CertPage({ params }: PageProps<"/certs/[id]">) {
  const content = getContent();
  const cert = content.certs.get((await params).id);
  if (!cert) notFound();

  const bank = content.certQuestions.get(cert.id) ?? [];
  const units = [...content.units.values()];
  const domains = cert.domains.map((domain) => ({
    ...domain,
    units: units.filter((u) => u.meta.certDomains.includes(`${cert.id}:${domain.id}`)),
    questions: bank.filter((q) => q.certs.some((c) => c.id === cert.id && c.domain === domain.id)),
  }));
  const practiceDomains: PracticeDomain[] = domains.map((d) => ({
    id: d.id,
    titleZh: d.titleZh,
    // Only the fields the quiz UI needs are sent to the browser.
    questions: d.questions.map(({ id, type, provider, question, options, answer }) => ({
      id,
      type,
      provider,
      question,
      options,
      answer,
    })),
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <nav aria-label="麵包屑" className="text-sm text-muted">
        <Link href="/certs" className="hover:text-text">
          證照備考
        </Link>
      </nav>
      <header className="mt-3">
        <div className="flex items-center gap-2">
          <ProviderBadge provider={cert.provider} />
          <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-muted">
            {LEVEL_LABEL[cert.level]}
          </span>
        </div>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight">{cert.name}</h1>
        <p className="mt-3 text-lg text-muted">{cert.summary}</p>
      </header>

      <section aria-labelledby="exam-info" className="mt-8">
        <h2 id="exam-info" className="text-xl font-bold">
          考試資訊
        </h2>
        <dl className="mt-3 divide-y divide-border rounded-xl border border-border bg-surface">
          {examFacts(cert).map((fact) => (
            <div key={fact.label} className="flex gap-4 px-4 py-3">
              <dt className="w-20 shrink-0 text-sm font-semibold text-muted">{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-sm text-muted">
          資料來源：
          <a href={cert.source.guideUrl} className="text-accent underline" rel="noreferrer" target="_blank">
            官方考試指南
          </a>
          {cert.source.officialPageUrl ? (
            <>
              、
              <a href={cert.source.officialPageUrl} className="text-accent underline" rel="noreferrer" target="_blank">
                官方認證頁面
              </a>
            </>
          ) : null}
          ，於 {cert.source.verifiedOn} 核對。考試內容可能改版，報名前請以官方為準。
          {cert.source.note ? ` ${cert.source.note}` : ""}
        </p>
      </section>

      <section aria-labelledby="domains" className="mt-10">
        <h2 id="domains" className="text-xl font-bold">
          考試範圍
        </h2>
        <div className="table-scroll lesson mt-3 rounded-xl border border-border bg-surface px-2">
          <table>
            <thead>
              <tr>
                <th scope="col">範圍</th>
                <th scope="col">比重</th>
                <th scope="col">練習題</th>
                <th scope="col">相關單元</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id}>
                  <th scope="row" className="!whitespace-normal !text-text">
                    {d.id}. {d.titleZh}
                    <span className="block text-sm font-normal text-muted">{d.title}</span>
                  </th>
                  <td className="whitespace-nowrap">{d.weightPercent}%</td>
                  <td className="whitespace-nowrap">{d.questions.length} 題</td>
                  <td>
                    {d.units.length === 0 ? (
                      <span className="text-muted">準備中</span>
                    ) : (
                      d.units.map((u, i) => (
                        <span key={u.meta.id}>
                          {i > 0 ? "、" : null}
                          <Link href={`/units/${u.meta.id}`}>{u.meta.title}</Link>
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="practice" className="mt-10">
        <h2 id="practice" className="text-xl font-bold">
          練習
        </h2>
        <p className="mt-1 text-sm text-muted">題目皆為依官方考試範圍撰寫的原創題，不是實際考題。</p>
        <div className="mt-4">
          <CertPractice certId={cert.id} domains={practiceDomains} />
        </div>
      </section>
    </div>
  );
}
