import type { Metadata } from "next";
import { ChallengeMap, type ChallengeSummary } from "@/components/ChallengeMap";
import { getContent } from "@/lib/content/loader";
import { CHALLENGE_TRACKS } from "@/lib/content/schema";

export const metadata: Metadata = {
  title: "闖關",
  description: "把正確的值填進設定和指令，讓系統真的跑起來。",
};

export default function ChallengesPage() {
  const { challenges } = getContent();
  const tracks = CHALLENGE_TRACKS.map((track) => ({
    track,
    levels: challenges
      .filter((c) => c.track === track)
      .map((c): ChallengeSummary => ({ id: c.id, track: c.track, level: c.level, title: c.title })),
  })).filter((t) => t.levels.length > 0);

  return (
    <div>
      <h1 className="text-3xl font-extrabold tracking-tight">闖關</h1>
      <p className="mt-2 max-w-2xl text-muted">
        每一關都是一個真實的工作情境：設定檔和指令缺了幾個地方，選出正確的值填進去，按下執行。
        填錯就會看到真正的錯誤訊息，填對系統才會動起來。第一次就過關可以拿到三顆星。
      </p>
      <ChallengeMap tracks={tracks} />
    </div>
  );
}
