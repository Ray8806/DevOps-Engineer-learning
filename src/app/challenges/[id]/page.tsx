import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChallengePlayer } from "@/components/ChallengePlayer";
import { ProviderBadge } from "@/components/ProviderBadge";
import { TRACK_LABEL } from "@/lib/challenges/tracks";
import { getContent } from "@/lib/content/loader";

export function generateStaticParams() {
  return getContent().challenges.map((c) => ({ id: c.id }));
}

export async function generateMetadata({ params }: PageProps<"/challenges/[id]">): Promise<Metadata> {
  const { id } = await params;
  const challenge = getContent().challenges.find((c) => c.id === id);
  return challenge ? { title: `闖關：${challenge.title}`, description: challenge.objective } : {};
}

export default async function ChallengePage({ params }: PageProps<"/challenges/[id]">) {
  const { id } = await params;
  const content = getContent();
  const challenge = content.challenges.find((c) => c.id === id);
  if (!challenge) notFound();

  const all = content.challenges.map(({ id, track, level }) => ({ id, track, level }));
  const next = content.challenges.find((c) => c.track === challenge.track && c.level === challenge.level + 1);
  const unitTitle = content.units.get(challenge.unitId)?.meta.title ?? challenge.unitId;

  return (
    <div>
      <nav aria-label="麵包屑" className="text-sm text-muted">
        <Link href="/challenges" className="hover:text-text">
          闖關
        </Link>
        <span aria-hidden> / </span>
        {TRACK_LABEL[challenge.track]}
      </nav>
      <header className="mt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-muted">
            {TRACK_LABEL[challenge.track]} · 第 {challenge.level} 關
          </span>
          {challenge.provider !== "general" ? <ProviderBadge provider={challenge.provider} /> : null}
        </div>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight">{challenge.title}</h1>
      </header>
      <ChallengePlayer
        challenge={challenge}
        all={all}
        next={next ? { id: next.id, title: next.title } : null}
        unitTitle={unitTitle}
      />
    </div>
  );
}
