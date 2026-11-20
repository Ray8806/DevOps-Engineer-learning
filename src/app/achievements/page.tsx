import type { Metadata } from "next";
import { AchievementsView } from "@/components/Achievements";
import { getContent } from "@/lib/content/loader";

export const metadata: Metadata = {
  title: "成就",
  description: "等級、經驗值、連續學習天數與徽章。",
};

export default function AchievementsPage() {
  const challenges = getContent().challenges.map(({ id, track }) => ({ id, track }));
  return (
    <div>
      <h1 className="text-3xl font-extrabold tracking-tight">成就</h1>
      <p className="mt-2 max-w-2xl text-muted">
        讀課文、做測驗、完成 Lab 和闖關都能累積經驗值升級，達成目標還能收集徽章。登入後，成就會跟著帳號在每台裝置上同步。
      </p>
      <AchievementsView challenges={challenges} />
    </div>
  );
}
