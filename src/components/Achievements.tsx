"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { badges, levelFor, streak, totalXp, XP, type ChallengeInfo } from "@/lib/progress/achievements";
import { localDay, type Progress } from "@/lib/progress/progress";
import { progressStore, useProgress } from "@/lib/progress/use-progress";

const noSubscribe = () => () => {};

/** Today's local date in the browser; null on the server, so the server render does not depend on the clock. */
function useToday(): string | null {
  return useSyncExternalStore(noSubscribe, () => localDay(new Date()), () => null);
}

function XpBar({ xp }: { xp: number }) {
  const info = levelFor(xp);
  const pct = info.levelSpan ? Math.round((info.intoLevel / info.levelSpan) * 100) : 100;
  return (
    <div>
      <div
        role="progressbar"
        aria-label="升級進度"
        aria-valuemin={0}
        aria-valuemax={info.levelSpan ?? info.intoLevel}
        aria-valuenow={info.intoLevel}
        className="h-2.5 overflow-hidden rounded-full bg-surface-2"
      >
        <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-700" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {info.levelSpan ? `再 ${info.levelSpan - info.intoLevel} XP 升到 Lv.${info.level + 1}` : "已經是最高等級！"}
      </p>
    </div>
  );
}

/** Compact level and streak line, linking to the achievements page. */
export function LevelSummary() {
  const [progress] = useProgress();
  const today = useToday();
  const xp = totalXp(progress);
  const info = levelFor(xp);
  const s = today ? streak(progress.activeDays, today) : null;
  return (
    <Link
      href="/achievements"
      className="card-link inline-flex flex-wrap items-center gap-x-3 gap-y-1 rounded-full bg-surface px-3 py-1 text-sm ring-1 ring-border hover:ring-accent"
    >
      <span className="font-bold text-accent">Lv.{info.level}</span>
      <span>{info.title}</span>
      <span className="text-muted">{xp} XP</span>
      {s && s.current > 0 ? <span>🔥 {s.current} 天</span> : null}
      <span className="text-accent">成就 →</span>
    </Link>
  );
}

export function AchievementsView({ challenges }: { challenges: ChallengeInfo[] }) {
  const [progress] = useProgress();
  const today = useToday();
  const xp = totalXp(progress);
  const info = levelFor(xp);
  const s = today ? streak(progress.activeDays, today) : { current: 0, best: 0, activeToday: false };
  const list = badges(progress, { challenges, today: today ?? "1970-01-01" });
  const earnedCount = list.filter((b) => b.earned).length;

  return (
    <div className="mt-8 space-y-8">
      <div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="level" className="rounded-xl border border-border bg-surface p-5">
          <p className="text-sm text-muted">目前等級</p>
          <h2 id="level" className="mt-1 flex flex-wrap items-baseline gap-3">
            <span className="text-gradient text-4xl font-extrabold">Lv.{info.level}</span>
            <span className="text-xl font-bold">{info.title}</span>
          </h2>
          <p className="mt-1 text-sm text-muted">累積 {xp} XP</p>
          <div className="mt-4">
            <XpBar xp={xp} />
          </div>
        </section>
        <section aria-labelledby="streak" className="rounded-xl border border-border bg-surface p-5">
          <p className="text-sm text-muted">連續學習</p>
          <h2 id="streak" className="mt-1 text-4xl font-extrabold">
            <span aria-hidden>🔥</span> {s.current} <span className="text-lg font-bold">天</span>
          </h2>
          <p className="mt-1 text-sm text-muted">
            最長紀錄 {s.best} 天 · {s.activeToday ? "今天已經學習過了" : "今天還沒學習，讀一段課文或做一題就算"}
          </p>
        </section>
      </div>

      <section aria-labelledby="badges">
        <h2 id="badges" className="text-xl font-bold">
          徽章 <span className="text-base font-semibold text-muted">{earnedCount} / {list.length}</span>
        </h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((b) => (
            <li
              key={b.id}
              className={`flex gap-3 rounded-xl border p-4 ${b.earned ? "border-accent bg-accent-soft" : "border-border bg-surface"}`}
            >
              <span aria-hidden className={`grid h-12 w-12 shrink-0 place-items-center rounded-full text-2xl ${b.earned ? "bg-surface" : "bg-surface-2 grayscale opacity-50"}`}>
                {b.icon}
              </span>
              <div className="min-w-0">
                <p className="font-bold">
                  {b.title}
                  <span className="sr-only">{b.earned ? "（已獲得）" : "（未獲得）"}</span>
                </p>
                <p className="text-sm text-muted">{b.description}</p>
                {!b.earned ? (
                  <p className="mt-1 text-xs text-muted">
                    進度 {b.current} / {b.target}
                  </p>
                ) : (
                  <p className="mt-1 text-xs font-semibold text-accent">已獲得 ✓</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="how" className="rounded-xl border border-border bg-surface p-5">
        <h2 id="how" className="font-bold">怎麼獲得經驗值</h2>
        <ul className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          <li>讀完一個單元的課文：+{XP.unitRead} XP</li>
          <li>通過單元測驗：+{XP.quizPassed} XP</li>
          <li>完成一個 Lab：+{XP.labDone} XP</li>
          <li>
            通過一關闖關：+{XP.challengeCleared} XP，每顆星再 +{XP.challengeStar} XP
          </li>
          <li>答對一道題目（測驗或證照練習）：+{XP.correctAnswer} XP</li>
          <li>每天有學習，就會累積連續天數</li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/challenges" className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-surface hover:opacity-90">
            去闖關
          </Link>
          <Link href="/roadmap" className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-semibold hover:border-accent">
            學習路線
          </Link>
        </div>
      </section>
    </div>
  );
}

interface Snapshot {
  level: number;
  earned: Set<string>;
}

function snapshot(progress: Progress, challenges: ChallengeInfo[]): Snapshot {
  const today = localDay(new Date());
  return {
    level: levelFor(totalXp(progress)).level,
    earned: new Set(badges(progress, { challenges, today }).filter((b) => b.earned).map((b) => b.id)),
  };
}

/** Pops up when the learner levels up or earns a badge on this page. */
export function AchievementToast({ challenges }: { challenges: ChallengeInfo[] }) {
  const [progress] = useProgress();
  const previous = useRef<Snapshot | null>(null);
  const [message, setMessage] = useState<{ icon: string; title: string; text: string } | null>(null);

  useEffect(() => {
    // The first snapshot comes from the store itself, so the progress loaded on page open is not "new".
    if (previous.current === null) {
      previous.current = snapshot(progressStore.get(), challenges);
      return;
    }
    const now = snapshot(progress, challenges);
    const before = previous.current;
    previous.current = now;
    const newBadges = badges(progress, { challenges, today: localDay(new Date()) }).filter((b) => b.earned && !before.earned.has(b.id));
    if (now.level > before.level) {
      setMessage({ icon: "🆙", title: `升級了！Lv.${now.level}`, text: `你現在是「${levelFor(totalXp(progress)).title}」。` });
    } else if (newBadges.length === 1) {
      setMessage({ icon: newBadges[0].icon, title: `獲得徽章：${newBadges[0].title}`, text: newBadges[0].description });
    } else if (newBadges.length > 1) {
      setMessage({ icon: "🏅", title: `獲得 ${newBadges.length} 個徽章`, text: newBadges.map((b) => b.title).join("、") });
    }
  }, [progress, challenges]);

  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 5000);
    return () => window.clearTimeout(t);
  }, [message]);

  if (!message) return null;
  return (
    <div role="status" className="fixed inset-x-4 bottom-4 z-20 mx-auto max-w-sm sm:right-6 sm:left-auto">
      <Link
        href="/achievements"
        onClick={() => setMessage(null)}
        className="flex items-center gap-3 rounded-xl border border-accent bg-surface p-4 shadow-[0_0_40px_-10px_rgb(34_211_238_/_0.8)]"
      >
        <span aria-hidden className="text-3xl">
          {message.icon}
        </span>
        <span className="min-w-0">
          <span className="block font-bold">{message.title}</span>
          <span className="block text-sm text-muted">{message.text}</span>
        </span>
      </Link>
    </div>
  );
}
