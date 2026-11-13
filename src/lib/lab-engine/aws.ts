import { EC2_COMMANDS, ec2 } from "./aws-ec2";
import { IAM_COMMANDS, iam } from "./aws-iam";
import { parseArgs, type Command, type Ctx } from "./context";
import { LISTING_TIME, byteLength, listPrefix, parseLocation, relativeToCwd, transfer, type TransferStyle } from "./object-store";
import { DEFAULT_S3_REGION } from "./state";

const S3_SUPPORTED = "這個模擬終端機目前支援 aws s3 的 mb、rb、ls、cp、mv、rm。";
const SUPPORTED = `這個模擬終端機支援的 AWS 服務：s3（mb、rb、ls、cp、mv、rm）、iam（${IAM_COMMANDS}）、ec2（${EC2_COMMANDS}）。`;

const apiError = (code: string, operation: string, message: string) =>
  `An error occurred (${code}) when calling the ${operation} operation: ${message}`;
const NO_BUCKET = "The specified bucket does not exist";

const style: TransferStyle = {
  scheme: "s3",
  buckets: (state) => state.s3,
  done: (kind, move, from, to) => `${move ? "move" : kind}: ${from} to ${to}`,
  localPath: relativeToCwd,
  noBucket: (bucket) => `fatal error: ${apiError("NoSuchBucket", "PutObject", NO_BUCKET)} (s3://${bucket})`,
  noObject: (_bucket, key) => `fatal error: ${apiError("404", "HeadObject", `Key "${key}" does not exist`)}`,
  noLocalFile: (arg) => `The user-provided path ${arg} does not exist.`,
  localIsDirectory: (arg) => `upload failed: ${arg} 是目錄，要上傳整個目錄請加上 --recursive`,
  bothLocal: () => "usage: aws s3 cp <LocalPath> <S3Uri> or <S3Uri> <LocalPath> or <S3Uri> <S3Uri>",
  unsupported: (what) => `這個模擬終端機尚未支援${what}。`,
};

/** S3 bucket naming rules (the common subset). */
function bucketNameProblem(name: string): string | null {
  if (name.length < 3 || name.length > 63) return "Bucket name must be between 3 and 63 characters long";
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) {
    return "Bucket name can contain only lowercase letters, numbers, dots and hyphens, and must begin and end with a letter or number";
  }
  return null;
}

function bucketArg(ctx: Ctx, arg: string | undefined, usage: string): string | null {
  const loc = arg === undefined ? null : parseLocation(arg, "s3");
  if (!loc || loc.kind !== "remote" || loc.bucket === "" || loc.key.replace(/\/$/, "") !== "") {
    ctx.err(`usage: ${usage}`);
    return null;
  }
  return loc.bucket;
}

function s3(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  const parsed = parseArgs(rest, { flags: ["--recursive", "--force"], options: ["--region"] });
  if (parsed.unknown) {
    ctx.err(`Unknown options: ${parsed.unknown}`);
    return 252;
  }
  const { positional, flags } = parsed;
  const buckets = ctx.state.s3;

  switch (sub) {
    case "mb": {
      const name = bucketArg(ctx, positional[0], "aws s3 mb <S3Uri>");
      if (name === null) return 252;
      const fail = (reason: string) => {
        ctx.err(`make_bucket failed: s3://${name} ${reason}`);
        return 1;
      };
      const problem = bucketNameProblem(name);
      if (problem) return fail(apiError("InvalidBucketName", "CreateBucket", problem));
      if (buckets.has(name)) {
        return fail(
          apiError("BucketAlreadyOwnedByYou", "CreateBucket", "Your previous request to create the named bucket succeeded and you already own it."),
        );
      }
      const region = (parsed.options.get("--region") ?? DEFAULT_S3_REGION).toLowerCase();
      buckets.set(name, { location: region, storageClass: "STANDARD", objects: new Map() });
      ctx.out(`make_bucket: ${name}\n`);
      return 0;
    }

    case "rb": {
      const name = bucketArg(ctx, positional[0], "aws s3 rb <S3Uri>");
      if (name === null) return 252;
      const bucket = buckets.get(name);
      const fail = (reason: string) => {
        ctx.err(`remove_bucket failed: s3://${name} ${reason}`);
        return 1;
      };
      if (!bucket) return fail(apiError("NoSuchBucket", "DeleteBucket", NO_BUCKET));
      if (bucket.objects.size > 0) {
        if (!flags.has("--force")) return fail(apiError("BucketNotEmpty", "DeleteBucket", "The bucket you tried to delete is not empty"));
        for (const key of [...bucket.objects.keys()].sort()) ctx.out(`delete: s3://${name}/${key}\n`);
      }
      buckets.delete(name);
      ctx.out(`remove_bucket: ${name}\n`);
      return 0;
    }

    case "ls": {
      if (positional.length === 0) {
        for (const name of [...buckets.keys()].sort()) ctx.out(`${LISTING_TIME} ${name}\n`);
        return 0;
      }
      const loc = parseLocation(positional[0], "s3");
      if (loc.kind !== "remote" || loc.bucket === "") {
        ctx.err("usage: aws s3 ls [<S3Uri>]");
        return 252;
      }
      const bucket = buckets.get(loc.bucket);
      if (!bucket) {
        ctx.err(apiError("NoSuchBucket", "ListObjectsV2", NO_BUCKET));
        return 254;
      }
      const row = (key: string, shown: string) => `${LISTING_TIME} ${String(byteLength(bucket.objects.get(key)!)).padStart(10)} ${shown}\n`;
      if (flags.has("--recursive")) {
        const keys = [...bucket.objects.keys()].filter((k) => k.startsWith(loc.key)).sort();
        for (const key of keys) ctx.out(row(key, key));
        return keys.length || loc.key === "" ? 0 : 1;
      }
      const dir = loc.key.slice(0, loc.key.lastIndexOf("/") + 1);
      const listing = listPrefix(bucket, loc.key);
      for (const p of listing.prefixes) ctx.out(`${" ".repeat(27)}PRE ${p.slice(dir.length)}\n`);
      for (const key of listing.keys) ctx.out(row(key, key.slice(dir.length)));
      return listing.prefixes.length + listing.keys.length > 0 || loc.key === "" ? 0 : 1;
    }

    case "cp":
    case "mv": {
      if (positional.length !== 2) {
        ctx.err(`usage: aws s3 ${sub} <LocalPath> <S3Uri> or <S3Uri> <LocalPath> or <S3Uri> <S3Uri>`);
        return 252;
      }
      return transfer(ctx, style, positional[0], positional[1], { move: sub === "mv", recursive: flags.has("--recursive") });
    }

    case "rm": {
      const loc = positional.length === 1 ? parseLocation(positional[0], "s3") : null;
      if (!loc || loc.kind !== "remote" || loc.bucket === "") {
        ctx.err("usage: aws s3 rm <S3Uri>");
        return 252;
      }
      const bucket = buckets.get(loc.bucket);
      if (!bucket) {
        ctx.err(`fatal error: ${apiError("NoSuchBucket", "ListObjectsV2", NO_BUCKET)}`);
        return 1;
      }
      if (flags.has("--recursive")) {
        for (const key of [...bucket.objects.keys()].filter((k) => k.startsWith(loc.key)).sort()) {
          bucket.objects.delete(key);
          ctx.out(`delete: s3://${loc.bucket}/${key}\n`);
        }
        return 0;
      }
      if (loc.key === "") {
        ctx.err("usage: aws s3 rm <S3Uri>（要刪除整個 bucket 的內容請加上 --recursive）");
        return 252;
      }
      // S3 deletes are idempotent: removing a missing key still reports success.
      bucket.objects.delete(loc.key);
      ctx.out(`delete: s3://${loc.bucket}/${loc.key}\n`);
      return 0;
    }

    default:
      ctx.err(sub ? `aws: 不支援的 s3 指令 '${sub}'。${S3_SUPPORTED}` : `usage: aws s3 <command> [parameters]\n${S3_SUPPORTED}`);
      return 252;
  }
}

export const aws: Command = (ctx, args) => {
  if (args[0] === "--version") {
    ctx.out("aws-cli/2 (模擬終端機)\n");
    return 0;
  }
  if (args[0] === "s3") return s3(ctx, args.slice(1));
  if (args[0] === "iam") return iam(ctx, args.slice(1));
  if (args[0] === "ec2") return ec2(ctx, args.slice(1));
  ctx.err(args[0] ? `aws: 不支援的服務 '${args[0]}'。${SUPPORTED}` : `usage: aws <service> <command> [parameters]\n${SUPPORTED}`);
  return 252;
};
