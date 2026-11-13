import { parseArgs, type Ctx } from "./context";

function error(ctx: Ctx, command: string, message: string): number {
  ctx.err(`ERROR: (${command}) ${message}`);
  return 1;
}

const NAME = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const NAME_RULE = "名稱必須以小寫字母開頭，只能包含小寫字母、數字和連字號，最多 63 個字元。";
const ZONE = /^[a-z]+-[a-z]+\d+-[a-z]$/;
const list = (value: string | undefined) => (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);

function table(ctx: Ctx, header: string[], rows: string[][]) {
  if (rows.length === 0) {
    ctx.out("Listed 0 items.\n");
    return;
  }
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)) + 2);
  for (const row of [header, ...rows]) ctx.out(`${row.map((cell, i) => cell.padEnd(widths[i])).join("").trimEnd()}\n`);
}

function instances(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
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
    return error(ctx, "gcloud.compute.instances", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、stop、start、delete、add-tags。`);
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
    for (const name of names) {
      gcp.instances.set(name, { zone: zoneArg, machineType, status: "RUNNING", tags: new Set(tags) });
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
          `machineType: ${instance.machineType}\nname: ${name}\nstatus: ${instance.status}\n${
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
          "default",
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
      // With no source filter, Google Cloud defaults ingress rules to every IPv4 address.
      gcp.firewallRules.set(name, {
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

/** `gcloud compute instances …` and `gcloud compute firewall-rules …`. */
export function compute(ctx: Ctx, args: string[]): number {
  if (args[0] === "instances") return instances(ctx, args.slice(1));
  if (args[0] === "firewall-rules") return firewallRules(ctx, args.slice(1));
  return error(ctx, "gcloud.compute", `不支援 '${args[0] ?? ""}'。這個模擬終端機支援 gcloud compute instances 和 gcloud compute firewall-rules。`);
}
