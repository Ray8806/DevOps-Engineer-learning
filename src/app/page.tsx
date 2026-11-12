import Link from "next/link";
import { getContent } from "@/lib/content/loader";

const STEPS = [
  { title: "讀", body: "先懂通用觀念，再看 AWS 與 GCP 各自怎麼做。" },
  { title: "測驗", body: "每題都有逐一選項的解析，知道為什麼對、為什麼錯。" },
  { title: "動手做", body: "在瀏覽器裡的模擬終端機練指令，不必開雲端帳號。" },
];

export default function HomePage() {
  const content = getContent();
  const firstUnit = content.stages.flatMap((s) => s.units)[0];

  return (
    <div className="space-y-14">
      <section className="pt-4 sm:pt-10">
        <p className="text-sm font-semibold text-accent">AWS · GCP · 證照備考</p>
        <h1 className="mt-2 max-w-2xl text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
          從零開始，成為雲端工程師
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-muted">
          一個觀念學一次，同時看懂兩個平台。每個單元都有課文、測驗和實作練習。
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/roadmap"
            className="rounded-lg bg-accent px-5 py-2.5 font-semibold text-surface hover:opacity-90"
          >
            查看學習路線
          </Link>
          {firstUnit ? (
            <Link
              href={`/units/${firstUnit}`}
              className="rounded-lg border border-border bg-surface px-5 py-2.5 font-semibold hover:border-accent"
            >
              試讀第一個單元
            </Link>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="how">
        <h2 id="how" className="text-2xl font-bold">
          每個單元三個步驟
        </h2>
        <ol className="mt-4 grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="rounded-xl border border-border bg-surface p-5">
              <span className="text-sm font-bold text-accent">步驟 {i + 1}</span>
              <h3 className="mt-1 text-lg font-bold">{step.title}</h3>
              <p className="mt-1 text-sm text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="stages">
        <h2 id="stages" className="text-2xl font-bold">
          五個學習階段
        </h2>
        <ol className="mt-4 divide-y divide-border rounded-xl border border-border bg-surface">
          {content.stages.map((stage) => (
            <li key={stage.id} className="flex gap-4 px-5 py-4">
              <span className="mt-0.5 h-fit rounded-md bg-surface-2 px-2 py-0.5 text-xs font-bold text-muted">
                {stage.id}
              </span>
              <div>
                <h3 className="font-bold">{stage.title}</h3>
                <p className="text-sm text-muted">{stage.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
