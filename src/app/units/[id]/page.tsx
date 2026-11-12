import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { lessonComponents, ProviderBadge } from "@/components/lesson-components";
import { getContent } from "@/lib/content/loader";
import { PROVIDERS } from "@/lib/content/schema";

export function generateStaticParams() {
  return [...getContent().units.keys()].map((id) => ({ id }));
}

export async function generateMetadata({ params }: PageProps<"/units/[id]">): Promise<Metadata> {
  const unit = getContent().units.get((await params).id);
  return unit ? { title: unit.meta.title, description: unit.meta.summary } : {};
}

export default async function UnitPage({ params }: PageProps<"/units/[id]">) {
  const content = getContent();
  const unit = content.units.get((await params).id);
  if (!unit) notFound();

  const { meta } = unit;
  const stage = content.stages.find((s) => s.id === meta.stage)!;
  const providers = PROVIDERS.filter((p) => meta.providers[p]);

  return (
    <article className="mx-auto max-w-3xl">
      <nav aria-label="麵包屑" className="text-sm text-muted">
        <Link href="/roadmap" className="hover:text-text">
          學習路線
        </Link>
        <span aria-hidden> / </span>
        階段 {stage.id}：{stage.title}
      </nav>

      <header className="mt-3 border-b border-border pb-6">
        <h1 className="text-4xl font-extrabold tracking-tight">{meta.title}</h1>
        <p className="mt-3 text-lg text-muted">{meta.summary}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {providers.map((p) => (
            <ProviderBadge key={p} provider={p}>
              {meta.providers[p]!.services.join("、")}
            </ProviderBadge>
          ))}
          <span className="text-sm text-muted">約 {meta.estimatedMinutes} 分鐘</span>
        </div>
        {meta.prerequisites.length > 0 ? (
          <p className="mt-3 text-sm text-muted">
            建議先讀：
            {meta.prerequisites.map((id, i) => (
              <span key={id}>
                {i > 0 ? "、" : null}
                <Link href={`/units/${id}`} className="text-accent underline">
                  {content.units.get(id)!.meta.title}
                </Link>
              </span>
            ))}
          </p>
        ) : null}
      </header>

      <div className="lesson mt-2">
        <MDXRemote
          source={unit.lesson}
          components={lessonComponents(meta)}
          options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
        />
      </div>

      <section aria-labelledby="next-steps" className="mt-12 border-t border-border pt-8">
        <h2 id="next-steps" className="text-xl font-bold">
          接下來
        </h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          <li className="rounded-xl border border-border bg-surface p-4">
            <h3 className="font-bold">單元測驗</h3>
            <p className="mt-1 text-sm text-muted">共 {unit.quiz.length} 題，每個選項都有解析。</p>
            <p className="mt-3 text-xs font-semibold text-muted">即將開放</p>
          </li>
          {unit.labs.map((lab) => (
            <li key={lab.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-bold">{lab.title}</h3>
                {lab.provider !== "general" ? <ProviderBadge provider={lab.provider} /> : null}
              </div>
              <p className="mt-1 text-sm text-muted">
                {lab.description}（約 {lab.estimatedMinutes} 分鐘）
              </p>
              <p className="mt-3 text-xs font-semibold text-muted">即將開放</p>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
