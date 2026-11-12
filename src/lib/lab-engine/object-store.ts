import type { Ctx } from "./context";
import { basename, dirname, displayPath, isWithin, resolvePath, type Bucket, type LabState } from "./state";

/** Fixed timestamp so simulated listings are deterministic. */
export const LISTING_TIME = "2026-01-01 09:00:00";

export const byteLength = (text: string) => new TextEncoder().encode(text).length;

export type Location =
  | { kind: "local"; arg: string }
  | { kind: "remote"; bucket: string; key: string; url: string };

/** Parses "s3://bucket/key" (or gs://). Anything else is a local path. */
export function parseLocation(arg: string, scheme: string): Location {
  const prefix = `${scheme}://`;
  if (!arg.startsWith(prefix)) return { kind: "local", arg };
  const rest = arg.slice(prefix.length);
  const slash = rest.indexOf("/");
  return slash === -1
    ? { kind: "remote", bucket: rest, key: "", url: arg }
    : { kind: "remote", bucket: rest.slice(0, slash), key: rest.slice(slash + 1), url: arg };
}

/**
 * Delimiter-style listing, as both clouds do it: keys under `prefix`, with
 * anything past the next "/" collapsed into a common prefix.
 */
export function listPrefix(bucket: Bucket, prefix: string): { prefixes: string[]; keys: string[] } {
  const prefixes = new Set<string>();
  const keys: string[] = [];
  for (const key of [...bucket.objects.keys()].sort()) {
    if (!key.startsWith(prefix)) continue;
    const slash = key.indexOf("/", prefix.length);
    if (slash === -1) keys.push(key);
    else prefixes.add(key.slice(0, slash + 1));
  }
  return { prefixes: [...prefixes], keys };
}

/** How one CLI words its transfer messages and errors. */
export interface TransferStyle {
  scheme: "s3" | "gs";
  buckets(state: LabState): Map<string, Bucket>;
  /** e.g. "upload: ./a.txt to s3://b/a.txt". `from`/`to` are already formatted. */
  done(kind: "upload" | "download" | "copy", move: boolean, from: string, to: string): string;
  localPath(state: LabState, abs: string): string;
  noBucket(bucket: string): string;
  noObject(bucket: string, key: string, url: string): string;
  noLocalFile(arg: string): string;
  localIsDirectory(arg: string): string;
  bothLocal(): string;
  unsupported(what: string): string;
}

/** `./x` when under the current directory, otherwise the display path. */
export function relativeToCwd(state: LabState, abs: string): string {
  if (isWithin(abs, state.cwd) && abs !== state.cwd) return `./${abs.slice(state.cwd === "/" ? 1 : state.cwd.length + 1)}`;
  return displayPath(abs);
}

/** Target key when copying `name` to a bucket root or a "folder/" key. */
const keyFor = (key: string, name: string) => (key === "" || key.endsWith("/") ? key + name : key);

/**
 * cp / mv between local files and buckets, in any direction.
 * `recursive` is supported for uploading a local directory.
 */
export function transfer(
  ctx: Ctx,
  style: TransferStyle,
  srcArg: string,
  dstArg: string,
  opts: { move: boolean; recursive: boolean },
): number {
  const { state } = ctx;
  const src = parseLocation(srcArg, style.scheme);
  const dst = parseLocation(dstArg, style.scheme);
  const buckets = style.buckets(state);
  const fail = (message: string) => {
    ctx.err(message);
    return 1;
  };

  if (src.kind === "local" && dst.kind === "local") return fail(style.bothLocal());

  if (dst.kind === "remote" && !buckets.has(dst.bucket)) return fail(style.noBucket(dst.bucket));
  if (src.kind === "remote" && !buckets.has(src.bucket)) return fail(style.noBucket(src.bucket));

  // ---- local -> bucket
  if (src.kind === "local" && dst.kind === "remote") {
    const abs = resolvePath(state.cwd, src.arg);
    const target = buckets.get(dst.bucket)!;
    if (state.dirs.has(abs)) {
      if (!opts.recursive) return fail(style.localIsDirectory(src.arg));
      const base = dst.key === "" || dst.key.endsWith("/") ? dst.key : `${dst.key}/`;
      const files = [...state.files.keys()].filter((f) => isWithin(f, abs)).sort();
      for (const file of files) {
        const key = base + file.slice(abs.length + (abs === "/" ? 0 : 1));
        target.objects.set(key, state.files.get(file)!);
        if (opts.move) state.files.delete(file);
        ctx.out(`${style.done("upload", opts.move, style.localPath(state, file), `${style.scheme}://${dst.bucket}/${key}`)}\n`);
      }
      return 0;
    }
    if (!state.files.has(abs)) return fail(style.noLocalFile(src.arg));
    const key = keyFor(dst.key, basename(abs));
    target.objects.set(key, state.files.get(abs)!);
    if (opts.move) state.files.delete(abs);
    ctx.out(`${style.done("upload", opts.move, style.localPath(state, abs), `${style.scheme}://${dst.bucket}/${key}`)}\n`);
    return 0;
  }

  if (src.kind !== "remote") return fail(style.bothLocal());
  const source = buckets.get(src.bucket)!;
  if (opts.recursive) return fail(style.unsupported("從 bucket 遞迴複製"));
  if (src.key === "" || !source.objects.has(src.key)) return fail(style.noObject(src.bucket, src.key, src.url));
  const content = source.objects.get(src.key)!;

  // ---- bucket -> local
  if (dst.kind === "local") {
    let abs = resolvePath(state.cwd, dst.arg);
    if (state.dirs.has(abs)) abs = `${abs === "/" ? "" : abs}/${basename(src.key)}`;
    else if (dst.arg.endsWith("/") || !state.dirs.has(dirname(abs))) return fail(style.noLocalFile(dst.arg));
    state.files.set(abs, content);
    if (opts.move) source.objects.delete(src.key);
    ctx.out(`${style.done("download", opts.move, src.url, style.localPath(state, abs))}\n`);
    return 0;
  }

  // ---- bucket -> bucket
  const key = keyFor(dst.key, basename(src.key));
  buckets.get(dst.bucket)!.objects.set(key, content);
  if (opts.move && !(src.bucket === dst.bucket && src.key === key)) source.objects.delete(src.key);
  ctx.out(`${style.done("copy", opts.move, src.url, `${style.scheme}://${dst.bucket}/${key}`)}\n`);
  return 0;
}
