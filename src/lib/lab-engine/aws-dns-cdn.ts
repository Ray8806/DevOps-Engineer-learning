import type { Ctx } from "./context";
import { resolvePath, type HostedZone, type LabState, type Route53Record } from "./state";

export const ROUTE53_COMMANDS = [
  "create-hosted-zone", "list-hosted-zones", "get-hosted-zone", "delete-hosted-zone",
  "change-resource-record-sets", "list-resource-record-sets", "test-dns-answer",
];
export const CLOUDFRONT_COMMANDS = ["create-distribution", "list-distributions", "get-distribution", "create-invalidation", "list-invalidations"];

/** The hosted zone id every CloudFront alias target uses. */
export const CLOUDFRONT_ZONE_ID = "Z2FDTNDATAQYW2";
const ACCOUNT = "123456789012";
const TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "CAA", "SRV", "PTR"];

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

interface Parsed {
  options: Map<string, string[]>;
  unknown?: string;
}

function parse(args: string[], options: string[], lists: string[] = []): Parsed {
  const result: Parsed = { options: new Map() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
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

/** Inline JSON or file://path; null after reporting the problem. */
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
    ctx.err(`\nError parsing parameter '${option}': Invalid JSON: ${source.slice(0, 60)}\n（JSON 要用雙引號，整段用單引號包起來，或寫進檔案後用 file:// 讀取）`);
    return null;
  }
}

/** Deterministic pseudo-random id characters. */
function idChars(seed: number, length: number, alphabet: string): string {
  let x = (seed * 2654435761 + 97) >>> 0;
  let out = "";
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += alphabet[(x >>> 16) % alphabet.length];
  }
  return out;
}

const fqdn = (name: string) => (name.endsWith(".") ? name : `${name}.`).toLowerCase();
const recordKey = (name: string, type: string, setId: string | null) => `${name}|${type}|${setId ?? ""}`;
const zoneId = (text: string) => text.replace(/^\/hostedzone\//, "");

/** Where an alias record points: "cloudfront:<origin>", "elb:<name>", "record:<name>" or the raw DNS name. */
export function aliasTarget(state: LabState, zone: HostedZone, record: Route53Record): string | null {
  if (!record.alias) return null;
  const dns = record.alias.dnsName.replace(/\.$/, "").toLowerCase();
  const dist = [...state.aws.cloudfront.distributions.values()].find((d) => d.domainName === dns);
  if (dist) return `cloudfront:${dist.origin}`;
  const lb = [...state.aws.elbv2.loadBalancers].find(([, l]) => l.dnsName.toLowerCase() === dns);
  if (lb) return `elb:${lb[0]}`;
  if ([...zone.records.values()].some((r) => r.name === fqdn(dns))) return `record:${fqdn(dns)}`;
  return fqdn(dns);
}

function recordJson(r: Route53Record) {
  return {
    Name: r.name,
    Type: r.type,
    ...(r.setIdentifier !== null ? { SetIdentifier: r.setIdentifier, Weight: r.weight } : {}),
    ...(r.alias
      ? { AliasTarget: { HostedZoneId: r.alias.hostedZoneId, DNSName: fqdn(r.alias.dnsName), EvaluateTargetHealth: r.alias.evaluateTargetHealth } }
      : { TTL: r.ttl, ResourceRecords: r.values.map((Value) => ({ Value })) }),
  };
}

/** Validates one change; returns an error message, or null after applying it. */
function applyChange(state: LabState, zone: HostedZone, change: unknown): string | null {
  if (typeof change !== "object" || change === null) return "Invalid change";
  const { Action: action, ResourceRecordSet: set } = change as { Action?: unknown; ResourceRecordSet?: Record<string, unknown> };
  if (action !== "CREATE" && action !== "UPSERT" && action !== "DELETE") return `Invalid Action '${String(action)}'（可用的值：CREATE、UPSERT、DELETE）`;
  if (typeof set !== "object" || set === null) return "ResourceRecordSet is required";
  if (typeof set.Name !== "string" || typeof set.Type !== "string") return "ResourceRecordSet 需要 Name 和 Type";
  const name = fqdn(set.Name);
  const type = set.Type.toUpperCase();
  if (!TYPES.includes(type)) return `Invalid Type '${set.Type}'`;
  if (name !== zone.name && !name.endsWith(`.${zone.name}`)) return `RRSet with DNS name ${name} is not permitted in zone ${zone.name}`;
  const setId = typeof set.SetIdentifier === "string" ? set.SetIdentifier : null;
  const key = recordKey(name, type, setId);
  const existing = zone.records.get(key);
  const label = `[name='${name}', type='${type}'${setId ? `, set-identifier='${setId}'` : ""}]`;

  if (action === "DELETE") {
    if (!existing) return `Tried to delete resource record set ${label} but it was not found`;
    if (name === zone.name && (type === "NS" || type === "SOA")) return "區域頂點的 NS 和 SOA 紀錄不能刪除。（模擬終端機的檢查）";
    zone.records.delete(key);
    return null;
  }
  if (action === "CREATE" && existing) return `Tried to create resource record set ${label} but it already exists`;

  let weight: number | null = null;
  if (setId !== null) {
    if (typeof set.Weight !== "number" || !Number.isInteger(set.Weight) || set.Weight < 0 || set.Weight > 255) {
      return "這個模擬終端機只支援加權路由：有 SetIdentifier 時要加上 0 到 255 的 Weight。";
    }
    weight = set.Weight;
  } else if (set.Weight !== undefined) return "Weight 要和 SetIdentifier 一起使用";
  const others = [...zone.records.values()].filter((r) => r.name === name && recordKey(r.name, r.type, r.setIdentifier) !== key);
  if (others.some((r) => r.type === type && (r.setIdentifier === null) !== (setId === null))) {
    return `RRSet with DNS name ${name} and type ${type} cannot mix simple and weighted records（同名同類型的紀錄要全部是簡單路由，或全部是加權路由）`;
  }
  if (type === "CNAME" && name === zone.name) return `RRSet of type CNAME with DNS name ${name} is not permitted at apex in zone ${zone.name}`;
  if ((type === "CNAME" && others.some((r) => r.type !== "CNAME")) || (type !== "CNAME" && others.some((r) => r.type === "CNAME"))) {
    return `RRSet of type ${type} with DNS name ${name} is not permitted because a conflicting RRSet of type ${type === "CNAME" ? others[0].type : "CNAME"} with the same DNS name already exists in zone ${zone.name}`;
  }

  let record: Route53Record;
  const alias = set.AliasTarget as { HostedZoneId?: unknown; DNSName?: unknown; EvaluateTargetHealth?: unknown } | undefined;
  if (alias !== undefined) {
    if (set.TTL !== undefined || set.ResourceRecords !== undefined) return "別名紀錄不能設定 TTL 或 ResourceRecords：TTL 由目標資源決定。";
    if (typeof alias.HostedZoneId !== "string" || typeof alias.DNSName !== "string") return "AliasTarget 需要 HostedZoneId 和 DNSName";
    const target = alias.DNSName.replace(/\.$/, "").toLowerCase();
    const dist = [...state.aws.cloudfront.distributions.values()].find((d) => d.domainName === target);
    const lb = [...state.aws.elbv2.loadBalancers.values()].find((l) => l.dnsName.toLowerCase() === target);
    const sameZone = [...zone.records.values()].find((r) => r.name === fqdn(target) && r.type === type);
    if (target.endsWith(".cloudfront.net")) {
      if (!dist) return `Tried to create an alias that targets ${fqdn(target)}, type ${type} in zone ${alias.HostedZoneId}, but the alias target name does not lie within the target zone（找不到這個 CloudFront 分配）`;
      if (alias.HostedZoneId !== CLOUDFRONT_ZONE_ID) return `Tried to create an alias that targets ${fqdn(target)}, type ${type} in zone ${alias.HostedZoneId}, but that target was not found（指到 CloudFront 的別名，HostedZoneId 一律是 ${CLOUDFRONT_ZONE_ID}）`;
      if (type !== "A" && type !== "AAAA") return "指到 CloudFront 的別名紀錄類型要是 A 或 AAAA。";
    } else if (target.endsWith(".elb.amazonaws.com")) {
      if (!lb) return `Tried to create an alias that targets ${fqdn(target)}, but that target was not found（找不到這個負載平衡器）`;
    } else if (zoneId(alias.HostedZoneId) === zoneIdOf(state, zone)) {
      if (!sameZone) return `Tried to create an alias that targets ${fqdn(target)}, type ${type} in zone ${alias.HostedZoneId}, but that target was not found（同一個代管區域裡要有同名、同類型的紀錄）`;
    } else {
      return "這個模擬終端機的別名紀錄支援 CloudFront 分配、ALB，以及同一個代管區域裡的紀錄。";
    }
    record = { name, type, ttl: null, values: [], setIdentifier: setId, weight, alias: { hostedZoneId: alias.HostedZoneId, dnsName: fqdn(target), evaluateTargetHealth: alias.EvaluateTargetHealth === true } };
  } else {
    if (typeof set.TTL !== "number" || !Number.isInteger(set.TTL) || set.TTL < 0) return "非別名紀錄要指定 TTL（秒）";
    const values = Array.isArray(set.ResourceRecords) ? set.ResourceRecords.map((r) => (r as { Value?: unknown })?.Value) : [];
    if (!values.length || values.some((v) => typeof v !== "string")) return "非別名紀錄要有 ResourceRecords，例如 [{\"Value\": \"192.0.2.44\"}]";
    if (type === "A" && !(values as string[]).every((v) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(v) && v.split(".").every((p) => Number(p) <= 255))) {
      return `Invalid Resource Record: FATAL problem: ARRDATAIllegalIPv4Address (Value is not a valid IPv4 address) encountered with '${values[0]}'`;
    }
    if (type === "CNAME" && values.length !== 1) return "CNAME 紀錄只能有一個值";
    record = { name, type, ttl: set.TTL, values: values as string[], setIdentifier: setId, weight, alias: null };
  }
  zone.records.set(key, record);
  return null;
}

const zoneIdOf = (state: LabState, zone: HostedZone) => [...state.aws.route53.zones].find(([, z]) => z === zone)![0];

function zoneJson(id: string, z: HostedZone) {
  return { Id: `/hostedzone/${id}`, Name: z.name, CallerReference: z.callerReference, Config: { Comment: z.comment, PrivateZone: false }, ResourceRecordSetCount: z.records.size };
}

/** What Route 53 answers for a name and type (weighted records rotate). */
function answer(state: LabState, zone: HostedZone, name: string, type: string, depth = 0): string[] {
  const records = [...zone.records.values()].filter((r) => r.name === name && r.type === type);
  if (!records.length || depth > 3) return [];
  let pick = records[0];
  if (records.length > 1 || pick.setIdentifier !== null) {
    const total = records.reduce((sum, r) => sum + (r.weight ?? 0), 0);
    if (total === 0) pick = records[zone.queries % records.length];
    else {
      let point = (zone.queries * 37) % total;
      pick = records.find((r) => (point -= r.weight ?? 0) < 0)!;
    }
  }
  if (!pick.alias) return pick.values;
  const target = aliasTarget(state, zone, pick)!;
  if (target.startsWith("cloudfront:")) return ["13.35.7.12", "13.35.7.64", "13.35.7.81", "13.35.7.103"];
  if (target.startsWith("elb:")) return ["3.208.10.21", "52.4.181.7"];
  if (target.startsWith("record:")) return answer(state, zone, target.slice(7), type, depth + 1);
  return [];
}

export function route53(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !ROUTE53_COMMANDS.includes(sub)) return unsupported(ctx, "route53", sub, ROUTE53_COMMANDS);
  const parsed = parse(rest, [
    "--name", "--caller-reference", "--hosted-zone-config", "--vpc", "--id", "--hosted-zone-id", "--change-batch",
    "--record-name", "--record-type", "--output", "--query", "--region",
  ]);
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const r53 = ctx.state.aws.route53;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("").replace("Dns", "DNS");
  const getZone = (option: string): [string, HostedZone] | null => {
    const id = zoneId(opt(option)!);
    const z = r53.zones.get(id);
    if (!z) {
      fail(ctx, "NoSuchHostedZone", operation, `No hosted zone found with ID: ${id}`);
      return null;
    }
    return [id, z];
  };

  switch (sub) {
    case "create-hosted-zone": {
      if (!required(ctx, parsed, ["name", "caller-reference"])) return 252;
      if (parsed.options.has("--vpc")) return fail(ctx, "InvalidInput", operation, "這個模擬終端機只支援公有代管區域（不加 --vpc）。");
      const name = fqdn(opt("name")!);
      if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+$/.test(name)) return fail(ctx, "InvalidDomainName", operation, `${opt("name")} is not a valid domain name`);
      if (name.split(".").length < 3) return fail(ctx, "InvalidDomainName", operation, `${name} is reserved by AWS!（不能替 .com 這類頂層網域建立代管區域）`);
      const reference = opt("caller-reference")!;
      if ([...r53.zones.values()].some((z) => z.callerReference === reference)) {
        return fail(ctx, "HostedZoneAlreadyExists", operation, `A hosted zone has already been created with the specified caller reference.（每次建立要用不同的 --caller-reference）`);
      }
      const n = ++r53.created;
      const id = `Z0${idChars(n, 19, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`;
      const base = 1000 + ((n * 389) % 1000);
      const nameServers = [`ns-${base}.awsdns-${(n * 7) % 64}.org`, `ns-${base + 485}.awsdns-${(n * 11) % 64}.co.uk`, `ns-${(base % 512) + 12}.awsdns-${(n * 13) % 64}.net`, `ns-${(base % 512) + 300}.awsdns-${(n * 17) % 64}.com`];
      const comment = /Comment=(.*)$/.exec(opt("hosted-zone-config") ?? "")?.[1]?.split(",PrivateZone")[0] ?? "";
      // Route 53 creates the SOA record and four NS records with every public hosted zone.
      const records = new Map<string, Route53Record>([
        [recordKey(name, "NS", null), { name, type: "NS", ttl: 172800, values: nameServers.map((s) => `${s}.`), setIdentifier: null, weight: null, alias: null }],
        [recordKey(name, "SOA", null), { name, type: "SOA", ttl: 900, values: [`${nameServers[0]}. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400`], setIdentifier: null, weight: null, alias: null }],
      ]);
      const zone: HostedZone = { name, callerReference: reference, comment, nameServers, records, queries: 0 };
      r53.zones.set(id, zone);
      json(ctx, {
        Location: `https://route53.amazonaws.com/2013-04-01/hostedzone/${id}`,
        HostedZone: zoneJson(id, zone),
        ChangeInfo: { Id: `/change/C${idChars(n + 50, 12, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`, Status: "PENDING", SubmittedAt: "2026-11-16T08:00:00.000Z" },
        DelegationSet: { NameServers: nameServers },
      });
      return 0;
    }
    case "list-hosted-zones":
      json(ctx, { HostedZones: [...r53.zones].map(([id, z]) => zoneJson(id, z)), IsTruncated: false, MaxItems: "100" });
      return 0;
    case "get-hosted-zone": {
      if (!required(ctx, parsed, ["id"])) return 252;
      const found = getZone("id");
      if (!found) return 254;
      json(ctx, { HostedZone: zoneJson(...found), DelegationSet: { NameServers: found[1].nameServers } });
      return 0;
    }
    case "delete-hosted-zone": {
      if (!required(ctx, parsed, ["id"])) return 252;
      const found = getZone("id");
      if (!found) return 254;
      const [id, zone] = found;
      if ([...zone.records.values()].some((r) => !(r.name === zone.name && (r.type === "NS" || r.type === "SOA")))) {
        return fail(ctx, "HostedZoneNotEmpty", operation, "The specified hosted zone contains non-required resource record sets and so cannot be deleted.");
      }
      r53.zones.delete(id);
      json(ctx, { ChangeInfo: { Id: "/change/CDELETE", Status: "PENDING", SubmittedAt: "2026-11-16T08:00:00.000Z" } });
      return 0;
    }
    case "change-resource-record-sets": {
      if (!required(ctx, parsed, ["hosted-zone-id", "change-batch"])) return 252;
      const found = getZone("hosted-zone-id");
      if (!found) return 254;
      const batch = readJson(ctx, "--change-batch", opt("change-batch")!);
      if (batch === null) return 252;
      const changes = (batch as { Changes?: unknown }).Changes;
      if (!Array.isArray(changes) || !changes.length) return fail(ctx, "InvalidChangeBatch", operation, "change batch 要有 Changes 陣列");
      // The batch is all-or-nothing: apply to a copy of the records first.
      const [, zone] = found;
      const before = new Map(zone.records);
      for (const change of changes) {
        const problem = applyChange(ctx.state, zone, change);
        if (problem) {
          zone.records = before;
          return fail(ctx, "InvalidChangeBatch", operation, `[${problem}]`);
        }
      }
      json(ctx, { ChangeInfo: { Id: `/change/C${idChars(zone.records.size + r53.created * 31, 12, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`, Status: "PENDING", SubmittedAt: "2026-11-16T08:00:00.000Z" } });
      return 0;
    }
    case "list-resource-record-sets": {
      if (!required(ctx, parsed, ["hosted-zone-id"])) return 252;
      const found = getZone("hosted-zone-id");
      if (!found) return 254;
      json(ctx, { ResourceRecordSets: [...found[1].records.values()].map(recordJson) });
      return 0;
    }
    default: {
      if (!required(ctx, parsed, ["hosted-zone-id", "record-name", "record-type"])) return 252;
      const found = getZone("hosted-zone-id");
      if (!found) return 254;
      const zone = found[1];
      const name = fqdn(opt("record-name")!);
      const type = opt("record-type")!.toUpperCase();
      const data = answer(ctx.state, zone, name, type);
      zone.queries++;
      json(ctx, { Nameserver: zone.nameServers[0], RecordName: name, RecordType: type, RecordData: data, ResponseCode: data.length ? "NOERROR" : "NXDOMAIN", Protocol: "UDP" });
      return 0;
    }
  }
}

// --------------------------------------------------------------- CloudFront

export function cloudfront(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !CLOUDFRONT_COMMANDS.includes(sub)) return unsupported(ctx, "cloudfront", sub, CLOUDFRONT_COMMANDS);
  const parsed = parse(rest, ["--origin-domain-name", "--default-root-object", "--id", "--distribution-id", "--paths", "--output", "--query", "--region"], ["--paths"]);
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const cf = ctx.state.aws.cloudfront;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const distJson = (id: string, status: string) => {
    const d = cf.distributions.get(id)!;
    return {
      Id: id,
      ARN: `arn:aws:cloudfront::${ACCOUNT}:distribution/${id}`,
      Status: status,
      DomainName: d.domainName,
      DistributionConfig: {
        DefaultRootObject: d.defaultRootObject,
        Origins: { Quantity: 1, Items: [{ Id: `${d.origin}-cli`, DomainName: d.origin }] },
        Enabled: true,
      },
    };
  };
  const getDist = (option: string) => {
    const id = opt(option)!;
    if (!cf.distributions.has(id)) {
      fail(ctx, "NoSuchDistribution", operation, "The specified distribution does not exist.");
      return null;
    }
    return id;
  };

  switch (sub) {
    case "create-distribution": {
      if (!parsed.options.has("--origin-domain-name")) {
        ctx.err("\n這個模擬終端機用 --origin-domain-name 建立分配，例如 --origin-domain-name my-bucket.s3.amazonaws.com");
        return 252;
      }
      const origin = opt("origin-domain-name")!.toLowerCase();
      const s3 = /^([a-z0-9][a-z0-9.-]*)\.s3(\.[a-z0-9-]+)?\.amazonaws\.com$/.exec(origin);
      if (s3 && !ctx.state.s3.has(s3[1])) {
        return fail(ctx, "InvalidArgument", operation, `The parameter Origin DomainName does not refer to a valid S3 bucket.（找不到 bucket ${s3[1]}）`);
      }
      if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(origin)) return fail(ctx, "InvalidArgument", operation, "The parameter origin name must be a domain name.");
      const n = ++cf.created;
      const id = `E${idChars(n, 13, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`;
      cf.distributions.set(id, { domainName: `d${idChars(n + 7, 13, "abcdefghijklmnopqrstuvwxyz0123456789")}.cloudfront.net`, origin, defaultRootObject: opt("default-root-object") ?? "", invalidations: [] });
      json(ctx, { Location: `https://cloudfront.amazonaws.com/2020-05-31/distribution/${id}`, ETag: `E${idChars(n + 3, 12, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")}`, Distribution: distJson(id, "InProgress") });
      return 0;
    }
    case "list-distributions":
      json(ctx, { DistributionList: { Items: [...cf.distributions.keys()].map((id) => { const d = distJson(id, "Deployed"); return { Id: d.Id, ARN: d.ARN, Status: d.Status, DomainName: d.DomainName, Origins: d.DistributionConfig.Origins }; }), Quantity: cf.distributions.size } });
      return 0;
    case "get-distribution": {
      if (!required(ctx, parsed, ["id"])) return 252;
      const id = getDist("id");
      if (!id) return 254;
      json(ctx, { ETag: "E2QWRUHEXAMPLE", Distribution: distJson(id, "Deployed") });
      return 0;
    }
    case "create-invalidation": {
      if (!required(ctx, parsed, ["distribution-id", "paths"])) return 252;
      const id = getDist("distribution-id");
      if (!id) return 254;
      const paths = parsed.options.get("--paths")!;
      const bad = paths.find((p) => !p.startsWith("/") || p.slice(0, -1).includes("*"));
      if (bad) return fail(ctx, "InvalidArgument", operation, `Your request contains one or more invalid invalidation paths.（'${bad}'：路徑要以 / 開頭，* 只能放在最後）`);
      const d = cf.distributions.get(id)!;
      d.invalidations.push(...paths);
      const invId = `I${idChars(d.invalidations.length + n0(id), 13, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`;
      json(ctx, {
        Location: `https://cloudfront.amazonaws.com/2020-05-31/distribution/${id}/invalidation/${invId}`,
        Invalidation: { Id: invId, Status: "InProgress", CreateTime: "2026-11-16T08:00:00.000Z", InvalidationBatch: { Paths: { Quantity: paths.length, Items: paths }, CallerReference: `cli-${d.invalidations.length}` } },
      });
      return 0;
    }
    default: {
      if (!required(ctx, parsed, ["distribution-id"])) return 252;
      const id = getDist("distribution-id");
      if (!id) return 254;
      const items = cf.distributions.get(id)!.invalidations;
      json(ctx, { InvalidationList: { Items: items.map((p, i) => ({ Id: `I${idChars(i + 1 + n0(id), 13, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`, Status: "Completed", Path: p })), Quantity: items.length } });
      return 0;
    }
  }
}

const n0 = (id: string) => [...id].reduce((s, c) => s + c.charCodeAt(0), 0);
