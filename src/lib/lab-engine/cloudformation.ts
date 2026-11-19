import { parse as parseYaml, type Tags } from "yaml";
import type { Ctx } from "./context";
import { ACCOUNT, ECR_REGION as REGION } from "./docker";
import { resolvePath, type CfnChange, type CfnJson, type CfnStack, type LabState } from "./state";

export const CLOUDFORMATION_COMMANDS = [
  "validate-template", "create-stack", "describe-stacks", "describe-stack-events", "describe-stack-resources", "create-change-set",
  "describe-change-set", "execute-change-set", "detect-stack-drift", "describe-stack-resource-drifts", "delete-stack",
];

type Json = CfnJson;
type Obj = { [k: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** YAML short forms of the intrinsic functions. */
const TAGS: Tags = [
  { tag: "!Ref", resolve: (v: string) => ({ Ref: v }) },
  { tag: "!Sub", resolve: (v: string) => ({ "Fn::Sub": v }) },
  { tag: "!GetAtt", resolve: (v: string) => ({ "Fn::GetAtt": v.split(".") }) },
  { tag: "!Sub", collection: "seq", resolve: (v: unknown) => ({ "Fn::Sub": (v as { toJSON(): Json }).toJSON() }) },
  { tag: "!GetAtt", collection: "seq", resolve: (v: unknown) => ({ "Fn::GetAtt": (v as { toJSON(): Json }).toJSON() }) },
] as Tags;

/** How each supported resource type is named, referenced and checked. */
interface ResourceType {
  nameProperty: string;
  /** Ref returns this; GetAtt attributes are computed from the physical id. */
  ref: (physical: string) => string;
  attrs: (physical: string) => Record<string, string>;
  generate: (stack: string, logical: string, suffix: string) => string;
  exists: (state: LabState, physical: string) => boolean;
  create: (state: LabState, physical: string, props: Obj) => string | null;
  update: (state: LabState, physical: string, props: Obj) => void;
  remove: (state: LabState, physical: string) => void;
  /** Property differences between the template and the real resource (drift). */
  drift: (state: LabState, physical: string, props: Obj) => { path: string; expected: string; actual: string }[];
  /** Properties whose change needs a new resource. */
  replaceOn: string[];
}

const topicArn = (name: string) => `arn:aws:sns:${REGION}:${ACCOUNT}:${name}`;

const TYPES: Record<string, ResourceType> = {
  "AWS::S3::Bucket": {
    nameProperty: "BucketName",
    ref: (p) => p,
    attrs: (p) => ({ Arn: `arn:aws:s3:::${p}`, DomainName: `${p}.s3.amazonaws.com` }),
    generate: (stack, logical, suffix) => `${stack}-${logical}-${suffix}`.toLowerCase().slice(0, 63),
    exists: (s, p) => s.s3.has(p),
    create: (s, p) => {
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(p)) return `Bucket name should not contain uppercase characters（${p}）`;
      if (s.s3.has(p)) return `${p} already exists`;
      s.s3.set(p, { location: REGION, storageClass: "STANDARD", objects: new Map() });
      return null;
    },
    update: () => {},
    remove: (s, p) => void s.s3.delete(p),
    drift: () => [],
    replaceOn: ["BucketName"],
  },
  "AWS::SNS::Topic": {
    nameProperty: "TopicName",
    ref: topicArn,
    attrs: (p) => ({ TopicArn: topicArn(p), TopicName: p }),
    generate: (stack, logical, suffix) => `${stack}-${logical}-${suffix.toUpperCase()}`,
    exists: (s, p) => s.aws.sns.topics.has(p),
    create: (s, p) => {
      if (s.aws.sns.topics.has(p)) return `${p} already exists in stack`;
      s.aws.sns.topics.set(p, { subscriptions: new Map(), published: 0 });
      return null;
    },
    update: () => {},
    remove: (s, p) => void s.aws.sns.topics.delete(p),
    drift: () => [],
    replaceOn: ["TopicName"],
  },
  "AWS::Logs::LogGroup": {
    nameProperty: "LogGroupName",
    ref: (p) => p,
    attrs: (p) => ({ Arn: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${p}:*` }),
    generate: (stack, logical, suffix) => `${stack}-${logical}-${suffix}`,
    exists: (s, p) => s.aws.logs.groups.has(p),
    create: (s, p, props) => {
      if (s.aws.logs.groups.has(p)) return `Resource of type 'AWS::Logs::LogGroup' with identifier '${p}' already exists.`;
      s.aws.logs.groups.set(p, { retentionInDays: props.RetentionInDays === undefined ? null : Number(props.RetentionInDays), events: [], searches: new Set(), metricFilters: new Map() });
      return null;
    },
    update: (s, p, props) => {
      const g = s.aws.logs.groups.get(p);
      if (g) g.retentionInDays = props.RetentionInDays === undefined ? null : Number(props.RetentionInDays);
    },
    remove: (s, p) => void s.aws.logs.groups.delete(p),
    drift: (s, p, props) => {
      const g = s.aws.logs.groups.get(p)!;
      const expected = props.RetentionInDays === undefined ? null : Number(props.RetentionInDays);
      return g.retentionInDays === expected ? [] : [{ path: "/RetentionInDays", expected: String(expected), actual: String(g.retentionInDays) }];
    },
    replaceOn: ["LogGroupName"],
  },
};

function hash(text: string, length: number): string {
  let x = 2166136261;
  for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 16777619) >>> 0;
  let out = "";
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += "abcdefghijklmnopqrstuvwxyz0123456789"[(x >>> 16) % 36];
  }
  return out;
}

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

interface Template {
  parameters: Map<string, { default?: string; allowed?: string[]; description: string }>;
  resources: Map<string, { type: string; props: Obj; deletionPolicy: string }>;
  outputs: Map<string, Json>;
}

function loadTemplate(text: string): Template | string {
  let doc: unknown;
  try {
    doc = parseYaml(text, { customTags: TAGS });
  } catch (e) {
    return `Template format error: YAML not well-formed. ${(e as Error).message.split("\n")[0]}`;
  }
  if (!isObj(doc)) return "Template format error: 範本要是 YAML 或 JSON 物件";
  if (!isObj(doc.Resources) || !Object.keys(doc.Resources).length) return "Template format error: At least one Resources member must be defined.";
  const t: Template = { parameters: new Map(), resources: new Map(), outputs: new Map() };
  for (const [name, p] of Object.entries(isObj(doc.Parameters) ? doc.Parameters : {})) {
    if (!isObj(p) || p.Type !== "String") return `Template format error: Parameter ${name}：這個模擬終端機只支援 Type: String 的參數`;
    t.parameters.set(name, {
      default: p.Default === undefined ? undefined : String(p.Default),
      allowed: Array.isArray(p.AllowedValues) ? p.AllowedValues.map(String) : undefined,
      description: typeof p.Description === "string" ? p.Description : "",
    });
  }
  for (const [name, r] of Object.entries(doc.Resources)) {
    if (!isObj(r) || typeof r.Type !== "string") return `Template format error: [/Resources/${name}] Every Resources object must contain a Type member.`;
    if (!TYPES[r.Type]) return `Template format error: Unrecognized resource types: [${r.Type}]（這個模擬終端機支援 ${Object.keys(TYPES).join("、")}）`;
    t.resources.set(name, { type: r.Type, props: isObj(r.Properties) ? r.Properties : {}, deletionPolicy: typeof r.DeletionPolicy === "string" ? r.DeletionPolicy : "Delete" });
  }
  for (const [name, o] of Object.entries(isObj(doc.Outputs) ? doc.Outputs : {})) {
    if (!isObj(o) || o.Value === undefined) return `Template format error: Every Outputs member must contain a Value object`;
    t.outputs.set(name, o.Value);
  }
  // Every Ref must point at a parameter, a resource or a pseudo parameter.
  const refs = JSON.stringify(doc).match(/"Ref":"([^"]+)"/g) ?? [];
  for (const r of refs) {
    const target = r.slice(7, -1);
    if (!t.parameters.has(target) && !t.resources.has(target) && !target.startsWith("AWS::")) return `Template format error: Unresolved resource dependencies [${target}] in the Resources block of the template`;
  }
  return t;
}

/** Resolves intrinsic functions against parameters and physical ids. */
function resolve(value: Json, ctx: { stack: string; params: Record<string, string>; physical: Map<string, { type: string; id: string }> }): Json {
  if (Array.isArray(value)) return value.map((v) => resolve(v, ctx));
  if (!isObj(value)) return value;
  const pseudo: Record<string, string> = { "AWS::StackName": ctx.stack, "AWS::Region": REGION, "AWS::AccountId": ACCOUNT };
  const ref = (name: string): string => {
    if (name in pseudo) return pseudo[name];
    if (name in ctx.params) return ctx.params[name];
    const r = ctx.physical.get(name);
    return r ? TYPES[r.type].ref(r.id) : "";
  };
  if ("Ref" in value) return ref(String(value.Ref));
  if ("Fn::Sub" in value) {
    const s = value["Fn::Sub"];
    const [text, vars] = Array.isArray(s) ? [String(s[0]), isObj(s[1]) ? s[1] : {}] : [String(s), {}];
    return text.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
      if (name in vars) return String(resolve(vars[name], ctx));
      if (name.includes(".")) {
        const [res, attr] = name.split(".");
        const r = ctx.physical.get(res);
        return r ? (TYPES[r.type].attrs(r.id)[attr] ?? "") : "";
      }
      return ref(name);
    });
  }
  if ("Fn::GetAtt" in value) {
    const [res, attr] = value["Fn::GetAtt"] as string[];
    const r = ctx.physical.get(res);
    return r ? (TYPES[r.type].attrs(r.id)[attr] ?? "") : "";
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, ctx)]));
}

/** "ParameterKey=Env,ParameterValue=prod" entries. */
function parameters(entries: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const e of entries) {
    const key = /ParameterKey=([^,]+)/.exec(e)?.[1];
    const value = /ParameterValue=(.*)$/.exec(e)?.[1];
    if (!key || value === undefined) return null;
    out[key] = value;
  }
  return out;
}

function bindParams(t: Template, given: Record<string, string>): Record<string, string> | string {
  const unknown = Object.keys(given).find((k) => !t.parameters.has(k));
  if (unknown) return `Parameters: [${unknown}] do not exist in the template`;
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, p] of t.parameters) {
    const v = given[name] ?? p.default;
    if (v === undefined) missing.push(name);
    else if (p.allowed && !p.allowed.includes(v)) return `Parameter '${name}' must be one of AllowedValues（${p.allowed.join("、")}）`;
    else out[name] = v;
  }
  if (missing.length) return `Parameters: [${missing.join(", ")}] must have values`;
  return out;
}

/** Resource names and properties a template would produce for this stack. */
function desired(stackName: string, t: Template, params: Record<string, string>, existing?: CfnStack) {
  const physical = new Map<string, { type: string; id: string }>();
  for (const [logical, r] of t.resources) {
    const named = r.props[TYPES[r.type].nameProperty];
    const keep = existing?.resources.get(logical);
    const id =
      named !== undefined
        ? String(resolve(named, { stack: stackName, params, physical }))
        : keep && keep.type === r.type
          ? keep.physicalId
          : TYPES[r.type].generate(stackName, logical, hash(`${stackName}/${logical}`, 12));
    physical.set(logical, { type: r.type, id });
  }
  const resources = new Map<string, { type: string; physicalId: string; props: Obj; deletionPolicy: string }>();
  for (const [logical, r] of t.resources) {
    resources.set(logical, { type: r.type, physicalId: physical.get(logical)!.id, props: resolve(r.props, { stack: stackName, params, physical }) as Obj, deletionPolicy: r.deletionPolicy });
  }
  const outputs = Object.fromEntries([...t.outputs].map(([k, v]) => [k, String(resolve(v, { stack: stackName, params, physical }))]));
  return { resources, outputs };
}

const stackId = (name: string) => `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${name}/${hash(name, 8)}-${hash(`${name}1`, 4)}-${hash(`${name}2`, 4)}-${hash(`${name}3`, 12)}`;

export function cloudformation(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !CLOUDFORMATION_COMMANDS.includes(sub)) {
    ctx.err(sub ? `aws: 不支援的 cloudformation 指令 '${sub}'。支援：${CLOUDFORMATION_COMMANDS.join("、")}` : `usage: aws cloudformation <command> [parameters]\n支援：${CLOUDFORMATION_COMMANDS.join("、")}`);
    return 252;
  }
  const options = ["--stack-name", "--template-body", "--parameters", "--change-set-name", "--capabilities", "--region", "--output"];
  const opts = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const eq = rest[i].indexOf("=");
    const name = rest[i].startsWith("--") && eq !== -1 ? rest[i].slice(0, eq) : rest[i];
    if (!options.includes(name)) {
      ctx.err(`\nUnknown options: ${rest[i]}`);
      return 252;
    }
    const values = eq !== -1 && rest[i].startsWith("--") ? [rest[i].slice(eq + 1)] : rest[i + 1] !== undefined ? [rest[++i]] : [];
    if (name === "--parameters") while (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) values.push(rest[++i]);
    opts.set(name, values);
  }
  const opt = (n: string) => opts.get(`--${n}`)?.[0];
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const required = (names: string[]) => {
    const missing = names.filter((n) => !opts.has(`--${n}`));
    if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
    return missing.length === 0;
  };
  const stacks = ctx.state.aws.cloudformation.stacks;
  const live = (name: string | undefined) => {
    const s = name ? stacks.get(name) : undefined;
    return s && s.status !== "DELETE_COMPLETE" ? s : undefined;
  };
  const noStack = (name: string | undefined) => fail(ctx, "ValidationError", operation, `Stack with id ${name ?? ""} does not exist`);
  const readTemplate = (): Template | null => {
    const body = opt("template-body")!;
    let text = body;
    if (body.startsWith("file://")) {
      const content = ctx.state.files.get(resolvePath(ctx.state.cwd, body.slice(7)));
      if (content === undefined) {
        ctx.err(`\nError parsing parameter '--template-body': Unable to load paramfile ${body}: [Errno 2] No such file or directory`);
        return null;
      }
      text = content;
    }
    const t = loadTemplate(text);
    if (typeof t === "string") {
      fail(ctx, "ValidationError", operation, t);
      return null;
    }
    return t;
  };
  const event = (s: CfnStack, logical: string, status: string, reason = "") => s.events.unshift({ logical, status, reason });

  switch (sub) {
    case "validate-template": {
      if (!required(["template-body"])) return 252;
      const t = readTemplate();
      if (!t) return 254;
      json(ctx, { Parameters: [...t.parameters].map(([k, p]) => ({ ParameterKey: k, ...(p.default !== undefined ? { DefaultValue: p.default } : {}), NoEcho: false, Description: p.description })) });
      return 0;
    }
    case "create-stack": {
      if (!required(["stack-name", "template-body"])) return 252;
      const name = opt("stack-name")!;
      if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(name)) return fail(ctx, "ValidationError", operation, `1 validation error detected: Value '${name}' at 'stackName' failed to satisfy constraint（以字母開頭，只能用英數字和連字號）`);
      if (live(name)) return fail(ctx, "AlreadyExistsException", operation, `Stack [${name}] already exists`);
      const t = readTemplate();
      if (!t) return 254;
      const given = parameters(opts.get("--parameters") ?? []);
      if (!given) return fail(ctx, "ValidationError", operation, "--parameters 的格式是 ParameterKey=名稱,ParameterValue=值");
      const params = bindParams(t, given);
      if (typeof params === "string") return fail(ctx, "ValidationError", operation, params);
      const want = desired(name, t, params);
      const stack: CfnStack = { id: stackId(name), status: "CREATE_IN_PROGRESS", template: opt("template-body")!, params, resources: new Map(), outputs: {}, events: [], drift: null, changeSets: new Map() };
      stacks.set(name, stack);
      event(stack, name, "CREATE_IN_PROGRESS", "User Initiated");
      for (const [logical, r] of want.resources) {
        event(stack, logical, "CREATE_IN_PROGRESS");
        const problem = TYPES[r.type].create(ctx.state, r.physicalId, r.props);
        if (problem) {
          event(stack, logical, "CREATE_FAILED", `Resource handler returned message: "${problem}"`);
          // By default a failed create rolls back what it already made.
          event(stack, name, "ROLLBACK_IN_PROGRESS", "The following resource(s) failed to create: [" + logical + "]. Rollback requested by user.");
          for (const [l, done] of [...stack.resources].reverse()) {
            TYPES[done.type].remove(ctx.state, done.physicalId);
            event(stack, l, "DELETE_COMPLETE");
          }
          stack.resources.clear();
          stack.status = "ROLLBACK_COMPLETE";
          event(stack, name, "ROLLBACK_COMPLETE");
          json(ctx, { StackId: stack.id });
          return 0;
        }
        stack.resources.set(logical, r);
        event(stack, logical, "CREATE_COMPLETE");
      }
      stack.outputs = want.outputs;
      stack.status = "CREATE_COMPLETE";
      event(stack, name, "CREATE_COMPLETE");
      json(ctx, { StackId: stack.id });
      return 0;
    }
    case "describe-stacks": {
      const name = opt("stack-name");
      if (name !== undefined && !live(name)) return noStack(name);
      const list = name ? [[name, live(name)!] as const] : [...stacks].filter(([, s]) => s.status !== "DELETE_COMPLETE");
      json(ctx, {
        Stacks: list.map(([n, s]) => ({
          StackId: s.id,
          StackName: n,
          Parameters: Object.entries(s.params).map(([k, v]) => ({ ParameterKey: k, ParameterValue: v })),
          StackStatus: s.status,
          ...(s.status === "ROLLBACK_COMPLETE" ? { StackStatusReason: s.events.find((e) => e.status === "CREATE_FAILED")?.reason } : {}),
          ...(s.drift ? { DriftInformation: { StackDriftStatus: s.drift } } : {}),
          Outputs: Object.entries(s.outputs).map(([k, v]) => ({ OutputKey: k, OutputValue: v })),
        })),
      });
      return 0;
    }
    case "describe-stack-events": {
      if (!required(["stack-name"])) return 252;
      const s = live(opt("stack-name"));
      if (!s) return noStack(opt("stack-name"));
      json(ctx, { StackEvents: s.events.map((e) => ({ StackName: opt("stack-name"), LogicalResourceId: e.logical, ResourceStatus: e.status, ...(e.reason ? { ResourceStatusReason: e.reason } : {}) })) });
      return 0;
    }
    case "describe-stack-resources": {
      if (!required(["stack-name"])) return 252;
      const s = live(opt("stack-name"));
      if (!s) return noStack(opt("stack-name"));
      json(ctx, { StackResources: [...s.resources].map(([l, r]) => ({ LogicalResourceId: l, PhysicalResourceId: r.type === "AWS::SNS::Topic" ? topicArn(r.physicalId) : r.physicalId, ResourceType: r.type, ResourceStatus: "CREATE_COMPLETE" })) });
      return 0;
    }
    case "create-change-set": {
      if (!required(["stack-name", "change-set-name", "template-body"])) return 252;
      const name = opt("stack-name")!;
      const s = live(name);
      if (!s) return noStack(name);
      if (s.status === "ROLLBACK_COMPLETE") return fail(ctx, "ValidationError", operation, `Stack:${s.id} is in ROLLBACK_COMPLETE state and can not be updated.（先刪除這個堆疊再重新建立）`);
      const t = readTemplate();
      if (!t) return 254;
      const given = parameters(opts.get("--parameters") ?? []);
      if (!given) return fail(ctx, "ValidationError", operation, "--parameters 的格式是 ParameterKey=名稱,ParameterValue=值");
      const params = bindParams(t, { ...Object.fromEntries(Object.entries(s.params).filter(([k]) => t.parameters.has(k))), ...given });
      if (typeof params === "string") return fail(ctx, "ValidationError", operation, params);
      const want = desired(name, t, params, s);
      const changes: CfnChange[] = [];
      for (const [logical, r] of want.resources) {
        const cur = s.resources.get(logical);
        if (!cur) changes.push({ action: "Add", logical, type: r.type, replacement: "", details: [] });
        else {
          const diff = [...new Set([...Object.keys(cur.props), ...Object.keys(r.props)])].filter((k) => JSON.stringify(cur.props[k]) !== JSON.stringify(r.props[k]));
          if (diff.length || cur.deletionPolicy !== r.deletionPolicy) {
            const replace = cur.physicalId !== r.physicalId || diff.some((k) => TYPES[r.type].replaceOn.includes(k));
            changes.push({ action: "Modify", logical, type: r.type, replacement: replace ? "True" : "False", details: diff });
          }
        }
      }
      for (const [logical, cur] of s.resources) if (!want.resources.has(logical)) changes.push({ action: "Remove", logical, type: cur.type, replacement: "", details: [] });
      const csName = opt("change-set-name")!;
      s.changeSets.set(csName, { template: opt("template-body")!, params, changes });
      json(ctx, { Id: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:changeSet/${csName}/${hash(csName, 8)}`, StackId: s.id });
      return 0;
    }
    case "describe-change-set": {
      if (!required(["stack-name", "change-set-name"])) return 252;
      const s = live(opt("stack-name"));
      if (!s) return noStack(opt("stack-name"));
      const cs = s.changeSets.get(opt("change-set-name")!);
      if (!cs) return fail(ctx, "ChangeSetNotFound", operation, `ChangeSet [${opt("change-set-name")}] does not exist`);
      json(ctx, {
        ChangeSetName: opt("change-set-name"),
        StackName: opt("stack-name"),
        Status: cs.changes.length ? "CREATE_COMPLETE" : "FAILED",
        ...(cs.changes.length ? {} : { StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." }),
        ExecutionStatus: cs.changes.length ? "AVAILABLE" : "UNAVAILABLE",
        Changes: cs.changes.map((c) => ({
          Type: "Resource",
          ResourceChange: { Action: c.action, LogicalResourceId: c.logical, ResourceType: c.type, ...(c.action === "Modify" ? { Replacement: c.replacement, Details: c.details.map((d) => ({ Target: { Attribute: "Properties", Name: d } })) } : {}) },
        })),
      });
      return 0;
    }
    case "execute-change-set": {
      if (!required(["stack-name", "change-set-name"])) return 252;
      const name = opt("stack-name")!;
      const s = live(name);
      if (!s) return noStack(name);
      const cs = s.changeSets.get(opt("change-set-name")!);
      if (!cs) return fail(ctx, "ChangeSetNotFound", operation, `ChangeSet [${opt("change-set-name")}] does not exist`);
      if (!cs.changes.length) return fail(ctx, "InvalidChangeSetStatus", operation, "ChangeSet is in FAILED status: 這個變更集沒有任何變更");
      const body = cs.template.startsWith("file://") ? ctx.state.files.get(resolvePath(ctx.state.cwd, cs.template.slice(7))) : cs.template;
      const t = body === undefined ? null : loadTemplate(body);
      if (!t || typeof t === "string") return fail(ctx, "ValidationError", operation, "找不到變更集的範本檔案");
      const want = desired(name, t, cs.params, s);
      event(s, name, "UPDATE_IN_PROGRESS", "User Initiated");
      for (const c of cs.changes) {
        const next = want.resources.get(c.logical);
        const cur = s.resources.get(c.logical);
        const type = TYPES[c.type];
        if (c.action === "Add" || (c.action === "Modify" && c.replacement === "True")) {
          const problem = type.create(ctx.state, next!.physicalId, next!.props);
          if (problem) return fail(ctx, "ValidationError", operation, `更新失敗：${problem}`);
          if (cur) type.remove(ctx.state, cur.physicalId);
        } else if (c.action === "Modify") type.update(ctx.state, next!.physicalId, next!.props);
        else if (cur!.deletionPolicy !== "Retain") type.remove(ctx.state, cur!.physicalId);
        event(s, c.logical, c.action === "Remove" ? "DELETE_COMPLETE" : "UPDATE_COMPLETE");
      }
      s.resources = want.resources;
      s.outputs = want.outputs;
      s.params = cs.params;
      s.template = cs.template;
      s.changeSets.clear();
      s.drift = null;
      s.status = "UPDATE_COMPLETE";
      event(s, name, "UPDATE_COMPLETE");
      return 0;
    }
    case "detect-stack-drift": {
      if (!required(["stack-name"])) return 252;
      const s = live(opt("stack-name"));
      if (!s) return noStack(opt("stack-name"));
      const drifted = [...s.resources].some(([, r]) => !TYPES[r.type].exists(ctx.state, r.physicalId) || TYPES[r.type].drift(ctx.state, r.physicalId, r.props).length);
      s.drift = drifted ? "DRIFTED" : "IN_SYNC";
      json(ctx, { StackDriftDetectionId: `${hash(s.id, 8)}-${hash(`${s.id}d`, 4)}-${hash(`${s.id}e`, 4)}-${hash(`${s.id}f`, 4)}-${hash(`${s.id}g`, 12)}` });
      return 0;
    }
    case "describe-stack-resource-drifts": {
      if (!required(["stack-name"])) return 252;
      const s = live(opt("stack-name"));
      if (!s) return noStack(opt("stack-name"));
      if (!s.drift) return fail(ctx, "ValidationError", operation, "還沒有偏移偵測的結果，先執行 detect-stack-drift。（模擬終端機的檢查）");
      json(ctx, {
        StackResourceDrifts: [...s.resources].map(([l, r]) => {
          const t = TYPES[r.type];
          const gone = !t.exists(ctx.state, r.physicalId);
          const diffs = gone ? [] : t.drift(ctx.state, r.physicalId, r.props);
          return {
            LogicalResourceId: l,
            PhysicalResourceId: r.physicalId,
            ResourceType: r.type,
            StackResourceDriftStatus: gone ? "DELETED" : diffs.length ? "MODIFIED" : "IN_SYNC",
            ...(diffs.length ? { PropertyDifferences: diffs.map((d) => ({ PropertyPath: d.path, ExpectedValue: d.expected, ActualValue: d.actual, DifferenceType: "NOT_EQUAL" })) } : {}),
          };
        }),
      });
      return 0;
    }
    default: {
      if (!required(["stack-name"])) return 252;
      const name = opt("stack-name")!;
      const s = live(name);
      // Deleting a stack that does not exist is not an error.
      if (!s) return 0;
      for (const [l, r] of [...s.resources].reverse()) {
        if (r.deletionPolicy === "Retain") event(s, l, "DELETE_SKIPPED");
        else {
          TYPES[r.type].remove(ctx.state, r.physicalId);
          event(s, l, "DELETE_COMPLETE");
        }
      }
      s.retained = [...s.resources].filter(([, r]) => r.deletionPolicy === "Retain").map(([l]) => l);
      s.resources = new Map();
      s.status = "DELETE_COMPLETE";
      return 0;
    }
  }
}
