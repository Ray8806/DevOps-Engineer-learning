"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Lab } from "@/lib/content/schema";
import { advance } from "@/lib/lab-engine/check";
import { complete, execute, prompt } from "@/lib/lab-engine/engine";
import { createLabState } from "@/lib/lab-engine/state";
import { isLabDone, recordLabDone } from "@/lib/progress/progress";
import { useProgress } from "@/lib/progress/use-progress";

export type RunnableLab = Pick<Lab, "id" | "title" | "initialState" | "steps">;

interface Line {
  kind: "input" | "output" | "error" | "system";
  text: string;
}

const MAX_LINES = 500;
const WELCOME: Line[] = [{ kind: "system", text: "這是模擬終端機，不會連到真實的雲端帳號。輸入 help 查看可用的指令。" }];

const lineClass: Record<Line["kind"], string> = {
  input: "text-white",
  output: "text-[#d5dbe5]",
  error: "text-[#ff9d8f]",
  system: "text-[#6fe0cf]",
};

export function LabRunner({ unitId, unitTitle, lab }: { unitId: string; unitTitle: string; lab: RunnableLab }) {
  const [progress, update] = useProgress();
  const [state, setState] = useState(() => createLabState(lab.initialState));
  const [done, setDone] = useState(0);
  const [lines, setLines] = useState<Line[]>(WELCOME);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  /** Position in history while browsing with the arrow keys; null = editing a new line. */
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [hintFor, setHintFor] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const total = lab.steps.length;
  const finished = done === total;
  const previouslyDone = isLabDone(progress, unitId, lab.id);

  // Keep the newest output in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function run(command: string) {
    const result = execute(state, command);
    const nextDone = advance(done, result.state, lab.steps);
    const added: Line[] = [
      { kind: "input", text: `${prompt(state)} ${command}` },
      ...result.lines.map((l): Line => ({ kind: l.error ? "error" : "output", text: l.text })),
    ];
    for (let step = done; step < nextDone; step++) added.push({ kind: "system", text: `✓ 步驟 ${step + 1} 完成` });
    if (nextDone === total && done < total) added.push({ kind: "system", text: "全部步驟完成！" });

    setLines((prev) => [...(result.clear ? [] : prev), ...(result.clear ? added.slice(1) : added)].slice(-MAX_LINES));
    setState(result.state);
    setDone(nextDone);
    if (command.trim() !== "") setHistory((prev) => (prev[prev.length - 1] === command ? prev : [...prev, command]));
    setHistoryIndex(null);
    setInput("");
    setHintFor(null);
    if (nextDone === total && done < total) update((p) => recordLabDone(p, unitId, lab.id));
  }

  function reset() {
    setState(createLabState(lab.initialState));
    setDone(0);
    setLines(WELCOME);
    setInput("");
    setHistoryIndex(null);
    setHintFor(null);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      run(input);
    } else if (e.key === "Tab" && !e.shiftKey && input !== "") {
      // Completion only while typing, so Tab on an empty line still moves focus on.
      e.preventDefault();
      setInput(complete(state, input));
    } else if (e.key === "ArrowUp") {
      if (history.length === 0) return;
      e.preventDefault();
      const index = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(index);
      setInput(history[index]);
    } else if (e.key === "ArrowDown") {
      if (historyIndex === null) return;
      e.preventDefault();
      const index = historyIndex + 1;
      if (index >= history.length) {
        setHistoryIndex(null);
        setInput("");
      } else {
        setHistoryIndex(index);
        setInput(history[index]);
      }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    } else if (e.key === "c" && e.ctrlKey && input !== "") {
      e.preventDefault();
      setLines((prev) => [...prev, { kind: "input" as const, text: `${prompt(state)} ${input}^C` }].slice(-MAX_LINES));
      setInput("");
      setHistoryIndex(null);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <section aria-labelledby="steps-heading">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="steps-heading" className="text-lg font-bold">
            步驟
          </h2>
          <p className="text-sm text-muted" role="status" data-testid="lab-progress">
            {finished ? "全部完成" : `已完成 ${done} / ${total}`}
          </p>
        </div>

        <ol className="mt-3 space-y-3">
          {lab.steps.map((step, i) => {
            const status = i < done ? "done" : i === done ? "current" : "todo";
            return (
              <li
                key={i}
                data-step-status={status}
                aria-current={status === "current" ? "step" : undefined}
                className={`rounded-xl border p-4 ${
                  status === "current" ? "border-accent bg-surface" : "border-border bg-surface"
                } ${status === "todo" ? "opacity-60" : ""}`}
              >
                <div className="flex gap-3">
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${
                      status === "done" ? "bg-accent text-surface" : "border-2 border-border text-muted"
                    }`}
                  >
                    {status === "done" ? (
                      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                        <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      i + 1
                    )}
                  </span>
                  <div className="min-w-0">
                    <p>
                      <span className="sr-only">{status === "done" ? "已完成：" : status === "current" ? "目前步驟：" : ""}</span>
                      {step.instruction}
                    </p>
                    {status === "current" && step.hint ? (
                      hintFor === i ? (
                        <p className="mt-2 rounded-lg bg-accent-soft px-3 py-2 text-sm">提示：{step.hint}</p>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setHintFor(i)}
                          className="mt-2 text-sm font-semibold text-accent underline"
                        >
                          需要提示
                        </button>
                      )
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        {finished ? (
          <div className="mt-4 rounded-xl border border-accent bg-accent-soft p-4">
            <p className="font-bold">Lab 完成！</p>
            <p className="mt-1 text-sm text-muted">終端機還可以繼續用，想多試幾個指令也沒問題。</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href={`/units/${unitId}`} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-surface hover:opacity-90">
                回到「{unitTitle}」
              </Link>
              <Link href="/roadmap" className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-semibold hover:border-accent">
                學習路線
              </Link>
            </div>
          </div>
        ) : previouslyDone ? (
          <p className="mt-4 text-sm text-muted">你之前已經完成過這個 Lab，這次是重新練習。</p>
        ) : null}

        <button type="button" onClick={reset} className="mt-4 text-sm font-semibold text-muted underline hover:text-text">
          重新開始這個 Lab
        </button>
      </section>

      <section aria-label="終端機" className="min-w-0">
        {/* On narrow screens the step list is far above; repeat the current step next to the terminal. */}
        {!finished ? (
          <p className="mb-2 rounded-lg border border-accent bg-surface px-3 py-2 text-sm lg:hidden" aria-hidden>
            <span className="font-bold text-accent">
              步驟 {done + 1} / {total}
            </span>
            　{lab.steps[done].instruction}
          </p>
        ) : null}
        {/* Clicking anywhere in the terminal focuses the input, unless text is being selected. */}
        <div
          ref={scrollRef}
          onClick={() => {
            if (window.getSelection()?.isCollapsed !== false) inputRef.current?.focus();
          }}
          className="h-[26rem] cursor-text overflow-y-auto rounded-xl bg-[#0d1117] p-4 font-mono text-[13px] leading-relaxed ring-1 ring-border focus-within:ring-2 focus-within:ring-accent sm:h-[32rem]"
        >
          <div role="log" aria-label="終端機輸出" aria-live="polite">
            {lines.map((line, i) => (
              <div key={i} data-line={line.kind} className={`min-h-[1.4em] whitespace-pre-wrap break-all ${lineClass[line.kind]}`}>
                {line.text}
              </div>
            ))}
          </div>
          <div className="flex gap-2 text-white">
            <label htmlFor="terminal-input" className="shrink-0 text-[#6fe0cf]">
              {prompt(state)}
            </label>
            <input
              id="terminal-input"
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setHistoryIndex(null);
              }}
              onKeyDown={onKeyDown}
              aria-label="輸入指令，按 Enter 執行"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="send"
              className="min-w-0 flex-1 bg-transparent text-[16px] leading-[1.25] text-white caret-[#6fe0cf] outline-none sm:text-[13px] sm:leading-relaxed"
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-muted">Enter 執行 · Tab 補完路徑 · ↑ ↓ 歷史指令 · Ctrl+L 清除畫面</p>
      </section>
    </div>
  );
}
