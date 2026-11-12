import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LabRunner } from "@/components/LabRunner";
import { ProviderBadge } from "@/components/ProviderBadge";
import { getContent } from "@/lib/content/loader";

export function generateStaticParams() {
  return [...getContent().units.values()].flatMap((unit) =>
    unit.labs.map((lab) => ({ id: unit.meta.id, labId: lab.id })),
  );
}

function find(id: string, labId: string) {
  const unit = getContent().units.get(id);
  const lab = unit?.labs.find((l) => l.id === labId);
  return unit && lab ? { unit, lab } : undefined;
}

export async function generateMetadata({ params }: PageProps<"/units/[id]/labs/[labId]">): Promise<Metadata> {
  const { id, labId } = await params;
  const found = find(id, labId);
  return found ? { title: `Lab：${found.lab.title}`, description: found.lab.description } : {};
}

export default async function LabPage({ params }: PageProps<"/units/[id]/labs/[labId]">) {
  const { id, labId } = await params;
  const found = find(id, labId);
  if (!found) notFound();
  const { unit, lab } = found;

  return (
    <div>
      <nav aria-label="麵包屑" className="text-sm text-muted">
        <Link href="/roadmap" className="hover:text-text">
          學習路線
        </Link>
        <span aria-hidden> / </span>
        <Link href={`/units/${unit.meta.id}`} className="hover:text-text">
          {unit.meta.title}
        </Link>
      </nav>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-extrabold tracking-tight">Lab：{lab.title}</h1>
        {lab.provider !== "general" ? <ProviderBadge provider={lab.provider} /> : null}
      </div>
      <p className="mt-2 text-muted">
        {lab.description}（約 {lab.estimatedMinutes} 分鐘）
      </p>
      <div className="mt-6">
        <LabRunner
          unitId={unit.meta.id}
          unitTitle={unit.meta.title}
          lab={{ id: lab.id, title: lab.title, initialState: lab.initialState, steps: lab.steps }}
        />
      </div>
    </div>
  );
}
