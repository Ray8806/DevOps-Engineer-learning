import type { ComponentProps, ReactNode } from "react";
import type { Flow as FlowData, Provider as ProviderId, UnitMeta } from "@/lib/content/schema";
import { PROVIDERS } from "@/lib/content/schema";
import { Flow } from "./Flow";
import { ProviderTabs } from "./ProviderTabs";

function ProviderSection({ name, children }: { name: ProviderId; children: ReactNode }) {
  return (
    <section data-provider={name} className="lesson">
      {children}
    </section>
  );
}

function Callout({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <aside className="rounded-lg border-l-4 border-accent bg-accent-soft px-4 py-3 text-[0.95rem]">
      {title ? <p className="font-bold">{title}</p> : null}
      <div className="lesson">{children}</div>
    </aside>
  );
}

/** Folded reference answer, so learners think first and then compare. */
function Answer({ children }: { children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-border bg-surface px-4 py-2">
      <summary className="cursor-pointer py-1 text-sm font-semibold text-accent select-none">
        <span className="group-open:hidden">看回答重點</span>
        <span className="hidden group-open:inline">收起回答重點</span>
      </summary>
      <div className="lesson pb-2">{children}</div>
    </details>
  );
}

function CompareTable({ rows }: { rows: UnitMeta["compare"] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">比較項目</th>
            <th scope="col" className="!text-aws">AWS</th>
            <th scope="col" className="!text-gcp">GCP</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.aspect}>
              <th scope="row">{row.aspect}</th>
              <td>{row.aws}</td>
              <td>{row.gcp}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Components available inside lesson.mdx, bound to the unit being rendered. */
export function lessonComponents(meta: UnitMeta, flows: FlowData[] = []) {
  const providers = PROVIDERS.filter((p) => meta.providers[p]);
  return {
    ProviderTabs: ({ children }: { children: ReactNode }) => (
      <ProviderTabs providers={providers}>{children}</ProviderTabs>
    ),
    Provider: ProviderSection,
    Callout,
    Answer,
    Compare: () => <CompareTable rows={meta.compare} />,
    // The loader checks every <Flow id> has a flows/<id>.json.
    Flow: ({ id }: { id: string }) => <Flow flow={flows.find((f) => f.id === id)!} />,
    table: (props: ComponentProps<"table">) => (
      <div className="table-scroll">
        <table {...props} />
      </div>
    ),
  };
}
