import { challengeStars, isChallengeCleared, QUIZ_PASS_SCORE, type Progress } from "./progress";

/**
 * Experience, levels, streaks and badges. Everything here is computed from
 * progress, so it needs no storage of its own, counts learning done before
 * the feature existed, and agrees on every synced device.
 */

export const XP = {
  unitRead: 20,
  quizPassed: 30,
  labDone: 40,
  /** Per cleared challenge, plus `challengeStar` for each star. */
  challengeCleared: 20,
  challengeStar: 10,
  correctAnswer: 2,
} as const;

export interface ChallengeInfo {
  id: string;
  track: string;
}

export interface AchievementContext {
  challenges: readonly ChallengeInfo[];
  /** Today as YYYY-MM-DD in the learner's time zone. */
  today: string;
}

export function totalXp(progress: Progress): number {
  let xp = 0;
  for (const unit of Object.values(progress.units)) {
    if (unit.read) xp += XP.unitRead;
    if ((unit.quizScore ?? 0) >= QUIZ_PASS_SCORE) xp += XP.quizPassed;
    xp += unit.labsDone.length * XP.labDone;
  }
  for (const id of Object.keys(progress.challenges)) {
    if (isChallengeCleared(progress, id)) xp += XP.challengeCleared + challengeStars(progress, id) * XP.challengeStar;
  }
  xp += Object.values(progress.questions).filter((q) => q.lastCorrect).length * XP.correctAnswer;
  return xp;
}

/** XP needed to reach each level (index 0 is level 1). */
const LEVELS: readonly { xp: number; title: string }[] = [
  { xp: 0, title: "雲端新手" },
  { xp: 100, title: "見習工程師" },
  { xp: 250, title: "初級工程師" },
  { xp: 450, title: "雲端工程師" },
  { xp: 700, title: "進階工程師" },
  { xp: 1000, title: "資深工程師" },
  { xp: 1400, title: "技術主管" },
  { xp: 1900, title: "解決方案架構師" },
  { xp: 2500, title: "資深架構師" },
  { xp: 3200, title: "首席架構師" },
];

export interface LevelInfo {
  level: number;
  title: string;
  /** XP earned inside the current level. */
  intoLevel: number;
  /** XP the current level spans; null at the top level. */
  levelSpan: number | null;
}

export function levelFor(xp: number): LevelInfo {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1].xp) i++;
  const next = LEVELS[i + 1];
  return {
    level: i + 1,
    title: LEVELS[i].title,
    intoLevel: xp - LEVELS[i].xp,
    levelSpan: next ? next.xp - LEVELS[i].xp : null,
  };
}

/** The calendar day before `day` (both YYYY-MM-DD). */
export function previousDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d - 1));
  return date.toISOString().slice(0, 10);
}

export interface Streak {
  /** Consecutive active days ending today, or yesterday if today has no activity yet. */
  current: number;
  best: number;
  activeToday: boolean;
}

export function streak(activeDays: readonly string[], today: string): Streak {
  const days = new Set(activeDays);
  const activeToday = days.has(today);
  let current = 0;
  for (let day = activeToday ? today : previousDay(today); days.has(day); day = previousDay(day)) current++;

  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of [...days].sort()) {
    run = prev !== null && previousDay(day) === prev ? run + 1 : 1;
    best = Math.max(best, run);
    prev = day;
  }
  return { current, best, activeToday };
}

export interface Badge {
  id: string;
  icon: string;
  title: string;
  description: string;
  current: number;
  target: number;
  earned: boolean;
}

interface BadgeRule {
  id: string;
  icon: string;
  title: string;
  description: string;
  target: (ctx: AchievementContext) => number;
  count: (progress: Progress, ctx: AchievementContext) => number;
}

const unitsRead = (p: Progress) => Object.values(p.units).filter((u) => u.read).length;
const labsDone = (p: Progress) => Object.values(p.units).reduce((n, u) => n + u.labsDone.length, 0);
const quizzesPassed = (p: Progress) => Object.values(p.units).filter((u) => (u.quizScore ?? 0) >= QUIZ_PASS_SCORE).length;
const cleared = (p: Progress, ctx: AchievementContext, track?: string) =>
  ctx.challenges.filter((c) => (track === undefined || c.track === track) && isChallengeCleared(p, c.id)).length;
const inTrack = (ctx: AchievementContext, track: string) => ctx.challenges.filter((c) => c.track === track).length;

const TRACK_BADGES: { track: string; name: string; icon: string }[] = [
  { track: "basics", name: "基礎", icon: "🧰" },
  { track: "aws", name: "AWS", icon: "🚀" },
  { track: "gcp", name: "Google Cloud", icon: "🌐" },
];

const RULES: readonly BadgeRule[] = [
  { id: "first-unit", icon: "📖", title: "踏出第一步", description: "讀完第一個單元的課文", target: () => 1, count: unitsRead },
  { id: "bookworm", icon: "📚", title: "勤學不倦", description: "讀完 10 個單元的課文", target: () => 10, count: unitsRead },
  { id: "first-lab", icon: "🛠️", title: "第一次動手", description: "完成第一個 Lab", target: () => 1, count: labsDone },
  { id: "hands-on", icon: "⚙️", title: "實作派", description: "完成 10 個 Lab", target: () => 10, count: labsDone },
  { id: "quiz-master", icon: "🎯", title: "測驗達人", description: "通過 5 個單元測驗", target: () => 5, count: quizzesPassed },
  {
    id: "hundred-questions",
    icon: "💯",
    title: "百題斬",
    description: "作答 100 道不同的題目",
    target: () => 100,
    count: (p) => Object.keys(p.questions).length,
  },
  { id: "first-clear", icon: "🚩", title: "第一關", description: "通過第一個闖關關卡", target: () => 1, count: (p, ctx) => cleared(p, ctx) },
  {
    id: "flawless",
    icon: "⭐",
    title: "一次就過",
    description: "第一次執行就通過一關（三顆星）",
    target: () => 1,
    count: (p, ctx) => ctx.challenges.filter((c) => challengeStars(p, c.id) === 3).length,
  },
  {
    id: "multi-cloud",
    icon: "☁️",
    title: "雙棲工程師",
    description: "AWS 和 Google Cloud 路線各通過至少一關",
    target: () => 2,
    count: (p, ctx) => (cleared(p, ctx, "aws") > 0 ? 1 : 0) + (cleared(p, ctx, "gcp") > 0 ? 1 : 0),
  },
  ...TRACK_BADGES.map(({ track, name, icon }): BadgeRule => {
    // A space between Latin and CJK text: "AWS 路線", but "基礎路線".
    const named = /[A-Za-z]$/.test(name) ? `${name} ` : name;
    return {
      id: `track-${track}`,
      icon,
      title: `${named}路線全破`,
      description: `通過${/^[A-Za-z]/.test(name) ? ` ${named}` : named}路線的所有關卡`,
      target: (ctx) => inTrack(ctx, track),
      count: (p, ctx) => cleared(p, ctx, track),
    };
  }),
  {
    id: "perfectionist",
    icon: "🏆",
    title: "完美主義",
    description: "所有闖關關卡都拿到三顆星",
    target: (ctx) => ctx.challenges.length,
    count: (p, ctx) => ctx.challenges.filter((c) => challengeStars(p, c.id) === 3).length,
  },
  { id: "streak-3", icon: "🔥", title: "連續三天", description: "連續 3 天都有學習", target: () => 3, count: (p, ctx) => streak(p.activeDays, ctx.today).best },
  { id: "streak-7", icon: "📅", title: "一週不間斷", description: "連續 7 天都有學習", target: () => 7, count: (p, ctx) => streak(p.activeDays, ctx.today).best },
];

export function badges(progress: Progress, ctx: AchievementContext): Badge[] {
  return RULES.map((rule) => {
    const target = rule.target(ctx);
    const current = Math.min(rule.count(progress, ctx), target);
    // A badge with nothing to do (no levels in a track yet) is not shown as earned.
    return { id: rule.id, icon: rule.icon, title: rule.title, description: rule.description, current, target, earned: target > 0 && current >= target };
  }).filter((b) => b.target > 0);
}
