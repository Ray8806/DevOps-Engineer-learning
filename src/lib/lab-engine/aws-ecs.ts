import type { Ctx } from "./context";
import { ACCOUNT, ECR_REGION, ECR_REGISTRY, ECR_TOKEN, parseTarget, remoteImage } from "./docker";
import { resolvePath, type EcsTaskDefinition, type LabState } from "./state";

export const ECR_COMMANDS = ["create-repository", "describe-repositories", "describe-images", "delete-repository", "get-login-password"];
export const ECS_COMMANDS = [
  "create-cluster", "list-clusters", "register-task-definition", "describe-task-definition", "create-service", "describe-services",
  "update-service", "list-tasks",
];

/** Valid Fargate task sizes for Linux: CPU units -> allowed memory in MiB. */
const FARGATE_SIZES: Record<string, number[]> = {
  "256": [512, 1024, 2048],
  "512": [1024, 2048, 3072, 4096],
  "1024": [2048, 3072, 4096, 5120, 6144, 7168, 8192],
  "2048": Array.from({ length: 13 }, (_, i) => (i + 4) * 1024),
  "4096": Array.from({ length: 23 }, (_, i) => (i + 8) * 1024),
};

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

interface Parsed {
  options: Map<string, string[]>;
  flags: Set<string>;
  unknown?: string;
}

function parse(args: string[], options: string[], lists: string[] = [], flags: string[] = []): Parsed {
  const result: Parsed = { options: new Map(), flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
    if (flags.includes(arg)) {
      result.flags.add(arg);
      continue;
    }
    if (!options.includes(name)) return { ...result, unknown: arg };
    const values = eq !== -1 && arg.startsWith("--") ? [arg.slice(eq + 1)] : [];
    if (values.length === 0) {
      if (args[i + 1] === undefined) return { ...result, unknown: arg };
      values.push(args[++i]);
    }
    if (lists.includes(name)) while (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) values.push(args[++i]);
    result.options.set(name, values);
  }
  return result;
}

function required(ctx: Ctx, parsed: Parsed, names: string[]): boolean {
  const missing = names.filter((n) => !parsed.options.has(`--${n}`));
  if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
  return missing.length === 0;
}

function unsupported(ctx: Ctx, service: string, sub: string | undefined, supported: string[]): number {
  ctx.err(sub ? `aws: 不支援的 ${service} 指令 '${sub}'。支援：${supported.join("、")}` : `usage: aws ${service} <command> [parameters]\n支援：${supported.join("、")}`);
  return 252;
}

function readJson(ctx: Ctx, option: string, text: string): unknown {
  let source = text;
  if (text.startsWith("file://")) {
    const content = ctx.state.files.get(resolvePath(ctx.state.cwd, text.slice(7)));
    if (content === undefined) {
      ctx.err(`\nError parsing parameter '${option}': Unable to load paramfile ${text}: [Errno 2] No such file or directory`);
      return null;
    }
    source = content;
  }
  try {
    return JSON.parse(source);
  } catch {
    ctx.err(`\nError parsing parameter '${option}': Invalid JSON: ${source.slice(0, 60)}`);
    return null;
  }
}

const repoUri = (name: string) => `${ECR_REGISTRY}/${name}`;

export function ecr(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !ECR_COMMANDS.includes(sub)) return unsupported(ctx, "ecr", sub, ECR_COMMANDS);
  const parsed = parse(rest, ["--repository-name", "--repository-names", "--image-tag-mutability", "--image-scanning-configuration", "--region", "--output"], ["--repository-names"], ["--force"]);
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const repos = ctx.state.aws.ecr.repositories;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const repoJson = (name: string) => {
    const r = repos.get(name)!;
    return {
      repositoryArn: `arn:aws:ecr:${ECR_REGION}:${ACCOUNT}:repository/${name}`,
      registryId: ACCOUNT,
      repositoryName: name,
      repositoryUri: repoUri(name),
      imageTagMutability: r.mutability,
      imageScanningConfiguration: { scanOnPush: r.scanOnPush },
    };
  };
  const notFound = (name: string) => fail(ctx, "RepositoryNotFoundException", operation, `The repository with name '${name}' does not exist in the registry with id '${ACCOUNT}'`);

  switch (sub) {
    case "get-login-password":
      ctx.out(`${ECR_TOKEN}\n`);
      return 0;
    case "create-repository": {
      if (!required(ctx, parsed, ["repository-name"])) return 252;
      const name = opt("repository-name")!;
      if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(name) || name.length < 2) {
        return fail(ctx, "InvalidParameterException", operation, "Invalid parameter at 'repositoryName' failed to satisfy constraint: 'must satisfy regular expression'（儲存庫名稱用小寫字母、數字、-、_、.、/）");
      }
      if (repos.has(name)) return fail(ctx, "RepositoryAlreadyExistsException", operation, `The repository with name '${name}' already exists in the registry with id '${ACCOUNT}'`);
      const mutability = opt("image-tag-mutability") ?? "MUTABLE";
      if (mutability !== "MUTABLE" && mutability !== "IMMUTABLE") return fail(ctx, "InvalidParameterException", operation, "--image-tag-mutability 要是 MUTABLE 或 IMMUTABLE");
      repos.set(name, { mutability, scanOnPush: /scanOnPush=true/i.test(opt("image-scanning-configuration") ?? ""), images: new Map() });
      json(ctx, { repository: repoJson(name) });
      return 0;
    }
    case "describe-repositories": {
      const names = parsed.options.get("--repository-names") ?? [...repos.keys()];
      const missing = names.find((n) => !repos.has(n));
      if (missing) return notFound(missing);
      json(ctx, { repositories: names.map(repoJson) });
      return 0;
    }
    case "describe-images": {
      if (!required(ctx, parsed, ["repository-name"])) return 252;
      const name = opt("repository-name")!;
      const repo = repos.get(name);
      if (!repo) return notFound(name);
      const byId = new Map<string, string[]>();
      for (const [tag, id] of repo.images) byId.set(id, [...(byId.get(id) ?? []), tag]);
      json(ctx, {
        imageDetails: [...byId].map(([id, tags]) => ({ registryId: ACCOUNT, repositoryName: name, imageDigest: `sha256:${id}${"0".repeat(52)}`, imageTags: tags, imageSizeInBytes: 72_000_000 })),
      });
      return 0;
    }
    default: {
      if (!required(ctx, parsed, ["repository-name"])) return 252;
      const name = opt("repository-name")!;
      const repo = repos.get(name);
      if (!repo) return notFound(name);
      if (repo.images.size && !parsed.flags.has("--force")) {
        return fail(ctx, "RepositoryNotEmptyException", operation, `The repository with name '${name}' in registry with id '${ACCOUNT}' cannot be deleted because it still contains images（加上 --force 連映像檔一起刪除）`);
      }
      const out = repoJson(name);
      repos.delete(name);
      json(ctx, { repository: out });
      return 0;
    }
  }
}

/** Parses "awsvpcConfiguration={subnets=[a,b],securityGroups=[c],assignPublicIp=ENABLED}". */
function networkConfig(text: string): { subnets: string[]; securityGroups: string[]; assignPublicIp: string } | null {
  const m = /^awsvpcConfiguration=\{(.*)\}$/.exec(text.replace(/\s/g, ""));
  if (!m) return null;
  const list = (key: string) => /\[([^\]]*)\]/.exec(new RegExp(`${key}=(\\[[^\\]]*\\])`).exec(m[1])?.[1] ?? "")?.[1].split(",").filter(Boolean) ?? [];
  return { subnets: list("subnets"), securityGroups: list("securityGroups"), assignPublicIp: /assignPublicIp=(ENABLED|DISABLED)/.exec(m[1])?.[1] ?? "DISABLED" };
}

/** Why a service's tasks cannot run, or null when they can. */
export function taskProblem(state: LabState, def: EcsTaskDefinition): string | null {
  for (const c of def.containers) {
    const t = parseTarget(c.image);
    if (t.kind === "ecr") {
      if (!remoteImage(state, c.image)) return `CannotPullContainerError: pull image manifest has been retried 5 time(s): ${c.image}: not found（映像檔還沒推送到 ECR）`;
      if (!def.executionRoleArn) return "CannotPullContainerError: 從私有 ECR 儲存庫拉取映像檔需要任務執行角色（executionRoleArn）";
    }
  }
  return null;
}

export function ecs(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !ECS_COMMANDS.includes(sub)) return unsupported(ctx, "ecs", sub, ECS_COMMANDS);
  const parsed = parse(rest, [
    "--cluster-name", "--cluster", "--cli-input-json", "--family", "--task-definition", "--service-name", "--service", "--services", "--desired-count",
    "--launch-type", "--network-configuration", "--platform-version", "--region", "--output",
  ], ["--services"]);
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const e = ctx.state.aws.ecs;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const arn = (kind: string, name: string) => `arn:aws:ecs:${ECR_REGION}:${ACCOUNT}:${kind}/${name}`;
  const cluster = () => {
    const name = opt("cluster") ?? "default";
    if (!e.clusters.has(name)) {
      fail(ctx, "ClusterNotFoundException", operation, `Cluster not found.（找不到叢集 ${name}）`);
      return null;
    }
    return name;
  };
  /** "family:revision" (or just family for the latest) -> [ref, definition]. */
  const findDef = (ref: string): [string, EcsTaskDefinition] | null => {
    const [family, rev] = ref.replace(/^arn:aws:ecs:[^:]+:\d+:task-definition\//, "").split(":");
    const revisions = e.taskDefinitions.get(family);
    const n = rev === undefined ? revisions?.length : Number(rev);
    const def = n ? revisions?.[n - 1] : undefined;
    return def ? [`${family}:${n}`, def] : null;
  };
  const serviceJson = (key: string) => {
    const s = e.services.get(key)!;
    const [clusterName, name] = key.split("/");
    const problem = taskProblem(ctx.state, findDef(s.taskDefinition)![1]);
    return {
      serviceArn: arn("service", key),
      serviceName: name,
      clusterArn: arn("cluster", clusterName),
      status: "ACTIVE",
      desiredCount: s.desiredCount,
      runningCount: problem ? 0 : s.desiredCount,
      pendingCount: 0,
      launchType: s.launchType,
      taskDefinition: arn("task-definition", s.taskDefinition),
      networkConfiguration: { awsvpcConfiguration: { subnets: s.subnets, assignPublicIp: s.assignPublicIp } },
      events: problem ? [{ message: `(service ${name}) 無法啟動任務：${problem}` }] : [{ message: `(service ${name}) has reached a steady state.` }],
    };
  };

  switch (sub) {
    case "create-cluster": {
      const name = opt("cluster-name") ?? "default";
      e.clusters.add(name);
      json(ctx, { cluster: { clusterArn: arn("cluster", name), clusterName: name, status: "ACTIVE", activeServicesCount: 0 } });
      return 0;
    }
    case "list-clusters":
      json(ctx, { clusterArns: [...e.clusters].map((c) => arn("cluster", c)) });
      return 0;
    case "register-task-definition": {
      if (!parsed.options.has("--cli-input-json")) {
        ctx.err("\n這個模擬終端機用 --cli-input-json file://taskdef.json 註冊任務定義。");
        return 252;
      }
      const raw = readJson(ctx, "--cli-input-json", opt("cli-input-json")!) as Record<string, unknown> | null;
      if (raw === null) return 252;
      const family = raw.family;
      if (typeof family !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(family)) return fail(ctx, "ClientException", operation, "family 要有值，只能用英數字、- 和 _");
      const compat = Array.isArray(raw.requiresCompatibilities) ? raw.requiresCompatibilities.map(String) : [];
      const fargate = compat.includes("FARGATE");
      const cpu = raw.cpu === undefined ? "" : String(raw.cpu);
      const memory = raw.memory === undefined ? "" : String(raw.memory);
      const networkMode = typeof raw.networkMode === "string" ? raw.networkMode : "bridge";
      if (fargate) {
        if (networkMode !== "awsvpc") return fail(ctx, "ClientException", operation, "Fargate only supports network mode 'awsvpc'.");
        if (!cpu || !memory) return fail(ctx, "ClientException", operation, "Fargate requires that 'cpu' be defined at the task level.（Fargate 要在任務層級指定 cpu 和 memory）");
        if (!FARGATE_SIZES[cpu]) return fail(ctx, "ClientException", operation, `No Fargate configuration exists for given values: ${cpu} CPU, ${memory} memory.（這個模擬終端機支援的 CPU：${Object.keys(FARGATE_SIZES).join("、")}）`);
        if (!FARGATE_SIZES[cpu].includes(Number(memory))) {
          return fail(ctx, "ClientException", operation, `No Fargate configuration exists for given values: ${cpu} CPU, ${memory} memory. See the Amazon ECS documentation for the valid values.`);
        }
      }
      const defs = Array.isArray(raw.containerDefinitions) ? (raw.containerDefinitions as Record<string, unknown>[]) : [];
      if (!defs.length) return fail(ctx, "ClientException", operation, "containerDefinitions 至少要有一個容器");
      const containers: EcsTaskDefinition["containers"] = [];
      for (const c of defs) {
        if (typeof c?.name !== "string" || typeof c.image !== "string") return fail(ctx, "ClientException", operation, "每個容器定義都要有 name 和 image");
        const ports = Array.isArray(c.portMappings) ? c.portMappings.map((p) => Number((p as { containerPort?: unknown }).containerPort)).filter((p) => p > 0) : [];
        containers.push({ name: c.name, image: c.image, ports, essential: c.essential !== false });
      }
      const executionRoleArn = typeof raw.executionRoleArn === "string" ? raw.executionRoleArn : null;
      if (executionRoleArn !== null && !/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(executionRoleArn)) {
        return fail(ctx, "ClientException", operation, "executionRoleArn 要是 IAM 角色的 ARN，例如 arn:aws:iam::123456789012:role/ecsTaskExecutionRole");
      }
      const revisions = e.taskDefinitions.get(family) ?? [];
      revisions.push({ cpu, memory, networkMode, compatibilities: compat, executionRoleArn, containers });
      e.taskDefinitions.set(family, revisions);
      json(ctx, {
        taskDefinition: {
          taskDefinitionArn: arn("task-definition", `${family}:${revisions.length}`),
          family,
          revision: revisions.length,
          status: "ACTIVE",
          networkMode,
          requiresCompatibilities: compat,
          cpu,
          memory,
          executionRoleArn,
          containerDefinitions: containers.map((c) => ({ name: c.name, image: c.image, portMappings: c.ports.map((p) => ({ containerPort: p, protocol: "tcp" })), essential: c.essential })),
        },
      });
      return 0;
    }
    case "describe-task-definition": {
      if (!required(ctx, parsed, ["task-definition"])) return 252;
      const found = findDef(opt("task-definition")!);
      if (!found) return fail(ctx, "ClientException", operation, "Unable to describe task definition.");
      const [ref, d] = found;
      json(ctx, { taskDefinition: { taskDefinitionArn: arn("task-definition", ref), cpu: d.cpu, memory: d.memory, networkMode: d.networkMode, executionRoleArn: d.executionRoleArn, containerDefinitions: d.containers.map((c) => ({ name: c.name, image: c.image })) } });
      return 0;
    }
    case "create-service": {
      if (!required(ctx, parsed, ["service-name", "task-definition"])) return 252;
      const clusterName = cluster();
      if (!clusterName) return 254;
      const name = opt("service-name")!;
      const key = `${clusterName}/${name}`;
      if (e.services.has(key)) return fail(ctx, "InvalidParameterException", operation, "Creation of service was not idempotent.（這個叢集裡已經有同名的服務）");
      const found = findDef(opt("task-definition")!);
      if (!found) return fail(ctx, "ClientException", operation, `TaskDefinition not found.（找不到 ${opt("task-definition")}）`);
      const [ref, def] = found;
      const launchType = opt("launch-type") ?? "EC2";
      if (launchType !== "FARGATE") return fail(ctx, "InvalidParameterException", operation, "這個模擬終端機的服務只支援 --launch-type FARGATE（叢集裡沒有 EC2 容器執行個體）。");
      if (!def.compatibilities.includes("FARGATE")) return fail(ctx, "InvalidParameterException", operation, "Task definition does not support launch_type FARGATE.（任務定義要有 requiresCompatibilities: [\"FARGATE\"]）");
      const desired = Number(opt("desired-count") ?? 0);
      if (!Number.isInteger(desired) || desired < 0) return fail(ctx, "InvalidParameterException", operation, "--desired-count 要是 0 以上的整數");
      const net = opt("network-configuration");
      if (net === undefined) return fail(ctx, "InvalidParameterException", operation, "Network Configuration must be provided when networkMode 'awsvpc' is specified.");
      const config = networkConfig(net);
      if (!config || !config.subnets.length) return fail(ctx, "InvalidParameterException", operation, "--network-configuration 的格式是 'awsvpcConfiguration={subnets=[subnet-…],securityGroups=[sg-…],assignPublicIp=ENABLED}'");
      const badSubnet = config.subnets.find((s) => !ctx.state.aws.vpc.subnets.has(s));
      if (badSubnet) return fail(ctx, "InvalidParameterException", operation, `Error retrieving subnet information for [${badSubnet}]: The subnet ID '${badSubnet}' does not exist（用 aws ec2 describe-subnets 查子網路 ID）`);
      e.services.set(key, { taskDefinition: ref, desiredCount: desired, launchType, subnets: config.subnets, assignPublicIp: config.assignPublicIp });
      json(ctx, { service: { ...serviceJson(key), runningCount: 0, pendingCount: desired, events: [] } });
      return 0;
    }
    case "update-service": {
      const clusterName = cluster();
      if (!clusterName) return 254;
      const name = opt("service") ?? "";
      const s = e.services.get(`${clusterName}/${name}`);
      if (!s) return fail(ctx, "ServiceNotFoundException", operation, "Service not found.");
      if (parsed.options.has("--desired-count")) {
        const n = Number(opt("desired-count"));
        if (!Number.isInteger(n) || n < 0) return fail(ctx, "InvalidParameterException", operation, "--desired-count 要是 0 以上的整數");
        s.desiredCount = n;
      }
      if (parsed.options.has("--task-definition")) {
        const found = findDef(opt("task-definition")!);
        if (!found) return fail(ctx, "ClientException", operation, "TaskDefinition not found.");
        s.taskDefinition = found[0];
      }
      json(ctx, { service: serviceJson(`${clusterName}/${name}`) });
      return 0;
    }
    case "describe-services": {
      const clusterName = cluster();
      if (!clusterName) return 254;
      const names = parsed.options.get("--services") ?? [];
      json(ctx, {
        services: names.filter((n) => e.services.has(`${clusterName}/${n}`)).map((n) => serviceJson(`${clusterName}/${n}`)),
        failures: names.filter((n) => !e.services.has(`${clusterName}/${n}`)).map((n) => ({ arn: arn("service", `${clusterName}/${n}`), reason: "MISSING" })),
      });
      return 0;
    }
    default: {
      const clusterName = cluster();
      if (!clusterName) return 254;
      const tasks: string[] = [];
      for (const [key, s] of e.services) {
        if (!key.startsWith(`${clusterName}/`) || taskProblem(ctx.state, findDef(s.taskDefinition)![1])) continue;
        for (let i = 0; i < s.desiredCount; i++) tasks.push(arn("task", `${clusterName}/${(key.length * 7919 + i * 104729).toString(16).padStart(32, "0").slice(-32)}`));
      }
      json(ctx, { taskArns: tasks });
      return 0;
    }
  }
}
