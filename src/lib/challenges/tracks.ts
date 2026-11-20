import type { ChallengeTrack } from "@/lib/content/schema";

export const TRACK_LABEL: Record<ChallengeTrack, string> = {
  basics: "基礎",
  aws: "AWS",
  gcp: "Google Cloud",
};

export const TRACK_DESCRIPTION: Record<ChallengeTrack, string> = {
  basics: "Linux 與容器，兩個平台都用得到的基本功。",
  aws: "Amazon Web Services 的真實情境。",
  gcp: "Google Cloud 的真實情境。",
};
