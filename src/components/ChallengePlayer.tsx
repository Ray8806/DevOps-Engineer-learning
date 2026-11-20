"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { allFilled, runChallenge, type Answers, type ChallengeRun } from "@/lib/challenges/run";
import { BLANK_PATTERN, type Challenge } from "@/lib/content/schema";
import { challengeStars, isChallengeUnlocked, recordChallengeRun, type ChallengeRef } from "@/lib/progress/progress";
import { XP } from "@/lib/progress/achievements";
import { useProgress } from "@/lib/progress/use-progress";
import { Stars } from "./ChallengeMap";

/** Stable shuffle so the answer is not always the first choice, and server and browser agree. */
function shuffled(items: readonly string[], seed: string): string[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface BlankProps {
  challenge: Challenge;
  answers: Answers;
  onPick: (id: string, value: string) => void;
}

/** Text with each {{id}} replaced by a dropdown for that blank. */
function WithBlanks({ text, challenge, answers, onPick }: BlankProps & { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(BLANK_PATTERN)) {
    const index = m.index ?? 0;
    parts.push(text.slice(last, index));
    const blank = challenge.blanks.find((b) => b.id === m[1]);
    if (blank) {
      const value = answers[blank.id] ?? "";
      parts.push(
        <select
          key={`${blank.id}-${n++}`}
          aria-label={`空格 ${challenge.blanks.indexOf(blank) + 1}`}
          value={value}
          onChange={(e) => onPick(blank.id, e.target.value)}
          className={`mx-0.5 max-w-full rounded-md border px-1.5 py-0.5 align-baseline font-mono text-[13px] font-semibold focus:outline-2 focus:outline-accent ${
            value ? "border-accent bg-accent-soft text-accent" : "border-dashed border-accent-2 bg-[color-mix(in_oklab,var(--accent-2)_15%,transparent)] text-accent-2"
          }`}
        >
          <option value="" disabled>
            ？選擇
          </option>
          {shuffled(blank.choices, `${challenge.id}/${blank.id}`).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>,
      );
    }
    last = index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

export function ChallengePlayer({
  challenge,
  all,
  next,
  unitTitle,
}: {
  challenge: Challenge;
  all: ChallengeRef[];
  next: { id: string; title: string } | null;
  unitTitle: string;
}) {
  const [progress, update] = useProgress();
  const [answers, setAnswers] = useState<Answers>({});
  const [run, setRun] = useState<ChallengeRun | null>(null);
  /** How many commands of the current run are on screen (they appear one by one). */
  const [shown, setShown] = useState(0);
  const [showHint, setShowHint] = useState(false);

  const unlocked = isChallengeUnlocked(progress, challenge, all);
  const stars = challengeStars(progress, challenge.id);
  const runs = progress.challenges[challenge.id]?.runs ?? 0;
  const ready = allFilled(challenge, answers);
  const finished = run !== null && shown >= run.commands.length;

  useEffect(() => {
    if (!run || shown >= run.commands.length) return;
    const t = window.setTimeout(() => setShown((s) => s + 1), 380);
    return () => window.clearTimeout(t);
  }, [run, shown]);

  function pick(id: string, value: string) {
    setAnswers((a) => ({ ...a, [id]: value }));
    setRun(null);
  }

  function execute() {
    const result = runChallenge(challenge, answers);
    update((p) => recordChallengeRun(p, challenge.id, result.cleared));
    setRun(result);
    setShown(prefersReducedMotion() ? result.commands.length : 1);
  }

  if (!unlocked) {
    return (
      <div className="mt-8 rounded-xl border border-border bg-surface p-6 text-center">
        <p className="text-3xl" aria-hidden>
          🔒
        </p>
        <p className="mt-2 font-semibold">這一關還沒解鎖</p>
        <p className="mt-1 text-sm text-muted">先通過同一條路線的第 {challenge.level - 1} 關。</p>
        <Link href="/challenges" className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-surface hover:opacity-90">
          回到關卡地圖
        </Link>
      </div>
    );
  }

  const files = Object.entries(challenge.initialState.files);
  const blankProps = { challenge, answers, onPick: pick };

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
      <div className="min-w-0 space-y-5">
        <section aria-labelledby="brief" className="rounded-xl border border-border bg-surface p-5">
          <h2 id="brief" className="flex items-center gap-2 text-sm font-semibold text-accent">
            <span aria-hidden>📟</span> 任務簡報
          </h2>
          <p className="mt-2 leading-relaxed">{challenge.story}</p>
          <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-sm">
            <strong>目標：</strong>
            {challenge.objective}
          </p>
          {stars > 0 ? (
            <p className="mt-3 text-sm text-muted">
              你已經通過這一關 <Stars count={stars} size="text-sm" />，可以再挑戰一次。
            </p>
          ) : null}
        </section>

        {files.map(([path, text]) => (
          <section key={path} aria-label={`檔案 ${path}`} className="overflow-hidden rounded-xl ring-1 ring-border">
            <p className="bg-surface-2 px-4 py-2 font-mono text-xs text-muted">{path}</p>
            <pre className="overflow-x-auto bg-[var(--code-bg)] p-4 font-mono text-[13px] leading-relaxed text-[#d5dbe5] whitespace-pre-wrap [overflow-wrap:anywhere]">
              <WithBlanks text={text} {...blankProps} />
            </pre>
          </section>
        ))}

        <section aria-label="要執行的指令" className="overflow-hidden rounded-xl ring-1 ring-border">
          <p className="bg-surface-2 px-4 py-2 font-mono text-xs text-muted">要執行的指令</p>
          <ol className="space-y-1.5 bg-[var(--code-bg)] p-4 font-mono text-[13px] leading-relaxed text-[#d5dbe5] [overflow-wrap:anywhere]">
            {challenge.commands.map((command, i) => (
              <li key={i}>
                <span aria-hidden className="text-[#67e8f9] select-none">
                  ${" "}
                </span>
                <WithBlanks text={command} {...blankProps} />
              </li>
            ))}
          </ol>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={execute}
            disabled={!ready || (run !== null && !finished)}
            className="rounded-lg bg-accent px-6 py-2.5 font-bold text-surface shadow-[0_0_24px_-6px_rgb(34_211_238_/_0.7)] hover:opacity-90 disabled:opacity-40 disabled:shadow-none"
          >
            ▶ 執行
          </button>
          <p className="text-sm text-muted" role="status">
            {ready ? (runs > 0 ? `已執行 ${runs} 次` : "空格都填好了，按下執行看看。") : "先把每個空格選好。"}
          </p>
        </div>
      </div>

      <div className="min-w-0 space-y-5">
        <section aria-labelledby="output" className="overflow-hidden rounded-xl ring-1 ring-border">
          <h2 id="output" className="bg-surface-2 px-4 py-2 font-mono text-xs text-muted">
            執行結果
          </h2>
          <div className="min-h-48 bg-[var(--code-bg)] p-4 font-mono text-[13px] leading-relaxed [overflow-wrap:anywhere]" aria-live="polite">
            {run === null ? (
              <p className="text-[#67e8f9]">這是模擬環境，不會動到真的雲端帳號。選好空格後按「執行」。</p>
            ) : (
              run.commands.slice(0, shown).map((c, i) => (
                <Fragment key={i}>
                  <p className="text-white">
                    <span className="text-[#67e8f9]">$ </span>
                    {c.command}
                  </p>
                  {c.lines.slice(0, 40).map((l, j) => (
                    <p key={j} className={`whitespace-pre-wrap ${l.error ? "text-[#ff9d8f]" : "text-[#d5dbe5]"}`}>
                      {l.text || " "}
                    </p>
                  ))}
                  {run.failedAt === i ? <p className="mt-1 font-bold text-[#ff9d8f]">✗ 這一行失敗了，後面的指令沒有執行。</p> : null}
                </Fragment>
              ))
            )}
          </div>
        </section>

        {finished ? (
          <section aria-labelledby="goals-heading" className="rounded-xl border border-border bg-surface p-5">
            <h2 id="goals-heading" className="font-bold">
              過關條件
            </h2>
            <ul className="mt-2 space-y-1.5 text-sm">
              {run.goals.map((g) => (
                <li key={g.description} className="flex gap-2">
                  <span aria-hidden className={g.passed ? "text-accent" : "text-danger"}>
                    {g.passed ? "✓" : "✗"}
                  </span>
                  <span>
                    <span className="sr-only">{g.passed ? "達成：" : "未達成："}</span>
                    {g.description}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {finished && run.cleared ? (
          <section aria-labelledby="result" className="rounded-xl border border-accent bg-accent-soft p-5">
            <h2 id="result" className="flex flex-wrap items-center gap-3 text-xl font-extrabold">
              🎉 過關！ <Stars count={stars} size="text-2xl" />
            </h2>
            {progress.challenges[challenge.id]?.clearedOnRun === runs ? (
              <p className="mt-2 inline-block rounded-full bg-surface px-3 py-0.5 text-sm font-bold text-accent">
                +{XP.challengeCleared + stars * XP.challengeStar} XP
              </p>
            ) : null}
            <p className="mt-1 text-sm text-muted">
              {progress.challenges[challenge.id]?.clearedOnRun === 1 ? "第一次執行就成功，太厲害了！" : "繼續保持，第一次就成功可以拿到三顆星。"}
            </p>
            <h3 className="mt-4 text-sm font-bold">為什麼是這些答案</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {challenge.blanks.map((b) => (
                <li key={b.id}>
                  <code className="rounded bg-surface px-1.5 py-0.5 font-semibold text-accent">{b.answer}</code>
                  <span className="ml-1.5">{b.explain}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              {next ? (
                <Link href={`/challenges/${next.id}`} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-surface hover:opacity-90">
                  下一關：{next.title} →
                </Link>
              ) : null}
              <Link href="/challenges" className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-semibold hover:border-accent">
                關卡地圖
              </Link>
              <Link href={`/units/${challenge.unitId}`} className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-semibold hover:border-accent">
                複習：{unitTitle}
              </Link>
            </div>
          </section>
        ) : null}

        {finished && !run.cleared ? (
          <section aria-labelledby="result" className="rounded-xl border border-danger bg-danger-soft p-5">
            <h2 id="result" className="text-lg font-bold">還沒過關</h2>
            <p className="mt-1 text-sm">
              {run.failedAt !== null ? "看看紅色的錯誤訊息，它通常會告訴你哪裡不對。" : "指令都成功了，但還沒達成所有過關條件。"}
              改一下空格再執行一次。
            </p>
            {showHint ? (
              <p className="mt-3 rounded-lg bg-surface px-3 py-2 text-sm">提示：{challenge.hint}</p>
            ) : (
              <button type="button" onClick={() => setShowHint(true)} className="mt-3 text-sm font-semibold text-accent underline">
                給我一點提示
              </button>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
