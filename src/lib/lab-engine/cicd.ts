import { parse as parseYaml } from "yaml";
import { decodeArchive } from "./archive";
import type { Ctx } from "./context";
import { ACCOUNT, ECR_REGION } from "./docker";
import { execute } from "./engine";
import { error, list, table } from "./gcloud-common";
import { addDirWithParents, isWithin, resolvePath, type BuildRecord, type LabState, type LogGroup } from "./state";

export const CODEBUILD_COMMANDS = ["create-project", "update-project", "list-projects", "start-build", "batch-get-builds", "list-builds-for-project"];
const BUILD_DATE = "Mon Nov 16 08:00:00 UTC 2026";


/** Replaces $VAR and ${VAR} (and `date`) the way a build shell or Cloud Build substitution would. */
function expand(text: string, vars: Record<string, string>): string {
  return text
    .replace(/`date`/g, BUILD_DATE)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a: string | undefined, b: string | undefined) => vars[(a ?? b)!] ?? whole);
}

const quote = (arg: string) => (/^[A-Za-z0-9_./:=@,%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);

/**
 * Runs one command line inside a build: a fresh working directory with the
 * source, the build's own Docker engine, and the rest of the cloud shared.
 */
function runInBuild(ctx: Ctx, dir: string, line: string, log: string[]): boolean {
  const saved = ctx.state.cwd;
  const result = execute({ ...ctx.state, cwd: dir }, line);
  Object.assign(ctx.state, result.state);
  ctx.state.cwd = saved;
  for (const l of result.lines) log.push(l.text);
  return result.exitCode === 0;
}

/** Copies a source tree (files under `from`, or an archive's entries) into a new build directory. */
function stage(state: LabState, dir: string, files: Record<string, string>) {
  addDirWithParents(state.dirs, dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = `${dir}/${rel.replace(/^\.\//, "")}`;
    addDirWithParents(state.dirs, abs.slice(0, abs.lastIndexOf("/")));
    state.files.set(abs, content);
  }
}

function cleanup(state: LabState, dir: string) {
  for (const p of [...state.files.keys()]) if (isWithin(p, dir)) state.files.delete(p);
  for (const d of [...state.dirs]) if (isWithin(d, dir)) state.dirs.delete(d);
}

/** Runs `body` with a throwaway local Docker engine, restoring the learner's afterwards. */
function isolatedDocker<T>(state: LabState, logins: string[], body: () => T): T {
  const saved = structuredClone(state.docker);
  state.docker = { images: new Map(), containers: new Map(), logins: new Set(logins) };
  try {
    return body();
  } finally {
    state.docker = saved;
  }
}

// ---------------------------------------------------------------- CodeBuild

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

/** "type=LINUX_CONTAINER,image=…,privilegedMode=true" */
function shorthand(text: string): Record<string, string> {
  return Object.fromEntries(text.split(",").map((p) => p.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
}

const PHASES = ["install", "pre_build", "build", "post_build"];

export function codebuild(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !CODEBUILD_COMMANDS.includes(sub)) {
    ctx.err(sub ? `aws: 不支援的 codebuild 指令 '${sub}'。支援：${CODEBUILD_COMMANDS.join("、")}` : `usage: aws codebuild <command> [parameters]\n支援：${CODEBUILD_COMMANDS.join("、")}`);
    return 252;
  }
  const opts = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const eq = rest[i].indexOf("=");
    const name = rest[i].startsWith("--") && eq !== -1 ? rest[i].slice(0, eq) : rest[i];
    if (!["--cli-input-json", "--name", "--project-name", "--environment", "--source", "--service-role", "--artifacts", "--ids", "--region", "--output"].includes(name)) {
      ctx.err(`\nUnknown options: ${rest[i]}`);
      return 252;
    }
    const values = eq !== -1 && rest[i].startsWith("--") ? [rest[i].slice(eq + 1)] : rest[i + 1] !== undefined ? [rest[++i]] : [];
    if (name === "--ids") while (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) values.push(rest[++i]);
    opts.set(name, values);
  }
  const opt = (n: string) => opts.get(`--${n}`)?.[0];
  const cb = ctx.state.aws.codebuild;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const projectArn = (n: string) => `arn:aws:codebuild:${ECR_REGION}:${ACCOUNT}:project/${n}`;

  switch (sub) {
    case "create-project": {
      let input: Record<string, unknown> = {};
      const raw = opt("cli-input-json");
      if (raw !== undefined) {
        const text = raw.startsWith("file://") ? ctx.state.files.get(resolvePath(ctx.state.cwd, raw.slice(7))) : raw;
        if (text === undefined) return (ctx.err(`\nError parsing parameter '--cli-input-json': Unable to load paramfile ${raw}`), 252);
        try {
          input = JSON.parse(text);
        } catch {
          return (ctx.err("\nError parsing parameter '--cli-input-json': Invalid JSON"), 252);
        }
      } else {
        input = { name: opt("name"), source: opt("source") && shorthand(opt("source")!), environment: opt("environment") && shorthand(opt("environment")!), serviceRole: opt("service-role") };
      }
      const name = input.name;
      if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9\-_]{1,254}$/.test(name)) return fail(ctx, "InvalidInputException", operation, "專案名稱要以英數字開頭，只能用英數字、- 和 _");
      if (cb.projects.has(name)) return fail(ctx, "ResourceAlreadyExistsException", operation, `Project already exists: ${name}`);
      const source = (input.source ?? {}) as Record<string, string>;
      if (source.type !== "S3" || !source.location) return fail(ctx, "InvalidInputException", operation, "這個模擬終端機的來源支援 S3：\"source\": {\"type\": \"S3\", \"location\": \"bucket/app.zip\"}");
      const env = (input.environment ?? {}) as Record<string, unknown>;
      if (!env.image || !env.computeType || env.type !== "LINUX_CONTAINER") return fail(ctx, "InvalidInputException", operation, "environment 需要 type（LINUX_CONTAINER）、image、computeType");
      if (typeof input.serviceRole !== "string" || !/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(input.serviceRole)) return fail(ctx, "InvalidInputException", operation, "serviceRole 要是 IAM 角色的 ARN，CodeBuild 用它代你存取 S3、ECR、CloudWatch Logs 等");
      const vars = Array.isArray(env.environmentVariables) ? Object.fromEntries((env.environmentVariables as { name: string; value: string }[]).map((v) => [v.name, String(v.value)])) : {};
      cb.projects.set(name, { source: source.location, image: String(env.image), privileged: env.privilegedMode === true || env.privilegedMode === "true", env: vars, serviceRole: input.serviceRole });
      json(ctx, { project: { name, arn: projectArn(name), source: { type: "S3", location: source.location }, environment: { type: "LINUX_CONTAINER", image: env.image, computeType: env.computeType, privilegedMode: cb.projects.get(name)!.privileged }, serviceRole: input.serviceRole } });
      return 0;
    }
    case "update-project": {
      const name = opt("name");
      const p = name ? cb.projects.get(name) : undefined;
      if (!p) return fail(ctx, "ResourceNotFoundException", operation, `Project cannot be found: ${name ?? ""}`);
      const env = opt("environment");
      if (env === undefined) return fail(ctx, "InvalidInputException", operation, "這個模擬終端機的 update-project 支援 --environment type=LINUX_CONTAINER,image=…,computeType=…,privilegedMode=true");
      const e = shorthand(env);
      if (e.type !== "LINUX_CONTAINER" || !e.image || !e.computeType) return fail(ctx, "InvalidInputException", operation, "--environment 要包含 type=LINUX_CONTAINER、image、computeType");
      p.image = e.image;
      p.privileged = e.privilegedMode === "true";
      json(ctx, { project: { name, arn: projectArn(name!), environment: { type: e.type, image: e.image, computeType: e.computeType, privilegedMode: p.privileged } } });
      return 0;
    }
    case "list-projects":
      json(ctx, { projects: [...cb.projects.keys()] });
      return 0;
    case "start-build": {
      const name = opt("project-name");
      const p = name ? cb.projects.get(name) : undefined;
      if (!p) return fail(ctx, "ResourceNotFoundException", operation, `Project cannot be found: ${name ?? ""}`);
      const id = `${name}:${(++cb.counter * 2654435761 >>> 0).toString(16).padStart(8, "0")}-0000-4000-8000-${String(cb.counter).padStart(12, "0")}`;
      const log: string[] = [];
      const steps: BuildRecord["steps"] = [];
      let ok = true;
      const finish = (status: "SUCCEEDED" | "FAILED") => {
        // Commands run during the build replace ctx.state's services, so look them up again.
        ctx.state.aws.codebuild.builds.set(id, { project: name!, status, steps, log });
        const group = `/aws/codebuild/${name}`;
        const g: LogGroup = ctx.state.aws.logs.groups.get(group) ?? { retentionInDays: null, events: [], searches: new Set(), metricFilters: new Map() };
        g.events.push(...log.map((message, i) => ({ stream: id.split(":")[1], timestamp: 1763280000000 + cb.counter * 100000 + i * 1000, message })));
        ctx.state.aws.logs.groups.set(group, g);
        json(ctx, { build: { id, arn: `arn:aws:codebuild:${ECR_REGION}:${ACCOUNT}:build/${id}`, buildNumber: cb.counter, projectName: name, buildStatus: "IN_PROGRESS", currentPhase: "QUEUED" } });
        ctx.out("（模擬終端機：建置立即執行完畢，用 batch-get-builds 看結果）\n");
      };
      // DOWNLOAD_SOURCE: the S3 object must be a zip of the source.
      const [bucket, ...keyParts] = p.source.split("/");
      const archive = ctx.state.s3.get(bucket)?.objects.get(keyParts.join("/"));
      const files = archive === undefined ? null : decodeArchive(archive);
      steps.push({ name: "DOWNLOAD_SOURCE", status: files ? "SUCCEEDED" : "FAILED" });
      if (!files) {
        log.push(`CLIENT_ERROR: no matching artifact paths found（找不到 s3://${p.source}，或它不是 zip 檔）`);
        return (finish("FAILED"), 0);
      }
      const dir = `/codebuild/output/src${cb.counter}/src`;
      stage(ctx.state, dir, files);
      const spec = files["./buildspec.yml"] ?? files["buildspec.yml"];
      let doc: Record<string, unknown> | null = null;
      try {
        doc = spec === undefined ? null : (parseYaml(spec) as Record<string, unknown>);
      } catch {
        doc = null;
      }
      const phases = doc && typeof doc.phases === "object" && doc.phases ? (doc.phases as Record<string, { commands?: string[] }>) : null;
      if (!phases) {
        steps.push({ name: "DOWNLOAD_SOURCE", status: "FAILED" });
        log.push(spec === undefined ? "YAML_FILE_ERROR: stat /codebuild/output/src/buildspec.yml: no such file or directory（來源的根目錄要有 buildspec.yml）" : "YAML_FILE_ERROR: buildspec.yml 格式錯誤，要有 version 和 phases");
        cleanup(ctx.state, dir);
        return (finish("FAILED"), 0);
      }
      // Precedence: project environment variables over the buildspec's env.variables.
      const specEnv = doc && typeof doc.env === "object" && doc.env && typeof (doc.env as Record<string, unknown>).variables === "object" ? ((doc.env as Record<string, unknown>).variables as Record<string, unknown>) : {};
      const vars: Record<string, string> = { AWS_DEFAULT_REGION: ECR_REGION, AWS_REGION: ECR_REGION, CODEBUILD_BUILD_ID: id, CODEBUILD_SRC_DIR: dir };
      for (const [k, v] of Object.entries(specEnv ?? {})) vars[k] = String(v);
      Object.assign(vars, p.env);
      isolatedDocker(ctx.state, [], () => {
        for (const phase of PHASES) {
          const commands = phases[phase]?.commands ?? [];
          if (!ok) break;
          if (!commands.length) continue;
          log.push(`[Container] Entering phase ${phase.toUpperCase()}`);
          for (const raw of commands) {
            const line = expand(String(raw), vars);
            log.push(`[Container] Running command ${String(raw)}`);
            if (/(^|[|;&]\s*)docker\s+(?!login\b)/.test(line) && !p.privileged) {
              log.push("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
              ok = false;
            } else ok = runInBuild(ctx, dir, line, log);
            if (!ok) {
              log.push(`[Container] Command did not exit successfully ${String(raw)} exit status 1`);
              break;
            }
          }
          log.push(`[Container] Phase complete: ${phase.toUpperCase()} State: ${ok ? "SUCCEEDED" : "FAILED"}`);
          steps.push({ name: phase.toUpperCase(), status: ok ? "SUCCEEDED" : "FAILED" });
        }
      });
      cleanup(ctx.state, dir);
      finish(ok ? "SUCCEEDED" : "FAILED");
      return 0;
    }
    case "batch-get-builds": {
      const ids = opts.get("--ids") ?? [];
      json(ctx, {
        builds: ids.filter((i) => cb.builds.has(i)).map((i) => {
          const b = cb.builds.get(i)!;
          return { id: i, projectName: b.project, buildStatus: b.status, phases: b.steps.map((s) => ({ phaseType: s.name, phaseStatus: s.status })), logs: { groupName: `/aws/codebuild/${b.project}`, streamName: i.split(":")[1] } };
        }),
        buildsNotFound: ids.filter((i) => !cb.builds.has(i)),
      });
      return 0;
    }
    default: {
      const name = opt("project-name");
      if (!name || !cb.projects.has(name)) return fail(ctx, "ResourceNotFoundException", operation, `Project cannot be found: ${name ?? ""}`);
      json(ctx, { ids: [...cb.builds].filter(([, b]) => b.project === name).map(([i]) => i).reverse() });
      return 0;
    }
  }
}

// -------------------------------------------------------------- Cloud Build

/** gcloud builds submit | list | log | describe */
export function builds(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.builds.${action}`;
  const opts = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (!["--config", "--substitutions", "--region", "--tag", "--project", "--format", "--limit"].includes(name)) return error(ctx, command, `unrecognized arguments: ${a}`);
      opts.set(name, eq === -1 ? (rest[++i] ?? "") : a.slice(eq + 1));
    } else positional.push(a);
  }
  const cloud = ctx.state.gcp.cloudbuild;
  const project = ctx.state.gcp.project;
  if (action === "list") {
    table(ctx, ["ID", "STATUS", "STEPS"], [...cloud.builds].reverse().map(([id, b]) => [id, b.status, b.steps.map((s) => `${s.name}:${s.status}`).join(" ")]));
    return 0;
  }
  if (action === "log" || action === "describe") {
    const b = cloud.builds.get(positional[0] ?? "");
    if (!b) return error(ctx, command, `NOT_FOUND: Requested entity was not found.（用 gcloud builds list 查建置 ID）`);
    if (action === "log") ctx.out(`${b.log.join("\n")}\n`);
    else ctx.out(`id: ${positional[0]}\nstatus: ${b.status}\nsteps:\n${b.steps.map((s) => `- name: ${s.name}\n  status: ${s.status}\n`).join("")}`);
    return 0;
  }
  if (action !== "submit") return error(ctx, "gcloud.builds", `不支援的指令 '${action ?? ""}'。這個模擬終端機支援 gcloud builds submit、list、log、describe。`);
  if (opts.has("--tag")) return error(ctx, command, "這個模擬終端機的 builds submit 請用 --config=cloudbuild.yaml 指定建置設定。");
  const sourceDir = resolvePath(ctx.state.cwd, positional[0] ?? ".");
  if (!ctx.state.dirs.has(sourceDir)) return error(ctx, command, `could not find source [${positional[0]}]`);
  const configPath = resolvePath(ctx.state.cwd, opts.get("--config") ?? "cloudbuild.yaml");
  const configText = ctx.state.files.get(configPath);
  if (configText === undefined) return error(ctx, command, `Unable to read file [${opts.get("--config") ?? "cloudbuild.yaml"}]: No such file or directory`);
  let config: { steps?: unknown; images?: unknown; substitutions?: unknown };
  try {
    config = parseYaml(configText) ?? {};
  } catch (e) {
    return error(ctx, command, `parsing ${opts.get("--config") ?? "cloudbuild.yaml"}: ${(e as Error).message.split("\n")[0]}`);
  }
  const steps = Array.isArray(config.steps) ? (config.steps as { name?: string; args?: unknown[]; entrypoint?: string; id?: string }[]) : [];
  if (!steps.length) return error(ctx, command, "INVALID_ARGUMENT: invalid build: Build must have at least one step.");
  const userSubs: Record<string, string> = typeof config.substitutions === "object" && config.substitutions ? Object.fromEntries(Object.entries(config.substitutions as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {};
  for (const pair of list(opts.get("--substitutions"))) {
    const [k, ...v] = pair.split("=");
    if (k === "PROJECT_ID" || k === "BUILD_ID") return error(ctx, command, `INVALID_ARGUMENT: invalid build: ${k} 不能覆寫`);
    if (!/^_[A-Z0-9_]+$/.test(k)) return error(ctx, command, `INVALID_ARGUMENT: invalid build: invalid substitution key "${k}"（自訂的替代變數要以 _ 開頭，只能用大寫字母、數字和底線）`);
    userSubs[k] = v.join("=").replace(/^"|"$/g, "");
  }
  const id = `${(++cloud.counter * 2654435761 >>> 0).toString(16).padStart(8, "0")}-1d2c-4b3a-9e8f-${String(cloud.counter).padStart(12, "0")}`;
  const location = opts.get("--region") ?? "global";
  const vars: Record<string, string> = { PROJECT_ID: project, BUILD_ID: id, PROJECT_NUMBER: "498765432109", ...userSubs };
  // Without ALLOW_LOOSE, a $_NAME with no value fails the build request.
  for (const s of steps) {
    for (const a of Array.isArray(s.args) ? s.args : []) {
      const missing = String(a).match(/\$\{?(_[A-Z0-9_]+)/g)?.map((m) => m.replace(/^\$\{?/, "")).find((k) => !(k in vars));
      if (missing) return error(ctx, command, `INVALID_ARGUMENT: generic::invalid_argument: key in the template "${missing}" is not matched in the substitution list（在 substitutions 區塊或 --substitutions 給它一個值）`);
    }
  }
  const log: string[] = [`BUILD`, `Fetching storage object: gs://${project}_cloudbuild/source/${id}.tgz`];
  const record: BuildRecord = { status: "SUCCESS", steps: [], log };
  const dir = `/workspace-${cloud.counter}`;
  const files: Record<string, string> = {};
  for (const [p, c] of ctx.state.files) if (isWithin(p, sourceDir)) files[p.slice(sourceDir.length + 1)] = c;
  ctx.out(`Creating temporary archive of ${Object.keys(files).length} file(s) totalling ${Object.values(files).join("").length} bytes before compression.\nUploading tarball of [${positional[0] ?? "."}] to [gs://${project}_cloudbuild/source/${id}.tgz]\nCreated [https://cloudbuild.googleapis.com/v1/projects/${project}/locations/${location}/builds/${id}].\n`);
  stage(ctx.state, dir, files);
  // Cloud Build's service account can push to this project's Artifact Registry.
  const registries = [...new Set(expand(configText, vars).match(/[a-z0-9-]+-docker\.pkg\.dev/g) ?? [])];
  let ok = true;
  isolatedDocker(ctx.state, registries, () => {
    steps.forEach((s, i) => {
      const name = String(s.name ?? "");
      const label = `Step #${i}${s.id ? ` - "${s.id}"` : ""}`;
      if (!ok) {
        record.steps.push({ name, status: "QUEUED" });
        return;
      }
      const stepArgs = (Array.isArray(s.args) ? s.args : []).map((a) => expand(String(a), vars));
      let program: string | null = null;
      if (name === "gcr.io/cloud-builders/docker") program = "docker";
      else if (name === "gcr.io/cloud-builders/gcloud" || (name.startsWith("gcr.io/google.com/cloudsdktool/") && s.entrypoint === "gcloud")) program = "gcloud";
      log.push(`${label}: Already have image (with digest): ${name}`);
      if (!program) {
        log.push(`${label}: 這個模擬終端機的 Cloud Build 只支援 docker（gcr.io/cloud-builders/docker）和 gcloud 步驟`);
        ok = false;
      } else {
        const stepLog: string[] = [];
        ok = runInBuild(ctx, dir, [program, ...stepArgs].map(quote).join(" "), stepLog);
        log.push(...stepLog.map((l) => `${label}: ${l}`));
      }
      record.steps.push({ name, status: ok ? "SUCCESS" : "FAILURE" });
      if (!ok) log.push(`ERROR: build step ${i} "${name}" failed: step exited with non-zero status: 1`);
    });
    if (ok && Array.isArray(config.images)) {
      log.push("PUSH");
      for (const image of config.images) {
        const stepLog: string[] = [];
        ok = runInBuild(ctx, dir, `docker push ${quote(expand(String(image), vars))}`, stepLog) && ok;
        log.push(...stepLog);
      }
    }
  });
  cleanup(ctx.state, dir);
  record.status = ok ? "SUCCESS" : "FAILURE";
  log.push("DONE");
  // Steps replace ctx.state's services, so look the store up again.
  ctx.state.gcp.cloudbuild.builds.set(id, record);
  if (!ok) {
    ctx.err(`ERROR: (gcloud.builds.submit) build ${id} completed with status "FAILURE"\n（用 gcloud builds log ${id} 看哪個步驟失敗）`);
    return 1;
  }
  table(ctx, ["ID", "STATUS"], [[id, "SUCCESS"]]);
  return 0;
}
