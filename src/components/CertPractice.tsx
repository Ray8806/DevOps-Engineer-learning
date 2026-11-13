"use client";

import { useState } from "react";
import { Quiz, type QuizQuestion } from "./Quiz";

export interface PracticeDomain {
  id: number;
  titleZh: string;
  questions: QuizQuestion[];
}

const ROUND_SIZE = 10;

/** Untimed practice for one cert: pick all domains or a single one. */
export function CertPractice({ certId, domains }: { certId: string; domains: PracticeDomain[] }) {
  const [domain, setDomain] = useState<number | "all">("all");

  // A question tagged with two domains of this cert appears once in "all".
  const all = [...new Map(domains.flatMap((d) => d.questions).map((q) => [q.id, q])).values()];
  const questions = domain === "all" ? all : (domains.find((d) => d.id === domain)?.questions ?? []);
  const choices: { id: number | "all"; label: string; count: number }[] = [
    { id: "all", label: "全部範圍", count: all.length },
    ...domains.map((d) => ({ id: d.id, label: `${d.id}. ${d.titleZh}`, count: d.questions.length })),
  ];

  return (
    <div>
      <fieldset>
        <legend className="text-sm font-semibold">練習範圍</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {choices.map((c) => (
            <label
              key={c.id}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                domain === c.id ? "border-accent bg-accent-soft font-semibold" : "border-border bg-surface hover:border-accent"
              } ${c.count === 0 ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <input
                type="radio"
                name="practice-domain"
                className="sr-only"
                checked={domain === c.id}
                disabled={c.count === 0}
                onChange={() => setDomain(c.id)}
              />
              {c.label}
              <span className="ml-1.5 text-muted">{c.count} 題</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4">
        {/* Remount on a new domain so a round in progress does not carry over. */}
        <Quiz
          key={domain}
          mode={{ kind: "practice", roundSize: ROUND_SIZE, backHref: `/certs/${certId}`, backLabel: "回到證照頁" }}
          questions={questions}
        />
      </div>
    </div>
  );
}
