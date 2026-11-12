"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { Question } from "@/lib/content/schema";
import { QUIZ_PASS_SCORE, recordAnswers, recordQuizAttempt } from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";
import { PROVIDER_LABEL } from "@/lib/providers";
import { isCorrect, questionsFor, sample, scoreQuiz, type QuestionResult } from "@/lib/quiz/quiz";
import { ProviderBadge } from "./ProviderBadge";

export type QuizQuestion = Pick<Question, "id" | "type" | "provider" | "question" | "options" | "answer">;

type Phase =
  | { name: "intro" }
  | { name: "question"; questions: QuizQuestion[]; index: number; selected: string[]; submitted: boolean; results: QuestionResult[] }
  | { name: "results"; questions: QuizQuestion[]; results: QuestionResult[] };

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const letter = (index: number) => String.fromCharCode(65 + index);

const primaryButton =
  "rounded-lg bg-accent px-5 py-2.5 font-semibold text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
const secondaryButton = "rounded-lg border border-border bg-surface px-5 py-2.5 font-semibold hover:border-accent";

/**
 * `unit`: a unit quiz. Questions follow the learner's main platform, and the
 * best score is recorded against the pass mark.
 * `practice`: untimed practice. A random round of `roundSize` questions, with
 * only per-question history recorded.
 */
export type QuizMode =
  | { kind: "unit"; unitId: string; unitTitle: string }
  | { kind: "practice"; roundSize: number; backHref: string; backLabel: string };

export function Quiz({ mode, questions }: { mode: QuizMode; questions: QuizQuestion[] }) {
  const practice = mode.kind === "practice";
  const [progress, update] = useProgress();
  const [phase, setPhase] = useState<Phase>({ name: "intro" });
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Move focus to the new screen's heading so keyboard and screen-reader users follow along. */
  const focusHeading = () => requestAnimationFrame(() => headingRef.current?.focus());

  const preferred = progress.preferredProvider;
  const available = practice ? questions : questionsFor(questions, preferred);
  const roundLength = practice ? Math.min(mode.roundSize, available.length) : available.length;
  const back = practice
    ? { href: mode.backHref, label: mode.backLabel }
    : { href: `/units/${mode.unitId}`, label: `回到「${mode.unitTitle}」` };

  function start() {
    // Random order is chosen here, in the click handler, never during render.
    const round = practice ? sample(available, mode.roundSize) : available;
    setPhase({ name: "question", questions: round, index: 0, selected: [], submitted: false, results: [] });
    focusHeading();
  }

  if (phase.name === "intro") {
    return (
      <div className="rounded-xl border border-border bg-surface p-6">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-bold outline-none">
          準備好了嗎？
        </h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-muted">
          <li>
            {practice && roundLength < available.length ? `從 ${available.length} 題中隨機抽 ${roundLength} 題` : `共 ${roundLength} 題`}
            ，一次作答一題，送出後立即顯示每個選項的解析。
          </li>
          <li>
            {practice
              ? "不計時，可以重複練習，每一輪的題目和順序都會重新抽。"
              : `答對 ${percent(QUIZ_PASS_SCORE)} 以上算通過，可以重複作答，系統保留最高分。`}
          </li>
          {!practice && available.length < questions.length && preferred !== "both" ? (
            <li>
              你的主要平台是 {PROVIDER_LABEL[preferred]}，已略過其他平台的 {questions.length - available.length} 題。
            </li>
          ) : null}
        </ul>
        <button type="button" onClick={start} disabled={roundLength === 0} className={`${primaryButton} mt-5`}>
          {practice ? "開始練習" : "開始測驗"}
        </button>
      </div>
    );
  }

  if (phase.name === "results") {
    const score = scoreQuiz(phase.results);
    const passed = !practice && score.score >= QUIZ_PASS_SCORE;
    return (
      <div>
        <div className={`rounded-xl border p-6 ${passed ? "border-accent bg-accent-soft" : "border-border bg-surface"}`}>
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-bold outline-none">
            {practice ? "這一輪結束了" : passed ? "通過了！" : "還差一點"}
          </h2>
          <p className="mt-2 text-lg" data-testid="quiz-score">
            答對 {score.correct} / {score.total} 題（{percent(score.score)}）
          </p>
          <p className="mt-1 text-sm text-muted">
            {practice
              ? "每一題的作答結果都已記錄。"
              : passed
                ? "這次的成績已記錄。"
                : `需要 ${percent(QUIZ_PASS_SCORE)} 才算通過。看看下面答錯的題目，再試一次。`}
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            {passed ? (
              <Link href="/roadmap" className={primaryButton}>
                回到學習路線
              </Link>
            ) : null}
            <button type="button" onClick={start} className={passed ? secondaryButton : primaryButton}>
              {practice ? "再練一輪" : "再測一次"}
            </button>
            <Link href={back.href} className={secondaryButton}>
              {back.label}
            </Link>
          </div>
        </div>

        <h3 className="mt-8 text-lg font-bold">各題結果</h3>
        <ol className="mt-3 divide-y divide-border rounded-xl border border-border bg-surface">
          {phase.questions.map((q, i) => {
            const correct = phase.results[i].correct;
            return (
              <li key={q.id} className="flex gap-3 px-4 py-3">
                <span
                  className={`mt-0.5 h-fit shrink-0 rounded-md px-2 py-0.5 text-xs font-bold ${
                    correct ? "bg-accent-soft text-accent" : "bg-danger-soft text-danger"
                  }`}
                >
                  {correct ? "答對" : "答錯"}
                </span>
                <div className="min-w-0">
                  <p>
                    {i + 1}. {q.question}
                  </p>
                  {!correct ? (
                    <p className="mt-1 text-sm text-muted">
                      正確答案：
                      {q.options
                        .map((o, oi) => ({ o, oi }))
                        .filter(({ o }) => q.answer.includes(o.id))
                        .map(({ o, oi }) => `${letter(oi)}. ${o.text}`)
                        .join("；")}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  // ---- question phase
  const { index, selected, submitted, results } = phase;
  const question = phase.questions[index];
  const multiple = question.type === "multiple";
  const answeredCorrectly = submitted && isCorrect(question, selected);
  const isLast = index === phase.questions.length - 1;

  function toggle(optionId: string) {
    if (phase.name !== "question" || submitted) return;
    const next = multiple
      ? selected.includes(optionId)
        ? selected.filter((id) => id !== optionId)
        : [...selected, optionId]
      : [optionId];
    setPhase({ ...phase, selected: next });
  }

  function submit() {
    if (phase.name !== "question" || selected.length === 0) return;
    setPhase({
      ...phase,
      submitted: true,
      results: [...results, { questionId: question.id, correct: isCorrect(question, selected) }],
    });
  }

  function next() {
    if (phase.name !== "question") return;
    if (isLast) {
      update((p) => (mode.kind === "unit" ? recordQuizAttempt(p, mode.unitId, results) : recordAnswers(p, results)));
      setPhase({ name: "results", questions: phase.questions, results });
    } else {
      setPhase({ ...phase, index: index + 1, selected: [], submitted: false });
    }
    focusHeading();
  }

  return (
    <form
      className="rounded-xl border border-border bg-surface p-5 sm:p-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (submitted) next();
        else submit();
      }}
    >
      <div className="flex items-center justify-between gap-3 text-sm text-muted">
        <span>
          第 {index + 1} 題，共 {phase.questions.length} 題
        </span>
        {!practice && question.provider !== "general" ? <ProviderBadge provider={question.provider} /> : null}
      </div>
      <div
        role="progressbar"
        aria-label="測驗進度"
        aria-valuemin={0}
        aria-valuemax={phase.questions.length}
        aria-valuenow={index + (submitted ? 1 : 0)}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width]"
          style={{ width: `${((index + (submitted ? 1 : 0)) / phase.questions.length) * 100}%` }}
        />
      </div>

      <fieldset className="mt-5">
        <legend className="text-lg font-semibold leading-relaxed">
          <span ref={headingRef} tabIndex={-1} className="outline-none">
            {question.question}
          </span>
        </legend>
        <p className="mt-1 text-sm text-muted">
          {multiple ? `複選題，請選出 ${question.answer.length} 個答案` : "單選題"}
        </p>

        <ul className="mt-4 space-y-3">
          {question.options.map((option, oi) => {
            const chosen = selected.includes(option.id);
            const right = question.answer.includes(option.id);
            const tone = !submitted
              ? chosen
                ? "border-accent bg-accent-soft"
                : "border-border hover:border-accent"
              : right
                ? "border-accent bg-accent-soft"
                : chosen
                  ? "border-danger bg-danger-soft"
                  : "border-border";
            return (
              <li key={option.id}>
                <label
                  data-option={option.id}
                  className={`block rounded-lg border-2 p-3 transition-colors ${tone} ${submitted ? "" : "cursor-pointer"} has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent`}
                >
                  <span className="flex gap-3">
                    <input
                      type={multiple ? "checkbox" : "radio"}
                      name={`q-${question.id}`}
                      value={option.id}
                      checked={chosen}
                      disabled={submitted}
                      onChange={() => toggle(option.id)}
                      className="mt-1.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                    />
                    <span className="min-w-0">
                      <span className="font-semibold">{letter(oi)}.</span> {option.text}
                    </span>
                  </span>
                  {submitted ? (
                    <span className="mt-2 block pl-7 text-sm">
                      <span className={`font-bold ${right ? "text-accent" : chosen ? "text-danger" : "text-muted"}`}>
                        {right ? (chosen ? "正確答案，你選對了" : "正確答案") : chosen ? "你選了這個，不正確" : "不正確"}
                      </span>
                      <span className="mt-0.5 block text-muted">{option.explanation}</span>
                    </span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p role="status" className={`font-bold ${answeredCorrectly ? "text-accent" : "text-danger"}`}>
          {submitted ? (answeredCorrectly ? "答對了" : "答錯了") : ""}
        </p>
        {submitted ? (
          <button type="submit" className={primaryButton}>
            {isLast ? "看結果" : "下一題"}
          </button>
        ) : (
          <button type="submit" disabled={selected.length === 0} className={primaryButton}>
            送出答案
          </button>
        )}
      </div>
    </form>
  );
}
