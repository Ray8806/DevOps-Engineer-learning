import type { Question } from "@/lib/content/schema";
import { providerMatches, type PreferredProvider } from "@/lib/progress/progress";

/** Correct only when the chosen options are exactly the answer set. */
export function isCorrect(question: Pick<Question, "answer">, selected: readonly string[]): boolean {
  const chosen = new Set(selected);
  return chosen.size === question.answer.length && question.answer.every((id) => chosen.has(id));
}

export interface QuestionResult {
  questionId: string;
  correct: boolean;
}

export interface QuizScore {
  correct: number;
  total: number;
  /** Fraction correct, 0 to 1. An empty quiz scores 0. */
  score: number;
}

export function scoreQuiz(results: readonly QuestionResult[]): QuizScore {
  const correct = results.filter((r) => r.correct).length;
  return { correct, total: results.length, score: results.length ? correct / results.length : 0 };
}

/**
 * Questions for the learner's main platform: general ones plus that
 * platform's. Falls back to every question rather than an empty quiz.
 */
export function questionsFor<Q extends Pick<Question, "provider">>(questions: Q[], preferred: PreferredProvider): Q[] {
  const filtered = questions.filter((q) => providerMatches(q.provider, preferred));
  return filtered.length ? filtered : questions;
}
