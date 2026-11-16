import { newId } from "./aws-vpc";
import { parseArgs, type Ctx } from "./context";

export const EBS_COMMANDS = [
  "create-volume", "describe-volumes", "attach-volume", "detach-volume", "modify-volume", "delete-volume",
  "create-snapshot", "describe-snapshots", "delete-snapshot",
];

const OWNER = "123456789012";
const AZ = /^[a-z]{2}-[a-z]+-\d[a-z]$/;
/** Size range in GiB for each volume type. */
const SIZES: Record<string, [number, number]> = {
  gp2: [1, 16384],
  gp3: [1, 65536],
  io1: [4, 16384],
  io2: [4, 65536],
  st1: [125, 16384],
  sc1: [125, 16384],
  standard: [1, 1024],
};
const DEVICE = /^\/dev\/(sd[b-z]|xvd[b-z])$/;

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

/** `aws ec2` commands for EBS volumes and snapshots. */
export function ebs(ctx: Ctx, sub: string, rest: string[]): number {
  const parsed = parseArgs(rest, {
    options: [
      "--availability-zone", "--size", "--volume-type", "--snapshot-id", "--volume-id", "--volume-ids", "--instance-id",
      "--device", "--description", "--snapshot-ids", "--iops", "--throughput", "--tag-specifications", "--region", "--output",
    ],
    flags: ["--force", "--encrypted", "--no-encrypted"],
  });
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const { volumes, snapshots, instances } = ctx.state.aws.ec2;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const opt = (name: string) => parsed.options.get(`--${name}`);
  const list = (name: string) => (parsed.options.has(`--${name}`) ? [opt(name)!, ...parsed.positional] : []);
  function required(...names: string[]): boolean {
    const missing = names.filter((n) => !parsed.options.has(`--${n}`));
    if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
    return missing.length === 0;
  }
  const noVolume = (id: string) => fail(ctx, "InvalidVolume.NotFound", operation, `The volume '${id}' does not exist.`);
  const noSnapshot = (id: string) => fail(ctx, "InvalidSnapshot.NotFound", operation, `The snapshot '${id}' does not exist.`);
  const volumeJson = (id: string, state?: string) => {
    const v = volumes.get(id)!;
    return {
      AvailabilityZone: v.availabilityZone,
      Encrypted: false,
      VolumeType: v.type,
      VolumeId: id,
      State: state ?? (v.attachment ? "in-use" : "available"),
      SnapshotId: v.snapshotId ?? "",
      Size: v.size,
      Attachments: v.attachment ? [{ InstanceId: v.attachment.instanceId, Device: v.attachment.device, State: "attached", VolumeId: id }] : [],
    };
  };
  function checkSize(type: string, size: number): boolean {
    const [min, max] = SIZES[type];
    if (Number.isInteger(size) && size >= min && size <= max) return true;
    fail(ctx, "InvalidParameterValue", operation, `Volume of ${size}GiB is too large or too small. ${type} 的大小要介於 ${min} 到 ${max} GiB。`);
    return false;
  }

  switch (sub) {
    case "create-volume": {
      if (!required("availability-zone")) return 252;
      const az = opt("availability-zone")!;
      if (!AZ.test(az)) return fail(ctx, "InvalidParameterValue", operation, `Invalid availability zone: [${az}]. 可用區的格式像 us-east-1a。`);
      // The CLI's default volume type is gp2, not gp3.
      const type = opt("volume-type") ?? "gp2";
      if (!SIZES[type]) return fail(ctx, "InvalidParameterValue", operation, `Value (${type}) for parameter volumeType is invalid. 可用的類型：${Object.keys(SIZES).join("、")}`);
      const snapshotId = opt("snapshot-id");
      const snapshot = snapshotId === undefined ? undefined : snapshots.get(snapshotId);
      if (snapshotId !== undefined && !snapshot) return noSnapshot(snapshotId);
      if (opt("size") === undefined && !snapshot) {
        return fail(ctx, "MissingParameter", operation, "The request must contain the parameter size or snapshotId");
      }
      const size = opt("size") === undefined ? snapshot!.size : Number(opt("size"));
      if (!checkSize(type, size)) return 254;
      if (snapshot && size < snapshot.size) {
        return fail(ctx, "InvalidParameterValue", operation, `Volume of size ${size}GiB is smaller than snapshot '${snapshotId}', expect size >= ${snapshot.size}GiB`);
      }
      const id = newId("vol", ++ctx.state.aws.ec2.created);
      volumes.set(id, { availabilityZone: az, size, type, snapshotId: snapshotId ?? null, attachment: null });
      json(ctx, volumeJson(id, "creating"));
      return 0;
    }
    case "describe-volumes": {
      const ids = list("volume-ids");
      const unknown = ids.find((id) => !volumes.has(id));
      if (unknown) return noVolume(unknown);
      json(ctx, { Volumes: [...volumes.keys()].filter((id) => ids.length === 0 || ids.includes(id)).map((id) => volumeJson(id)) });
      return 0;
    }
    case "attach-volume": {
      if (!required("volume-id", "instance-id", "device")) return 252;
      const id = opt("volume-id")!;
      const volume = volumes.get(id);
      if (!volume) return noVolume(id);
      const instanceId = opt("instance-id")!;
      const instance = instances.get(instanceId);
      if (!instance || instance.state === "terminated") return fail(ctx, "InvalidInstanceID.NotFound", operation, `The instance ID '${instanceId}' does not exist`);
      if (volume.attachment) return fail(ctx, "VolumeInUse", operation, `${id} is already attached to an instance (${volume.attachment.instanceId})`);
      if (volume.availabilityZone !== instance.availabilityZone) {
        return fail(ctx, "InvalidVolume.ZoneMismatch", operation, `The volume '${id}' is not in the same availability zone as instance '${instanceId}'. 磁碟區在 ${volume.availabilityZone}，執行個體在 ${instance.availabilityZone}。`);
      }
      const device = opt("device")!;
      if (!DEVICE.test(device)) return fail(ctx, "InvalidParameterValue", operation, `Value (${device}) for parameter device is invalid. 這個模擬終端機接受 /dev/sdf 這類名稱。`);
      if ([...volumes.values()].some((v) => v.attachment?.instanceId === instanceId && v.attachment.device === device)) {
        return fail(ctx, "InvalidParameterValue", operation, `Attachment point ${device} is already in use`);
      }
      volume.attachment = { instanceId, device };
      json(ctx, { InstanceId: instanceId, VolumeId: id, State: "attaching", Device: device });
      return 0;
    }
    case "detach-volume": {
      if (!required("volume-id")) return 252;
      const id = opt("volume-id")!;
      const volume = volumes.get(id);
      if (!volume) return noVolume(id);
      if (!volume.attachment) return fail(ctx, "IncorrectState", operation, `Volume '${id}' is in the 'available' state.`);
      const { instanceId, device } = volume.attachment;
      volume.attachment = null;
      json(ctx, { InstanceId: instanceId, VolumeId: id, State: "detaching", Device: device });
      return 0;
    }
    case "modify-volume": {
      if (!required("volume-id")) return 252;
      const id = opt("volume-id")!;
      const volume = volumes.get(id);
      if (!volume) return noVolume(id);
      const type = opt("volume-type") ?? volume.type;
      if (!SIZES[type]) return fail(ctx, "InvalidParameterValue", operation, `Value (${type}) for parameter volumeType is invalid.`);
      const size = opt("size") === undefined ? volume.size : Number(opt("size"));
      if (size < volume.size) return fail(ctx, "InvalidParameterValue", operation, `New size cannot be smaller than existing size. 磁碟區只能加大，不能縮小。`);
      if (!checkSize(type, size)) return 254;
      const original = { size: volume.size, type: volume.type };
      volume.size = size;
      volume.type = type;
      json(ctx, {
        VolumeModification: { VolumeId: id, ModificationState: "modifying", TargetSize: size, TargetVolumeType: type, OriginalSize: original.size, OriginalVolumeType: original.type },
      });
      return 0;
    }
    case "delete-volume": {
      if (!required("volume-id")) return 252;
      const id = opt("volume-id")!;
      const volume = volumes.get(id);
      if (!volume) return noVolume(id);
      if (volume.attachment) return fail(ctx, "VolumeInUse", operation, `Volume ${id} is currently attached to ${volume.attachment.instanceId}. 請先用 detach-volume 卸離。`);
      volumes.delete(id);
      return 0;
    }
    case "create-snapshot": {
      if (!required("volume-id")) return 252;
      const volumeId = opt("volume-id")!;
      const volume = volumes.get(volumeId);
      if (!volume) return noVolume(volumeId);
      const id = newId("snap", ++ctx.state.aws.ec2.created);
      snapshots.set(id, { volumeId, size: volume.size, description: opt("description") ?? "" });
      json(ctx, { Description: opt("description") ?? "", Encrypted: false, VolumeId: volumeId, State: "pending", VolumeSize: volume.size, OwnerId: OWNER, SnapshotId: id });
      return 0;
    }
    case "describe-snapshots": {
      const ids = list("snapshot-ids");
      const unknown = ids.find((id) => !snapshots.has(id));
      if (unknown) return noSnapshot(unknown);
      json(ctx, {
        Snapshots: [...snapshots]
          .filter(([id]) => ids.length === 0 || ids.includes(id))
          .map(([id, s]) => ({ Description: s.description, VolumeId: s.volumeId, State: "completed", VolumeSize: s.size, OwnerId: OWNER, SnapshotId: id })),
      });
      return 0;
    }
    case "delete-snapshot": {
      if (!required("snapshot-id")) return 252;
      const id = opt("snapshot-id")!;
      if (!snapshots.delete(id)) return noSnapshot(id);
      return 0;
    }
    default:
      return 252;
  }
}
