import type { ComponentProps, ReactNode } from "react";
import type { Provider as ProviderId, UnitMeta } from "@/lib/content/schema";
import { PROVIDERS } from "@/lib/content/schema";
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
export function lessonComponents(meta: UnitMeta) {
  const providers = PROVIDERS.filter((p) => meta.providers[p]);
  return {
    ProviderTabs: ({ children }: { children: ReactNode }) => (
      <ProviderTabs providers={providers}>{children}</ProviderTabs>
    ),
    Provider: ProviderSection,
    Callout,
    Compare: () => <CompareTable rows={meta.compare} />,
    table: (props: ComponentProps<"table">) => (
      <div className="table-scroll">
        <table {...props} />
      </div>
    ),
  };
}
