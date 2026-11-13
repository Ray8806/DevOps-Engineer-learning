import { parseArgs, type Command, type Ctx } from "./context";
import {
  addDirWithParents,
  branchFiles,
  dirname,
  history,
  isWithin,
  resolvePath,
  workingFiles,
  type GitRepo,
  type LabState,
} from "./state";

const SUPPORTED = "這個模擬終端機支援 git 的 init、status、add、commit、log、branch、switch、checkout、merge。";
const NO_REMOTE = "這個模擬終端機沒有遠端儲存庫，所以不支援 clone、remote、push、pull、fetch。";
const NOT_A_REPO = "fatal: not a git repository (or any of the parent directories): .git";

/** Innermost repository containing the current directory. */
function findRepo(state: LabState): { root: string; repo: GitRepo } | null {
  for (let dir = state.cwd; ; dir = dirname(dir)) {
    const repo = state.git.get(dir);
    if (repo) return { root: dir, repo };
    if (dir === "/") return null;
  }
}

/** Short, deterministic commit id derived from the commit's content (FNV-1a). */
function commitId(repo: GitRepo, message: string, parents: string[]): string {
  let hash = 0x811c9dc5;
  for (const ch of `${repo.commits.size}\0${parents.join(",")}\0${message}`) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 7);
}

type Change = "new file" | "modified" | "deleted";

/** Paths that differ between two snapshots, sorted. */
function diff(from: Map<string, string>, to: Map<string, string>): [string, Change][] {
  const result: [string, Change][] = [];
  for (const path of [...new Set([...from.keys(), ...to.keys()])].sort()) {
    if (!from.has(path)) result.push([path, "new file"]);
    else if (!to.has(path)) result.push([path, "deleted"]);
    else if (from.get(path) !== to.get(path)) result.push([path, "modified"]);
  }
  return result;
}

/** Path of a working-tree argument relative to the repository root, or null if outside it. */
function relative(state: LabState, root: string, arg: string): string | null {
  const abs = resolvePath(state.cwd, arg);
  if (!isWithin(abs, root)) return null;
  return abs === root ? "" : abs.slice(root === "/" ? 1 : root.length + 1);
}

function writeTree(state: LabState, root: string, from: Map<string, string>, to: Map<string, string>) {
  const base = root === "/" ? "" : root;
  for (const path of from.keys()) if (!to.has(path)) state.files.delete(`${base}/${path}`);
  for (const [path, content] of to) {
    state.files.set(`${base}/${path}`, content);
    addDirWithParents(state.dirs, dirname(`${base}/${path}`));
  }
}

function init(ctx: Ctx, args: string[]): number {
  if (args.length > 1 || args[0]?.startsWith("-")) {
    ctx.err("usage: git init [<directory>]");
    return 129;
  }
  const root = resolvePath(ctx.state.cwd, args[0] ?? ".");
  if (ctx.state.files.has(root)) {
    ctx.err(`fatal: cannot mkdir ${args[0]}: File exists`);
    return 128;
  }
  const existed = ctx.state.git.has(root);
  if (!existed) {
    addDirWithParents(ctx.state.dirs, `${root === "/" ? "" : root}/.git`);
    ctx.state.git.set(root, { head: "main", branches: new Map([["main", null]]), commits: new Map(), index: new Map() });
  }
  ctx.out(`${existed ? "Reinitialized existing" : "Initialized empty"} Git repository in ${root === "/" ? "" : root}/.git/\n`);
  return 0;
}

function status(ctx: Ctx, root: string, repo: GitRepo): number {
  const head = branchFiles(repo, repo.head);
  const working = workingFiles(ctx.state, root);
  const staged = diff(head, repo.index);
  const unstaged = diff(repo.index, working).filter(([, change]) => change !== "new file");
  const untracked = [...working.keys()].filter((p) => !repo.index.has(p)).sort();

  const lines = [`On branch ${repo.head}`];
  if (repo.branches.get(repo.head) === null) lines.push("", "No commits yet");
  if (staged.length) {
    lines.push("", "Changes to be committed:");
    for (const [path, change] of staged) lines.push(`\t${`${change}:`.padEnd(12)}${path}`);
  }
  if (unstaged.length) {
    lines.push("", "Changes not staged for commit:", '  (use "git add <file>..." to update what will be committed)');
    for (const [path, change] of unstaged) lines.push(`\t${`${change}:`.padEnd(12)}${path}`);
  }
  if (untracked.length) {
    lines.push("", "Untracked files:", '  (use "git add <file>..." to include in what will be committed)');
    for (const path of untracked) lines.push(`\t${path}`);
  }
  lines.push("");
  if (staged.length === 0) {
    if (unstaged.length) lines.push('no changes added to commit (use "git add" and/or "git commit -a")');
    else if (untracked.length) lines.push('nothing added to commit but untracked files present (use "git add" to track)');
    else lines.push(repo.branches.get(repo.head) === null ? 'nothing to commit (create/copy files and use "git add" to track)' : "nothing to commit, working tree clean");
  }
  ctx.out(`${lines.join("\n").trimEnd()}\n`);
  return 0;
}

function add(ctx: Ctx, root: string, repo: GitRepo, args: string[]): number {
  const parsed = parseArgs(args, { flags: ["-A", "--all"] });
  if (parsed.unknown) {
    ctx.err(`error: unknown option '${parsed.unknown}'`);
    return 129;
  }
  const all = parsed.flags.size > 0;
  if (!all && parsed.positional.length === 0) {
    ctx.err("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?");
    return 0;
  }
  const working = workingFiles(ctx.state, root);
  const targets = all ? [""] : [];
  for (const arg of parsed.positional) {
    const rel = relative(ctx.state, root, arg);
    if (rel === null) {
      ctx.err(`fatal: ${arg}: '${arg}' is outside repository at '${root}'`);
      return 128;
    }
    targets.push(rel);
  }
  // Validate everything first so a bad path stages nothing, as git does.
  const under = (path: string, target: string) => target === "" || path === target || path.startsWith(`${target}/`);
  for (const [i, target] of targets.entries()) {
    const known = [...working.keys(), ...repo.index.keys()].some((p) => under(p, target));
    if (!known && target !== "") {
      ctx.err(`fatal: pathspec '${parsed.positional[all ? i - 1 : i]}' did not match any files`);
      return 128;
    }
  }
  for (const target of targets) {
    for (const path of [...repo.index.keys()]) if (under(path, target) && !working.has(path)) repo.index.delete(path);
    for (const [path, content] of working) if (under(path, target)) repo.index.set(path, content);
  }
  return 0;
}

function commit(ctx: Ctx, root: string, repo: GitRepo, args: string[]): number {
  const parsed = parseArgs(args, { options: ["-m", "--message", "-am"], flags: ["-a", "--all"] });
  if (parsed.unknown || parsed.positional.length) {
    ctx.err(`error: 不支援的參數 '${parsed.unknown ?? parsed.positional[0]}'`);
    return 129;
  }
  const message = parsed.options.get("-m") ?? parsed.options.get("--message") ?? parsed.options.get("-am");
  if (message === undefined) {
    ctx.err('這個模擬終端機沒有文字編輯器，請用 git commit -m "訊息" 直接寫上提交訊息。');
    return 1;
  }
  if (message.trim() === "") {
    ctx.err("Aborting commit due to empty commit message.");
    return 1;
  }
  const working = workingFiles(ctx.state, root);
  if (parsed.flags.size > 0 || parsed.options.has("-am")) {
    // -a stages changes to files git already tracks, never new files.
    for (const path of [...repo.index.keys()]) {
      if (working.has(path)) repo.index.set(path, working.get(path)!);
      else repo.index.delete(path);
    }
  }
  const tip = repo.branches.get(repo.head) ?? null;
  const changes = diff(branchFiles(repo, repo.head), repo.index);
  if (changes.length === 0) {
    const untracked = [...working.keys()].some((p) => !repo.index.has(p));
    const unstaged = diff(repo.index, working).some(([, c]) => c !== "new file");
    ctx.out(`On branch ${repo.head}\n`);
    ctx.out(
      unstaged
        ? 'no changes added to commit (use "git add" and/or "git commit -a")\n'
        : untracked
          ? 'nothing added to commit but untracked files present (use "git add" to track)\n'
          : "nothing to commit, working tree clean\n",
    );
    return 1;
  }
  const parents = tip ? [tip] : [];
  const id = commitId(repo, message, parents);
  repo.commits.set(id, { id, message, parents, files: new Map(repo.index) });
  repo.branches.set(repo.head, id);
  ctx.out(`[${repo.head}${tip ? "" : " (root-commit)"} ${id}] ${message}\n`);
  ctx.out(` ${changes.length} file${changes.length === 1 ? "" : "s"} changed\n`);
  return 0;
}

function log(ctx: Ctx, repo: GitRepo, args: string[]): number {
  const parsed = parseArgs(args, { flags: ["--oneline"] });
  if (parsed.unknown || parsed.positional.length) {
    ctx.err("這個模擬終端機的 git log 只支援 --oneline。");
    return 129;
  }
  const tip = repo.branches.get(repo.head) ?? null;
  if (!tip) {
    ctx.err(`fatal: your current branch '${repo.head}' does not have any commits yet`);
    return 128;
  }
  const decoration = (id: string) => {
    const names = [...repo.branches].filter(([, c]) => c === id).map(([name]) => name).sort();
    if (names.length === 0) return "";
    const current = names.includes(repo.head) ? [`HEAD -> ${repo.head}`] : [];
    return ` (${[...current, ...names.filter((n) => n !== repo.head)].join(", ")})`;
  };
  const commits = history(repo, tip);
  if (parsed.flags.has("--oneline")) {
    for (const c of commits) ctx.out(`${c.id}${decoration(c.id)} ${c.message}\n`);
  } else {
    ctx.out(
      commits
        .map((c) => `commit ${c.id}${decoration(c.id)}\nAuthor: learner <learner@example.com>\n\n    ${c.message}\n`)
        .join("\n"),
    );
  }
  return 0;
}

const validBranchName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.endsWith("/") && !name.includes("..");

function createBranch(ctx: Ctx, repo: GitRepo, name: string): boolean {
  if (!validBranchName(name)) ctx.err(`fatal: '${name}' is not a valid branch name`);
  else if (repo.branches.has(name)) ctx.err(`fatal: a branch named '${name}' already exists`);
  else if (repo.branches.get(repo.head) === null) ctx.err(`fatal: not a valid object name: '${repo.head}'`);
  else {
    repo.branches.set(name, repo.branches.get(repo.head)!);
    return true;
  }
  return false;
}

function branch(ctx: Ctx, repo: GitRepo, args: string[]): number {
  const parsed = parseArgs(args, { options: ["-d", "-D", "--delete"] });
  if (parsed.unknown) {
    ctx.err(`error: unknown option '${parsed.unknown}'`);
    return 129;
  }
  const toDelete = parsed.options.get("-d") ?? parsed.options.get("-D") ?? parsed.options.get("--delete");
  if (toDelete !== undefined) {
    if (!repo.branches.has(toDelete)) {
      ctx.err(`error: branch '${toDelete}' not found`);
      return 1;
    }
    if (toDelete === repo.head) {
      ctx.err(`error: cannot delete branch '${toDelete}' used by worktree`);
      return 1;
    }
    const tip = repo.branches.get(toDelete) ?? null;
    const merged = tip === null || history(repo, repo.branches.get(repo.head) ?? null).some((c) => c.id === tip);
    if (!merged && !parsed.options.has("-D")) {
      ctx.err(`error: the branch '${toDelete}' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D ${toDelete}'`);
      return 1;
    }
    repo.branches.delete(toDelete);
    ctx.out(`Deleted branch ${toDelete} (was ${tip ?? "no commits"}).\n`);
    return 0;
  }
  if (parsed.positional.length === 0) {
    for (const name of [...repo.branches.keys()].sort()) {
      // A branch with no commits is not listed, as in git.
      if (repo.branches.get(name) !== null) ctx.out(`${name === repo.head ? "*" : " "} ${name}\n`);
    }
    return 0;
  }
  if (parsed.positional.length > 1) {
    ctx.err("這個模擬終端機的 git branch 只支援：列出分支、git branch <名稱>、git branch -d <名稱>。");
    return 129;
  }
  return createBranch(ctx, repo, parsed.positional[0]) ? 0 : 128;
}

function switchBranch(ctx: Ctx, root: string, repo: GitRepo, cmd: "switch" | "checkout", args: string[]): number {
  const createFlag = cmd === "switch" ? "-c" : "-b";
  const parsed = parseArgs(args, { options: [createFlag, ...(cmd === "switch" ? ["--create"] : [])] });
  const createName = parsed.options.get(createFlag) ?? parsed.options.get("--create");
  if (parsed.unknown || parsed.positional.length + (createName === undefined ? 0 : 1) !== 1) {
    ctx.err(`usage: git ${cmd} <分支> 或 git ${cmd} ${createFlag} <新分支>`);
    return 129;
  }
  if (createName !== undefined) {
    if (repo.branches.get(repo.head) === null) {
      // No commits yet: the unborn branch is simply renamed.
      if (!validBranchName(createName)) {
        ctx.err(`fatal: '${createName}' is not a valid branch name`);
        return 128;
      }
      repo.branches.delete(repo.head);
      repo.branches.set(createName, null);
    } else if (!createBranch(ctx, repo, createName)) return 128;
    repo.head = createName;
    ctx.out(`Switched to a new branch '${createName}'\n`);
    return 0;
  }
  const target = parsed.positional[0];
  if (!repo.branches.has(target)) {
    ctx.err(cmd === "switch" ? `fatal: invalid reference: ${target}` : `error: pathspec '${target}' did not match any file(s) known to git`);
    return 1;
  }
  if (target === repo.head) {
    ctx.out(`Already on '${target}'\n`);
    return 0;
  }
  const from = branchFiles(repo, repo.head);
  const to = branchFiles(repo, target);
  const working = workingFiles(ctx.state, root);
  // Simplification: local changes to tracked files block a switch that would change any file.
  const dirty = [...diff(from, repo.index), ...diff(repo.index, working).filter(([, c]) => c !== "new file")];
  if (dirty.length && diff(from, to).length) {
    ctx.err(
      `error: Your local changes to the following files would be overwritten by checkout:\n${dirty.map(([p]) => `\t${p}`).join("\n")}\nPlease commit your changes before you switch branches.\nAborting`,
    );
    return 1;
  }
  const clash = [...to.keys()].find((p) => !from.has(p) && working.has(p) && working.get(p) !== to.get(p));
  if (clash) {
    ctx.err(`error: The following untracked working tree files would be overwritten by checkout:\n\t${clash}\nAborting`);
    return 1;
  }
  writeTree(ctx.state, root, from, to);
  if (dirty.length === 0) repo.index = new Map(to);
  repo.head = target;
  ctx.out(`Switched to branch '${target}'\n`);
  return 0;
}

function merge(ctx: Ctx, root: string, repo: GitRepo, args: string[]): number {
  if (args.length !== 1 || args[0].startsWith("-")) {
    ctx.err("usage: git merge <分支>");
    return 129;
  }
  const name = args[0];
  const theirs = repo.branches.get(name);
  if (theirs === undefined || theirs === null) {
    ctx.err(`merge: ${name} - not something we can merge`);
    return 1;
  }
  const ours = repo.branches.get(repo.head) ?? null;
  const ourHistory = history(repo, ours);
  if (ourHistory.some((c) => c.id === theirs)) {
    ctx.out("Already up to date.\n");
    return 0;
  }
  const working = workingFiles(ctx.state, root);
  const oursFiles = branchFiles(repo, repo.head);
  if (diff(oursFiles, repo.index).length || diff(repo.index, working).some(([, c]) => c !== "new file")) {
    ctx.err("error: 你有尚未提交的變更，請先提交再合併。");
    return 1;
  }
  const theirsFiles = repo.commits.get(theirs)!.files;
  const theirHistory = history(repo, theirs);

  if (ours === null || theirHistory.some((c) => c.id === ours)) {
    writeTree(ctx.state, root, oursFiles, theirsFiles);
    repo.index = new Map(theirsFiles);
    repo.branches.set(repo.head, theirs);
    ctx.out(`Updating ${ours ?? "0000000"}..${theirs}\nFast-forward\n`);
    return 0;
  }

  // Three-way merge against the newest common ancestor.
  const ourIds = new Set(ourHistory.map((c) => c.id));
  const base = theirHistory.find((c) => ourIds.has(c.id))?.files ?? new Map<string, string>();
  const merged = new Map<string, string>();
  const conflicts: string[] = [];
  for (const path of new Set([...oursFiles.keys(), ...theirsFiles.keys(), ...base.keys()])) {
    const [b, o, t] = [base.get(path), oursFiles.get(path), theirsFiles.get(path)];
    const result = o === t ? o : o === b ? t : t === b ? o : null;
    if (result === null) conflicts.push(path);
    else if (result !== undefined) merged.set(path, result);
  }
  if (conflicts.length) {
    ctx.err(
      `CONFLICT: 兩個分支都修改了 ${conflicts.sort().join("、")}。\n這個模擬終端機不支援解決合併衝突，合併已取消，檔案沒有變動。`,
    );
    return 1;
  }
  const message = `Merge branch '${name}'${repo.head === "main" ? "" : ` into ${repo.head}`}`;
  const id = commitId(repo, message, [ours, theirs]);
  repo.commits.set(id, { id, message, parents: [ours, theirs], files: merged });
  repo.branches.set(repo.head, id);
  writeTree(ctx.state, root, oursFiles, merged);
  repo.index = new Map(merged);
  ctx.out("Merge made by the 'ort' strategy.\n");
  return 0;
}

export const git: Command = (ctx, args) => {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    ctx.err(`usage: git <command> [<args>]\n${SUPPORTED}`);
    return 1;
  }
  if (sub === "--version" || sub === "version") {
    ctx.out("git version 2 (模擬終端機)\n");
    return 0;
  }
  if (sub === "init") return init(ctx, rest);
  // Identity setup is a common first step in tutorials; accept it and move on.
  if (sub === "config") return 0;
  if (["clone", "remote", "push", "pull", "fetch"].includes(sub)) {
    ctx.err(NO_REMOTE);
    return 1;
  }

  const found = findRepo(ctx.state);
  const needsRepo = ["status", "add", "commit", "log", "branch", "switch", "checkout", "merge"];
  if (!needsRepo.includes(sub)) {
    ctx.err(`git: 不支援的指令 '${sub}'。${SUPPORTED}`);
    return 1;
  }
  if (!found) {
    ctx.err(NOT_A_REPO);
    return 128;
  }
  const { root, repo } = found;
  switch (sub) {
    case "status":
      return status(ctx, root, repo);
    case "add":
      return add(ctx, root, repo, rest);
    case "commit":
      return commit(ctx, root, repo, rest);
    case "log":
      return log(ctx, repo, rest);
    case "branch":
      return branch(ctx, repo, rest);
    case "switch":
    case "checkout":
      return switchBranch(ctx, root, repo, sub, rest);
    default:
      return merge(ctx, root, repo, rest);
  }
};
