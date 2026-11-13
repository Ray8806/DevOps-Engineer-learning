import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Quiz, type QuizQuestion } from "@/components/Quiz";
import { getContent } from "@/lib/content/loader";

export function generateStaticParams() {
  return [...getContent().units.keys()].map((id) => ({ id }));
}

export async function generateMetadata({ params }: PageProps<"/units/[id]/quiz">): Promise<Metadata> {
  const unit = getContent().units.get((await params).id);
  return unit ? { title: `${unit.meta.title}：單元測驗` } : {};
}

export default async function QuizPage({ params }: PageProps<"/units/[id]/quiz">) {
  const unit = getContent().units.get((await params).id);
  if (!unit) notFound();

  // Only the fields the quiz UI needs are sent to the browser.
  const questions: QuizQuestion[] = unit.quiz.map(({ id, type, provider, question, options, answer }) => ({
    id,
    type,
    provider,
    question,
    options,
    answer,
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <nav aria-label="麵包屑" className="text-sm text-muted">
        <Link href="/roadmap" className="hover:text-text">
          學習路線
        </Link>
        <span aria-hidden> / </span>
        <Link href={`/units/${unit.meta.id}`} className="hover:text-text">
          {unit.meta.title}
        </Link>
      </nav>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight">單元測驗：{unit.meta.title}</h1>
      <div className="mt-6">
        <Quiz unitId={unit.meta.id} unitTitle={unit.meta.title} questions={questions} />
      </div>
    </div>
  );
}
