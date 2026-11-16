import { parseArgs, type Ctx } from "./context";
import { NAME, NAME_RULE, error, list, table } from "./gcloud-common";
import type { CloudRunService } from "./state";

const REGION = /^[a-z]+-[a-z]+\d+$/;
const IMAGE = /^[a-z0-9.-]+(:\d+)?\/[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+|@sha256:[0-9a-f]{64})?$/;
const PROJECT_NUMBER = "498765432109";
const MEMORY = /^(\d+)(Mi|Gi)$/;

const serviceUrl = (name: string, region: string) => `https://${name}-${PROJECT_NUMBER}.${region}.run.app`;

/** "300", "300s", "5m", "1h" -> seconds; null when unreadable. */
function seconds(text: string): number | null {
  const m = /^(\d+)(s|m|h)?$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "m" ? 60 : m[2] === "h" ? 3600 : 1);
}

/** Deterministic three-letter revision suffix (real ones are random). */
function suffix(n: number): string {
  let hash = 0x811c9dc5;
  for (const ch of `rev${n}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return [0, 1, 2].map((i) => "abcdefghijklmnopqrstuvwxyz"[(hash >>> (i * 5)) % 26]).join("");
}

function parseEnv(text: string): Record<string, string> | null {
  const env: Record<string, string> = {};
  for (const pair of list(text)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

const OPTIONS = [
  "--image", "--region", "--memory", "--cpu", "--concurrency", "--timeout", "--min-instances", "--max-instances", "--port",
  "--set-env-vars", "--update-env-vars", "--remove-env-vars", "--source", "--service", "--member", "--role", "--project", "--format",
];
const FLAGS = [
  "--allow-unauthenticated", "--no-allow-unauthenticated", "--invoker-iam-check", "--no-invoker-iam-check", "--clear-env-vars", "--quiet", "-q", "--async",
];

/**
 * Applies configuration flags shared by `deploy` and `services update` to a
 * copy of the service. Returns null after reporting an invalid value.
 */
function configure(ctx: Ctx, command: string, base: CloudRunService, opts: Map<string, string>, flags: Set<string>): CloudRunService | null {
  const next: CloudRunService = { ...base, invokers: new Set(base.invokers), env: { ...base.env }, revisions: [...base.revisions] };
  const fail = (message: string) => {
    error(ctx, command, message);
    return null;
  };
  const int = (name: string, min: number, max: number): number | null | undefined => {
    const text = opts.get(name);
    if (text === undefined) return undefined;
    const n = Number(text);
    if (!Number.isInteger(n) || n < min || n > max) {
      fail(`argument ${name}: 請輸入 ${min} 到 ${max} 的整數，收到 '${text}'。`);
      return null;
    }
    return n;
  };
  const image = opts.get("--image");
  if (image !== undefined) {
    if (!IMAGE.test(image)) return fail(`argument --image: '${image}' 不是容器映像檔的位址，格式像 us-docker.pkg.dev/cloudrun/container/hello。`);
    next.image = image;
  }
  const memory = opts.get("--memory");
  if (memory !== undefined) {
    const m = MEMORY.exec(memory);
    const mib = m ? Number(m[1]) * (m[2] === "Gi" ? 1024 : 1) : NaN;
    if (!m || mib < 128 || mib > 32 * 1024) return fail(`argument --memory: 無法使用 '${memory}'。格式像 512Mi 或 2Gi，最多 32Gi。`);
    next.memory = memory;
  }
  const concurrency = int("--concurrency", 1, 1000);
  const minInstances = int("--min-instances", 0, 1000);
  const maxInstances = int("--max-instances", 1, 1000);
  if (concurrency === null || minInstances === null || maxInstances === null) return null;
  next.concurrency = concurrency ?? next.concurrency;
  next.minInstances = minInstances ?? next.minInstances;
  next.maxInstances = maxInstances ?? next.maxInstances;
  if (next.minInstances > next.maxInstances) return fail(`min-instances（${next.minInstances}）不能大於 max-instances（${next.maxInstances}）。`);
  const timeoutText = opts.get("--timeout");
  if (timeoutText !== undefined) {
    const t = seconds(timeoutText);
    if (t === null || t < 1 || t > 3600) return fail(`argument --timeout: 逾時要介於 1 秒到 60 分鐘（3600 秒），收到 '${timeoutText}'。`);
    next.timeout = t;
  }
  if (flags.has("--clear-env-vars")) next.env = {};
  for (const name of ["--set-env-vars", "--update-env-vars"]) {
    const text = opts.get(name);
    if (text === undefined) continue;
    const env = parseEnv(text);
    if (!env) return fail(`argument ${name}: 格式是 KEY1=VALUE1,KEY2=VALUE2。`);
    next.env = name === "--set-env-vars" ? env : { ...next.env, ...env };
  }
  for (const key of list(opts.get("--remove-env-vars"))) delete next.env[key];
  if (flags.has("--allow-unauthenticated")) next.invokers.add("allUsers");
  if (flags.has("--no-allow-unauthenticated")) next.invokers.delete("allUsers");
  if (flags.has("--no-invoker-iam-check")) next.invokerIamCheck = false;
  if (flags.has("--invoker-iam-check")) next.invokerIamCheck = true;
  return next;
}

/** True when a deploy or update changes something that lives on a revision (anything but access settings). */
function revisionChanged(a: CloudRunService, b: CloudRunService): boolean {
  return (
    a.image !== b.image ||
    a.memory !== b.memory ||
    a.concurrency !== b.concurrency ||
    a.timeout !== b.timeout ||
    a.minInstances !== b.minInstances ||
    a.maxInstances !== b.maxInstances ||
    JSON.stringify(a.env) !== JSON.stringify(b.env)
  );
}

function regionArg(ctx: Ctx, command: string, region: string | undefined): string | null {
  if (region === undefined) {
    error(ctx, command, "這個模擬終端機不會互動詢問區域，請加上 --region，例如 --region=asia-east1。");
    return null;
  }
  if (!REGION.test(region)) {
    error(ctx, command, `Invalid value for [--region]: '${region}'. 區域的格式像 asia-east1。`);
    return null;
  }
  return region;
}

const isPublic = (s: CloudRunService) => !s.invokerIamCheck || s.invokers.has("allUsers");

function deploy(ctx: Ctx, args: string[]): number {
  const command = "gcloud.run.deploy";
  const parsed = parseArgs(args, { options: OPTIONS, flags: FLAGS });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  if (parsed.options.has("--source")) {
    return error(ctx, command, "這個模擬終端機不能從原始碼建置容器，請改用 --image 指定已經建好的映像檔，例如 --image=us-docker.pkg.dev/cloudrun/container/hello。");
  }
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "這個模擬終端機不會互動詢問服務名稱，請在 deploy 後面加上服務名稱。");
  if (!NAME.test(name)) return error(ctx, command, `Invalid service name '${name}'. ${NAME_RULE}`);
  const region = regionArg(ctx, command, parsed.options.get("--region"));
  if (!region) return 1;
  const run = ctx.state.gcp.run;
  const existing = run.services.get(name);
  if (existing && existing.region !== region) {
    return error(ctx, command, `這個模擬終端機裡已經有一個名為 ${name} 的服務在 ${existing.region}，請使用同一個區域或換一個名稱。`);
  }
  if (!existing && !parsed.options.has("--image")) return error(ctx, command, "新服務需要用 --image 指定容器映像檔。");
  const base: CloudRunService = existing ?? {
    region,
    image: "",
    invokerIamCheck: true,
    invokers: new Set(),
    concurrency: 80,
    memory: "512Mi",
    timeout: 300,
    minInstances: 0,
    maxInstances: 100,
    env: {},
    revisions: [],
  };
  const next = configure(ctx, command, base, parsed.options, parsed.flags);
  if (!next) return 1;
  const revision = `${name}-${String(next.revisions.length + 1).padStart(5, "0")}-${suffix(++run.revisionsCreated)}`;
  next.revisions.push(revision);
  run.services.set(name, next);
  ctx.out(
    [
      `Deploying container to Cloud Run service [${name}] in project [${ctx.state.gcp.project}] region [${region}]`,
      `OK Deploying${existing ? "" : " new service"}... Done.`,
      "  OK Creating Revision...",
      "  OK Routing traffic...",
      ...(parsed.flags.has("--allow-unauthenticated") || parsed.flags.has("--no-allow-unauthenticated") ? ["  OK Setting IAM Policy..."] : []),
      "Done.",
      `Service [${name}] revision [${revision}] has been deployed and is serving 100 percent of traffic.`,
      `Service URL: ${serviceUrl(name, region)}`,
      ...(!existing && !isPublic(next) ? ["（這個模擬終端機不會詢問是否允許未經驗證的呼叫；沒有加 --allow-unauthenticated，所以服務不公開。）"] : []),
      "",
    ].join("\n"),
  );
  return 0;
}

function services(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.run.services.${action}`;
  const parsed = parseArgs(rest, { options: OPTIONS, flags: FLAGS });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const run = ctx.state.gcp.run;
  if (action === "list") {
    table(
      ctx,
      ["SERVICE", "REGION", "URL", "LAST DEPLOYED BY"],
      [...run.services].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, s]) => [n, s.region, serviceUrl(n, s.region), "learner@example.com"]),
    );
    return 0;
  }
  const actions = ["describe", "update", "delete", "add-iam-policy-binding", "remove-iam-policy-binding"];
  if (!actions.includes(action ?? "")) return error(ctx, "gcloud.run.services", `不支援的指令 '${action ?? ""}'。支援 list、${actions.join("、")}。`);
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument SERVICE: Must be specified.");
  const region = regionArg(ctx, command, parsed.options.get("--region"));
  if (!region) return 1;
  const service = run.services.get(name);
  if (!service || service.region !== region) {
    return error(ctx, command, `Cannot find service [${name}] in region [${region}]. 用 gcloud run services list 看看有哪些服務。`);
  }
  switch (action) {
    case "describe":
      ctx.out(
        [
          `✔ Service ${name} in region ${region}`,
          "",
          `URL:     ${serviceUrl(name, region)}`,
          `Ingress: all`,
          `Traffic:`,
          `  100% LATEST (currently ${service.revisions.at(-1)})`,
          "",
          `Scaling: Auto (Min: ${service.minInstances}, Max: ${service.maxInstances})`,
          "",
          `Last updated by learner@example.com:`,
          `  Revision ${service.revisions.at(-1)}`,
          `  Container None`,
          `    Image:           ${service.image}`,
          `    Memory:          ${service.memory}`,
          ...Object.entries(service.env).map(([k, v], i) => `${i === 0 ? "    Env vars:" : "             "}        ${k}  ${v}`),
          `  Max concurrency:   ${service.concurrency}`,
          `  Timeout:           ${service.timeout}s`,
          `  Public access:     ${isPublic(service) ? "yes" : "no"}（模擬終端機的摘要）`,
          "",
        ].join("\n"),
      );
      return 0;
    case "update": {
      if (parsed.options.has("--image")) return error(ctx, command, "要更換映像檔請用 gcloud run deploy。");
      const next = configure(ctx, command, service, parsed.options, parsed.flags);
      if (!next) return 1;
      let revision = "";
      if (revisionChanged(service, next)) {
        revision = `${name}-${String(next.revisions.length + 1).padStart(5, "0")}-${suffix(++run.revisionsCreated)}`;
        next.revisions.push(revision);
      }
      run.services.set(name, next);
      ctx.out(
        revision
          ? `OK Deploying... Done.\n  OK Creating Revision...\n  OK Routing traffic...\nDone.\nService [${name}] revision [${revision}] has been deployed and is serving 100 percent of traffic.\nService URL: ${serviceUrl(name, region)}\n`
          : `Service [${name}] has been updated.\n`,
      );
      return 0;
    }
    case "delete":
      run.services.delete(name);
      ctx.out(`Deleted service [${name}].\n`);
      return 0;
    default: {
      const member = parsed.options.get("--member");
      const role = parsed.options.get("--role");
      if (member === undefined || role === undefined) return error(ctx, command, "argument --member and --role: Must be specified.");
      if (role !== "roles/run.invoker") return error(ctx, command, `這個模擬終端機只支援 roles/run.invoker（呼叫服務的權限），收到 '${role}'。`);
      if (member !== "allUsers" && !/^(user|serviceAccount|group):.+@.+$/.test(member)) {
        return error(ctx, command, `Invalid member '${member}'. 格式像 allUsers、user:alice@example.com 或 serviceAccount:…`);
      }
      if (action === "add-iam-policy-binding") service.invokers.add(member);
      else service.invokers.delete(member);
      ctx.out(
        `Updated IAM policy for service [${name}].\nbindings:\n${service.invokers.size ? `- members:\n${[...service.invokers].sort().map((m) => `  - ${m}\n`).join("")}  role: roles/run.invoker\n` : ""}`,
      );
      return 0;
    }
  }
}

function revisions(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.run.revisions.${action}`;
  if (action !== "list") return error(ctx, "gcloud.run.revisions", `不支援的指令 '${action ?? ""}'。支援 list。`);
  const parsed = parseArgs(rest, { options: OPTIONS, flags: FLAGS });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const region = regionArg(ctx, command, parsed.options.get("--region"));
  if (!region) return 1;
  const only = parsed.options.get("--service");
  const rows: string[][] = [];
  for (const [name, s] of ctx.state.gcp.run.services) {
    if (s.region !== region || (only !== undefined && only !== name)) continue;
    [...s.revisions].reverse().forEach((r, i) => rows.push([i === 0 ? "✔" : "", r, i === 0 ? "yes" : "", name]));
  }
  table(ctx, ["", "REVISION", "ACTIVE", "SERVICE"], rows);
  return 0;
}

export function run(ctx: Ctx, args: string[]): number {
  switch (args[0]) {
    case "deploy":
      return deploy(ctx, args.slice(1));
    case "services":
      return services(ctx, args.slice(1));
    case "revisions":
      return revisions(ctx, args.slice(1));
    default:
      return error(ctx, "gcloud.run", `不支援 '${args[0] ?? ""}'。這個模擬終端機支援 gcloud run deploy、gcloud run services、gcloud run revisions list。`);
  }
}
