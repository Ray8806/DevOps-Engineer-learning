import type { LabState } from "./state";

/** What a command implementation gets: a mutable draft state and output sinks. */
export interface Ctx {
  state: LabState;
  out(text: string): void;
  err(text: string): void;
}

/** A command returns its exit code: 0 for success. */
export type Command = (ctx: Ctx, args: string[]) => number;

export interface ParsedArgs {
  flags: Set<string>;
  options: Map<string, string>;
  positional: string[];
  /** First argument that looked like an option but is not known. */
  unknown?: string;
}

/**
 * Splits arguments into flags, valued options and positionals.
 * Valued options accept both `--name value` and `--name=value`.
 * `shortFlags` lists single letters that may be combined (`-rf`).
 */
export function parseArgs(
  args: string[],
  spec: { flags?: string[]; options?: string[]; shortFlags?: string },
): ParsedArgs {
  const result: ParsedArgs = { flags: new Set(), options: new Map(), positional: [] };
  const flags = new Set(spec.flags ?? []);
  const options = new Set(spec.options ?? []);
  const short = spec.shortFlags ?? "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      result.positional.push(...args.slice(i + 1));
      break;
    }
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
    if (flags.has(name) && eq === -1) {
      result.flags.add(name);
    } else if (options.has(name)) {
      const value = arg.startsWith("--") && eq !== -1 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined) result.unknown ??= arg;
      else result.options.set(name, value);
    } else if (/^-[A-Za-z0-9]+$/.test(arg) && [...arg.slice(1)].every((ch) => short.includes(ch))) {
      for (const ch of arg.slice(1)) result.flags.add(`-${ch}`);
    } else if (arg.startsWith("-") && arg.length > 1) {
      result.unknown ??= arg;
    } else {
      result.positional.push(arg);
    }
  }
  return result;
}
