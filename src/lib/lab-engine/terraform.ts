import type { Command, Ctx } from "./context";
import { HclError, parseHcl, type Block, type Expr } from "./hcl";
import { addDirWithParents, type LabState } from "./state";

const PROVIDER_VERSIONS: Record<string, string> = { google: "6.12.0", aws: "5.80.0" };

type Value = string | number | boolean | null | Value[] | { [k: string]: Value };
const UNKNOWN = "(known after apply)";

/** What each supported resource type accepts and how it maps onto the simulated cloud. */
interface ResourceType {
  provider: "google" | "aws";
  required: string[];
  defaults: Record<string, Value>;
  /** Changing these destroys and recreates the resource. */
  forceNew: string[];
  /** Attributes only known after apply. */
  computed: (attrs: Record<string, Value>) => Record<string, Value>;
  id: (attrs: Record<string, Value>) => string;
  exists: (state: LabState, attrs: Record<string, Value>) => boolean;
  /** Creates or updates the real object; returns an error message on failure. */
  write: (state: LabState, attrs: Record<string, Value>, creating: boolean) => string | null;
  remove: (state: LabState, attrs: Record<string, Value>) => string | null;
}

const GCS_NAME = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const STORAGE_CLASSES = ["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"];

const TYPES: Record<string, ResourceType> = {
  google_storage_bucket: {
    provider: "google",
    required: ["name", "location"],
    defaults: { storage_class: "STANDARD", force_destroy: false },
    forceNew: ["name", "location"],
    computed: (a) => ({ url: `gs://${a.name}`, self_link: `https://www.googleapis.com/storage/v1/b/${a.name}` }),
    id: (a) => String(a.name),
    exists: (s, a) => s.gcs.has(String(a.name)),
    write: (s, a, creating) => {
      const name = String(a.name);
      if (!GCS_NAME.test(name)) return `googleapi: Error 400: Invalid bucket name: '${name}', invalid`;
      if (!STORAGE_CLASSES.includes(String(a.storage_class))) return `expected storage_class to be one of ${JSON.stringify(STORAGE_CLASSES)}, got ${a.storage_class}`;
      if (creating && s.gcs.has(name)) return `googleapi: Error 409: Your previous request to create the named bucket succeeded and you already own it., conflict\n（bucket ${name} 已經存在，但不在 Terraform 的狀態裡；可以用 terraform import 納入管理）`;
      const existing = s.gcs.get(name);
      s.gcs.set(name, { location: String(a.location).toLowerCase(), storageClass: String(a.storage_class), objects: existing?.objects ?? new Map() });
      return null;
    },
    remove: (s, a) => {
      const b = s.gcs.get(String(a.name));
      if (b && b.objects.size && a.force_destroy !== true) return `Error trying to delete bucket ${a.name} containing objects without \`force_destroy\` set to true`;
      s.gcs.delete(String(a.name));
      return null;
    },
  },
  aws_s3_bucket: {
    provider: "aws",
    required: ["bucket"],
    defaults: { force_destroy: false },
    forceNew: ["bucket"],
    computed: (a) => ({ arn: `arn:aws:s3:::${a.bucket}`, bucket_domain_name: `${a.bucket}.s3.amazonaws.com` }),
    id: (a) => String(a.bucket),
    exists: (s, a) => s.s3.has(String(a.bucket)),
    write: (s, a, creating) => {
      const name = String(a.bucket);
      if (creating && s.s3.has(name)) return `creating S3 Bucket (${name}): BucketAlreadyOwnedByYou`;
      if (!s.s3.has(name)) s.s3.set(name, { location: "us-east-1", storageClass: "STANDARD", objects: new Map() });
      return null;
    },
    remove: (s, a) => {
      const b = s.s3.get(String(a.bucket));
      if (b && b.objects.size && a.force_destroy !== true) return `deleting S3 Bucket (${a.bucket}): BucketNotEmpty: The bucket you tried to delete is not empty`;
      s.s3.delete(String(a.bucket));
      return null;
    },
  },
};

export interface TfWorkspace {
  initialized: boolean;
  resources: Map<string, { type: string; attrs: Record<string, Value> }>;
  outputs: Record<string, Value>;
  /** Times a resource deleted outside Terraform was created again by apply. */
  driftRepairs: number;
  applies: number;
}

interface Config {
  resources: Map<string, { type: string; name: string; block: Block }>;
  variables: Map<string, Expr | undefined>;
  outputs: Map<string, Expr>;
  providers: Set<string>;
}

function loadConfig(state: LabState, dir: string): Config | string {
  const files = [...state.files].filter(([p]) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/") && p.endsWith(".tf"));
  if (!files.length) return "Error: No configuration files\n\nApply requires configuration to be present. 目前目錄沒有 .tf 檔，先 cd 到放 Terraform 設定的目錄。";
  const config: Config = { resources: new Map(), variables: new Map(), outputs: new Map(), providers: new Set() };
  for (const [path, text] of files) {
    let blocks: Block[];
    try {
      blocks = parseHcl(text);
    } catch (e) {
      if (e instanceof HclError) return `Error: ${e.message}\n\n  on ${path.slice(dir.length + 1)} line ${e.line}`;
      throw e;
    }
    for (const b of blocks) {
      const where = `\n\n  on ${path.slice(dir.length + 1)} line ${b.line}`;
      if (b.type === "resource") {
        const [type, name] = b.labels;
        if (!type || !name || b.labels.length !== 2) return `Error: Missing name for resource\n\nAll resource blocks must have 2 labels (type, name).${where}`;
        if (!TYPES[type]) return `Error: Invalid resource type\n\nThe provider does not support resource type "${type}".（這個模擬終端機支援 ${Object.keys(TYPES).join("、")}）${where}`;
        const addr = `${type}.${name}`;
        if (config.resources.has(addr)) return `Error: Duplicate resource "${type}" configuration\n\nA ${type} resource named "${name}" was already declared.${where}`;
        config.resources.set(addr, { type, name, block: b });
        config.providers.add(TYPES[type].provider);
      } else if (b.type === "variable") {
        config.variables.set(b.labels[0], b.attributes.get("default"));
      } else if (b.type === "output") {
        const value = b.attributes.get("value");
        if (!value) return `Error: Missing required argument\n\nThe argument "value" is required, but no definition was found.${where}`;
        config.outputs.set(b.labels[0], value);
      } else if (b.type === "provider") {
        if (!PROVIDER_VERSIONS[b.labels[0]]) return `Error: 這個模擬終端機支援的 provider：google、aws${where}`;
        config.providers.add(b.labels[0]);
      } else if (b.type !== "terraform" && b.type !== "locals") {
        return `Error: Unsupported block type\n\nBlocks of type "${b.type}" are not expected here.${where}`;
      }
    }
  }
  return config;
}

/** Evaluates an expression; resource attributes come from `known` (null when not known yet). */
function evaluate(expr: Expr, vars: Record<string, Value>, known: (addr: string, attr: string) => Value | undefined): Value {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "list":
      return expr.items.map((i) => evaluate(i, vars, known));
    case "object":
      return Object.fromEntries(expr.entries.map(([k, v]) => [k, evaluate(v, vars, known)]));
    case "template": {
      const parts = expr.parts.map((p) => (typeof p === "string" ? p : evaluate(p, vars, known)));
      return parts.some((p) => p === UNKNOWN) ? UNKNOWN : parts.map((p) => String(p)).join("");
    }
    case "ref": {
      const [root, ...rest] = expr.path;
      if (root === "var") {
        if (!(rest[0] in vars)) throw new Error(`Reference to undeclared input variable "${rest[0]}"`);
        return vars[rest[0]];
      }
      if (rest.length < 2) throw new Error(`Invalid reference: "${expr.path.join(".")}"`);
      const value = known(`${root}.${rest[0]}`, rest[1]);
      if (value === undefined) throw new Error(`Reference to undeclared resource "${root}.${rest[0]}"`);
      return value;
    }
  }
}

type Action = "create" | "update" | "replace" | "delete" | "noop";
interface Change {
  addr: string;
  type: string;
  action: Action;
  before: Record<string, Value> | null;
  after: Record<string, Value> | null;
  drifted: boolean;
}

function plan(state: LabState, ws: TfWorkspace, config: Config, vars: Record<string, Value>, destroy: boolean): Change[] | string {
  const changes: Change[] = [];
  const planned = new Map<string, Record<string, Value>>();
  const known = (addr: string, attr: string): Value | undefined => {
    const p = planned.get(addr);
    if (p) return attr in p ? p[attr] : UNKNOWN;
    if (!config.resources.has(addr)) return undefined;
    return UNKNOWN;
  };
  if (!destroy) {
    for (const [addr, r] of config.resources) {
      const t = TYPES[r.type];
      const attrs: Record<string, Value> = { ...t.defaults };
      try {
        for (const [k, e] of r.block.attributes) attrs[k] = evaluate(e, vars, known);
      } catch (e) {
        return `Error: ${(e as Error).message}\n\n  on resource "${r.type}" "${r.name}"`;
      }
      for (const req of t.required) {
        if (attrs[req] === undefined || attrs[req] === null) return `Error: Missing required argument\n\n  on resource "${r.type}" "${r.name}":\nThe argument "${req}" is required, but no definition was found.`;
      }
      const current = ws.resources.get(addr);
      const drifted = !!current && !t.exists(state, current.attrs);
      let action: Action;
      if (!current || drifted) action = "create";
      else if (t.forceNew.some((k) => JSON.stringify(current.attrs[k]) !== JSON.stringify(attrs[k]))) action = "replace";
      else if (Object.keys(attrs).some((k) => JSON.stringify(current.attrs[k]) !== JSON.stringify(attrs[k]))) action = "update";
      else action = "noop";
      // Attributes the provider computes are unknown until a new object exists.
      const computed = t.computed(attrs);
      const fresh = action === "create" || action === "replace";
      const full = { ...attrs, ...(fresh ? Object.fromEntries(Object.keys(computed).map((k) => [k, UNKNOWN])) : computed) };
      planned.set(addr, full);
      changes.push({ addr, type: r.type, action, before: current && !drifted ? current.attrs : null, after: full, drifted });
    }
  }
  for (const [addr, r] of ws.resources) {
    if (destroy || !config.resources.has(addr)) {
      const gone = !TYPES[r.type].exists(state, r.attrs);
      if (!gone) changes.push({ addr, type: r.type, action: "delete", before: r.attrs, after: null, drifted: false });
    }
  }
  return changes;
}

const show = (v: Value): string => (typeof v === "string" ? (v === UNKNOWN ? v : `"${v}"`) : JSON.stringify(v));

function renderPlan(ctx: Ctx, changes: Change[]): { add: number; change: number; destroy: number } {
  const counts = { add: 0, change: 0, destroy: 0 };
  const drifted = changes.filter((c) => c.drifted);
  if (drifted.length) {
    ctx.out(`\nNote: Objects have changed outside of Terraform\n\nTerraform detected the following changes made outside of Terraform since the last "terraform apply":\n\n${drifted.map((c) => `  # ${c.addr} has been deleted\n`).join("")}\n`);
  }
  const real = changes.filter((c) => c.action !== "noop");
  if (!real.length) {
    ctx.out(`\nNo changes. Your infrastructure matches the configuration.\n\nTerraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.\n`);
    return counts;
  }
  ctx.out("\nTerraform will perform the following actions:\n\n");
  for (const c of real) {
    const [type, name] = c.addr.split(".");
    if (c.action === "create") {
      counts.add++;
      const keys = Object.keys(c.after!).sort();
      const width = Math.max(...keys.map((k) => k.length));
      ctx.out(`  # ${c.addr} will be created\n  + resource "${type}" "${name}" {\n${keys.map((k) => `      + ${k.padEnd(width)} = ${show(c.after![k])}\n`).join("")}    }\n\n`);
    } else if (c.action === "delete") {
      counts.destroy++;
      ctx.out(`  # ${c.addr} will be destroyed\n  - resource "${type}" "${name}" {\n${Object.keys(c.before!).sort().map((k) => `      - ${k} = ${show(c.before![k])} -> null\n`).join("")}    }\n\n`);
    } else {
      const diff = Object.keys(c.after!).filter((k) => c.after![k] !== UNKNOWN && JSON.stringify(c.before![k]) !== JSON.stringify(c.after![k]));
      const forceNew = TYPES[c.type].forceNew;
      if (c.action === "replace") {
        counts.add++;
        counts.destroy++;
      } else counts.change++;
      ctx.out(
        `  # ${c.addr} ${c.action === "replace" ? "must be replaced" : "will be updated in-place"}\n  ${c.action === "replace" ? "-/+" : "~"} resource "${type}" "${name}" {\n${diff
          .map((k) => `      ~ ${k} = ${show(c.before![k] ?? null)} -> ${show(c.after![k])}${c.action === "replace" && forceNew.includes(k) ? " # forces replacement" : ""}\n`)
          .join("")}    }\n\n`,
      );
    }
  }
  ctx.out(`Plan: ${counts.add} to add, ${counts.change} to change, ${counts.destroy} to destroy.\n`);
  return counts;
}

function stateFile(ws: TfWorkspace): string {
  return `${JSON.stringify(
    {
      version: 4,
      terraform_version: "1.10.0",
      serial: ws.applies,
      outputs: Object.fromEntries(Object.entries(ws.outputs).map(([k, v]) => [k, { value: v, type: typeof v }])),
      resources: [...ws.resources].map(([addr, r]) => ({
        mode: "managed",
        type: r.type,
        name: addr.split(".")[1],
        provider: `provider["registry.terraform.io/hashicorp/${TYPES[r.type].provider}"]`,
        instances: [{ attributes: { id: TYPES[r.type].id(r.attrs), ...r.attrs } }],
      })),
    },
    null,
    2,
  )}\n`;
}

/** Parses -var 'k=v' / -var=k=v and -auto-approve. */
function flags(args: string[]): { vars: Record<string, string>; auto: boolean; rest: string[]; raw: boolean; bad?: string } {
  const vars: Record<string, string> = {};
  const rest: string[] = [];
  let auto = false;
  let raw = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-auto-approve" || a === "--auto-approve") auto = true;
    else if (a === "-raw") raw = true;
    else if (a === "-var" || a.startsWith("-var=")) {
      const pair = a === "-var" ? args[++i] : a.slice(5);
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) return { vars, auto, rest, raw, bad: `Error: Invalid -var option\n\nThe given -var option "${pair ?? ""}" is not correctly specified. Must be a variable name and value separated by an equals sign, like -var="key=value".` };
      vars[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (a.startsWith("-")) return { vars, auto, rest, raw, bad: `Error: Failed to parse command-line flags\n\nflag provided but not defined: ${a}` };
    else rest.push(a);
  }
  return { vars, auto, rest, raw };
}

export const terraform: Command = (ctx, args) => {
  const [sub, ...more] = args;
  const dir = ctx.state.cwd;
  const ws: TfWorkspace = ctx.state.terraform.get(dir) ?? { initialized: false, resources: new Map(), outputs: {}, driftRepairs: 0, applies: 0 };
  const fail = (message: string) => {
    ctx.err(message);
    return 1;
  };
  const f = flags(more);
  if (f.bad) return fail(f.bad);
  if (sub === "version" || sub === "-version") {
    ctx.out("Terraform v1.10.0（模擬終端機）\n");
    return 0;
  }
  if (!sub || !["init", "validate", "fmt", "plan", "apply", "destroy", "output", "state"].includes(sub)) {
    return fail(`Terraform has no command named "${sub ?? ""}".\n\n這個模擬終端機支援 terraform init、validate、fmt、plan、apply、destroy、output、state list、state show。`);
  }
  const config = loadConfig(ctx.state, dir);
  if (typeof config === "string" && sub !== "output" && sub !== "state") return fail(config);

  if (sub === "init") {
    const cfg = config as Config;
    const providers = [...cfg.providers].sort();
    ctx.out(
      `Initializing the backend...\n\nInitializing provider plugins...\n${providers
        .map((p) => `- Finding latest version of hashicorp/${p}...\n- Installing hashicorp/${p} v${PROVIDER_VERSIONS[p]}...\n- Installed hashicorp/${p} v${PROVIDER_VERSIONS[p]} (signed by HashiCorp)\n`)
        .join("")}\nTerraform has created a lock file .terraform.lock.hcl to record the provider\nselections it made above. Include this file in your version control repository\nso that Terraform can guarantee to make the same selections by default when\nyou run "terraform init" in the future.\n\nTerraform has been successfully initialized!\n`,
    );
    ws.initialized = true;
    addDirWithParents(ctx.state.dirs, `${dir}/.terraform`);
    ctx.state.files.set(`${dir}/.terraform.lock.hcl`, providers.map((p) => `provider "registry.terraform.io/hashicorp/${p}" {\n  version = "${PROVIDER_VERSIONS[p]}"\n}\n`).join("\n"));
    ctx.state.terraform.set(dir, ws);
    return 0;
  }
  if (sub === "fmt") return 0;
  const needInit = () =>
    fail(`Error: Inconsistent dependency lock file\n\nThe following dependency selections recorded in the lock file are inconsistent\nwith the current configuration:\n  - provider registry.terraform.io/hashicorp/${[...(config as Config).providers][0] ?? "google"}: required by this configuration but no version is selected\n\nTo make the initial dependency selections that will initialize the dependency\nlock file, run:\n  terraform init`);
  if (sub === "validate") {
    if (!ws.initialized) return needInit();
    ctx.out("Success! The configuration is valid.\n");
    return 0;
  }
  if (sub === "output") {
    const name = f.rest[0];
    if (name !== undefined) {
      if (!(name in ws.outputs)) return fail(`╷\n│ Error: Output "${name}" not found\n╵`);
      ctx.out(`${f.raw ? String(ws.outputs[name]) : show(ws.outputs[name])}\n`);
      return 0;
    }
    if (!Object.keys(ws.outputs).length) {
      ctx.err("╷\n│ Warning: No outputs found\n╵");
      return 0;
    }
    ctx.out(Object.entries(ws.outputs).map(([k, v]) => `${k} = ${show(v)}\n`).join(""));
    return 0;
  }
  if (sub === "state") {
    const [action, addr] = f.rest;
    if (action === "list") {
      ctx.out([...ws.resources.keys()].map((a) => `${a}\n`).join(""));
      return 0;
    }
    if (action === "show") {
      const r = addr ? ws.resources.get(addr) : undefined;
      if (!r) return fail(`No instance found for the given address!\n\nThis command requires that the address references one specific instance.`);
      const [type, name] = addr!.split(".");
      const keys = Object.keys(r.attrs).sort();
      const width = Math.max(...keys.map((k) => k.length), 2);
      ctx.out(`# ${addr}:\nresource "${type}" "${name}" {\n    ${"id".padEnd(width)} = "${TYPES[type].id(r.attrs)}"\n${keys.map((k) => `    ${k.padEnd(width)} = ${show(r.attrs[k])}\n`).join("")}}\n`);
      return 0;
    }
    return fail("這個模擬終端機支援 terraform state list 和 terraform state show 位址。");
  }

  // plan / apply / destroy
  const cfg = config as Config;
  if (!ws.initialized) return needInit();
  const vars: Record<string, Value> = {};
  for (const [name, def] of cfg.variables) {
    if (name in f.vars) vars[name] = f.vars[name];
    else if (def) vars[name] = evaluate(def, {}, () => undefined);
    else return fail(`╷\n│ Error: No value for required variable\n│\n│ The root module input variable "${name}" is not set, and has no default value.\n│ Use a -var or -var-file command line argument to provide a value for this variable.\n╵`);
  }
  const unknownVar = Object.keys(f.vars).find((v) => !cfg.variables.has(v));
  if (unknownVar) return fail(`╷\n│ Error: Value for undeclared variable\n│\n│ A variable named "${unknownVar}" was given on the command line, but a variable of that name has not been declared.\n╵`);
  const changes = plan(ctx.state, ws, cfg, vars, sub === "destroy");
  if (typeof changes === "string") return fail(changes);
  const counts = renderPlan(ctx, changes);
  if (sub === "plan") {
    ctx.state.terraform.set(dir, ws);
    if (counts.add + counts.change + counts.destroy) ctx.out(`\nNote: You didn't use the -out option to save this plan, so Terraform can't guarantee to take exactly these actions if you run "terraform apply" now.\n`);
    return 0;
  }
  if (!f.auto && counts.add + counts.change + counts.destroy) {
    ctx.out(`\nDo you want to ${sub === "destroy" ? "really destroy all resources" : "perform these actions"}?\n  Terraform will perform the actions described above.\n  Only 'yes' will be accepted to approve.\n\n  Enter a value:\n`);
    return fail(`（模擬終端機不能互動輸入 yes，這次沒有執行任何變更。請加上 -auto-approve 再執行一次）`);
  }
  ctx.out("\n");
  for (const c of changes) {
    const t = TYPES[c.type];
    if (c.action === "noop") continue;
    if (c.action === "delete" || c.action === "replace") {
      ctx.out(`${c.addr}: Destroying... [id=${t.id(c.before!)}]\n`);
      const problem = t.remove(ctx.state, c.before!);
      if (problem) return fail(`╷\n│ Error: ${problem}\n╵`);
      ws.resources.delete(c.addr);
      ctx.out(`${c.addr}: Destruction complete after 1s\n`);
    }
    if (c.action === "create" || c.action === "replace" || c.action === "update") {
      const config = Object.fromEntries(Object.entries(c.after!).filter(([, v]) => v !== UNKNOWN));
      const attrs = { ...config, ...t.computed(config) };
      ctx.out(`${c.addr}: ${c.action === "update" ? "Modifying" : "Creating"}...\n`);
      const problem = t.write(ctx.state, attrs, c.action !== "update");
      if (problem) {
        ctx.state.terraform.set(dir, ws);
        ctx.state.files.set(`${dir}/terraform.tfstate`, stateFile(ws));
        return fail(`╷\n│ Error: ${problem}\n│\n│   with ${c.addr},\n╵`);
      }
      ws.resources.set(c.addr, { type: c.type, attrs });
      if (c.drifted) ws.driftRepairs++;
      ctx.out(`${c.addr}: ${c.action === "update" ? "Modifications complete" : "Creation complete"} after 1s [id=${t.id(attrs)}]\n`);
    }
  }
  if (sub === "destroy") ws.outputs = {};
  else {
    const known = (addr: string, attr: string) => ws.resources.get(addr)?.attrs[attr] ?? (cfg.resources.has(addr) ? null : undefined);
    ws.outputs = Object.fromEntries([...cfg.outputs].map(([k, e]) => [k, evaluate(e, vars, known)]));
  }
  ws.applies++;
  ctx.state.terraform.set(dir, ws);
  ctx.state.files.set(`${dir}/terraform.tfstate`, stateFile(ws));
  ctx.out(
    `\n${sub === "destroy" ? `Destroy complete! Resources: ${counts.destroy} destroyed.` : `Apply complete! Resources: ${counts.add} added, ${counts.change} changed, ${counts.destroy} destroyed.`}\n${
      Object.keys(ws.outputs).length ? `\nOutputs:\n\n${Object.entries(ws.outputs).map(([k, v]) => `${k} = ${show(v)}\n`).join("")}` : ""
    }`,
  );
  return 0;
};
