import { parseArgs, type Ctx } from "./context";
import { NAME, NAME_RULE, error, list, networkUrl, subnetUrl, table, zoneRegion } from "./gcloud-common";
import { attachDetach, disks, snapshots } from "./gcloud-disks";
import { networks, routers } from "./gcloud-network";

const ZONE = /^[a-z]+-[a-z]+\d+-[a-z]$/;

/**
 * Picks the network and subnet for a new instance in `region`. Subnets are
 * regional, so the subnet must be in the instance's region. Without flags the
 * instance goes on the default network; auto mode networks have a subnet named
 * after the network in every region.
 */
function networkInterface(ctx: Ctx, command: string, region: string, networkArg?: string, subnetArg?: string): { network: string; subnet: string } | null {
  const gcp = ctx.state.gcp;
  if (subnetArg !== undefined) {
    const subnet = gcp.subnets.get(`${region}/${subnetArg}`);
    if (!subnet) {
      const elsewhere = [...gcp.subnets.values()].find((s) => s.name === subnetArg);
      error(
        ctx,
        command,
        `Could not fetch resource:\n - The resource 'projects/${gcp.project}/regions/${region}/subnetworks/${subnetArg}' was not found${
          elsewhere ? `\n子網路是區域資源：${subnetArg} 在 ${elsewhere.region}，而這台執行個體的可用區在 ${region}。請改用 ${elsewhere.region} 的可用區，或在 ${region} 建立子網路。` : ""
        }`,
      );
      return null;
    }
    if (networkArg !== undefined && networkArg !== subnet.network) {
      error(ctx, command, `子網路 ${subnetArg} 屬於網路 ${subnet.network}，不是 ${networkArg}。`);
      return null;
    }
    return { network: subnet.network, subnet: subnet.name };
  }
  const network = networkArg ?? "default";
  const net = gcp.networks.get(network);
  if (!net) {
    error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${gcp.project}/global/networks/${network}' was not found`);
    return null;
  }
  if (net.mode === "auto") return { network, subnet: network };
  const candidates = [...gcp.subnets.values()].filter((s) => s.network === network && s.region === region);
  if (candidates.length === 1) return { network, subnet: candidates[0].name };
  error(
    ctx,
    command,
    candidates.length === 0
      ? `網路 ${network} 是自訂模式，在區域 ${region} 沒有子網路。請先建立子網路，或選擇有子網路的區域。`
      : `網路 ${network} 在區域 ${region} 有多個子網路，請用 --subnet 指定其中一個。`,
  );
  return null;
}

function instances(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  if (action === "attach-disk" || action === "detach-disk") return attachDetach(ctx, action, rest);
  const command = `gcloud.compute.instances.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--zone", "--machine-type", "--tags", "--image-family", "--image-project", "--image", "--network", "--subnet", "--boot-disk-size", "--project", "--format"],
    flags: ["--quiet", "-q", "--no-address"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;
  const zoneArg = parsed.options.get("--zone");
  const url = (name: string, zone: string) => `https://www.googleapis.com/compute/v1/projects/${gcp.project}/zones/${zone}/instances/${name}`;

  if (action === "list") {
    table(
      ctx,
      ["NAME", "ZONE", "MACHINE_TYPE", "STATUS"],
      [...gcp.instances].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, i]) => [name, i.zone, i.machineType, i.status]),
    );
    return 0;
  }
  if (!["create", "stop", "start", "delete", "add-tags", "describe"].includes(action ?? "")) {
    return error(ctx, "gcloud.compute.instances", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、stop、start、delete、add-tags、attach-disk、detach-disk。`);
  }
  const names = parsed.positional;
  if (names.length === 0) return error(ctx, command, "argument INSTANCE_NAMES: Must be specified.");

  if (action === "create") {
    if (!zoneArg) return error(ctx, command, "這個模擬終端機不會互動詢問可用區，請加上 --zone，例如 --zone=asia-east1-b。");
    if (!ZONE.test(zoneArg)) return error(ctx, command, `Invalid value for field 'zone': '${zoneArg}'. 可用區的格式像 asia-east1-b（區域加上一個字母）。`);
    const machineType = parsed.options.get("--machine-type") ?? "n1-standard-1";
    if (!/^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(machineType)) return error(ctx, command, `Invalid value for field 'resource.machineType': '${machineType}'.`);
    const tags = list(parsed.options.get("--tags"));
    for (const name of names) {
      if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
      if (gcp.instances.has(name)) return error(ctx, command, `The resource 'projects/${gcp.project}/zones/${gcp.instances.get(name)!.zone}/instances/${name}' already exists`);
    }
    const nic = networkInterface(ctx, command, zoneRegion(zoneArg), parsed.options.get("--network"), parsed.options.get("--subnet"));
    if (!nic) return 1;
    const externalIp = !parsed.flags.has("--no-address");
    for (const name of names) {
      gcp.instances.set(name, { zone: zoneArg, machineType, status: "RUNNING", tags: new Set(tags), ...nic, externalIp });
      ctx.out(`Created [${url(name, zoneArg)}].\n`);
    }
    table(ctx, ["NAME", "ZONE", "MACHINE_TYPE", "STATUS"], names.map((n) => [n, zoneArg, machineType, "RUNNING"]));
    return 0;
  }

  // Every other action works on existing instances.
  for (const name of names) {
    const instance = gcp.instances.get(name);
    if (!instance || (zoneArg !== undefined && zoneArg !== instance.zone)) {
      return error(ctx, command, `The resource 'projects/${gcp.project}/zones/${zoneArg ?? "?"}/instances/${name}' was not found`);
    }
  }
  for (const name of names) {
    const instance = gcp.instances.get(name)!;
    switch (action) {
      case "stop":
        instance.status = "TERMINATED";
        ctx.out(`Stopping instance(s) ${name}...done.\nUpdated [${url(name, instance.zone)}].\n`);
        break;
      case "start":
        instance.status = "RUNNING";
        ctx.out(`Starting instance(s) ${name}...done.\nUpdated [${url(name, instance.zone)}].\n`);
        break;
      case "delete":
        gcp.instances.delete(name);
        // Attached data disks stay; they are only detached.
        for (const disk of gcp.disks.values()) disk.users.delete(name);
        ctx.out(`Deleted [${url(name, instance.zone)}].\n`);
        break;
      case "add-tags": {
        const tags = list(parsed.options.get("--tags"));
        if (tags.length === 0) return error(ctx, command, "argument --tags: Must be specified.");
        for (const tag of tags) instance.tags.add(tag);
        ctx.out(`Updated [${url(name, instance.zone)}].\n`);
        break;
      }
      default:
        ctx.out(
          `machineType: ${instance.machineType}\nname: ${name}\nnetworkInterfaces:\n${
            instance.externalIp ? "- accessConfigs:\n  - name: External NAT\n    type: ONE_TO_ONE_NAT\n  " : "- "
          }network: ${networkUrl(gcp.project, instance.network)}\n  subnetwork: ${subnetUrl(gcp.project, zoneRegion(instance.zone), instance.subnet)}\nstatus: ${instance.status}\n${
            instance.tags.size ? `tags:\n  items:\n${[...instance.tags].sort().map((t) => `  - ${t}\n`).join("")}` : ""
          }zone: ${instance.zone}\n`,
        );
    }
  }
  return 0;
}

function firewallRules(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.compute.firewall-rules.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--allow", "--rules", "--action", "--source-ranges", "--target-tags", "--network", "--direction", "--description", "--priority", "--project"],
    flags: ["--quiet", "-q"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;
  const name = parsed.positional[0];

  switch (action) {
    case "list":
      table(
        ctx,
        ["NAME", "NETWORK", "DIRECTION", "ALLOW", "SOURCE_RANGES", "TARGET_TAGS"],
        [...gcp.firewallRules].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, r]) => [
          n,
          r.network,
          "INGRESS",
          [...r.allow].sort().join(","),
          [...r.sourceRanges].sort().join(","),
          [...r.targetTags].sort().join(","),
        ]),
      );
      return 0;
    case "create": {
      if (!name) return error(ctx, command, "argument NAME: Must be specified.");
      if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
      if (gcp.firewallRules.has(name)) return error(ctx, command, `The resource 'projects/${gcp.project}/global/firewalls/${name}' already exists`);
      if ((parsed.options.get("--direction") ?? "INGRESS").toUpperCase() !== "INGRESS") return error(ctx, command, "這個模擬終端機只支援輸入（INGRESS）規則。");
      const allow = list(parsed.options.get("--allow") ?? parsed.options.get("--rules")).map((a) => a.toLowerCase());
      if (allow.length === 0) return error(ctx, command, "請用 --allow 指定要允許的通訊協定和連接埠，例如 --allow=tcp:80。");
      const bad = allow.find((a) => !/^(tcp|udp)(:\d{1,5}(-\d{1,5})?)?$|^icmp$/.test(a));
      if (bad) return error(ctx, command, `argument --allow: 無法解讀 '${bad}'。格式是 通訊協定:連接埠，例如 tcp:80 或 tcp:8000-8080。`);
      const ranges = list(parsed.options.get("--source-ranges"));
      const network = parsed.options.get("--network") ?? "default";
      if (!gcp.networks.has(network)) return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${gcp.project}/global/networks/${network}' was not found`);
      // With no source filter, Google Cloud defaults ingress rules to every IPv4 address.
      gcp.firewallRules.set(name, {
        network,
        allow: new Set(allow),
        sourceRanges: new Set(ranges.length ? ranges : ["0.0.0.0/0"]),
        targetTags: new Set(list(parsed.options.get("--target-tags"))),
      });
      ctx.out(`Creating firewall...done.\nCreated [https://www.googleapis.com/compute/v1/projects/${gcp.project}/global/firewalls/${name}].\n`);
      return 0;
    }
    case "delete":
      if (!name) return error(ctx, command, "argument NAME: Must be specified.");
      if (!gcp.firewallRules.delete(name)) return error(ctx, command, `The resource 'projects/${gcp.project}/global/firewalls/${name}' was not found`);
      ctx.out(`Deleted [https://www.googleapis.com/compute/v1/projects/${gcp.project}/global/firewalls/${name}].\n`);
      return 0;
    default:
      return error(ctx, "gcloud.compute.firewall-rules", `不支援的指令 '${action ?? ""}'。支援 create、list、delete。`);
  }
}

/** `gcloud compute instances | firewall-rules | networks | routers …`. */
export function compute(ctx: Ctx, args: string[]): number {
  if (args[0] === "instances") return instances(ctx, args.slice(1));
  if (args[0] === "firewall-rules") return firewallRules(ctx, args.slice(1));
  if (args[0] === "networks") return networks(ctx, args.slice(1));
  if (args[0] === "routers") return routers(ctx, args.slice(1));
  if (args[0] === "disks") return disks(ctx, args.slice(1));
  if (args[0] === "snapshots") return snapshots(ctx, args.slice(1));
  return error(
    ctx,
    "gcloud.compute",
    `不支援 '${args[0] ?? ""}'。這個模擬終端機支援 gcloud compute instances、firewall-rules、networks（含 networks subnets）、routers（含 routers nats）、disks 和 snapshots。`,
  );
}
