"use client";

import Link from "next/link";
import { TRACK_DESCRIPTION, TRACK_LABEL } from "@/lib/challenges/tracks";
import type { ChallengeTrack } from "@/lib/content/schema";
import { challengeStars, isChallengeUnlocked, type ChallengeRef } from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";

export interface ChallengeSummary extends ChallengeRef {
  track: ChallengeTrack;
  title: string;
}

export function Stars({ count, size = "text-base" }: { count: number; size?: string }) {
  return (
    <span className={`${size} tracking-tight`} aria-label={`${count} 顆星`}>
      {[1, 2, 3].map((n) => (
        <span key={n} aria-hidden className={n <= count ? "text-[#fbbf24]" : "text-border"}>
          ★
        </span>
      ))}
    </span>
  );
}

/** The level map: one path per track, with stars and locks from local progress. */
export function ChallengeMap({ tracks }: { tracks: { track: ChallengeTrack; levels: ChallengeSummary[] }[] }) {
  const [progress] = useProgress();
  const all = tracks.flatMap((t) => t.levels);
  const earned = all.reduce((sum, c) => sum + challengeStars(progress, c.id), 0);

  return (
    <div>
      <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1 text-sm ring-1 ring-border">
        <span aria-hidden className="text-[#fbbf24]">
          ★
        </span>
        已獲得 <strong>{earned}</strong> / {all.length * 3} 顆星
      </p>
      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {tracks.map(({ track, levels }) => (
          <section key={track} aria-labelledby={`track-${track}`} className="rounded-xl border border-border bg-surface p-5">
            <h2 id={`track-${track}`} className="text-lg font-bold">
              {TRACK_LABEL[track]}
            </h2>
            <p className="mt-1 text-sm text-muted">{TRACK_DESCRIPTION[track]}</p>
            <ol className="mt-5 space-y-0">
              {levels.map((c, i) => {
                const stars = challengeStars(progress, c.id);
                const unlocked = isChallengeUnlocked(progress, c, all);
                const node = (
                  <span
                    className={`relative z-[1] grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-bold ${
                      stars > 0
                        ? "bg-gradient-to-br from-accent to-accent-2 text-bg"
                        : unlocked
                          ? "bg-bg text-accent ring-2 ring-accent"
                          : "bg-surface-2 text-muted"
                    }`}
                  >
                    {unlocked ? c.level : <span aria-label="未解鎖">🔒</span>}
                  </span>
                );
                return (
                  <li key={c.id} className="relative pb-4 last:pb-0">
                    {i < levels.length - 1 ? (
                      <span aria-hidden className="absolute top-10 left-5 h-[calc(100%-2.5rem)] w-px -translate-x-1/2 bg-border" />
                    ) : null}
                    {unlocked ? (
                      <Link href={`/challenges/${c.id}`} className="card-link flex items-center gap-3 rounded-lg p-1 hover:bg-surface-2">
                        {node}
                        <span className="min-w-0">
                          <span className="block font-semibold">{c.title}</span>
                          {stars > 0 ? <Stars count={stars} size="text-sm" /> : <span className="text-xs text-accent">挑戰 →</span>}
                        </span>
                      </Link>
                    ) : (
                      <div className="flex items-center gap-3 p-1 text-muted">
                        {node}
                        <span className="min-w-0">
                          <span className="block font-semibold">{c.title}</span>
                          <span className="text-xs">先通過第 {c.level - 1} 關</span>
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
