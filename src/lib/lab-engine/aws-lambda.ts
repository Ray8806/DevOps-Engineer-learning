import { decodeArchive } from "./archive";
import { roleArn } from "./aws-iam";
import { parseArgs, type Ctx } from "./context";
import { resolvePath, type LambdaFunction } from "./state";

export const LAMBDA_COMMANDS = [
  "create-function", "get-function", "list-functions", "invoke", "update-function-configuration", "update-function-code", "delete-function",
];

/** Runtimes Lambda currently lists as supported (a subset). */
const RUNTIMES = [
  "nodejs22.x", "nodejs24.x", "nodejs26.x",
  "python3.12", "python3.13", "python3.14", "python3.15",
  "java21", "java25", "dotnet10", "ruby3.4", "ruby4.0", "provided.al2023",
];
const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

/** Base64 as the AWS CLI v2 expects for --payload without --cli-binary-format. */
const isBase64 = (text: string) => /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0;

/**
 * Checks a Python handler ("module.function") against the package, the way
 * Lambda's Python runtime fails at invocation time. Other runtimes are not checked.
 */
function handlerError(f: LambdaFunction): { errorType: string; errorMessage: string } | null {
  if (!f.runtime.startsWith("python")) return null;
  const dot = f.handler.lastIndexOf(".");
  const moduleName = f.handler.slice(0, dot);
  const functionName = f.handler.slice(dot + 1);
  const source = f.code[`${moduleName.replace(/\./g, "/")}.py`];
  if (dot <= 0 || source === undefined) {
    return { errorType: "Runtime.ImportModuleError", errorMessage: `Unable to import module '${moduleName}': No module named '${moduleName}'` };
  }
  if (!new RegExp(`^def\\s+${functionName}\\s*\\(`, "m").test(source)) {
    return { errorType: "Runtime.HandlerNotFound", errorMessage: `Handler '${functionName}' missing on module '${moduleName}'` };
  }
  return null;
}

/** Parses `Variables={KEY=value,OTHER=x}` (the shorthand the AWS CLI accepts). */
function environment(text: string): Record<string, string> | null {
  const m = /^Variables=\{(.*)\}$/.exec(text.trim());
  if (!m) return null;
  const vars: Record<string, string> = {};
  for (const pair of m[1].split(",").filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    vars[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return vars;
}

export function lambda(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !LAMBDA_COMMANDS.includes(sub)) {
    const supported = LAMBDA_COMMANDS.join("、");
    ctx.err(sub ? `aws: 不支援的 lambda 指令 '${sub}'。支援：${supported}` : `usage: aws lambda <command> [parameters]\n支援：${supported}`);
    return 252;
  }
  const parsed = parseArgs(rest, {
    options: [
      "--function-name", "--runtime", "--role", "--handler", "--zip-file", "--timeout", "--memory-size", "--environment",
      "--description", "--payload", "--cli-binary-format", "--invocation-type", "--region", "--output",
    ],
    flags: ["--publish"],
  });
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const functions = ctx.state.aws.lambda.functions;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const opt = (name: string) => parsed.options.get(`--${name}`);
  function required(...names: string[]): boolean {
    const missing = names.filter((n) => !parsed.options.has(`--${n}`));
    if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
    return missing.length === 0;
  }
  const notFound = (name: string) =>
    fail(ctx, "ResourceNotFoundException", operation, `Function not found: arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`);
  const invalid = (message: string) => fail(ctx, "InvalidParameterValueException", operation, message);
  if (parsed.positional.length && sub !== "invoke") {
    ctx.err(`\nUnknown options: ${parsed.positional.join(", ")}`);
    return 252;
  }

  const config = (name: string, state: string) => {
    const f = functions.get(name)!;
    return {
      FunctionName: name,
      FunctionArn: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`,
      Runtime: f.runtime,
      Role: f.role,
      Handler: f.handler,
      CodeSize: JSON.stringify(f.code).length,
      Description: "",
      Timeout: f.timeout,
      MemorySize: f.memorySize,
      Version: "$LATEST",
      ...(Object.keys(f.environment).length ? { Environment: { Variables: f.environment } } : {}),
      State: state,
      PackageType: "Zip",
    };
  };

  /** Reads --zip-file fileb://path into the package's files. */
  function zipFile(): Record<string, string> | null {
    const source = opt("zip-file")!;
    if (!source.startsWith("fileb://")) {
      invalid(`--zip-file 要用 fileb:// 開頭，例如 fileb://function.zip（收到 '${source}'）`);
      return null;
    }
    const path = source.slice("fileb://".length);
    const content = ctx.state.files.get(resolvePath(ctx.state.cwd, path));
    if (content === undefined) {
      ctx.err(`\nError parsing parameter '--zip-file': Unable to load paramfile ${source}: [Errno 2] No such file or directory: '${path}'`);
      return null;
    }
    const files = decodeArchive(content);
    if (!files) {
      invalid("Could not unzip uploaded file. Please check your file, then try to upload again. （請先用 zip 指令把程式碼壓縮成 .zip 檔）");
      return null;
    }
    return files;
  }

  /** Validates --role: an existing role that Lambda is allowed to assume. */
  function role(arn: string): boolean {
    const m = /^arn:aws:iam::(\d{12}):role\/([A-Za-z0-9+=,.@_-]+)$/.exec(arn);
    if (!m) {
      invalid(`1 validation error detected: Value '${arn}' at 'role' failed to satisfy constraint. 角色 ARN 的格式是 ${roleArn("角色名稱")}`);
      return false;
    }
    const r = ctx.state.aws.iam.roles.get(m[2]);
    if (m[1] !== ACCOUNT || !r || !r.trustedServices.has("lambda.amazonaws.com")) {
      invalid("The role defined for the function cannot be assumed by Lambda. 角色必須存在，而且信任政策要允許 lambda.amazonaws.com。");
      return false;
    }
    return true;
  }

  function limits(): { timeout?: number; memory?: number } | null {
    const result: { timeout?: number; memory?: number } = {};
    if (opt("timeout") !== undefined) {
      const t = Number(opt("timeout"));
      if (!Number.isInteger(t) || t < 1 || t > 900) {
        invalid(`1 validation error detected: Value '${opt("timeout")}' at 'timeout' failed to satisfy constraint: Member must have value between 1 and 900`);
        return null;
      }
      result.timeout = t;
    }
    if (opt("memory-size") !== undefined) {
      const m = Number(opt("memory-size"));
      if (!Number.isInteger(m) || m < 128 || m > 10240) {
        invalid(`1 validation error detected: Value '${opt("memory-size")}' at 'memorySize' failed to satisfy constraint: Member must have value between 128 and 10240`);
        return null;
      }
      result.memory = m;
    }
    return result;
  }

  switch (sub) {
    case "create-function": {
      if (!required("function-name", "role")) return 252;
      const name = opt("function-name")!;
      if (!NAME.test(name)) return invalid(`函式名稱只能包含字母、數字、連字號和底線，最多 64 個字元（收到 '${name}'）。`);
      if (functions.has(name)) return fail(ctx, "ResourceConflictException", operation, `Function already exist: ${name}`);
      if (!parsed.options.has("--zip-file")) return invalid("這個模擬終端機只支援用 --zip-file fileb://檔名.zip 上傳程式碼。");
      if (!required("runtime", "handler")) return 252;
      const runtime = opt("runtime")!;
      if (!RUNTIMES.includes(runtime)) {
        return invalid(`Value ${runtime} at 'runtime' failed to satisfy constraint. 這個模擬終端機認得的 Runtime：${RUNTIMES.join("、")}`);
      }
      if (!role(opt("role")!)) return 254;
      const code = zipFile();
      if (!code) return 254;
      const l = limits();
      if (!l) return 254;
      const env = opt("environment") === undefined ? {} : environment(opt("environment")!);
      if (!env) return invalid("--environment 的格式是 Variables={KEY=value,KEY2=value2}");
      functions.set(name, { runtime, handler: opt("handler")!, role: opt("role")!, code, timeout: l.timeout ?? 3, memorySize: l.memory ?? 128, environment: env, invocations: 0 });
      json(ctx, config(name, "Pending"));
      return 0;
    }
    case "get-function": {
      if (!required("function-name")) return 252;
      const name = opt("function-name")!;
      if (!functions.has(name)) return notFound(name);
      json(ctx, { Configuration: config(name, "Active"), Code: { RepositoryType: "S3", Location: "（模擬環境不提供程式碼下載連結）" } });
      return 0;
    }
    case "list-functions":
      json(ctx, { Functions: [...functions.keys()].sort().map((n) => config(n, "Active")) });
      return 0;
    case "delete-function": {
      if (!required("function-name")) return 252;
      if (!functions.delete(opt("function-name")!)) return notFound(opt("function-name")!);
      return 0;
    }
    case "update-function-configuration": {
      if (!required("function-name")) return 252;
      const name = opt("function-name")!;
      const f = functions.get(name);
      if (!f) return notFound(name);
      const l = limits();
      if (!l) return 254;
      if (opt("role") !== undefined && !role(opt("role")!)) return 254;
      if (opt("runtime") !== undefined && !RUNTIMES.includes(opt("runtime")!)) return invalid(`Value ${opt("runtime")} at 'runtime' failed to satisfy constraint.`);
      const env = opt("environment") === undefined ? f.environment : environment(opt("environment")!);
      if (!env) return invalid("--environment 的格式是 Variables={KEY=value,KEY2=value2}");
      f.timeout = l.timeout ?? f.timeout;
      f.memorySize = l.memory ?? f.memorySize;
      f.role = opt("role") ?? f.role;
      f.handler = opt("handler") ?? f.handler;
      f.runtime = opt("runtime") ?? f.runtime;
      f.environment = env;
      json(ctx, { ...config(name, "Active"), LastUpdateStatus: "InProgress" });
      return 0;
    }
    case "update-function-code": {
      if (!required("function-name", "zip-file")) return 252;
      const name = opt("function-name")!;
      const f = functions.get(name);
      if (!f) return notFound(name);
      const code = zipFile();
      if (!code) return 254;
      f.code = code;
      json(ctx, { ...config(name, "Active"), LastUpdateStatus: "InProgress" });
      return 0;
    }
    case "invoke": {
      if (!required("function-name")) return 252;
      const outfile = parsed.positional[0];
      if (!outfile || parsed.positional.length > 1) {
        ctx.err("\naws: error: the following arguments are required: outfile（例如在最後加上 response.json，回應會寫進這個檔案）");
        return 252;
      }
      const name = opt("function-name")!;
      const f = functions.get(name);
      if (!f) return notFound(name);
      const payloadText = opt("payload") ?? "{}";
      // AWS CLI v2 reads --payload as base64 unless told the input is raw.
      if (opt("payload") !== undefined && opt("cli-binary-format") !== "raw-in-base64-out" && !isBase64(payloadText)) {
        ctx.err(`\nInvalid base64: "${payloadText}"\n（AWS CLI v2 預設把 --payload 當成 base64。直接傳 JSON 時要加上 --cli-binary-format raw-in-base64-out）`);
        return 255;
      }
      const raw = opt("cli-binary-format") === "raw-in-base64-out" || opt("payload") === undefined ? payloadText : atob(payloadText);
      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        return fail(ctx, "InvalidRequestContentException", operation, "Could not parse request body into json: Could not parse payload into json");
      }
      const target = resolvePath(ctx.state.cwd, outfile);
      if (ctx.state.dirs.has(target) || !ctx.state.dirs.has(target.slice(0, target.lastIndexOf("/")) || "/")) {
        ctx.err(`\n[Errno 2] No such file or directory: '${outfile}'`);
        return 255;
      }
      const error = handlerError(f);
      if (error) {
        ctx.state.files.set(target, `${JSON.stringify({ ...error, requestId: "00000000-0000-0000-0000-000000000000", stackTrace: [] })}\n`);
        json(ctx, { StatusCode: 200, FunctionError: "Unhandled", ExecutedVersion: "$LATEST" });
        return 0;
      }
      // The simulator does not run code; it answers like the lab's sample handler, echoing the event in the body.
      f.invocations++;
      ctx.state.files.set(target, `${JSON.stringify({ statusCode: 200, body: JSON.stringify(event) })}\n`);
      json(ctx, { StatusCode: 200, ExecutedVersion: "$LATEST" });
      return 0;
    }
    default:
      return 252;
  }
}
