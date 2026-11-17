import type { Ctx } from "./context";
import { fromBase64, toBase64 } from "./encoding";
import { resolvePath, type KmsKey, type LabState, type WafRule } from "./state";

export const KMS_COMMANDS = [
  "create-key", "describe-key", "list-keys", "create-alias", "list-aliases", "enable-key-rotation", "disable-key-rotation",
  "get-key-rotation-status", "enable-key", "disable-key", "schedule-key-deletion", "cancel-key-deletion", "encrypt", "decrypt",
];
export const WAFV2_COMMANDS = ["create-ip-set", "list-ip-sets", "create-web-acl", "list-web-acls", "get-web-acl", "associate-web-acl"];

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
/** Prefix of the simulator's ciphertext; real ciphertext is opaque binary. */
const CIPHER_PREFIX = "kms-sim:v1:";

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

/**
 * Prints the response, honouring `--query Field --output text` for a single
 * top-level field (the form the KMS documentation uses).
 */
function respond(ctx: Ctx, parsed: Parsed, value: Record<string, unknown>): number {
  const query = parsed.options.get("--query")?.[0];
  const output = parsed.options.get("--output")?.[0];
  if (query === undefined) {
    if (output === "text") ctx.out(`${Object.values(value).map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join("\t")}\n`);
    else json(ctx, value);
    return 0;
  }
  if (!(query in value)) {
    ctx.err(`這個模擬終端機的 --query 只支援最上層的欄位，例如 --query ${Object.keys(value)[0]}`);
    return 252;
  }
  const picked = value[query];
  if (output === "text") ctx.out(`${typeof picked === "object" ? JSON.stringify(picked) : String(picked)}\n`);
  else json(ctx, picked);
  return 0;
}

/** Reads a blob parameter: fileb://path gives the raw file, anything else is base64. */
function blob(ctx: Ctx, option: string, value: string): string | null {
  if (value.startsWith("fileb://") || value.startsWith("file://")) {
    const path = value.slice(value.indexOf("://") + 3);
    const content = ctx.state.files.get(resolvePath(ctx.state.cwd, path));
    if (content === undefined) {
      ctx.err(`\nError parsing parameter '${option}': Unable to load paramfile ${value}: [Errno 2] No such file or directory: '${path}'`);
      return null;
    }
    return content;
  }
  const decoded = fromBase64(value);
  if (decoded === null) {
    ctx.err(`\nInvalid base64: "${value.slice(0, 40)}"（AWS CLI v2 的 ${option} 要是 base64，或用 fileb:// 讀檔案）`);
    return null;
  }
  return decoded;
}

/** Deterministic pseudo-random hex. */
function hex(seed: number, length: number): string {
  let x = (seed * 2654435761 + 7) >>> 0;
  let out = "";
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += ((x >>> 16) & 15).toString(16);
  }
  return out;
}

const keyArn = (id: string) => `arn:aws:kms:${REGION}:${ACCOUNT}:key/${id}`;

/** Resolves a key id, key ARN, alias name or alias ARN; `allowAlias` false accepts only ids and ARNs. */
function findKey(state: LabState, ref: string, allowAlias: boolean): string | null {
  const kms = state.aws.kms;
  const id = ref.startsWith("arn:aws:kms:") && ref.includes(":key/") ? ref.split(":key/")[1] : ref;
  if (kms.keys.has(id)) return id;
  if (!allowAlias) return null;
  const alias = ref.startsWith("arn:aws:kms:") ? ref.slice(ref.indexOf(":alias/") + 1) : ref;
  return kms.aliases.get(alias) ?? null;
}

function metadata(id: string, k: KmsKey) {
  return {
    AWSAccountId: ACCOUNT,
    KeyId: id,
    Arn: keyArn(id),
    CreationDate: "2026-11-16T08:00:00+00:00",
    Enabled: k.state === "Enabled",
    Description: k.description,
    KeyUsage: "ENCRYPT_DECRYPT",
    KeyState: k.state,
    ...(k.state === "PendingDeletion" ? { DeletionDate: "2026-11-23T08:00:00+00:00", PendingDeletionWindowInDays: k.pendingWindowInDays } : {}),
    Origin: "AWS_KMS",
    KeyManager: "CUSTOMER",
    KeySpec: "SYMMETRIC_DEFAULT",
    EncryptionAlgorithms: ["SYMMETRIC_DEFAULT"],
    MultiRegion: false,
  };
}

/** Obfuscates bytes with a key-specific stream so the ciphertext does not show the plaintext. */
function scramble(keyId: string, bytes: Uint8Array): Uint8Array {
  let x = [...keyId].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7);
  return bytes.map((b) => {
    x = (x * 1103515245 + 12345) >>> 0;
    return b ^ ((x >>> 16) & 255);
  });
}

export function kms(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !KMS_COMMANDS.includes(sub)) return unsupported(ctx, "kms", sub, KMS_COMMANDS);
  const parsed = parse(rest, [
    "--description", "--key-usage", "--key-spec", "--key-id", "--alias-name", "--target-key-id", "--rotation-period-in-days",
    "--pending-window-in-days", "--plaintext", "--ciphertext-blob", "--encryption-algorithm", "--output", "--query", "--region",
  ]);
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const store = ctx.state.aws.kms;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const notFound = (ref: string, aliasHint: boolean) =>
    fail(ctx, "NotFoundException", operation, `Key '${ref}' does not exist${aliasHint && ref.startsWith("alias/") ? "（這個操作要用金鑰 ID 或金鑰 ARN，不能用別名）" : ""}`);
  /** The key named by --key-id; reports and returns null when missing. */
  const key = (allowAlias: boolean): [string, KmsKey] | null => {
    const ref = opt("key-id")!;
    const id = findKey(ctx.state, ref, allowAlias);
    if (id === null) {
      notFound(ref, !allowAlias);
      return null;
    }
    return [id, store.keys.get(id)!];
  };
  const usable = (id: string, k: KmsKey) => {
    if (k.state === "Enabled") return true;
    if (k.state === "PendingDeletion") fail(ctx, "KMSInvalidStateException", operation, `${keyArn(id)} is pending deletion.`);
    else fail(ctx, "DisabledException", operation, `${keyArn(id)} is disabled.`);
    return false;
  };

  switch (sub) {
    case "create-key": {
      const usage = opt("key-usage") ?? "ENCRYPT_DECRYPT";
      const spec = opt("key-spec") ?? "SYMMETRIC_DEFAULT";
      if (usage !== "ENCRYPT_DECRYPT" || spec !== "SYMMETRIC_DEFAULT") return fail(ctx, "UnsupportedOperationException", operation, "這個模擬終端機只支援對稱加密金鑰（預設的 SYMMETRIC_DEFAULT、ENCRYPT_DECRYPT）。");
      const n = ++store.created;
      const h = hex(n, 32);
      const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
      const k: KmsKey = { description: opt("description") ?? "", state: "Enabled", rotationPeriodInDays: null, pendingWindowInDays: null };
      store.keys.set(id, k);
      json(ctx, { KeyMetadata: metadata(id, k) });
      return 0;
    }
    case "list-keys":
      json(ctx, { Keys: [...store.keys.keys()].map((id) => ({ KeyId: id, KeyArn: keyArn(id) })) });
      return 0;
    case "list-aliases":
      json(ctx, { Aliases: [...store.aliases].map(([name, id]) => ({ AliasName: name, AliasArn: `arn:aws:kms:${REGION}:${ACCOUNT}:${name}`, TargetKeyId: id })) });
      return 0;
    case "create-alias": {
      if (!required(ctx, parsed, ["alias-name", "target-key-id"])) return 252;
      const name = opt("alias-name")!;
      if (!/^alias\/[A-Za-z0-9/_-]{1,250}$/.test(name)) return fail(ctx, "ValidationException", operation, "別名要以 alias/ 開頭，後面只能用英數字、/、_、-。");
      if (name.startsWith("alias/aws/")) return fail(ctx, "NotAuthorizedException", operation, "alias/aws/ 開頭的別名保留給 AWS 受管金鑰。");
      if (store.aliases.has(name)) return fail(ctx, "AlreadyExistsException", operation, `An alias with the name arn:aws:kms:${REGION}:${ACCOUNT}:${name} already exists`);
      const target = opt("target-key-id")!;
      const id = findKey(ctx.state, target, false);
      if (id === null) return notFound(target, false);
      store.aliases.set(name, id);
      return 0;
    }
    case "describe-key": {
      if (!required(ctx, parsed, ["key-id"])) return 252;
      const found = key(true);
      if (!found) return 254;
      json(ctx, { KeyMetadata: metadata(...found) });
      return 0;
    }
    case "enable-key-rotation": {
      if (!required(ctx, parsed, ["key-id"])) return 252;
      const found = key(false);
      if (!found || !usable(...found)) return 254;
      const days = opt("rotation-period-in-days") === undefined ? 365 : Number(opt("rotation-period-in-days"));
      if (!Number.isInteger(days) || days < 90 || days > 2560) {
        return fail(ctx, "ValidationException", operation, "1 validation error detected: Value at 'rotationPeriodInDays' failed to satisfy constraint: Member must have value between 90 and 2560");
      }
      found[1].rotationPeriodInDays = days;
      return 0;
    }
    case "disable-key-rotation": {
      if (!required(ctx, parsed, ["key-id"])) return 252;
      const found = key(false);
      if (!found) return 254;
      found[1].rotationPeriodInDays = null;
      return 0;
    }
    case "get-key-rotation-status": {
      if (!required(ctx, parsed, ["key-id"])) return 252;
      const found = key(false);
      if (!found) return 254;
      const [id, k] = found;
      json(ctx, {
        KeyRotationEnabled: k.rotationPeriodInDays !== null,
        KeyId: keyArn(id),
        ...(k.rotationPeriodInDays !== null ? { RotationPeriodInDays: k.rotationPeriodInDays, NextRotationDate: "2027-11-16T08:00:00+00:00" } : {}),
      });
      return 0;
    }
    case "enable-key":
    case "disable-key": {
      if (!required(ctx, parsed, ["key-id"])) return 252;
      const found = key(false);
      if (!found) return 254;
      if (found[1].state === "PendingDeletion") return fail(ctx, "KMSInvalidStateException", operation, `${keyArn(found[0])} is pending deletion.（先 cancel-key-deletion）`);
      found[1].state = sub === "enable-key" ? "Enabled" : "Disabled";
      return 0;
    }
    case "schedule-key-deletion": {
      if (!required(ctx, parsed, ["key-id"])) return 252;
      const found = key(false);
      if (!found) return 254;
      const [id, k] = found;
      if (k.state === "PendingDeletion") return fail(ctx, "KMSInvalidStateException", operation, `${keyArn(id)} is pending deletion.`);
      const days = opt("pending-window-in-days") === undefined ? 30 : Number(opt("pending-window-in-days"));
      if (!Number.isInteger(days) || days < 7 || days > 30) {
        return fail(ctx, "ValidationException", operation, "1 validation error detected: Value at 'pendingWindowInDays' failed to satisfy constraint: Member must have value between 7 and 30");
      }
      k.state = "PendingDeletion";
      k.pendingWindowInDays = days;
      json(ctx, { KeyId: keyArn(id), DeletionDate: "2026-11-23T08:00:00+00:00", KeyState: "PendingDeletion", PendingWindowInDays: days });
      return 0;
    }
    case "cancel-key-deletion": {
      if (!required(ctx, parsed, ["key-id"])) return 252;
      const found = key(false);
      if (!found) return 254;
      const [id, k] = found;
      if (k.state !== "PendingDeletion") return fail(ctx, "KMSInvalidStateException", operation, `${keyArn(id)} is not pending deletion.`);
      // A key whose deletion is cancelled comes back disabled.
      k.state = "Disabled";
      k.pendingWindowInDays = null;
      json(ctx, { KeyId: keyArn(id) });
      return 0;
    }
    case "encrypt": {
      if (!required(ctx, parsed, ["key-id", "plaintext"])) return 252;
      const found = key(true);
      if (!found || !usable(...found)) return 254;
      const plaintext = blob(ctx, "--plaintext", opt("plaintext")!);
      if (plaintext === null) return 252;
      const bytes = new TextEncoder().encode(plaintext);
      if (bytes.length === 0 || bytes.length > 4096) return fail(ctx, "ValidationException", operation, "Plaintext 要介於 1 到 4,096 位元組；更大的資料要用信封加密（GenerateDataKey）。");
      const [id] = found;
      const cipher = `${CIPHER_PREFIX}${id}:${Array.from(scramble(id, bytes), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      return respond(ctx, parsed, { CiphertextBlob: toBase64(cipher), KeyId: keyArn(id), EncryptionAlgorithm: "SYMMETRIC_DEFAULT" });
    }
    default: {
      if (!required(ctx, parsed, ["ciphertext-blob"])) return 252;
      const cipher = blob(ctx, "--ciphertext-blob", opt("ciphertext-blob")!);
      if (cipher === null) return 252;
      const m = new RegExp(`^${CIPHER_PREFIX}([0-9a-f-]{36}):([0-9a-f]*)$`).exec(cipher.trim());
      if (!m) {
        const hint = /^[A-Za-z0-9+/=\s]+$/.test(cipher) ? "（這個檔案看起來還是 base64 文字，先用 base64 -d 解碼成二進位再傳入）" : "";
        return fail(ctx, "InvalidCiphertextException", operation, `${hint}`);
      }
      const [, id, body] = m;
      const k = store.keys.get(id);
      if (!k) return fail(ctx, "InvalidCiphertextException", operation, "");
      if (opt("key-id") !== undefined && findKey(ctx.state, opt("key-id")!, true) !== id) {
        return fail(ctx, "IncorrectKeyException", operation, "The key ID in the request does not identify a CMK that can perform this operation.");
      }
      if (!usable(id, k)) return 254;
      const bytes = scramble(id, Uint8Array.from(body.match(/../g) ?? [], (h) => parseInt(h, 16)));
      return respond(ctx, parsed, { KeyId: keyArn(id), Plaintext: toBase64(new TextDecoder().decode(bytes)), EncryptionAlgorithm: "SYMMETRIC_DEFAULT" });
    }
  }
}

// --------------------------------------------------------------------- WAF

/** Reads inline JSON or file://path; null after reporting. */
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

const ACTIONS = ["Allow", "Block", "Count"];
const actionOf = (value: unknown) => (typeof value === "object" && value !== null ? Object.keys(value)[0] : undefined);

/** Validates the --rules JSON; returns the rules or an error message. */
function parseRules(state: LabState, scope: string, value: unknown): WafRule[] | string {
  if (!Array.isArray(value)) return "--rules 要是規則的 JSON 陣列";
  const rules: WafRule[] = [];
  for (const raw of value as Record<string, unknown>[]) {
    if (typeof raw?.Name !== "string" || typeof raw.Priority !== "number") return "每條規則都要有 Name 和 Priority";
    if (rules.some((r) => r.priority === raw.Priority)) return `規則的 Priority 不能重複（${raw.Priority}）`;
    if (typeof raw.VisibilityConfig !== "object") return `規則 ${raw.Name} 缺少 VisibilityConfig`;
    const st = raw.Statement as Record<string, Record<string, unknown>> | undefined;
    const kind = st ? Object.keys(st)[0] : undefined;
    let summary: string;
    if (kind === "ManagedRuleGroupStatement") {
      const m = st![kind];
      if (typeof m.VendorName !== "string" || typeof m.Name !== "string") return "ManagedRuleGroupStatement 需要 VendorName 和 Name";
      if (raw.Action !== undefined || actionOf(raw.OverrideAction) === undefined) return `規則 ${raw.Name} 使用規則群組，要用 OverrideAction（例如 {"None": {}}），不能用 Action`;
      summary = `managed:${m.VendorName}/${m.Name}`;
    } else {
      const action = actionOf(raw.Action);
      if (!action || !ACTIONS.includes(action)) return `規則 ${raw.Name} 的 Action 要是 Allow、Block 或 Count，例如 {"Block": {}}`;
      if (kind === "IPSetReferenceStatement") {
        const arn = st![kind].ARN;
        const set = [...state.aws.wafv2.ipSets].find(([, s]) => s.arn === arn);
        if (!set) return `WAFNonexistentItemException: 找不到 IP set ${String(arn)}`;
        if (set[1].scope !== scope) return "IP set 和 web ACL 的 scope 要相同";
        summary = `ipset:${set[0]}:${action}`;
      } else if (kind === "GeoMatchStatement") {
        const codes = st![kind].CountryCodes;
        if (!Array.isArray(codes) || !codes.length) return "GeoMatchStatement 需要 CountryCodes";
        summary = `geo:${codes.join(",")}:${action}`;
      } else if (kind === "RateBasedStatement") {
        const limit = st![kind].Limit;
        if (typeof limit !== "number") return "RateBasedStatement 需要 Limit";
        summary = `rate:${limit}:${action}`;
      } else return "這個模擬終端機支援的規則：ManagedRuleGroupStatement、IPSetReferenceStatement、GeoMatchStatement、RateBasedStatement";
    }
    rules.push({ name: raw.Name, priority: raw.Priority, summary });
  }
  return rules;
}

export function wafv2(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !WAFV2_COMMANDS.includes(sub)) return unsupported(ctx, "wafv2", sub, WAFV2_COMMANDS);
  const parsed = parse(
    rest,
    ["--name", "--scope", "--description", "--ip-address-version", "--addresses", "--default-action", "--visibility-config", "--rules", "--id", "--web-acl-arn", "--resource-arn", "--output", "--region"],
    ["--addresses"],
  );
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const waf = ctx.state.aws.wafv2;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("").replace("Acl", "ACL").replace("Acls", "ACLs");
  const scopeOk = () => {
    const scope = opt("scope");
    if (scope !== "REGIONAL" && scope !== "CLOUDFRONT") {
      fail(ctx, "WAFInvalidParameterException", operation, "Error reason: The scope is not valid., field: SCOPE_VALUE（--scope 要是 REGIONAL 或 CLOUDFRONT）");
      return false;
    }
    return true;
  };
  const scopePath = () => (opt("scope") === "CLOUDFRONT" ? "global" : "regional");
  const uuid = (n: number) => {
    const h = hex(n + 500, 32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  switch (sub) {
    case "create-ip-set": {
      if (!required(ctx, parsed, ["name", "scope", "ip-address-version", "addresses"]) || !scopeOk()) return 252;
      const name = opt("name")!;
      if (waf.ipSets.has(name)) return fail(ctx, "WAFDuplicateItemException", operation, "AWS WAF couldn’t perform the operation because some resource in your request is a duplicate of an existing one.");
      const addresses = parsed.options.get("--addresses")!;
      const bad = addresses.find((a) => !/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(a));
      if (bad) return fail(ctx, "WAFInvalidParameterException", operation, `Error reason: The parameter contains formatting that isn't valid., field: IP_ADDRESS, parameter: ${bad}（要用 CIDR，例如 203.0.113.0/24 或 198.51.100.7/32）`);
      const id = uuid(waf.ipSets.size + 1);
      const arn = `arn:aws:wafv2:${REGION}:${ACCOUNT}:${scopePath()}/ipset/${name}/${id}`;
      waf.ipSets.set(name, { id, arn, scope: opt("scope")!, addresses });
      json(ctx, { Summary: { Name: name, Id: id, Description: opt("description") ?? "", LockToken: uuid(90 + waf.ipSets.size), ARN: arn } });
      return 0;
    }
    case "list-ip-sets":
      if (!required(ctx, parsed, ["scope"]) || !scopeOk()) return 252;
      json(ctx, { IPSets: [...waf.ipSets].filter(([, s]) => s.scope === opt("scope")).map(([n, s]) => ({ Name: n, Id: s.id, ARN: s.arn })) });
      return 0;
    case "create-web-acl": {
      if (!required(ctx, parsed, ["name", "scope", "default-action", "visibility-config"]) || !scopeOk()) return 252;
      const name = opt("name")!;
      if (waf.webAcls.has(name)) return fail(ctx, "WAFDuplicateItemException", operation, "AWS WAF couldn’t perform the operation because some resource in your request is a duplicate of an existing one.");
      const def = /^(Allow|Block)=\{\}$/.exec(opt("default-action")!.replace(/\s/g, "")) ?? (() => {
        const parsedDefault = readJson(ctx, "--default-action", opt("default-action")!);
        const a = actionOf(parsedDefault);
        return a === "Allow" || a === "Block" ? [a, a] : null;
      })();
      if (!def) return fail(ctx, "WAFInvalidParameterException", operation, "--default-action 要是 Allow={} 或 Block={}");
      const rulesText = opt("rules");
      let rules: WafRule[] = [];
      if (rulesText !== undefined) {
        const value = readJson(ctx, "--rules", rulesText);
        if (value === null) return 252;
        const result = parseRules(ctx.state, opt("scope")!, value);
        if (typeof result === "string") return fail(ctx, "WAFInvalidParameterException", operation, result);
        rules = result;
      }
      const id = uuid(100 + waf.webAcls.size);
      const arn = `arn:aws:wafv2:${REGION}:${ACCOUNT}:${scopePath()}/webacl/${name}/${id}`;
      waf.webAcls.set(name, { id, arn, scope: opt("scope")!, defaultAction: def[1], rules, associations: [] });
      json(ctx, { Summary: { Name: name, Id: id, Description: opt("description") ?? "", LockToken: uuid(200 + waf.webAcls.size), ARN: arn } });
      return 0;
    }
    case "list-web-acls":
      if (!required(ctx, parsed, ["scope"]) || !scopeOk()) return 252;
      json(ctx, { WebACLs: [...waf.webAcls].filter(([, a]) => a.scope === opt("scope")).map(([n, a]) => ({ Name: n, Id: a.id, ARN: a.arn })) });
      return 0;
    case "get-web-acl": {
      if (!required(ctx, parsed, ["name", "scope", "id"]) || !scopeOk()) return 252;
      const acl = waf.webAcls.get(opt("name")!);
      if (!acl || acl.id !== opt("id")) return fail(ctx, "WAFNonexistentItemException", operation, "AWS WAF couldn’t perform the operation because your resource doesn’t exist.");
      json(ctx, {
        WebACL: {
          Name: opt("name"),
          Id: acl.id,
          ARN: acl.arn,
          DefaultAction: { [acl.defaultAction]: {} },
          Rules: acl.rules.map((r) => ({ Name: r.name, Priority: r.priority, Summary: r.summary })),
        },
      });
      return 0;
    }
    default: {
      if (!required(ctx, parsed, ["web-acl-arn", "resource-arn"])) return 252;
      const acl = [...waf.webAcls.values()].find((a) => a.arn === opt("web-acl-arn"));
      if (!acl) return fail(ctx, "WAFNonexistentItemException", operation, "AWS WAF couldn’t perform the operation because your resource doesn’t exist.");
      if (acl.scope === "CLOUDFRONT") return fail(ctx, "WAFInvalidParameterException", operation, "CLOUDFRONT 範圍的 web ACL 要在 CloudFront 分配的設定裡指定，不能用 associate-web-acl。");
      const lb = [...ctx.state.aws.elbv2.loadBalancers.values()].find((l) => l.arn === opt("resource-arn"));
      if (!lb) return fail(ctx, "WAFNonexistentItemException", operation, "這個模擬終端機可以把 web ACL 關聯到已存在的 Application Load Balancer（用它的 ARN）。");
      if (!acl.associations.includes(lb.arn)) acl.associations.push(lb.arn);
      return 0;
    }
  }
}
