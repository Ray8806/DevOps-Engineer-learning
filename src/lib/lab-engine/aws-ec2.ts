import { EBS_COMMANDS, ebs } from "./aws-ebs";
import { VPC_COMMANDS, newId, vpc } from "./aws-vpc";
import { parseCidr } from "./cidr";
import { parseArgs, type Ctx } from "./context";

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

const INSTANCE_COMMANDS =
  "create-security-group、authorize-security-group-ingress、describe-security-groups、delete-security-group、run-instances、describe-instances、stop-instances、start-instances、terminate-instances";
export const EC2_COMMANDS = `${INSTANCE_COMMANDS}、${VPC_COMMANDS.join("、")}、${EBS_COMMANDS.join("、")}`;

export function ec2(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  // Say the command is unsupported before complaining about its options.
  if (sub === undefined || !EC2_COMMANDS.split("、").includes(sub)) {
    ctx.err(sub ? `aws: 不支援的 ec2 指令 '${sub}'。支援：${EC2_COMMANDS}` : `usage: aws ec2 <command> [parameters]\n支援：${EC2_COMMANDS}`);
    return 252;
  }
  if (VPC_COMMANDS.includes(sub)) return vpc(ctx, sub, rest);
  if (EBS_COMMANDS.includes(sub)) return ebs(ctx, sub, rest);
  const parsed = parseArgs(rest, {
    options: [
      "--group-name", "--group-id", "--description", "--protocol", "--port", "--cidr", "--vpc-id",
      "--image-id", "--instance-type", "--key-name", "--count", "--security-group-ids", "--security-groups",
      "--instance-ids", "--group-ids", "--group-names", "--tag-specifications", "--subnet-id", "--placement", "--region", "--output",
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
      Placement: { AvailabilityZone: i.availabilityZone },
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
      if (!parseCidr(cidr)) return fail(ctx, "InvalidParameterValue", operation, `CIDR block ${cidr} is malformed`);
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
      // --placement AvailabilityZone=us-east-1b; this simulated Region defaults to us-east-1a.
      const placement = opt("placement");
      const az = placement === undefined ? "us-east-1a" : /^AvailabilityZone=([a-z]{2}-[a-z]+-\d[a-z])$/.exec(placement)?.[1];
      if (!az) return fail(ctx, "InvalidParameterValue", operation, `這個模擬終端機的 --placement 只支援 AvailabilityZone=us-east-1a 這種寫法，收到 '${placement}'`);
      const id = newId("i", ++ctx.state.aws.ec2.created);
      instances.set(id, { imageId, instanceType, state: "running", securityGroups: groups, availabilityZone: az });
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
        // Data volumes attached after launch are preserved and detached when the instance is terminated.
        if (target === "terminated") {
          for (const volume of ctx.state.aws.ec2.volumes.values()) if (volume.attachment?.instanceId === id) volume.attachment = null;
        }
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
