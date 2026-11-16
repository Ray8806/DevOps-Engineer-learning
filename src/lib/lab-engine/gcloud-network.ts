import { cidrOverlaps, formatCidr, parseCidr } from "./cidr";
import { parseArgs, type Ctx } from "./context";
import { NAME, NAME_RULE, error, list, networkUrl, subnetUrl, table } from "./gcloud-common";

const REGION = /^[a-z]+-[a-z]+\d+$/;
/** Auto mode subnets are carved out of this block. */
const AUTO_MODE_BLOCK = parseCidr("10.128.0.0/9")!;

const notFound = (ctx: Ctx, command: string, resource: string) =>
  error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${ctx.state.gcp.project}/${resource}' was not found`);

function regionArg(ctx: Ctx, command: string, region: string | undefined): string | null {
  if (region === undefined) {
    error(ctx, command, "這個模擬終端機不會互動詢問區域，請加上 --region，例如 --region=asia-east1。");
    return null;
  }
  if (!REGION.test(region)) {
    error(ctx, command, `Invalid value for field 'region': '${region}'. 區域的格式像 asia-east1（不含最後的可用區字母）。`);
    return null;
  }
  return region;
}

// ------------------------------------------------------------------ networks

function subnets(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.compute.networks.subnets.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--network", "--range", "--region", "--regions", "--description", "--project", "--format"],
    flags: ["--quiet", "-q", "--enable-private-ip-google-access", "--no-enable-private-ip-google-access"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;
  const name = parsed.positional[0];

  if (action === "list") {
    const network = parsed.options.get("--network");
    const regions = list(parsed.options.get("--regions"));
    const rows = [...gcp.subnets.values()]
      .filter((s) => (network === undefined || s.network === network) && (regions.length === 0 || regions.includes(s.region)))
      .sort((a, b) => (a.name + a.region < b.name + b.region ? -1 : 1))
      .map((s) => [s.name, s.region, s.network, s.range]);
    table(ctx, ["NAME", "REGION", "NETWORK", "RANGE"], rows);
    const auto = [...gcp.networks].filter(([n, net]) => net.mode === "auto" && (network === undefined || network === n)).map(([n]) => n);
    if (auto.length) ctx.out(`（auto 模式網路 ${auto.join("、")} 在每個區域都有一個同名的子網路，範圍在 10.128.0.0/9 內，這個模擬終端機不逐一列出。）\n`);
    return 0;
  }
  if (!["create", "describe", "delete"].includes(action ?? "")) {
    return error(ctx, "gcloud.compute.networks.subnets", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、delete。`);
  }
  if (!name) return error(ctx, command, "argument NAME: Must be specified.");
  const region = regionArg(ctx, command, parsed.options.get("--region"));
  if (!region) return 1;
  const key = `${region}/${name}`;

  if (action === "create") {
    const networkName = parsed.options.get("--network");
    if (networkName === undefined) return error(ctx, command, "argument --network: Must be specified.");
    if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
    const network = gcp.networks.get(networkName);
    if (!network) return notFound(ctx, command, `global/networks/${networkName}`);
    if (gcp.subnets.has(key)) return error(ctx, command, `The resource 'projects/${gcp.project}/regions/${region}/subnetworks/${name}' already exists`);
    const rangeArg = parsed.options.get("--range");
    if (rangeArg === undefined) return error(ctx, command, "請用 --range 指定子網路的 IPv4 範圍，例如 --range=10.10.1.0/24。");
    const range = parseCidr(rangeArg);
    if (!range) return error(ctx, command, `Invalid IPCidrRange: ${rangeArg}. 格式像 10.10.1.0/24。`);
    if (!range.canonical) return error(ctx, command, `Invalid IPCidrRange: ${rangeArg}. 範圍要寫成網路位址，例如 ${formatCidr(range)}。`);
    // The longest mask is /29; Google recommends nothing larger than /8.
    if (range.prefix > 29 || range.prefix < 8) return error(ctx, command, `Invalid IPCidrRange: ${rangeArg}. 這個模擬終端機接受 /8 到 /29 的範圍（最小的子網路是 /29，也就是 8 個位址）。`);
    if (network.mode === "auto" && cidrOverlaps(range, AUTO_MODE_BLOCK)) {
      return error(ctx, command, `Invalid IPCidrRange: ${rangeArg} conflicts with the auto mode range 10.128.0.0/9. 在 auto 模式網路手動加子網路時，要使用 10.128.0.0/9 以外的範圍。`);
    }
    const conflict = [...gcp.subnets.values()].find((s) => s.network === networkName && cidrOverlaps(parseCidr(s.range)!, range));
    if (conflict) {
      return error(ctx, command, `Invalid IPCidrRange: ${rangeArg} conflicts with existing subnetwork '${conflict.name}' in region '${conflict.region}'.`);
    }
    gcp.subnets.set(key, { name, network: networkName, region, range: rangeArg });
    ctx.out(`Created [${subnetUrl(gcp.project, region, name)}].\n`);
    table(ctx, ["NAME", "REGION", "NETWORK", "RANGE"], [[name, region, networkName, rangeArg]]);
    return 0;
  }

  const subnet = gcp.subnets.get(key);
  if (!subnet) return notFound(ctx, command, `regions/${region}/subnetworks/${name}`);
  if (action === "describe") {
    ctx.out(`ipCidrRange: ${subnet.range}\nname: ${name}\nnetwork: ${networkUrl(gcp.project, subnet.network)}\nregion: ${region}\n`);
    return 0;
  }
  const user = [...gcp.instances].find(([, i]) => i.subnet === name && i.network === subnet.network && i.zone.startsWith(`${region}-`));
  if (user) return error(ctx, command, `The subnetwork resource '${key}' is already being used by 'instances/${user[0]}'`);
  gcp.subnets.delete(key);
  ctx.out(`Deleted [${subnetUrl(gcp.project, region, name)}].\n`);
  return 0;
}

export function networks(ctx: Ctx, args: string[]): number {
  if (args[0] === "subnets") return subnets(ctx, args.slice(1));
  const [action, ...rest] = args;
  const command = `gcloud.compute.networks.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--subnet-mode", "--bgp-routing-mode", "--description", "--mtu", "--project", "--format"],
    flags: ["--quiet", "-q"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;
  const name = parsed.positional[0];
  const row = (n: string, mode: string) => [n, mode.toUpperCase(), "REGIONAL"];

  switch (action) {
    case "list":
      table(ctx, ["NAME", "SUBNET_MODE", "BGP_ROUTING_MODE"], [...gcp.networks].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, net]) => row(n, net.mode)));
      return 0;
    case "create": {
      if (!name) return error(ctx, command, "argument NAME: Must be specified.");
      if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
      if (gcp.networks.has(name)) return error(ctx, command, `The resource 'projects/${gcp.project}/global/networks/${name}' already exists`);
      // Without --subnet-mode, gcloud creates an auto mode network.
      const mode = (parsed.options.get("--subnet-mode") ?? "auto").toLowerCase();
      if (mode !== "auto" && mode !== "custom") return error(ctx, command, `argument --subnet-mode: Invalid choice: '${mode}'. 請使用 auto 或 custom。`);
      gcp.networks.set(name, { mode });
      ctx.out(`Created [${networkUrl(gcp.project, name)}].\n`);
      table(ctx, ["NAME", "SUBNET_MODE", "BGP_ROUTING_MODE"], [row(name, mode)]);
      ctx.out(
        `\nInstances on this network will not be reachable until firewall rules\nare created. As an example, you can allow all internal traffic between\ninstances as well as SSH, RDP, and ICMP by running:\n\n$ gcloud compute firewall-rules create <FIREWALL_NAME> --network ${name} --allow tcp:22,tcp:3389,icmp\n`,
      );
      return 0;
    }
    case "describe": {
      if (!name) return error(ctx, command, "argument NAME: Must be specified.");
      const net = gcp.networks.get(name);
      if (!net) return notFound(ctx, command, `global/networks/${name}`);
      const subs = [...gcp.subnets.values()].filter((s) => s.network === name);
      ctx.out(
        `autoCreateSubnetworks: ${net.mode === "auto"}\nname: ${name}\nroutingConfig:\n  routingMode: REGIONAL\n${
          subs.length ? `subnetworks:\n${subs.map((s) => `- ${subnetUrl(gcp.project, s.region, s.name)}\n`).join("")}` : ""
        }x_gcloud_subnet_mode: ${net.mode.toUpperCase()}\n`,
      );
      return 0;
    }
    case "delete": {
      if (!name) return error(ctx, command, "argument NAME: Must be specified.");
      if (!gcp.networks.has(name)) return notFound(ctx, command, `global/networks/${name}`);
      const user =
        [...gcp.subnets.values()].find((s) => s.network === name)?.name.replace(/^/, "subnetworks/") ??
        [...gcp.firewallRules].find(([, r]) => r.network === name)?.[0].replace(/^/, "firewalls/") ??
        [...gcp.instances].find(([, i]) => i.network === name)?.[0].replace(/^/, "instances/") ??
        [...gcp.routers.values()].find((r) => r.network === name)?.name.replace(/^/, "routers/");
      if (user) return error(ctx, command, `The network resource 'projects/${gcp.project}/global/networks/${name}' is already being used by '${user}'`);
      gcp.networks.delete(name);
      ctx.out(`Deleted [${networkUrl(gcp.project, name)}].\n`);
      return 0;
    }
    default:
      return error(ctx, "gcloud.compute.networks", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、delete，以及 networks subnets。`);
  }
}

// ------------------------------------------------------------------- routers

const routerUrl = (project: string, region: string, name: string) =>
  `https://www.googleapis.com/compute/v1/projects/${project}/regions/${region}/routers/${name}`;

function nats(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.compute.routers.nats.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--router", "--region", "--nat-custom-subnet-ip-ranges", "--nat-external-ip-pool", "--project", "--format"],
    flags: ["--auto-allocate-nat-external-ips", "--nat-all-subnet-ip-ranges", "--nat-primary-subnet-ip-ranges", "--enable-logging", "--quiet", "-q", "--async"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  if (!["create", "list", "delete"].includes(action ?? "")) {
    return error(ctx, "gcloud.compute.routers.nats", `不支援的指令 '${action ?? ""}'。支援 create、list、delete。`);
  }
  const gcp = ctx.state.gcp;
  const routerName = parsed.options.get("--router");
  if (routerName === undefined) return error(ctx, command, "argument --router: Must be specified.");
  const region = regionArg(ctx, command, parsed.options.get("--region"));
  if (!region) return 1;
  const router = gcp.routers.get(`${region}/${routerName}`);
  if (!router) return notFound(ctx, command, `regions/${region}/routers/${routerName}`);
  const name = parsed.positional[0];

  if (action === "list") {
    table(ctx, ["NAME", "NAT_IP_ALLOCATE_OPTION", "SOURCE_SUBNETWORK_IP_RANGES_TO_NAT"], [...router.nats].map(([n, served]) => [
      n,
      "AUTO_ONLY",
      served === "ALL" ? "ALL_SUBNETWORKS_ALL_IP_RANGES" : "LIST_OF_SUBNETWORKS",
    ]));
    return 0;
  }
  if (!name) return error(ctx, command, "argument NAME: Must be specified.");
  if (action === "delete") {
    if (!router.nats.delete(name)) return error(ctx, command, `NAT \`${name}\` not found`);
    ctx.out(`Updated [${routerUrl(gcp.project, region, routerName)}].\n`);
    return 0;
  }
  if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.nats[0].name': '${name}'. ${NAME_RULE}`);
  if (router.nats.has(name)) return error(ctx, command, `NAT \`${name}\` already exists`);
  if (!parsed.flags.has("--auto-allocate-nat-external-ips") && !parsed.options.has("--nat-external-ip-pool")) {
    return error(ctx, command, "請指定 NAT 使用的外部 IP：--auto-allocate-nat-external-ips（自動配置）或 --nat-external-ip-pool。");
  }
  let served: string[] | "ALL";
  if (parsed.flags.has("--nat-all-subnet-ip-ranges") || parsed.flags.has("--nat-primary-subnet-ip-ranges")) served = "ALL";
  else if (parsed.options.has("--nat-custom-subnet-ip-ranges")) {
    served = list(parsed.options.get("--nat-custom-subnet-ip-ranges")).map((s) => s.split(":")[0]);
    const missing = served.find((s) => !gcp.subnets.has(`${region}/${s}`) || gcp.subnets.get(`${region}/${s}`)!.network !== router.network);
    if (missing) return error(ctx, command, `子網路 ${missing} 不在網路 ${router.network} 的 ${region} 區域。Cloud NAT 只能服務同一個區域、同一個網路的子網路。`);
  } else {
    return error(ctx, command, "請指定要使用 NAT 的子網路：--nat-all-subnet-ip-ranges（這個區域的所有子網路）或 --nat-custom-subnet-ip-ranges。");
  }
  router.nats.set(name, served);
  ctx.out(`Creating NAT [${name}] in router [${routerName}]...done.\n`);
  return 0;
}

export function routers(ctx: Ctx, args: string[]): number {
  if (args[0] === "nats") return nats(ctx, args.slice(1));
  const [action, ...rest] = args;
  const command = `gcloud.compute.routers.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--network", "--region", "--asn", "--description", "--project", "--format"],
    flags: ["--quiet", "-q", "--async"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;
  if (action === "list") {
    table(ctx, ["NAME", "REGION", "NETWORK"], [...gcp.routers.values()].map((r) => [r.name, r.region, r.network]));
    return 0;
  }
  if (!["create", "describe", "delete"].includes(action ?? "")) {
    return error(ctx, "gcloud.compute.routers", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、delete，以及 routers nats。`);
  }
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument NAME: Must be specified.");
  const region = regionArg(ctx, command, parsed.options.get("--region"));
  if (!region) return 1;
  const key = `${region}/${name}`;

  if (action === "create") {
    const network = parsed.options.get("--network");
    if (network === undefined) return error(ctx, command, "argument --network: Must be specified.");
    if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
    if (!gcp.networks.has(network)) return notFound(ctx, command, `global/networks/${network}`);
    if (gcp.routers.has(key)) return error(ctx, command, `The resource 'projects/${gcp.project}/regions/${region}/routers/${name}' already exists`);
    gcp.routers.set(key, { name, network, region, nats: new Map() });
    ctx.out(`Creating router [${name}]...done.\n`);
    table(ctx, ["NAME", "REGION", "NETWORK"], [[name, region, network]]);
    return 0;
  }
  const router = gcp.routers.get(key);
  if (!router) return notFound(ctx, command, `regions/${region}/routers/${name}`);
  if (action === "describe") {
    ctx.out(
      `name: ${name}\n${router.nats.size ? `nats:\n${[...router.nats.keys()].map((n) => `- name: ${n}\n`).join("")}` : ""}network: ${networkUrl(gcp.project, router.network)}\nregion: ${region}\n`,
    );
    return 0;
  }
  gcp.routers.delete(key);
  ctx.out(`Deleted [${routerUrl(gcp.project, region, name)}].\n`);
  return 0;
}
