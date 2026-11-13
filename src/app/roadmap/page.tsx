import type { Metadata } from "next";
import { Roadmap, type RoadmapStage } from "@/components/Roadmap";
import { getContent } from "@/lib/content/loader";
import { toUnitRef } from "@/lib/content/unit-ref";

export const metadata: Metadata = { title: "學習路線" };

export default function RoadmapPage() {
  const content = getContent();
  const stages: RoadmapStage[] = content.stages.map((stage) => ({
    id: stage.id,
    title: stage.title,
    description: stage.description,
    units: stage.units.map((id) => {
      const unit = content.units.get(id)!;
      const { meta } = unit;
      const ref = toUnitRef(unit);
      return {
        ...ref,
        title: meta.title,
        summary: meta.summary,
        estimatedMinutes: meta.estimatedMinutes,
        services: Object.fromEntries(ref.providers.map((p) => [p, meta.providers[p]!.services])),
      };
    }),
  }));

  return (
    <div>
      <h1 className="text-3xl font-extrabold tracking-tight">學習路線</h1>
      <p className="mt-2 max-w-2xl text-muted">
        依階段由淺入深。每個單元先教通用觀念，再分別說明 AWS 與 GCP 的做法。
      </p>
      <div className="mt-6">
        <Roadmap stages={stages} />
      </div>
    </div>
  );
}
