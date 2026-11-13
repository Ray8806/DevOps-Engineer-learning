import { parseArgs, type Ctx } from "./context";

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

export const EC2_COMMANDS =
  "create-security-group、authorize-security-group-ingress、describe-security-groups、delete-security-group、run-instances、describe-instances、stop-instances、start-instances、terminate-instances";

/** Deterministic 17-hex-digit resource id, e.g. i-0a3f…; `n` is a running counter. */
function newId(prefix: string, n: number): string {
  let hash = 0x811c9dc5;
  let hex = "";
  for (let round = 0; round < 2; round++) {
    for (const ch of `${prefix}${n}:${round}`) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hex += hash.toString(16).padStart(8, "0");
  }
  return `${prefix}-0${hex}`;
}

const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
function validCidr(cidr: string): boolean {
  const m = CIDR.exec(cidr);
  return m !== null && m.slice(1, 5).every((o) => Number(o) <= 255) && Number(m[5]) <= 32;
}

export function ec2(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  // Say the command is unsupported before complaining about its options.
  if (sub === undefined || !EC2_COMMANDS.split("、").includes(sub)) {
    ctx.err(sub ? `aws: 不支援的 ec2 指令 '${sub}'。支援：${EC2_COMMANDS}` : `usage: aws ec2 <command> [parameters]\n支援：${EC2_COMMANDS}`);
    return 252;
  }
  const parsed = parseArgs(rest, {
    options: [
      "--group-name", "--group-id", "--description", "--protocol", "--port", "--cidr", "--vpc-id",
      "--image-id", "--instance-type", "--key-name", "--count", "--security-group-ids", "--security-groups",
      "--instance-ids", "--group-ids", "--group-names", "--tag-specifications", "--subnet-id", "--region", "--output",
    ],
  });
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const { instances, securityGroups } = ctx.state.aws.ec2;
  const operation = (sub ?? "").split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const opt = (name: string) => parsed.options.get(`--${name}`);
  /** A list option's values: the one after the flag plus any following bare words. */
  const list = (name: string) => (parsed.options.has(`--${name}`) ? [opt(name)!, ...parsed.positional] : []);
  function required(...names: string[]): boolean {
    const missing = names.filter((n) => !parsed.options.has(`--${n}`));
    if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
    return missing.length === 0;
  }
  /** Security group id from --group-id or --group-name. */
  function groupId(idOrName: { id?: string; name?: string }): string | null {
    if (idOrName.id !== undefined) return securityGroups.has(idOrName.id) ? idOrName.id : null;
    return [...securityGroups].find(([, g]) => g.name === idOrName.name)?.[0] ?? null;
  }
  const noGroup = (ref: string) => fail(ctx, "InvalidGroup.NotFound", operation, `The security group '${ref}' does not exist`);
  const describe = (id: string) => {
    const i = instances.get(id)!;
    return {
      InstanceId: id,
      ImageId: i.imageId,
      InstanceType: i.instanceType,
      State: { Name: i.state },
      SecurityGroups: i.securityGroups.map((g) => ({ GroupId: g, GroupName: securityGroups.get(g)?.name ?? g })),
    };
  };

  switch (sub) {
    case "create-security-group": {
      if (!required("group-name", "description")) return 252;
      const name = opt("group-name")!;
      if ([...securityGroups.values()].some((g) => g.name === name)) {
        return fail(ctx, "InvalidGroup.Duplicate", operation, `The security group '${name}' already exists`);
      }
      const id = newId("sg", ++ctx.state.aws.ec2.created);
      securityGroups.set(id, { name, description: opt("description")!, ingress: new Set() });
      json(ctx, { GroupId: id });
      return 0;
    }
    case "authorize-security-group-ingress": {
      if (!parsed.options.has("--group-id") && !parsed.options.has("--group-name")) {
        ctx.err("\naws: error: 請用 --group-id 或 --group-name 指定安全群組");
        return 252;
      }
      if (!required("protocol", "port", "cidr")) return 252;
      const ref = opt("group-id") ?? opt("group-name")!;
      const id = groupId({ id: opt("group-id"), name: opt("group-name") });
      if (!id) return noGroup(ref);
      const protocol = opt("protocol")!.toLowerCase();
      const port = opt("port")!;
      const cidr = opt("cidr")!;
      if (!["tcp", "udp"].includes(protocol)) return fail(ctx, "InvalidParameterValue", operation, `這個模擬終端機只支援 tcp 和 udp，收到 '${protocol}'`);
      if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) return fail(ctx, "InvalidParameterValue", operation, `Invalid value '${port}' for port. 請輸入 0 到 65535 的單一連接埠`);
      if (!validCidr(cidr)) return fail(ctx, "InvalidParameterValue", operation, `CIDR block ${cidr} is malformed`);
      const rule = `${protocol}:${Number(port)}:${cidr}`;
      const group = securityGroups.get(id)!;
      if (group.ingress.has(rule)) {
        return fail(ctx, "InvalidPermission.Duplicate", operation, `the specified rule "peer: ${cidr}, ${protocol.toUpperCase()}, from port: ${port}, to port: ${port}, ALLOW" already exists`);
      }
      group.ingress.add(rule);
      json(ctx, {
        Return: true,
        SecurityGroupRules: [{ GroupId: id, IsEgress: false, IpProtocol: protocol, FromPort: Number(port), ToPort: Number(port), CidrIpv4: cidr }],
      });
      return 0;
    }
    case "describe-security-groups":
      json(ctx, {
        SecurityGroups: [...securityGroups].map(([id, g]) => ({
          GroupId: id,
          GroupName: g.name,
          Description: g.description,
          IpPermissions: [...g.ingress].sort().map((rule) => {
            const [protocol, port, cidr] = rule.split(":");
            return { IpProtocol: protocol, FromPort: Number(port), ToPort: Number(port), IpRanges: [{ CidrIp: cidr }] };
          }),
        })),
      });
      return 0;
    case "delete-security-group": {
      const ref = opt("group-id") ?? opt("group-name");
      if (ref === undefined) {
        ctx.err("\naws: error: 請用 --group-id 或 --group-name 指定安全群組");
        return 252;
      }
      const id = groupId({ id: opt("group-id"), name: opt("group-name") });
      if (!id) return noGroup(ref);
      if ([...instances.values()].some((i) => i.state !== "terminated" && i.securityGroups.includes(id))) {
        return fail(ctx, "DependencyViolation", operation, `resource ${id} has a dependent object`);
      }
      securityGroups.delete(id);
      return 0;
    }
    case "run-instances": {
      if (!required("image-id", "instance-type")) return 252;
      const imageId = opt("image-id")!;
      const instanceType = opt("instance-type")!;
      if (!/^ami-[0-9a-f]{8,17}$/.test(imageId)) return fail(ctx, "InvalidAMIID.Malformed", operation, `Invalid id: "${imageId}" (expecting "ami-...")`);
      if (!/^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(instanceType)) return fail(ctx, "InvalidParameterValue", operation, `Invalid value '${instanceType}' for InstanceType.`);
      if (opt("count") !== undefined && opt("count") !== "1") return fail(ctx, "InvalidParameterValue", operation, "這個模擬終端機一次只能啟動 1 台執行個體");
      const groups: string[] = [];
      for (const ref of list("security-group-ids")) {
        if (!securityGroups.has(ref)) return noGroup(ref);
        groups.push(ref);
      }
      for (const name of parsed.options.has("--security-groups") ? [opt("security-groups")!] : []) {
        const id = groupId({ name });
        if (!id) return noGroup(name);
        groups.push(id);
      }
      const id = newId("i", ++ctx.state.aws.ec2.created);
      instances.set(id, { imageId, instanceType, state: "running", securityGroups: groups });
      json(ctx, { Instances: [describe(id)] });
      return 0;
    }
    case "describe-instances": {
      const ids = list("instance-ids");
      const unknown = ids.find((id) => !instances.has(id));
      if (unknown) return fail(ctx, "InvalidInstanceID.NotFound", operation, `The instance ID '${unknown}' does not exist`);
      const shown = ids.length ? ids : [...instances.keys()];
      json(ctx, { Reservations: shown.length ? [{ Instances: shown.map(describe) }] : [] });
      return 0;
    }
    case "stop-instances":
    case "start-instances":
    case "terminate-instances": {
      if (!required("instance-ids")) return 252;
      const ids = list("instance-ids");
      const unknown = ids.find((id) => !instances.has(id));
      if (unknown) return fail(ctx, "InvalidInstanceID.NotFound", operation, `The instance ID '${unknown}' does not exist`);
      const target = sub === "stop-instances" ? "stopped" : sub === "start-instances" ? "running" : "terminated";
      // A terminated instance is gone for good; stopping or starting it is an error.
      const dead = ids.find((id) => instances.get(id)!.state === "terminated");
      if (dead && target !== "terminated") {
        return fail(ctx, "IncorrectInstanceState", operation, `The instance '${dead}' is not in a state from which it can be ${target === "stopped" ? "stopped" : "started"}.`);
      }
      const changes = ids.map((id) => {
        const instance = instances.get(id)!;
        const previous = instance.state;
        instance.state = target;
        return { InstanceId: id, CurrentState: { Name: target }, PreviousState: { Name: previous } };
      });
      const key = sub === "stop-instances" ? "StoppingInstances" : sub === "start-instances" ? "StartingInstances" : "TerminatingInstances";
      json(ctx, { [key]: changes });
      return 0;
    }
    default:
      return 252;
  }
}
