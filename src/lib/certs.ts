import type { Cert } from "@/lib/content/schema";

export const LEVEL_LABEL: Record<Cert["level"], string> = {
  foundational: "入門",
  associate: "助理級",
};

const TYPE_LABEL = { single: "單選題", multiple: "複選題" } as const;

/** Exam facts as label/value rows. Facts the official source omits are left out. */
export function examFacts(cert: Cert): { label: string; value: string }[] {
  const { exam } = cert;
  const count =
    exam.questionCountMin === exam.questionCountMax
      ? `${exam.questionCountMin} 題`
      : `${exam.questionCountMin} 到 ${exam.questionCountMax} 題`;
  const facts = [
    {
      label: "題數",
      value: exam.scoredQuestions
        ? `${count}（${exam.scoredQuestions} 題計分，${exam.questionCountMax - exam.scoredQuestions} 題不計分）`
        : count,
    },
    { label: "題型", value: exam.questionTypes.map((t) => TYPE_LABEL[t]).join("、") },
  ];
  if (exam.durationMinutes) facts.push({ label: "考試時間", value: `${exam.durationMinutes} 分鐘` });
  if (exam.passingScore) {
    const { score, scaleMin, scaleMax } = exam.passingScore;
    facts.push({ label: "及格分數", value: `${score} 分（計分範圍 ${scaleMin} 到 ${scaleMax}）` });
  }
  return facts;
}
