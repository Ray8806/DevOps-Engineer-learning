import { aws } from "./aws";
import type { Command, Ctx } from "./context";
import { gcloud, gsutil } from "./gcloud";
import { linuxCommands } from "./linux";
import { parseLine } from "./parse";
import { cloneState, dirname, displayPath, listDir, resolvePath, type LabState } from "./state";

export interface OutputLine {
  text: string;
  error: boolean;
}

export interface ExecResult {
  /** New state; the input state is never modified. */
  state: LabState;
  lines: OutputLine[];
  /** True when the screen should be cleared (`clear`). */
  clear: boolean;
}

const HELP = `可用的指令：
  檔案與目錄  pwd  ls  cd  mkdir  touch  cat  echo  cp  mv  rm  rmdir
  AWS         aws s3 mb | rb | ls | cp | mv | rm
  GCP         gcloud storage buckets create | delete | list | describe
              gcloud storage ls | cp | mv | rm | cat      （也支援 gsutil）
  其他        clear  help  whoami
支援 > 與 >> 輸出到檔案、用 && 或 ; 串接指令。按 Tab 補完路徑，上下鍵瀏覽歷史指令。
`;

const help: Command = (ctx) => {
  ctx.out(HELP);
  return 0;
};

const commands: Record<string, Command> = { ...linuxCommands, aws, gcloud, gsutil, help };

export const COMMAND_NAMES = [...Object.keys(commands), "clear"].sort();

function splitLines(text: string, error: boolean): OutputLine[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((t) => ({ text: t, error }));
}

/** Runs one input line against the state and returns the new state and output. */
export function execute(state: LabState, line: string): ExecResult {
  const parsed = parseLine(line);
  if (!parsed.ok) return { state, lines: [{ text: `bash: ${parsed.error}`, error: true }], clear: false };

  const draft = cloneState(state);
  const lines: OutputLine[] = [];
  let clear = false;
  let lastCode = 0;

  for (const command of parsed.commands) {
    if (command.joiner === "and" && lastCode !== 0) break;
    const [name, ...args] = command.argv;

    if (name === "clear") {
      lines.length = 0;
      clear = true;
      lastCode = 0;
      continue;
    }

    let stdout = "";
    const ctx: Ctx = {
      state: draft,
      out: (text) => {
        if (command.redirect) stdout += text;
        else lines.push(...splitLines(text, false));
      },
      err: (text) => lines.push(...splitLines(text, true)),
    };

    // Like a shell, open the redirect target before running the command.
    let target: string | undefined;
    if (command.redirect) {
      target = resolvePath(draft.cwd, command.redirect.path);
      const problem = draft.dirs.has(target)
        ? "Is a directory"
        : !draft.dirs.has(dirname(target))
          ? "No such file or directory"
          : null;
      if (problem) {
        ctx.err(`bash: ${command.redirect.path}: ${problem}`);
        lastCode = 1;
        continue;
      }
    }

    const run = Object.hasOwn(commands, name) ? commands[name] : undefined;
    if (!run) {
      ctx.err(`bash: ${name}: command not found（輸入 help 查看可用的指令）`);
      lastCode = 127;
    } else {
      lastCode = run(ctx, args);
    }

    if (target !== undefined && command.redirect) {
      draft.files.set(target, (command.redirect.append ? (draft.files.get(target) ?? "") : "") + stdout);
    }
  }

  return { state: draft, lines, clear };
}

/** Shell prompt for the current directory. */
export function prompt(state: LabState): string {
  return `learner@cloud:${displayPath(state.cwd)}$`;
}

/**
 * Tab completion: command names for the first word, local paths otherwise.
 * Returns the completed line, or the input unchanged when nothing (or more
 * than one thing with no longer common prefix) matches.
 */
export function complete(state: LabState, line: string): string {
  const start = line.lastIndexOf(" ") + 1;
  const word = line.slice(start);
  const head = line.slice(0, start);
  if (/["'\\]/.test(word)) return line;

  let candidates: string[];
  let base = "";
  if (head.trim() === "") {
    if (word === "") return line;
    candidates = COMMAND_NAMES.filter((c) => c.startsWith(word)).map((c) => `${c} `);
  } else {
    const slash = word.lastIndexOf("/");
    base = word.slice(0, slash + 1);
    const partial = word.slice(slash + 1);
    if (word.includes("://")) return line;
    const dir = resolvePath(state.cwd, base === "" ? "." : base);
    if (!state.dirs.has(dir)) return line;
    candidates = listDir(state, dir)
      .filter(([name]) => name.startsWith(partial) && (partial.startsWith(".") || !name.startsWith(".")))
      .map(([name, isDir]) => (isDir ? `${name}/` : `${name} `));
  }

  if (candidates.length === 0) return line;
  let common = candidates[0];
  for (const c of candidates) {
    while (!c.startsWith(common)) common = common.slice(0, -1);
  }
  if (candidates.length > 1) common = common.trimEnd();
  return common.length > word.length - base.length ? head + base + common : line;
}
