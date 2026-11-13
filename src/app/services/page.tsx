import type { Metadata } from "next";
import { ServiceTable, type ServiceRow } from "@/components/ServiceTable";
import { getContent } from "@/lib/content/loader";

export const metadata: Metadata = { title: "服務對照表" };

export default function ServicesPage() {
  const content = getContent();
  // Built from unit metadata, in learning order; provider-neutral units have nothing to compare.
  const rows: ServiceRow[] = content.stages.flatMap((stage) =>
    stage.units
      .map((id) => content.units.get(id)!.meta)
      .filter((meta) => meta.providers.aws || meta.providers.gcp)
      .map((meta) => ({
        unitId: meta.id,
        concept: meta.title,
        stage: `階段 ${stage.id}：${stage.title}`,
        aws: meta.providers.aws?.services ?? [],
        gcp: meta.providers.gcp?.services ?? [],
      })),
  );

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-extrabold tracking-tight">服務對照表</h1>
      <p className="mt-2 text-muted">
        同一個觀念在 AWS 和 GCP 各叫什麼。點觀念名稱可以進入對應的單元。對照表會隨課程單元增加而擴充。
      </p>
      <div className="mt-6">
        <ServiceTable rows={rows} />
      </div>
    </div>
  );
}
