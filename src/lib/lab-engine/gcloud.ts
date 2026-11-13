import { parseArgs, type Command, type Ctx } from "./context";
import { byteLength, listPrefix, parseLocation, transfer, type TransferStyle } from "./object-store";
import { DEFAULT_GCS_LOCATION, displayPath, type Bucket } from "./state";

const SUPPORTED =
  "這個模擬終端機目前支援 gcloud storage 的 buckets create／delete／list／describe，以及 ls、cp、mv、rm、cat。";

const style = (command: string): TransferStyle => ({
  scheme: "gs",
  buckets: (state) => state.gcs,
  done: (_kind, _move, from, to) => `Copying ${from} to ${to}`,
  localPath: (_state, abs) => `file://${displayPath(abs)}`,
  noBucket: (bucket) => `ERROR: (${command}) gs://${bucket} not found: 404.`,
  noObject: (_bucket, _key, url) => `ERROR: (${command}) The following URLs matched no objects or files:\n  ${url}`,
  noLocalFile: (arg) => `ERROR: (${command}) The following URLs matched no objects or files:\n  ${arg}`,
  localIsDirectory: (arg) => `ERROR: (${command}) ${arg} 是目錄，要上傳整個目錄請加上 --recursive`,
  bothLocal: () => `ERROR: (${command}) 來源或目的地至少要有一個是 gs:// 開頭的位置`,
  unsupported: (what) => `這個模擬終端機尚未支援${what}。`,
});

/** Cloud Storage bucket naming rules (the common subset). */
function bucketNameProblem(name: string): string | null {
  if (name.length < 3 || name.length > 63) return "Bucket names must contain 3-63 characters.";
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(name)) {
    return "Bucket names may only contain lowercase letters, numbers, dashes, underscores and dots, and must start and end with a letter or number.";
  }
  return null;
}

const STORAGE_CLASSES = ["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"];

function requireBucket(ctx: Ctx, command: string, arg: string | undefined): { name: string; bucket: Bucket } | null {
  const loc = arg === undefined ? null : parseLocation(arg, "gs");
  if (!loc || loc.kind !== "remote" || loc.bucket === "" || loc.key.replace(/\/$/, "") !== "") {
    ctx.err(`ERROR: (${command}) 請指定 bucket，例如 gs://my-bucket`);
    return null;
  }
  const bucket = ctx.state.gcs.get(loc.bucket);
  if (!bucket) {
    ctx.err(`ERROR: (${command}) gs://${loc.bucket} not found: 404.`);
    return null;
  }
  return { name: loc.bucket, bucket };
}

function createBucket(ctx: Ctx, command: string, arg: string | undefined, location?: string, storageClass?: string): number {
  const fail = (message: string) => {
    ctx.err(`ERROR: (${command}) ${message}`);
    return 1;
  };
  const loc = arg === undefined ? null : parseLocation(arg, "gs");
  if (!loc || loc.kind !== "remote" || loc.bucket === "" || loc.key.replace(/\/$/, "") !== "") {
    return fail("請指定要建立的 bucket，例如 gs://my-bucket");
  }
  const problem = bucketNameProblem(loc.bucket);
  if (problem) return fail(`HTTPError 400: ${problem}`);
  if (ctx.state.gcs.has(loc.bucket)) {
    return fail("HTTPError 409: Your previous request to create the named bucket succeeded and you already own it.");
  }
  const cls = (storageClass ?? "STANDARD").toUpperCase();
  if (!STORAGE_CLASSES.includes(cls)) return fail(`HTTPError 400: Invalid storage class: ${storageClass}`);
  const where = (location ?? DEFAULT_GCS_LOCATION).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(where)) return fail(`HTTPError 400: Invalid location: ${location}`);
  ctx.state.gcs.set(loc.bucket, { location: where, storageClass: cls, objects: new Map() });
  ctx.out(`Creating gs://${loc.bucket}/...\n`);
  return 0;
}

function deleteBucket(ctx: Ctx, command: string, arg: string | undefined): number {
  const found = requireBucket(ctx, command, arg);
  if (!found) return 1;
  if (found.bucket.objects.size > 0) {
    ctx.err(`ERROR: (${command}) HTTPError 409: The bucket you tried to delete is not empty.`);
    return 1;
  }
  ctx.state.gcs.delete(found.name);
  ctx.out(`Removing gs://${found.name}/...\n`);
  return 0;
}

function list(ctx: Ctx, command: string, arg: string | undefined, long: boolean): number {
  const buckets = ctx.state.gcs;
  if (arg === undefined) {
    for (const name of [...buckets.keys()].sort()) ctx.out(`gs://${name}/\n`);
    return 0;
  }
  const loc = parseLocation(arg, "gs");
  const bucket = loc.kind === "remote" ? buckets.get(loc.bucket) : undefined;
  if (loc.kind !== "remote" || !bucket) {
    ctx.err(`ERROR: (${command}) ${arg} not found: 404.`);
    return 1;
  }
  const row = (key: string) =>
    long ? `${String(byteLength(bucket.objects.get(key)!)).padStart(10)}  gs://${loc.bucket}/${key}\n` : `gs://${loc.bucket}/${key}\n`;
  // An exact object name lists just that object; a "folder" lists its contents.
  if (loc.key !== "" && bucket.objects.has(loc.key)) {
    ctx.out(row(loc.key));
    return 0;
  }
  const prefix = loc.key === "" || loc.key.endsWith("/") ? loc.key : `${loc.key}/`;
  const listing = listPrefix(bucket, prefix);
  if (prefix !== "" && listing.keys.length + listing.prefixes.length === 0) {
    ctx.err(`ERROR: (${command}) One or more URLs matched no objects.`);
    return 1;
  }
  for (const key of listing.keys) ctx.out(row(key));
  for (const p of listing.prefixes) ctx.out(`${long ? " ".repeat(12) : ""}gs://${loc.bucket}/${p}\n`);
  return 0;
}

function remove(ctx: Ctx, command: string, args: string[], recursive: boolean): number {
  if (args.length === 0) {
    ctx.err(`ERROR: (${command}) 請指定要刪除的物件，例如 gs://my-bucket/file.txt`);
    return 1;
  }
  let code = 0;
  for (const arg of args) {
    const loc = parseLocation(arg, "gs");
    const bucket = loc.kind === "remote" ? ctx.state.gcs.get(loc.bucket) : undefined;
    if (loc.kind !== "remote" || !bucket) {
      ctx.err(`ERROR: (${command}) ${arg} not found: 404.`);
      code = 1;
      continue;
    }
    const prefix = loc.key === "" || loc.key.endsWith("/") ? loc.key : `${loc.key}/`;
    const targets = bucket.objects.has(loc.key)
      ? [loc.key]
      : recursive
        ? [...bucket.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
        : [];
    const wholeBucket = recursive && loc.key.replace(/\/$/, "") === "";
    if (targets.length === 0 && !wholeBucket) {
      ctx.err(`ERROR: (${command}) The following URLs matched no objects or files:\n  ${arg}`);
      code = 1;
      continue;
    }
    for (const key of targets) {
      bucket.objects.delete(key);
      ctx.out(`Removing gs://${loc.bucket}/${key}...\n`);
    }
    if (wholeBucket) {
      ctx.state.gcs.delete(loc.bucket);
      ctx.out(`Removing gs://${loc.bucket}/...\n`);
    }
  }
  return code;
}

function catObjects(ctx: Ctx, command: string, args: string[]): number {
  if (args.length === 0) {
    ctx.err(`ERROR: (${command}) 請指定要讀取的物件`);
    return 1;
  }
  let code = 0;
  for (const arg of args) {
    const loc = parseLocation(arg, "gs");
    const content = loc.kind === "remote" ? ctx.state.gcs.get(loc.bucket)?.objects.get(loc.key) : undefined;
    if (content === undefined) {
      ctx.err(`ERROR: (${command}) The following URLs matched no objects or files:\n  ${arg}`);
      code = 1;
    } else ctx.out(content);
  }
  return code;
}

function storage(ctx: Ctx, args: string[]): number {
  const [group, ...rest] = args;

  if (group === "buckets") {
    const [action, ...actionArgs] = rest;
    const command = `gcloud.storage.buckets.${action}`;
    const use = parseArgs(actionArgs, {
      flags: ["--uniform-bucket-level-access", "--no-uniform-bucket-level-access", "--public-access-prevention", "--quiet", "-q"],
      options: ["--location", "-l", "--default-storage-class", "-c", "--project"],
    });
    if (use.unknown) {
      ctx.err(`ERROR: (${command}) unrecognized arguments: ${use.unknown}`);
      return 2;
    }
    switch (action) {
      case "create":
        return createBucket(
          ctx,
          command,
          use.positional[0],
          use.options.get("--location") ?? use.options.get("-l"),
          use.options.get("--default-storage-class") ?? use.options.get("-c"),
        );
      case "delete":
        return deleteBucket(ctx, command, use.positional[0]);
      case "list":
        for (const [name, b] of [...ctx.state.gcs].sort(([a], [b2]) => (a < b2 ? -1 : 1))) {
          ctx.out(`gs://${name}/  ${b.location.toUpperCase()}  ${b.storageClass}\n`);
        }
        return 0;
      case "describe": {
        const found = requireBucket(ctx, command, use.positional[0]);
        if (!found) return 1;
        ctx.out(
          `location: ${found.bucket.location.toUpperCase()}\nname: ${found.name}\nstorage_class: ${found.bucket.storageClass}\nstorage_url: gs://${found.name}/\n`,
        );
        return 0;
      }
      default:
        ctx.err(`ERROR: (gcloud.storage.buckets) 不支援的指令 '${action ?? ""}'。${SUPPORTED}`);
        return 2;
    }
  }

  const command = `gcloud.storage.${group}`;
  const parsed = parseArgs(rest, { flags: ["--recursive", "--long", "--quiet"], shortFlags: "rRlq" });
  if (parsed.unknown) {
    ctx.err(`ERROR: (${command}) unrecognized arguments: ${parsed.unknown}`);
    return 2;
  }
  const recursive = parsed.flags.has("--recursive") || parsed.flags.has("-r") || parsed.flags.has("-R");
  const { positional } = parsed;

  switch (group) {
    case "ls":
      return list(ctx, command, positional[0], parsed.flags.has("--long") || parsed.flags.has("-l"));
    case "cp":
    case "mv":
      if (positional.length !== 2) {
        ctx.err(`ERROR: (${command}) 需要來源和目的地兩個參數`);
        return 2;
      }
      return transfer(ctx, style(command), positional[0], positional[1], { move: group === "mv", recursive });
    case "rm":
      return remove(ctx, command, positional, recursive);
    case "cat":
      return catObjects(ctx, command, positional);
    default:
      ctx.err(`ERROR: (gcloud.storage) 不支援的指令 '${group ?? ""}'。${SUPPORTED}`);
      return 2;
  }
}

export const gcloud: Command = (ctx, args) => {
  if (args[0] === "--version" || args[0] === "version") {
    ctx.out("Google Cloud SDK (模擬終端機)\n");
    return 0;
  }
  if (args[0] === "storage") return storage(ctx, args.slice(1));
  ctx.err(`ERROR: (gcloud) 不支援 '${args[0] ?? ""}'。${SUPPORTED}`);
  return 2;
};

/** The older CLI, mapped onto the same operations. */
export const gsutil: Command = (ctx, args) => {
  const [sub, ...rest] = args;
  const command = `gsutil ${sub}`;
  switch (sub) {
    case "mb": {
      const parsed = parseArgs(rest, { options: ["-l", "-c", "-p"] });
      if (parsed.unknown) break;
      return createBucket(ctx, command, parsed.positional[0], parsed.options.get("-l"), parsed.options.get("-c"));
    }
    case "rb":
      return deleteBucket(ctx, command, rest[0]);
    case "ls": {
      const parsed = parseArgs(rest, { shortFlags: "l" });
      if (parsed.unknown) break;
      return list(ctx, command, parsed.positional[0], parsed.flags.has("-l"));
    }
    case "cp":
    case "mv": {
      const parsed = parseArgs(rest, { shortFlags: "rR" });
      if (parsed.unknown || parsed.positional.length !== 2) break;
      return transfer(ctx, style(command), parsed.positional[0], parsed.positional[1], {
        move: sub === "mv",
        recursive: parsed.flags.size > 0,
      });
    }
    case "rm": {
      const parsed = parseArgs(rest, { shortFlags: "rRf" });
      if (parsed.unknown) break;
      return remove(ctx, command, parsed.positional, parsed.flags.has("-r") || parsed.flags.has("-R"));
    }
    case "cat":
      return catObjects(ctx, command, rest);
    case "version":
      ctx.out("gsutil (模擬終端機)\n");
      return 0;
  }
  ctx.err("gsutil: 這個模擬終端機支援 gsutil 的 mb、rb、ls、cp、mv、rm、cat。建議改用較新的 gcloud storage。");
  return 1;
};
