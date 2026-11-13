import { parseArgs, type Command, type Ctx } from "./context";
import { HOME, addDirWithParents, basename, dirname, isWithin, listDir, resolvePath, type LabState } from "./state";

const isDir = (s: LabState, p: string) => s.dirs.has(p);
const isFile = (s: LabState, p: string) => s.files.has(p);
const exists = (s: LabState, p: string) => isDir(s, p) || isFile(s, p);
const byteLength = (text: string) => new TextEncoder().encode(text).length;

function usageError(ctx: Ctx, cmd: string, parsed: { unknown?: string }): boolean {
  if (!parsed.unknown) return false;
  ctx.err(`${cmd}: 不支援的選項 '${parsed.unknown}'`);
  return true;
}

const pwd: Command = (ctx) => {
  ctx.out(`${ctx.state.cwd}\n`);
  return 0;
};

const whoami: Command = (ctx) => {
  ctx.out("learner\n");
  return 0;
};

const cd: Command = (ctx, args) => {
  if (args.length > 1) {
    ctx.err("bash: cd: too many arguments");
    return 1;
  }
  const target = resolvePath(ctx.state.cwd, args[0] ?? "~");
  if (isFile(ctx.state, target)) {
    ctx.err(`bash: cd: ${args[0]}: Not a directory`);
    return 1;
  }
  if (!isDir(ctx.state, target)) {
    ctx.err(`bash: cd: ${args[0]}: No such file or directory`);
    return 1;
  }
  ctx.state.cwd = target;
  return 0;
};

const ls: Command = (ctx, args) => {
  const parsed = parseArgs(args, { shortFlags: "la1" });
  if (usageError(ctx, "ls", parsed)) return 2;
  const long = parsed.flags.has("-l");
  const all = parsed.flags.has("-a");
  const onePerLine = long || parsed.flags.has("-1");
  const targets = parsed.positional.length ? parsed.positional : ["."];
  let code = 0;

  const line = (name: string, abs: string, dir: boolean) =>
    long
      ? `${dir ? "drwxr-xr-x" : "-rw-r--r--"} learner ${String(dir ? 4096 : byteLength(ctx.state.files.get(abs) ?? "")).padStart(5)} ${name}${dir ? "/" : ""}`
      : `${name}${dir ? "/" : ""}`;

  const sections: string[] = [];
  for (const target of targets) {
    const abs = resolvePath(ctx.state.cwd, target);
    if (isFile(ctx.state, abs)) {
      sections.push(line(target, abs, false));
    } else if (isDir(ctx.state, abs)) {
      const entries = listDir(ctx.state, abs).filter(([name]) => all || !name.startsWith("."));
      const lines = entries.map(([name, dir]) => line(name, `${abs === "/" ? "" : abs}/${name}`, dir));
      const body = onePerLine ? lines.join("\n") : lines.join("  ");
      sections.push(targets.length > 1 ? `${target}:\n${body}`.trimEnd() : body);
    } else {
      ctx.err(`ls: cannot access '${target}': No such file or directory`);
      code = 2;
    }
  }
  const text = sections.filter((s) => s !== "").join(targets.length > 1 ? "\n\n" : "\n");
  if (text) ctx.out(`${text}\n`);
  return code;
};

const mkdir: Command = (ctx, args) => {
  const parsed = parseArgs(args, { shortFlags: "p" });
  if (usageError(ctx, "mkdir", parsed)) return 1;
  if (parsed.positional.length === 0) {
    ctx.err("mkdir: missing operand");
    return 1;
  }
  let code = 0;
  for (const target of parsed.positional) {
    const abs = resolvePath(ctx.state.cwd, target);
    const parents = parsed.flags.has("-p");
    if (isFile(ctx.state, abs) || (isDir(ctx.state, abs) && !parents)) {
      ctx.err(`mkdir: cannot create directory '${target}': File exists`);
      code = 1;
    } else if (parents) {
      // Every ancestor must be free of files.
      let blocked = false;
      for (let d = abs; d !== "/"; d = dirname(d)) blocked ||= isFile(ctx.state, d);
      if (blocked) {
        ctx.err(`mkdir: cannot create directory '${target}': Not a directory`);
        code = 1;
      } else addDirWithParents(ctx.state.dirs, abs);
    } else if (!isDir(ctx.state, dirname(abs))) {
      ctx.err(`mkdir: cannot create directory '${target}': No such file or directory`);
      code = 1;
    } else {
      ctx.state.dirs.add(abs);
    }
  }
  return code;
};

const touch: Command = (ctx, args) => {
  if (args.length === 0) {
    ctx.err("touch: missing file operand");
    return 1;
  }
  let code = 0;
  for (const target of args) {
    const abs = resolvePath(ctx.state.cwd, target);
    if (exists(ctx.state, abs)) continue;
    if (!isDir(ctx.state, dirname(abs))) {
      ctx.err(`touch: cannot touch '${target}': No such file or directory`);
      code = 1;
    } else ctx.state.files.set(abs, "");
  }
  return code;
};

const cat: Command = (ctx, args) => {
  if (args.length === 0) {
    ctx.err("cat: 這個模擬終端機需要指定檔名");
    return 1;
  }
  let code = 0;
  for (const target of args) {
    const abs = resolvePath(ctx.state.cwd, target);
    if (isDir(ctx.state, abs)) {
      ctx.err(`cat: ${target}: Is a directory`);
      code = 1;
    } else if (!isFile(ctx.state, abs)) {
      ctx.err(`cat: ${target}: No such file or directory`);
      code = 1;
    } else ctx.out(ctx.state.files.get(abs)!);
  }
  return code;
};

const echo: Command = (ctx, args) => {
  const noNewline = args[0] === "-n";
  ctx.out((noNewline ? args.slice(1) : args).join(" ") + (noNewline ? "" : "\n"));
  return 0;
};

/** Files and directories at or below `abs`, as paths relative to it ("" = itself). */
function subtree(state: LabState, abs: string): { dirs: string[]; files: string[] } {
  return {
    dirs: [...state.dirs].filter((d) => isWithin(d, abs)).map((d) => d.slice(abs.length)),
    files: [...state.files.keys()].filter((f) => isWithin(f, abs)).map((f) => f.slice(abs.length)),
  };
}

/** Shared by cp and mv: copies `src` to `dst`, optionally removing the source. */
function copyOrMove(ctx: Ctx, cmd: "cp" | "mv", args: string[]): number {
  const parsed = parseArgs(args, { shortFlags: cmd === "cp" ? "rR" : "" });
  if (usageError(ctx, cmd, parsed)) return 1;
  const recursive = cmd === "mv" || parsed.flags.has("-r") || parsed.flags.has("-R");
  const operands = parsed.positional;
  if (operands.length < 2) {
    ctx.err(operands.length === 0 ? `${cmd}: missing file operand` : `${cmd}: missing destination file operand after '${operands[0]}'`);
    return 1;
  }
  const { state } = ctx;
  const destArg = operands[operands.length - 1];
  const dest = resolvePath(state.cwd, destArg);
  const sources = operands.slice(0, -1);
  if (sources.length > 1 && !isDir(state, dest)) {
    ctx.err(`${cmd}: target '${destArg}' is not a directory`);
    return 1;
  }

  let code = 0;
  for (const srcArg of sources) {
    const src = resolvePath(state.cwd, srcArg);
    const target = isDir(state, dest) ? `${dest === "/" ? "" : dest}/${basename(src)}` : dest;
    const fail = (message: string) => {
      ctx.err(message);
      code = 1;
    };

    if (!exists(state, src)) fail(`${cmd}: cannot stat '${srcArg}': No such file or directory`);
    else if (src === target) fail(`${cmd}: '${srcArg}' and '${destArg}' are the same file`);
    else if (!isDir(state, dirname(target))) fail(`${cmd}: cannot create '${destArg}': No such file or directory`);
    else if (isFile(state, src)) {
      if (isDir(state, target)) fail(`${cmd}: cannot overwrite directory '${destArg}' with non-directory`);
      else {
        state.files.set(target, state.files.get(src)!);
        if (cmd === "mv") state.files.delete(src);
      }
    } else if (!recursive) fail(`cp: -r not specified; omitting directory '${srcArg}'`);
    else if (isWithin(target, src)) fail(`${cmd}: cannot ${cmd === "cp" ? "copy" : "move"} a directory, '${srcArg}', into itself`);
    else if (isFile(state, target)) fail(`${cmd}: cannot overwrite non-directory '${destArg}' with directory '${srcArg}'`);
    else if (cmd === "mv" && isWithin(state.cwd, src)) fail(`mv: 無法移動目前所在的目錄 '${srcArg}'`);
    else {
      const tree = subtree(state, src);
      for (const d of tree.dirs) state.dirs.add(target + d);
      for (const f of tree.files) state.files.set(target + f, state.files.get(src + f)!);
      if (cmd === "mv") {
        for (const d of tree.dirs) state.dirs.delete(src + d);
        for (const f of tree.files) state.files.delete(src + f);
      }
    }
  }
  return code;
}

const cp: Command = (ctx, args) => copyOrMove(ctx, "cp", args);
const mv: Command = (ctx, args) => copyOrMove(ctx, "mv", args);

const rm: Command = (ctx, args) => {
  const parsed = parseArgs(args, { shortFlags: "rRf" });
  if (usageError(ctx, "rm", parsed)) return 1;
  const recursive = parsed.flags.has("-r") || parsed.flags.has("-R");
  const force = parsed.flags.has("-f");
  if (parsed.positional.length === 0) {
    if (force) return 0;
    ctx.err("rm: missing operand");
    return 1;
  }
  const { state } = ctx;
  let code = 0;
  for (const target of parsed.positional) {
    const abs = resolvePath(state.cwd, target);
    if (isFile(state, abs)) state.files.delete(abs);
    else if (!isDir(state, abs)) {
      if (!force) {
        ctx.err(`rm: cannot remove '${target}': No such file or directory`);
        code = 1;
      }
    } else if (!recursive) {
      ctx.err(`rm: cannot remove '${target}': Is a directory`);
      code = 1;
    } else if (isWithin(HOME, abs) || isWithin(state.cwd, abs)) {
      ctx.err(`rm: 為了讓練習能繼續，不能刪除家目錄或目前所在的目錄 '${target}'`);
      code = 1;
    } else {
      const tree = subtree(state, abs);
      for (const d of tree.dirs) state.dirs.delete(abs + d);
      for (const f of tree.files) state.files.delete(abs + f);
    }
  }
  return code;
};

const rmdir: Command = (ctx, args) => {
  if (args.length === 0) {
    ctx.err("rmdir: missing operand");
    return 1;
  }
  const { state } = ctx;
  let code = 0;
  for (const target of args) {
    const abs = resolvePath(state.cwd, target);
    const fail = (reason: string) => {
      ctx.err(`rmdir: failed to remove '${target}': ${reason}`);
      code = 1;
    };
    if (isFile(state, abs)) fail("Not a directory");
    else if (!isDir(state, abs)) fail("No such file or directory");
    else if (listDir(state, abs).length > 0) fail("Directory not empty");
    else if (isWithin(HOME, abs) || isWithin(state.cwd, abs)) fail("不能刪除家目錄或目前所在的目錄");
    else state.dirs.delete(abs);
  }
  return code;
};

export const linuxCommands: Record<string, Command> = { pwd, whoami, cd, ls, mkdir, touch, cat, echo, cp, mv, rm, rmdir };
