import { parseArgs, type Ctx } from "./context";
import { NAME, NAME_RULE, error, list, table } from "./gcloud-common";
import { resolvePath, type GcpKmsKey } from "./state";

const CIPHER_PREFIX = "gcpkms-sim:v1:";
const DEFAULT_RULE = 2147483647;
const ACTIONS = ["allow", "deny-403", "deny-404", "deny-502"];

/** "90d" / "7776000s" / "2160h" to seconds; null when the format is not understood. */
function durationSeconds(text: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
}

function scramble(seed: string, bytes: Uint8Array): Uint8Array {
  let x = [...seed].reduce((s, c) => (s * 33 + c.charCodeAt(0)) >>> 0, 11);
  return bytes.map((b) => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return b ^ ((x >>> 24) & 255);
  });
}

function kms(ctx: Ctx, args: string[]): number {
  const [group, ...rest] = args;
  const store = ctx.state.gcp.kms;
  const project = ctx.state.gcp.project;

  if (group === "encrypt" || group === "decrypt") {
    const command = `gcloud.kms.${group}`;
    const parsed = parseArgs(rest, { options: ["--key", "--keyring", "--location", "--plaintext-file", "--ciphertext-file", "--version", "--project"] });
    if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
    for (const flag of ["--key", "--keyring", "--location", "--plaintext-file", "--ciphertext-file"]) {
      if (!parsed.options.has(flag)) return error(ctx, command, `argument ${flag}: Must be specified.`);
    }
    const ringId = `${parsed.options.get("--location")}/${parsed.options.get("--keyring")}`;
    const keyName = parsed.options.get("--key")!;
    const key = store.keyRings.get(ringId)?.keys.get(keyName);
    const keyPath = `projects/${project}/locations/${parsed.options.get("--location")}/keyRings/${parsed.options.get("--keyring")}/cryptoKeys/${keyName}`;
    if (!key) return error(ctx, command, `NOT_FOUND: ${keyPath} not found.`);
    const input = resolvePath(ctx.state.cwd, parsed.options.get(group === "encrypt" ? "--plaintext-file" : "--ciphertext-file")!);
    const output = resolvePath(ctx.state.cwd, parsed.options.get(group === "encrypt" ? "--ciphertext-file" : "--plaintext-file")!);
    const content = ctx.state.files.get(input);
    if (content === undefined) return error(ctx, command, `Failed to read file [${input}]: No such file or directory`);
    const outDir = output.slice(0, output.lastIndexOf("/")) || "/";
    if (!ctx.state.dirs.has(outDir)) return error(ctx, command, `Failed to write file [${output}]: No such file or directory`);

    if (group === "encrypt") {
      const version = key.primary;
      if (key.versions[version - 1] !== "ENABLED") return error(ctx, command, `FAILED_PRECONDITION: ${keyPath}/cryptoKeyVersions/${version} is not enabled, current state is: ${key.versions[version - 1]}.`);
      const bytes = new TextEncoder().encode(content);
      const body = btoa(String.fromCharCode(...scramble(`${ringId}/${keyName}/${version}`, bytes)));
      ctx.state.files.set(output, `${CIPHER_PREFIX}${ringId}/${keyName}/${version}:${body}`);
      return 0;
    }
    const m = new RegExp(`^${CIPHER_PREFIX}(.+)/([^/]+)/(\\d+):(.*)$`).exec(content);
    if (!m) return error(ctx, command, "INVALID_ARGUMENT: Decryption failed: the ciphertext is invalid.");
    const [, ring, name, versionText, body] = m;
    if (ring !== ringId || name !== keyName) return error(ctx, command, "INVALID_ARGUMENT: Decryption failed: verify that 'name' refers to the correct CryptoKey.");
    const version = Number(versionText);
    const state = key.versions[version - 1];
    if (state !== "ENABLED") {
      return error(ctx, command, `FAILED_PRECONDITION: ${keyPath}/cryptoKeyVersions/${version} is not enabled, current state is: ${state}.（加密這份資料的金鑰版本不能用了）`);
    }
    let scrambled: Uint8Array;
    try {
      scrambled = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    } catch {
      return error(ctx, command, "INVALID_ARGUMENT: Decryption failed: the ciphertext is invalid.");
    }
    ctx.state.files.set(output, new TextDecoder().decode(scramble(`${ring}/${name}/${version}`, scrambled)));
    return 0;
  }

  const [action, ...more] = rest;
  const command = `gcloud.kms.${group}.${action}`;
  const parsed = parseArgs(more, {
    options: ["--location", "--keyring", "--key", "--purpose", "--rotation-period", "--next-rotation-time", "--project", "--format"],
    flags: ["--primary", "--quiet", "-q"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const location = parsed.options.get("--location");

  if (group === "keyrings") {
    if (location === undefined) return error(ctx, command, "argument --location: Must be specified.");
    if (action === "list") {
      table(ctx, ["NAME"], [...store.keyRings.keys()].filter((k) => k.startsWith(`${location}/`)).map((k) => [`projects/${project}/locations/${k.replace("/", "/keyRings/")}`]));
      return 0;
    }
    if (action !== "create") return error(ctx, "gcloud.kms.keyrings", `不支援的指令 '${action ?? ""}'。支援 create、list。`);
    const name = parsed.positional[0];
    if (!name) return error(ctx, command, "argument KEYRING: Must be specified.");
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(name)) return error(ctx, command, "INVALID_ARGUMENT: 名稱只能用英數字、底線和連字號，最多 63 個字元。");
    const id = `${location}/${name}`;
    if (store.keyRings.has(id)) return error(ctx, command, `ALREADY_EXISTS: KeyRing projects/${project}/locations/${location}/keyRings/${name} already exists.`);
    store.keyRings.set(id, { keys: new Map() });
    return 0;
  }

  const ringName = parsed.options.get("--keyring");
  if (location === undefined) return error(ctx, command, "argument --location: Must be specified.");
  if (ringName === undefined) return error(ctx, command, "argument --keyring: Must be specified.");
  const ring = store.keyRings.get(`${location}/${ringName}`);
  const ringPath = `projects/${project}/locations/${location}/keyRings/${ringName}`;
  if (!ring) return error(ctx, command, `NOT_FOUND: KeyRing ${ringPath} not found.`);

  if (group === "keys") {
    if (action === "list") {
      table(ctx, ["NAME", "PURPOSE", "PRIMARY_STATE"], [...ring.keys].map(([n, k]) => [`${ringPath}/cryptoKeys/${n}`, k.purpose.toUpperCase().replace("-", "_"), k.versions[k.primary - 1]]));
      return 0;
    }
    const name = parsed.positional[0];
    if (!name) return error(ctx, command, "argument KEY: Must be specified.");
    if (action === "describe") {
      const k = ring.keys.get(name);
      if (!k) return error(ctx, command, `NOT_FOUND: ${ringPath}/cryptoKeys/${name} not found.`);
      ctx.out(`name: ${ringPath}/cryptoKeys/${name}\n${k.nextRotationTime ? `nextRotationTime: '${k.nextRotationTime}'\n` : ""}primary:\n  name: ${ringPath}/cryptoKeys/${name}/cryptoKeyVersions/${k.primary}\n  state: ${k.versions[k.primary - 1]}\npurpose: ENCRYPT_DECRYPT\n${k.rotationPeriod ? `rotationPeriod: ${k.rotationPeriod}\n` : ""}`);
      return 0;
    }
    if (action !== "create") return error(ctx, "gcloud.kms.keys", `不支援的指令 '${action ?? ""}'。支援 create、list、describe，以及 keys versions。`);
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(name)) return error(ctx, command, "INVALID_ARGUMENT: 名稱只能用英數字、底線和連字號，最多 63 個字元。");
    if (ring.keys.has(name)) return error(ctx, command, `ALREADY_EXISTS: CryptoKey ${ringPath}/cryptoKeys/${name} already exists.`);
    const purpose = parsed.options.get("--purpose");
    if (purpose === undefined) return error(ctx, command, "argument --purpose: Must be specified.");
    if (purpose !== "encryption") return error(ctx, command, "這個模擬終端機只支援 --purpose=encryption（對稱加密）。");
    const period = parsed.options.get("--rotation-period");
    let rotationPeriod: string | null = null;
    if (period !== undefined) {
      const seconds = durationSeconds(period);
      if (seconds === null) return error(ctx, command, `argument --rotation-period: 格式像 90d 或 7776000s，收到 '${period}'。`);
      rotationPeriod = `${seconds}s`;
    }
    const next = parsed.options.get("--next-rotation-time") ?? null;
    if (next !== null && Number.isNaN(Date.parse(next))) return error(ctx, command, `argument --next-rotation-time: 時間格式像 2027-01-01T00:00:00Z，收到 '${next}'。`);
    ring.keys.set(name, { purpose, rotationPeriod, nextRotationTime: rotationPeriod ? (next ?? "2027-02-14T08:00:00Z") : next, versions: ["ENABLED"], primary: 1, restored: [] });
    return 0;
  }

  return error(ctx, "gcloud.kms", `不支援 '${group ?? ""}'。這個模擬終端機支援 gcloud kms keyrings、keys、keys versions、encrypt、decrypt。`);
}

function versions(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.kms.keys.versions.${action}`;
  const parsed = parseArgs(rest, { options: ["--location", "--keyring", "--key", "--project", "--format"], flags: ["--primary", "--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  for (const flag of ["--location", "--keyring", "--key"]) if (!parsed.options.has(flag)) return error(ctx, command, `argument ${flag}: Must be specified.`);
  const project = ctx.state.gcp.project;
  const keyPath = `projects/${project}/locations/${parsed.options.get("--location")}/keyRings/${parsed.options.get("--keyring")}/cryptoKeys/${parsed.options.get("--key")}`;
  const key: GcpKmsKey | undefined = ctx.state.gcp.kms.keyRings.get(`${parsed.options.get("--location")}/${parsed.options.get("--keyring")}`)?.keys.get(parsed.options.get("--key")!);
  if (!key) return error(ctx, command, `NOT_FOUND: ${keyPath} not found.`);
  if (action === "list") {
    table(ctx, ["NAME", "STATE"], key.versions.map((s, i) => [`${keyPath}/cryptoKeyVersions/${i + 1}`, s]));
    return 0;
  }
  if (action === "create") {
    key.versions.push("ENABLED");
    if (parsed.flags.has("--primary")) key.primary = key.versions.length;
    return 0;
  }
  const n = Number(parsed.positional[0]);
  if (!Number.isInteger(n) || n < 1) return error(ctx, command, "argument VERSION: Must be specified.");
  if (n > key.versions.length) return error(ctx, command, `NOT_FOUND: ${keyPath}/cryptoKeyVersions/${n} not found.`);
  const state = key.versions[n - 1];
  const describe = () => ctx.out(`name: ${keyPath}/cryptoKeyVersions/${n}\nstate: ${key.versions[n - 1]}\n`);
  switch (action) {
    case "destroy":
      if (state === "DESTROY_SCHEDULED") return error(ctx, command, `FAILED_PRECONDITION: ${keyPath}/cryptoKeyVersions/${n} is already scheduled for destruction.`);
      if (n === key.primary && key.versions.length === 1) {
        ctx.out("（模擬終端機的提醒：這是唯一的版本，銷毀後用它加密的資料都無法解密）\n");
      }
      key.versions[n - 1] = "DESTROY_SCHEDULED";
      describe();
      ctx.out("destroyTime: 30 天後（預設的排程銷毀期間；期間內可以用 restore 還原）\n");
      return 0;
    case "restore":
      if (state !== "DESTROY_SCHEDULED") return error(ctx, command, `FAILED_PRECONDITION: ${keyPath}/cryptoKeyVersions/${n} is not scheduled for destruction.`);
      key.versions[n - 1] = "DISABLED";
      if (!key.restored.includes(n)) key.restored.push(n);
      describe();
      return 0;
    case "enable":
    case "disable":
      if (state === "DESTROY_SCHEDULED") return error(ctx, command, `FAILED_PRECONDITION: ${keyPath}/cryptoKeyVersions/${n} is scheduled for destruction（先 restore）。`);
      key.versions[n - 1] = action === "enable" ? "ENABLED" : "DISABLED";
      describe();
      return 0;
    default:
      return error(ctx, "gcloud.kms.keys.versions", `不支援的指令 '${action ?? ""}'。支援 list、create、enable、disable、destroy、restore。`);
  }
}

// ------------------------------------------------------------- Cloud Armor

function securityPolicies(ctx: Ctx, args: string[]): number {
  const policies = ctx.state.gcp.securityPolicies;
  const project = ctx.state.gcp.project;
  const url = (name: string) => `https://www.googleapis.com/compute/v1/projects/${project}/global/securityPolicies/${name}`;

  if (args[0] === "rules") {
    const [, action, ...rest] = args;
    const command = `gcloud.compute.security-policies.rules.${action}`;
    const parsed = parseArgs(rest, { options: ["--security-policy", "--action", "--src-ip-ranges", "--description", "--project"], flags: ["--preview", "--no-preview", "--quiet", "-q"] });
    if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
    const policyName = parsed.options.get("--security-policy");
    if (policyName === undefined) return error(ctx, command, "argument --security-policy: Must be specified.");
    const policy = policies.get(policyName);
    if (!policy) return error(ctx, command, `Could not fetch resource:\n - The resource '${url(policyName)}' was not found`);
    const priority = Number(parsed.positional[0]);
    if (!Number.isInteger(priority) || priority < 0 || priority > DEFAULT_RULE) return error(ctx, command, "argument PRIORITY: 要是 0 到 2147483646 的整數（2147483647 是預設規則）。");
    const actionValue = parsed.options.get("--action");
    if (actionValue !== undefined && !ACTIONS.includes(actionValue)) return error(ctx, command, `argument --action: Invalid choice: '${actionValue}'. 這個模擬終端機支援 ${ACTIONS.join("、")}。`);
    const ranges = list(parsed.options.get("--src-ip-ranges"));
    const bad = ranges.find((r) => r !== "*" && !/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(r));
    if (bad) return error(ctx, command, `Invalid value for field 'resource.match.config.srcIpRanges': '${bad}'.`);
    switch (action) {
      case "create": {
        if (priority === DEFAULT_RULE) return error(ctx, command, "預設規則（2147483647）已經存在，要修改它請用 rules update。");
        if (policy.rules.has(priority)) return error(ctx, command, `Cannot have rules with the same priorities.（優先順序 ${priority} 已經有規則）`);
        if (actionValue === undefined) return error(ctx, command, "argument --action: Must be specified.");
        if (!ranges.length) return error(ctx, command, "這個模擬終端機用 --src-ip-ranges 指定來源 IP 範圍。");
        if (ranges.length > 10) return error(ctx, command, "一條規則的 --src-ip-ranges 最多 10 個。（模擬終端機的檢查）");
        policy.rules.set(priority, { action: actionValue, srcIpRanges: ranges, description: parsed.options.get("--description") ?? "", preview: parsed.flags.has("--preview") });
        ctx.out(`Updated [${url(policyName)}].\n`);
        return 0;
      }
      case "update": {
        const rule = policy.rules.get(priority);
        if (!rule) return error(ctx, command, `Invalid value for field 'priority': '${priority}'. 這個政策沒有優先順序 ${priority} 的規則。`);
        if (actionValue !== undefined) rule.action = actionValue;
        if (ranges.length) {
          if (priority === DEFAULT_RULE) return error(ctx, command, "預設規則比對所有來源（*），不能改 --src-ip-ranges。");
          rule.srcIpRanges = ranges;
        }
        if (parsed.flags.has("--preview")) rule.preview = true;
        if (parsed.flags.has("--no-preview")) rule.preview = false;
        ctx.out(`Updated [${url(policyName)}].\n`);
        return 0;
      }
      case "delete":
        if (priority === DEFAULT_RULE) return error(ctx, command, "預設規則不能刪除，只能修改它的動作。");
        if (!policy.rules.delete(priority)) return error(ctx, command, `這個政策沒有優先順序 ${priority} 的規則。`);
        ctx.out(`Updated [${url(policyName)}].\n`);
        return 0;
      default:
        return error(ctx, "gcloud.compute.security-policies.rules", `不支援的指令 '${action ?? ""}'。支援 create、update、delete。`);
    }
  }

  const [action, ...rest] = args;
  const command = `gcloud.compute.security-policies.${action}`;
  const parsed = parseArgs(rest, { options: ["--description", "--type", "--project", "--format"], flags: ["--global", "--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  if (action === "list") {
    table(ctx, ["NAME"], [...policies.keys()].map((n) => [n]));
    return 0;
  }
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument NAME: Must be specified.");
  switch (action) {
    case "create": {
      if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
      if (policies.has(name)) return error(ctx, command, `The resource '${url(name).replace("https://www.googleapis.com/compute/v1/", "")}' already exists`);
      if ((parsed.options.get("--type") ?? "CLOUD_ARMOR") !== "CLOUD_ARMOR") return error(ctx, command, "這個模擬終端機只支援後端安全性政策（--type=CLOUD_ARMOR，預設值）。");
      // Every policy has a default rule at the lowest priority; it can be changed but not deleted.
      policies.set(name, { description: parsed.options.get("--description") ?? "", rules: new Map([[DEFAULT_RULE, { action: "allow", srcIpRanges: ["*"], description: "default rule", preview: false }]]) });
      ctx.out(`Created [${url(name)}].\n`);
      return 0;
    }
    case "describe": {
      const p = policies.get(name);
      if (!p) return error(ctx, command, `Could not fetch resource:\n - The resource '${url(name)}' was not found`);
      const rules = [...p.rules].sort(([a], [b]) => a - b);
      ctx.out(
        `description: ${p.description}\nname: ${name}\nrules:\n${rules
          .map(([pr, r]) => `- action: ${r.action}\n  description: ${r.description}\n  match:\n    config:\n      srcIpRanges:\n${r.srcIpRanges.map((x) => `      - '${x}'\n`).join("")}    versionedExpr: SRC_IPS_V1\n  preview: ${r.preview}\n  priority: ${pr}\n`)
          .join("")}`,
      );
      return 0;
    }
    case "delete": {
      if (!policies.has(name)) return error(ctx, command, `Could not fetch resource:\n - The resource '${url(name)}' was not found`);
      const user = [...ctx.state.gcp.backendServices].find(([, s]) => s.securityPolicy === name)?.[0];
      if (user) return error(ctx, command, `The security_policy resource '${name}' is already being used by 'backendServices/${user}'`);
      policies.delete(name);
      ctx.out(`Deleted [${url(name)}].\n`);
      return 0;
    }
    default:
      return error(ctx, "gcloud.compute.security-policies", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、delete，以及 rules create、update、delete。`);
  }
}

/** gcloud kms …; returns null for other groups. */
export function gcloudKms(ctx: Ctx, args: string[]): number {
  if (args[0] === "keys" && args[1] === "versions") return versions(ctx, args.slice(2));
  return kms(ctx, args);
}

/** gcloud compute security-policies …; returns null for other compute groups. */
export function cloudArmor(ctx: Ctx, args: string[]): number | null {
  if (args[0] === "security-policies") return securityPolicies(ctx, args.slice(1));
  return null;
}
