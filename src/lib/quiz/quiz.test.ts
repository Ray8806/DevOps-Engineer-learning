import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content/loader";
import { isCorrect, questionsFor, sample, scoreQuiz } from "./quiz";

const single = { answer: ["b"] };
const multiple = { answer: ["a", "c"] };

describe("isCorrect", () => {
  it("single choice: only the one right option is correct", () => {
    expect(isCorrect(single, ["b"])).toBe(true);
    expect(isCorrect(single, ["a"])).toBe(false);
    expect(isCorrect(single, [])).toBe(false);
  });

  it("multiple choice: needs exactly the answer set, in any order", () => {
    expect(isCorrect(multiple, ["a", "c"])).toBe(true);
    expect(isCorrect(multiple, ["c", "a"])).toBe(true);
  });

  it("multiple choice: partial, extra or wrong selections are incorrect", () => {
    expect(isCorrect(multiple, ["a"])).toBe(false);
    expect(isCorrect(multiple, ["a", "b", "c"])).toBe(false);
    expect(isCorrect(multiple, ["a", "b"])).toBe(false);
    expect(isCorrect(multiple, [])).toBe(false);
  });

  it("does not count a duplicated selection as two answers", () => {
    expect(isCorrect(multiple, ["a", "a"])).toBe(false);
    expect(isCorrect(multiple, ["a", "c", "a"])).toBe(true);
  });

  it("marks every real question correct with its own answer and wrong with any single other option", () => {
    for (const unit of loadContent().units.values()) {
      for (const q of unit.quiz) {
        expect(isCorrect(q, q.answer), q.id).toBe(true);
        for (const o of q.options.filter((o) => !q.answer.includes(o.id))) {
          expect(isCorrect(q, [o.id]), q.id).toBe(false);
        }
      }
    }
  });
});

describe("scoreQuiz", () => {
  it("counts correct answers", () => {
    const r = (correct: boolean, i: number) => ({ questionId: `q${i}`, correct });
    expect(scoreQuiz([true, false, true, true].map(r))).toEqual({ correct: 3, total: 4, score: 0.75 });
    expect(scoreQuiz([])).toEqual({ correct: 0, total: 0, score: 0 });
  });
});

describe("questionsFor", () => {
  const qs = [
    { id: 1, provider: "general" as const },
    { id: 2, provider: "aws" as const },
    { id: 3, provider: "gcp" as const },
  ];

  it("keeps general questions plus the chosen platform's", () => {
    expect(questionsFor(qs, "both").map((q) => q.id)).toEqual([1, 2, 3]);
    expect(questionsFor(qs, "aws").map((q) => q.id)).toEqual([1, 2]);
    expect(questionsFor(qs, "gcp").map((q) => q.id)).toEqual([1, 3]);
  });

  it("falls back to all questions instead of an empty quiz", () => {
    expect(questionsFor([qs[1]], "gcp")).toEqual([qs[1]]);
  });
});

describe("sample", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];

  it("returns the requested number of distinct items without changing the input", () => {
    const picked = sample(items, 5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked).size).toBe(5);
    expect(picked.every((x) => items.includes(x))).toBe(true);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("returns everything, shuffled, when asked for more than there is", () => {
    expect([...sample(items, 99)].sort()).toEqual(items);
    expect(sample(items, 0)).toEqual([]);
    expect(sample([], 3)).toEqual([]);
  });

  it("is driven by the random source", () => {
    // A source that always returns 0 swaps each position with the first.
    expect(sample([1, 2, 3], 3, () => 0)).toEqual([2, 3, 1]);
    // A source just under 1 leaves every item in place.
    expect(sample([1, 2, 3], 3, () => 0.999)).toEqual([1, 2, 3]);
  });
});
