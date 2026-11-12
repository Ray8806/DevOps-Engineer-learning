import type { Metadata } from "next";
import { StageList } from "@/components/StageList";
import { getContent } from "@/lib/content/loader";

export const metadata: Metadata = { title: "學習路線" };

export default function RoadmapPage() {
  return (
    <div>
      <h1 className="text-3xl font-extrabold tracking-tight">學習路線</h1>
      <p className="mt-2 max-w-2xl text-muted">
        依階段由淺入深。每個單元先教通用觀念，再分別說明 AWS 與 GCP 的做法。
      </p>
      <div className="mt-8">
        <StageList content={getContent()} />
      </div>
    </div>
  );
}
