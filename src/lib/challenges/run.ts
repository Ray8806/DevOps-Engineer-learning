import type { Challenge, ChallengeGoal } from "@/lib/content/schema";
import { BLANK_PATTERN } from "@/lib/content/schema";
import { passes } from "@/lib/lab-engine/check";
import { execute, startLab, type OutputLine } from "@/lib/lab-engine/engine";
import type { LabState } from "@/lib/lab-engine/state";

/** Chosen value per blank id; a missing value leaves the blank unfilled. */
export type Answers = Readonly<Record<string, string>>;

/** Replaces each {{id}} with its answer. */
export function fill(template: string, answers: Answers): string {
  return template.replace(BLANK_PATTERN, (whole, id: string) => answers[id] ?? whole);
}

export function allFilled(challenge: Challenge, answers: Answers): boolean {
  return challenge.blanks.every((b) => answers[b.id] !== undefined);
}

export function correctAnswers(challenge: Challenge): Answers {
  return Object.fromEntries(challenge.blanks.map((b) => [b.id, b.answer]));
}

export interface CommandRun {
  command: string;
  lines: OutputLine[];
  exitCode: number;
}

export interface GoalResult {
  description: string;
  passed: boolean;
}

export interface ChallengeRun {
  /** Commands that ran, ending at the first failure. */
  commands: CommandRun[];
  /** Index of the command that failed, or null when all succeeded. */
  failedAt: number | null;
  goals: GoalResult[];
  cleared: boolean;
}

function goalPasses(state: LabState, goal: ChallengeGoal): boolean {
  if ("check" in goal) return passes(state, goal.check);
  const result = execute(state, goal.run);
  const output = result.lines.map((l) => l.text).join("\n");
  if (result.exitCode !== 0) return false;
  if (goal.contains !== undefined && !output.includes(goal.contains)) return false;
  if (goal.notContains !== undefined && output.includes(goal.notContains)) return false;
  return true;
}

/**
 * Fills the blanks, runs the commands like a script that stops at the first
 * error, then checks the goals. Pure: the same answers give the same result.
 */
export function runChallenge(challenge: Challenge, answers: Answers): ChallengeRun {
  const files = Object.fromEntries(Object.entries(challenge.initialState.files).map(([p, text]) => [p, fill(text, answers)]));
  let state = startLab({ files, cloud: {}, setup: challenge.initialState.setup });

  const commands: CommandRun[] = [];
  let failedAt: number | null = null;
  for (const template of challenge.commands) {
    const command = fill(template, answers);
    const result = execute(state, command);
    state = result.state;
    commands.push({ command, lines: result.lines, exitCode: result.exitCode });
    if (result.exitCode !== 0) {
      failedAt = commands.length - 1;
      break;
    }
  }

  const goals = challenge.goals.map((goal) => ({
    description: goal.description,
    // Goals are only met by a script that ran to the end.
    passed: failedAt === null && goalPasses(state, goal),
  }));
  return { commands, failedAt, goals, cleared: failedAt === null && goals.every((g) => g.passed) };
}
