import { parseArgs, type Ctx } from "./context";
import { error, list, table } from "./gcloud-common";

const TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "CAA", "SRV", "PTR"];
const ZONE_NAME = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Adds the trailing dot DNS names carry in Cloud DNS. */
export const fqdn = (name: string) => (name.endsWith(".") ? name : `${name}.`).toLowerCase();
const inZone = (name: string, zone: string) => name === zone || name.endsWith(`.${zone}`);
const key = (name: string, type: string) => `${name}|${type}`;

function zones(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.dns.managed-zones.${action}`;
  const parsed = parseArgs(rest, { options: ["--dns-name", "--description", "--visibility", "--networks", "--project", "--format"], flags: ["--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const all = ctx.state.gcp.dns.zones;
  if (action === "list") {
    table(ctx, ["NAME", "DNS_NAME", "DESCRIPTION", "VISIBILITY"], [...all].map(([n, z]) => [n, z.dnsName, z.description, z.visibility]));
    return 0;
  }
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument ZONE_NAME: Must be specified.");
  switch (action) {
    case "create": {
      if (!ZONE_NAME.test(name)) return error(ctx, command, `Invalid value for 'name': '${name}'. 名稱只能用小寫字母、數字和連字號，並以字母開頭。`);
      if (all.has(name)) return error(ctx, command, `The resource 'entity.managedZone' named '${name}' already exists`);
      const dnsName = parsed.options.get("--dns-name");
      if (dnsName === undefined) return error(ctx, command, "argument --dns-name: Must be specified.");
      const zoneName = fqdn(dnsName);
      if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+$/.test(zoneName) || zoneName.split(".").length < 3) {
        return error(ctx, command, `Invalid value for 'entity.managedZone.dnsName': '${dnsName}'（請用像 example.com. 這樣的網域名稱）`);
      }
      const visibility = parsed.options.get("--visibility") ?? "public";
      if (visibility !== "public" && visibility !== "private") return error(ctx, command, "argument --visibility: Invalid choice. 可用的值：public、private");
      if (visibility === "private" && !parsed.options.has("--networks")) return error(ctx, command, "私人區域要用 --networks 指定看得到它的 VPC 網路。");
      const letter = "abcde"[all.size % 5];
      const nameServers = [1, 2, 3, 4].map((i) => `ns-cloud-${letter}${i}.googledomains.com.`);
      // Cloud DNS creates the NS and SOA records with the zone.
      const records = new Map([
        [key(zoneName, "NS"), { ttl: 21600, rrdatas: nameServers }],
        [key(zoneName, "SOA"), { ttl: 21600, rrdatas: [`${nameServers[0]} cloud-dns-hostmaster.google.com. 1 21600 3600 259200 300`] }],
      ]);
      all.set(name, { dnsName: zoneName, description: parsed.options.get("--description") ?? "", visibility, nameServers, records });
      ctx.out(`Created [https://dns.googleapis.com/dns/v1/projects/${ctx.state.gcp.project}/managedZones/${name}].\n`);
      return 0;
    }
    case "describe": {
      const z = all.get(name);
      if (!z) return error(ctx, command, `The 'parameters.managedZone' resource named '${name}' does not exist.`);
      ctx.out(`description: ${z.description}\ndnsName: ${z.dnsName}\nname: ${name}\nnameServers:\n${z.nameServers.map((n) => `- ${n}\n`).join("")}visibility: ${z.visibility}\n`);
      return 0;
    }
    case "delete": {
      const z = all.get(name);
      if (!z) return error(ctx, command, `The 'parameters.managedZone' resource named '${name}' does not exist.`);
      const extra = [...z.records.keys()].filter((k) => k !== key(z.dnsName, "NS") && k !== key(z.dnsName, "SOA"));
      if (extra.length) return error(ctx, command, `The resource named '${name}' cannot be deleted because it is not empty（先刪除 NS、SOA 以外的紀錄）`);
      all.delete(name);
      ctx.out(`Deleted [https://dns.googleapis.com/dns/v1/projects/${ctx.state.gcp.project}/managedZones/${name}].\n`);
      return 0;
    }
    default:
      return error(ctx, "gcloud.dns.managed-zones", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、delete。`);
  }
}

function recordSets(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.dns.record-sets.${action}`;
  const parsed = parseArgs(rest, { options: ["--zone", "-z", "--type", "--ttl", "--rrdatas", "--project", "--format"], flags: ["--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const zoneName = parsed.options.get("--zone") ?? parsed.options.get("-z");
  if (zoneName === undefined) return error(ctx, command, "argument --zone: Must be specified.");
  const zone = ctx.state.gcp.dns.zones.get(zoneName);
  if (!zone) return error(ctx, command, `The 'parameters.managedZone' resource named '${zoneName}' does not exist.`);
  if (action === "list") {
    table(ctx, ["NAME", "TYPE", "TTL", "DATA"], [...zone.records].map(([k, r]) => [...k.split("|"), String(r.ttl), r.rrdatas.join(",")]));
    return 0;
  }
  if (!["create", "update", "delete", "describe"].includes(action ?? "")) {
    return error(ctx, "gcloud.dns.record-sets", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、update、delete。`);
  }
  const raw = parsed.positional[0];
  if (!raw) return error(ctx, command, "argument DNS_NAME: Must be specified.");
  const name = fqdn(raw);
  const type = parsed.options.get("--type")?.toUpperCase();
  if (type === undefined) return error(ctx, command, "argument --type: Must be specified.");
  if (!TYPES.includes(type) && type !== "SOA") return error(ctx, command, `這個模擬終端機支援的紀錄類型：${TYPES.join("、")}`);
  const k = key(name, type);
  const existing = zone.records.get(k);
  const missing = () => error(ctx, command, `The 'entity.change.deletions[${name}][${type}]' resource named '${name} (${type})' does not exist.`);
  if (action === "describe") {
    if (!existing) return missing();
    table(ctx, ["NAME", "TYPE", "TTL", "DATA"], [[name, type, String(existing.ttl), existing.rrdatas.join(",")]]);
    return 0;
  }
  if (action === "delete") {
    if (!existing) return missing();
    if (name === zone.dnsName && (type === "NS" || type === "SOA")) return error(ctx, command, "區域頂點的 NS 和 SOA 紀錄由 Cloud DNS 管理，不能刪除。");
    zone.records.delete(k);
    ctx.out(`Deleted [${name}][${type}].\n`);
    return 0;
  }
  if (!inZone(name, zone.dnsName)) return error(ctx, command, `The 'entity.change.additions[${name}][${type}]' resource named '${name} (${type})' is not within the zone '${zone.dnsName}'.（紀錄名稱要以區域的網域名稱結尾）`);
  const rrdatas = list(parsed.options.get("--rrdatas"));
  if (!rrdatas.length) return error(ctx, command, "argument --rrdatas: Must be specified.");
  const ttlText = parsed.options.get("--ttl");
  if (ttlText === undefined && !existing) return error(ctx, command, "這個模擬終端機需要用 --ttl 指定 TTL（秒），例如 --ttl=300。");
  const ttl = ttlText === undefined ? existing!.ttl : Number(ttlText);
  if (!Number.isInteger(ttl) || ttl < 0) return error(ctx, command, `argument --ttl: 要是 0 以上的整數（秒），收到 '${ttlText}'。`);
  if (type === "A" && !rrdatas.every((v) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(v) && v.split(".").every((p) => Number(p) <= 255))) {
    return error(ctx, command, `Invalid value for 'entity.change.additions[${name}][A].rrdata[0]': A 紀錄的值要是 IPv4 位址。`);
  }
  if (type === "CNAME") {
    if (name === zone.dnsName) {
      return error(ctx, command, `The resource record set 'entity.change.additions[${name}][CNAME]' is invalid because a CNAME cannot be placed at the zone apex.（頂點已經有 NS 和 SOA 紀錄）`);
    }
    if (rrdatas.length !== 1) return error(ctx, command, "CNAME 紀錄只能有一個值。");
  }
  const sameName = [...zone.records.keys()].filter((x) => x.startsWith(`${name}|`) && x !== k);
  if ((type === "CNAME" && sameName.length) || (type !== "CNAME" && zone.records.has(key(name, "CNAME")))) {
    return error(ctx, command, `The resource record set 'entity.change.additions[${name}][${type}]' is invalid because the DNS name '${name}' has a CNAME record and other records at the same name.（CNAME 不能和同名的其他紀錄並存）`);
  }
  const values = type === "CNAME" ? rrdatas.map(fqdn) : rrdatas;
  if (action === "create") {
    if (existing) return error(ctx, command, `The resource 'entity.change.additions[${name}][${type}]' named '${name} (${type})' already exists（要修改請用 update）`);
  } else if (!existing) return missing();
  zone.records.set(k, { ttl, rrdatas: values });
  table(ctx, ["NAME", "TYPE", "TTL", "DATA"], [[name, type, String(ttl), values.join(",")]]);
  return 0;
}

export function dns(ctx: Ctx, args: string[]): number {
  if (args[0] === "managed-zones") return zones(ctx, args.slice(1));
  if (args[0] === "record-sets") return recordSets(ctx, args.slice(1));
  return error(ctx, "gcloud.dns", `不支援 '${args[0] ?? ""}'。這個模擬終端機支援 gcloud dns managed-zones 和 gcloud dns record-sets。`);
}
