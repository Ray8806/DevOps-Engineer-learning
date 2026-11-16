import { parseArgs, type Ctx } from "./context";
import { NAME, NAME_RULE, error, table } from "./gcloud-common";

const ZONE = /^[a-z]+-[a-z]+\d+-[a-z]$/;
const TYPES = ["pd-standard", "pd-balanced", "pd-ssd", "pd-extreme"];
/** gcloud's default size when --size is omitted, by disk type. */
const DEFAULT_SIZE: Record<string, number> = { "pd-standard": 500, "pd-balanced": 100, "pd-ssd": 100, "pd-extreme": 1000 };
const MAX_GB = 64 * 1024;

const diskUrl = (project: string, zone: string, name: string) => `https://www.googleapis.com/compute/v1/projects/${project}/zones/${zone}/disks/${name}`;
const snapshotUrl = (project: string, name: string) => `https://www.googleapis.com/compute/v1/projects/${project}/global/snapshots/${name}`;

/** "100GB", "2TB" or a bare number of GB -> GB; null when unreadable. */
function sizeGb(text: string): number | null {
  const m = /^(\d+)(GB|TB)?$/i.exec(text);
  if (!m) return null;
  return Number(m[1]) * (m[2]?.toUpperCase() === "TB" ? 1024 : 1);
}

function zoneArg(ctx: Ctx, command: string, zone: string | undefined): string | null {
  if (zone === undefined) {
    error(ctx, command, "這個模擬終端機不會互動詢問可用區，請加上 --zone，例如 --zone=asia-east1-b。");
    return null;
  }
  if (!ZONE.test(zone)) {
    error(ctx, command, `Invalid value for field 'zone': '${zone}'. 可用區的格式像 asia-east1-b（區域加上一個字母）。`);
    return null;
  }
  return zone;
}

export function disks(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.compute.disks.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--zone", "--size", "--type", "--source-snapshot", "--snapshot-names", "--description", "--project", "--format"],
    flags: ["--quiet", "-q"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;
  if (action === "list") {
    table(
      ctx,
      ["NAME", "LOCATION", "LOCATION_SCOPE", "SIZE_GB", "TYPE", "STATUS"],
      [...gcp.disks].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, d]) => [n, d.zone, "zone", String(d.sizeGb), d.type, "READY"]),
    );
    return 0;
  }
  if (!["create", "describe", "delete", "resize", "snapshot"].includes(action ?? "")) {
    return error(ctx, "gcloud.compute.disks", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、resize、snapshot、delete。`);
  }
  const names = parsed.positional;
  if (names.length === 0) return error(ctx, command, "argument DISK_NAME: Must be specified.");
  const zone = zoneArg(ctx, command, parsed.options.get("--zone"));
  if (!zone) return 1;

  if (action === "create") {
    const type = parsed.options.get("--type") ?? "pd-standard";
    if (!TYPES.includes(type)) return error(ctx, command, `Invalid value for field 'resource.type': '${type}'. 這個模擬終端機支援的磁碟類型：${TYPES.join("、")}`);
    const snapshotName = parsed.options.get("--source-snapshot");
    const snapshot = snapshotName === undefined ? undefined : gcp.snapshots.get(snapshotName);
    if (snapshotName !== undefined && !snapshot) {
      return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${gcp.project}/global/snapshots/${snapshotName}' was not found`);
    }
    const sizeText = parsed.options.get("--size");
    const size = sizeText === undefined ? (snapshot?.sizeGb ?? DEFAULT_SIZE[type]) : sizeGb(sizeText);
    if (size === null) return error(ctx, command, `argument --size: 無法解讀 '${sizeText}'，格式像 100GB 或 2TB。`);
    if (size < 10 || size > MAX_GB) return error(ctx, command, `Invalid value for field 'resource.sizeGb': '${size}'. 這個模擬終端機接受 10 GB 到 64 TB。`);
    if (snapshot && size < snapshot.sizeGb) {
      return error(ctx, command, `Invalid value for field 'resource.sizeGb': '${size}'. Requested disk size cannot be smaller than the snapshot size (${snapshot.sizeGb} GB).`);
    }
    for (const name of names) {
      if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
      if (gcp.disks.has(name)) return error(ctx, command, `The resource 'projects/${gcp.project}/zones/${gcp.disks.get(name)!.zone}/disks/${name}' already exists`);
    }
    for (const name of names) {
      gcp.disks.set(name, { zone, sizeGb: size, type, sourceSnapshot: snapshotName ?? null, users: new Map() });
      ctx.out(`Created [${diskUrl(gcp.project, zone, name)}].\n`);
    }
    table(ctx, ["NAME", "ZONE", "SIZE_GB", "TYPE", "STATUS"], names.map((n) => [n, zone, String(size), type, "READY"]));
    return 0;
  }

  for (const name of names) {
    const disk = gcp.disks.get(name);
    if (!disk || disk.zone !== zone) {
      return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${gcp.project}/zones/${zone}/disks/${name}' was not found`);
    }
  }
  switch (action) {
    case "describe": {
      const d = gcp.disks.get(names[0])!;
      ctx.out(
        `name: ${names[0]}\nsizeGb: '${d.sizeGb}'\n${d.sourceSnapshot ? `sourceSnapshot: ${snapshotUrl(gcp.project, d.sourceSnapshot)}\n` : ""}status: READY\ntype: ${d.type}\n${
          d.users.size ? `users:\n${[...d.users.keys()].map((u) => `- https://www.googleapis.com/compute/v1/projects/${gcp.project}/zones/${zone}/instances/${u}\n`).join("")}` : ""
        }zone: ${zone}\n`,
      );
      return 0;
    }
    case "resize": {
      const sizeText = parsed.options.get("--size");
      if (sizeText === undefined) return error(ctx, command, "argument --size: Must be specified.");
      const size = sizeGb(sizeText);
      if (size === null) return error(ctx, command, `argument --size: 無法解讀 '${sizeText}'，格式像 200GB。`);
      for (const name of names) {
        const d = gcp.disks.get(name)!;
        if (size <= d.sizeGb) {
          return error(ctx, command, `Invalid value for field 'sizeGb': '${size}'. New size must be larger than existing size '${d.sizeGb}'. 磁碟只能加大，不能縮小。`);
        }
        if (size > MAX_GB) return error(ctx, command, `Invalid value for field 'sizeGb': '${size}'.`);
      }
      for (const name of names) {
        gcp.disks.get(name)!.sizeGb = size;
        ctx.out(`Updated [${diskUrl(gcp.project, zone, name)}].\n`);
      }
      return 0;
    }
    case "snapshot": {
      const snapshotNames = (parsed.options.get("--snapshot-names") ?? "").split(",").filter(Boolean);
      if (snapshotNames.length !== names.length) {
        return error(ctx, command, "請用 --snapshot-names 為每個磁碟指定快照名稱，例如 --snapshot-names=data-snap。");
      }
      return createSnapshots(ctx, command, snapshotNames.map((s, i) => [s, names[i]]));
    }
    default: {
      // delete
      const inUse = names.find((n) => gcp.disks.get(n)!.users.size);
      if (inUse) {
        return error(ctx, command, `The disk resource 'projects/${gcp.project}/zones/${zone}/disks/${inUse}' is already being used by '${[...gcp.disks.get(inUse)!.users.keys()][0]}'`);
      }
      for (const name of names) {
        gcp.disks.delete(name);
        ctx.out(`Deleted [${diskUrl(gcp.project, zone, name)}].\n`);
      }
      return 0;
    }
  }
}

function createSnapshots(ctx: Ctx, command: string, pairs: [string, string][]): number {
  const gcp = ctx.state.gcp;
  for (const [snap] of pairs) {
    if (!NAME.test(snap)) return error(ctx, command, `Invalid value for field 'resource.name': '${snap}'. ${NAME_RULE}`);
    if (gcp.snapshots.has(snap)) return error(ctx, command, `The resource 'projects/${gcp.project}/global/snapshots/${snap}' already exists`);
  }
  for (const [snap, disk] of pairs) {
    gcp.snapshots.set(snap, { sourceDisk: disk, sizeGb: gcp.disks.get(disk)!.sizeGb });
    ctx.out(`Creating snapshot(s) ${snap}...done.\n`);
  }
  return 0;
}

export function snapshots(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.compute.snapshots.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--source-disk", "--source-disk-zone", "--storage-location", "--description", "--project", "--format"],
    flags: ["--quiet", "-q"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;
  const name = parsed.positional[0];
  switch (action) {
    case "list":
      table(
        ctx,
        ["NAME", "DISK_SIZE_GB", "SRC_DISK", "STATUS"],
        [...gcp.snapshots].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, s]) => [n, String(s.sizeGb), s.sourceDisk, "READY"]),
      );
      return 0;
    case "create": {
      if (!name) return error(ctx, command, "argument NAME: Must be specified.");
      const diskName = parsed.options.get("--source-disk");
      if (diskName === undefined) return error(ctx, command, "argument --source-disk: Must be specified.");
      const zone = zoneArg(ctx, command, parsed.options.get("--source-disk-zone"));
      if (!zone) return 1;
      const disk = gcp.disks.get(diskName);
      if (!disk || disk.zone !== zone) {
        return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${gcp.project}/zones/${zone}/disks/${diskName}' was not found`);
      }
      return createSnapshots(ctx, command, [[name, diskName]]);
    }
    case "describe": {
      if (!name) return error(ctx, command, "argument NAME: Must be specified.");
      const s = gcp.snapshots.get(name);
      if (!s) return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${gcp.project}/global/snapshots/${name}' was not found`);
      ctx.out(`diskSizeGb: '${s.sizeGb}'\nname: ${name}\nsourceDisk: ${s.sourceDisk}\nstatus: READY\n`);
      return 0;
    }
    case "delete":
      if (!name) return error(ctx, command, "argument NAME: Must be specified.");
      if (!gcp.snapshots.delete(name)) return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${gcp.project}/global/snapshots/${name}' was not found`);
      ctx.out(`Deleted [${snapshotUrl(gcp.project, name)}].\n`);
      return 0;
    default:
      return error(ctx, "gcloud.compute.snapshots", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、delete。`);
  }
}

/** `gcloud compute instances attach-disk | detach-disk INSTANCE --disk=NAME --zone=ZONE`. */
export function attachDetach(ctx: Ctx, action: "attach-disk" | "detach-disk", args: string[]): number {
  const command = `gcloud.compute.instances.${action}`;
  const parsed = parseArgs(args, { options: ["--disk", "--zone", "--mode", "--device-name", "--project"], flags: ["--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;
  const instanceName = parsed.positional[0];
  if (!instanceName) return error(ctx, command, "argument INSTANCE_NAME: Must be specified.");
  const diskName = parsed.options.get("--disk");
  if (diskName === undefined) return error(ctx, command, "argument --disk: Must be specified.");
  const zone = zoneArg(ctx, command, parsed.options.get("--zone"));
  if (!zone) return 1;
  const instance = gcp.instances.get(instanceName);
  if (!instance || instance.zone !== zone) {
    return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${gcp.project}/zones/${zone}/instances/${instanceName}' was not found`);
  }
  const disk = gcp.disks.get(diskName);
  if (!disk || disk.zone !== zone) {
    const elsewhere = disk ? `\n磁碟是可用區資源：${diskName} 在 ${disk.zone}，VM 在 ${zone}。要搬到其他可用區，先建立快照，再用快照在目標可用區建立新磁碟。` : "";
    return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${gcp.project}/zones/${zone}/disks/${diskName}' was not found${elsewhere}`);
  }
  const instanceUrl = `https://www.googleapis.com/compute/v1/projects/${gcp.project}/zones/${zone}/instances/${instanceName}`;
  if (action === "detach-disk") {
    if (!disk.users.delete(instanceName)) return error(ctx, command, `Disk [${diskName}] is not attached to instance [${instanceName}] in zone [${zone}].`);
    ctx.out(`Updated [${instanceUrl}].\n`);
    return 0;
  }
  const mode = parsed.options.get("--mode") ?? "rw";
  if (mode !== "rw" && mode !== "ro") return error(ctx, command, `argument --mode: Invalid choice: '${mode}'. 請使用 rw 或 ro。`);
  if (disk.users.has(instanceName)) return error(ctx, command, `The disk resource '${diskName}' is already attached to instance '${instanceName}'`);
  // A Persistent Disk can be shared only when every instance attaches it read-only.
  const others = [...disk.users.values()];
  if (others.length && (mode === "rw" || others.includes("rw"))) {
    return error(ctx, command, `The disk resource '${diskName}' is already being used by '${[...disk.users.keys()][0]}' in read-write mode. 多台 VM 共用同一個磁碟時，必須全部以唯讀（--mode=ro）掛載。`);
  }
  disk.users.set(instanceName, mode);
  ctx.out(`Updated [${instanceUrl}].\n`);
  return 0;
}
