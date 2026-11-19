import { newId } from "./aws-vpc";
import type { Ctx } from "./context";
import { resolvePath, targetHealth, type AwsState, type LabState } from "./state";

export const LAUNCH_TEMPLATE_COMMANDS = ["create-launch-template", "describe-launch-templates", "delete-launch-template"];
export const ELBV2_COMMANDS = [
  "create-target-group", "describe-target-groups", "delete-target-group", "register-targets", "deregister-targets", "describe-target-health",
  "create-load-balancer", "describe-load-balancers", "delete-load-balancer", "create-listener", "describe-listeners", "delete-listener",
];
export const AUTOSCALING_COMMANDS = [
  "create-auto-scaling-group", "describe-auto-scaling-groups", "update-auto-scaling-group", "set-desired-capacity", "delete-auto-scaling-group",
  "put-scaling-policy", "describe-policies",
];

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const ELB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?$/;
const METRICS = ["ASGAverageCPUUtilization", "ASGAverageNetworkIn", "ASGAverageNetworkOut", "ALBRequestCountPerTarget"];

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

/** 16 hex digits for ARNs and DNS names, from a running counter. */
const hex16 = (prefix: string, n: number) => newId(prefix, n).slice(prefix.length + 2);

interface Parsed {
  options: Map<string, string[]>;
  flags: Set<string>;
  unknown?: string;
}

/** Options listed in `lists` take every following value until the next option. */
function parse(args: string[], options: string[], lists: string[], flags: string[] = []): Parsed {
  const result: Parsed = { options: new Map(), flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
    if (flags.includes(arg)) result.flags.add(arg);
    else if (options.includes(name)) {
      const values = eq !== -1 && arg.startsWith("--") ? [arg.slice(eq + 1)] : [];
      if (values.length === 0) {
        if (args[i + 1] === undefined) return { ...result, unknown: arg };
        values.push(args[++i]);
      }
      if (lists.includes(name)) while (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) values.push(args[++i]);
      result.options.set(name, values);
    } else return { ...result, unknown: arg };
  }
  return result;
}

/** "Key=Value,Other=x" -> object. */
function shorthand(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const pair of text.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

/** Reads inline JSON or file://path; reports and returns null when it cannot. */
function readJson(ctx: Ctx, option: string, text: string): Record<string, unknown> | null {
  let source = text;
  if (text.startsWith("file://")) {
    const content = ctx.state.files.get(resolvePath(ctx.state.cwd, text.slice(7)));
    if (content === undefined) {
      ctx.err(`\nError parsing parameter '${option}': Unable to load paramfile ${text}: [Errno 2] No such file or directory: '${text.slice(7)}'`);
      return null;
    }
    source = content;
  }
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // reported below
  }
  ctx.err(`\nError parsing parameter '${option}': Invalid JSON: ${source}\n（JSON 要用單引號包起來）`);
  return null;
}

const operationName = (sub: string) => sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");

// -------------------------------------------------------- Auto Scaling core

/** Launches one instance for a group, spreading across the group's subnets' zones. */
function launchFor(state: LabState, groupName: string): string {
  const aws = state.aws;
  const group = aws.autoscaling.groups.get(groupName)!;
  const template = aws.ec2.launchTemplates.get(group.launchTemplate)!;
  const zones = group.subnets.map((s) => aws.vpc.subnets.get(s)?.availabilityZone ?? "us-east-1a");
  // Pick the zone with the fewest of the group's running instances.
  const counts = zones.map((z) => group.instances.filter((id) => aws.ec2.instances.get(id)?.availabilityZone === z).length);
  const zone = zones[counts.indexOf(Math.min(...counts))];
  const id = newId("i", ++aws.ec2.created);
  aws.ec2.instances.set(id, { imageId: template.imageId, instanceType: template.instanceType, state: "running", securityGroups: [...template.securityGroups], availabilityZone: zone });
  group.instances.push(id);
  for (const tg of group.targetGroups) aws.elbv2.targetGroups.get(tg)?.targets.add(id);
  return id;
}

function removeFromGroup(aws: AwsState, groupName: string, id: string) {
  const group = aws.autoscaling.groups.get(groupName)!;
  group.instances = group.instances.filter((i) => i !== id);
  for (const tg of group.targetGroups) aws.elbv2.targetGroups.get(tg)?.targets.delete(id);
}

/**
 * Brings every Auto Scaling group back to its desired capacity: stopped or
 * terminated instances count as unhealthy and are replaced; extra ones are
 * terminated (newest first).
 */
export function reconcileGroups(state: LabState) {
  const aws = state.aws;
  for (const [name, group] of aws.autoscaling.groups) {
    for (const id of [...group.instances]) {
      const instance = aws.ec2.instances.get(id);
      if (instance?.state === "running") continue;
      if (instance && instance.state === "stopped") instance.state = "terminated";
      removeFromGroup(aws, name, id);
      group.replaced++;
    }
    while (group.instances.length < group.desired) launchFor(state, name);
    while (group.instances.length > group.desired) {
      const id = group.instances.at(-1)!;
      aws.ec2.instances.get(id)!.state = "terminated";
      removeFromGroup(aws, name, id);
    }
  }
}

// ------------------------------------------------------- launch templates

export function launchTemplates(ctx: Ctx, sub: string, rest: string[]): number {
  const parsed = parse(rest, ["--launch-template-name", "--launch-template-data", "--version-description", "--launch-template-names", "--region", "--output"], ["--launch-template-names"]);
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const templates = ctx.state.aws.ec2.launchTemplates;
  const operation = operationName(sub);
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const describe = (name: string) => ({ LaunchTemplateId: templates.get(name)!.id, LaunchTemplateName: name, DefaultVersionNumber: 1, LatestVersionNumber: 1 });
  if (sub === "describe-launch-templates") {
    const names = parsed.options.get("--launch-template-names") ?? [];
    const missing = names.find((n) => !templates.has(n));
    if (missing) return fail(ctx, "InvalidLaunchTemplateName.NotFoundException", operation, `At least one of the launch templates specified in the request does not exist. (${missing})`);
    json(ctx, { LaunchTemplates: [...templates.keys()].filter((n) => !names.length || names.includes(n)).map(describe) });
    return 0;
  }
  const name = opt("launch-template-name");
  if (name === undefined) {
    ctx.err("\naws: error: the following arguments are required: --launch-template-name");
    return 252;
  }
  if (sub === "delete-launch-template") {
    if (!templates.has(name)) return fail(ctx, "InvalidLaunchTemplateName.NotFoundException", operation, `The specified launch template, with template name ${name}, does not exist.`);
    const user = [...ctx.state.aws.autoscaling.groups].find(([, g]) => g.launchTemplate === name);
    if (user) return fail(ctx, "ValidationError", operation, `Launch template ${name} is in use by Auto Scaling group ${user[0]}.（模擬終端機的檢查）`);
    const out = describe(name);
    templates.delete(name);
    json(ctx, { LaunchTemplate: out });
    return 0;
  }
  if (opt("launch-template-data") === undefined) {
    ctx.err("\naws: error: the following arguments are required: --launch-template-data");
    return 252;
  }
  if (!/^[A-Za-z0-9().\/_-]{3,128}$/.test(name)) return fail(ctx, "InvalidLaunchTemplateName.MalformedException", operation, `The launch template name ${name} is invalid.`);
  if (templates.has(name)) return fail(ctx, "InvalidLaunchTemplateName.AlreadyExistsException", operation, `Launch template name already in use.`);
  const data = readJson(ctx, "--launch-template-data", opt("launch-template-data")!);
  if (!data) return 252;
  const imageId = data.ImageId;
  const instanceType = data.InstanceType;
  if (typeof imageId !== "string" || !/^ami-[0-9a-f]{8,17}$/.test(imageId)) return fail(ctx, "InvalidAMIID.Malformed", operation, `這個模擬終端機需要在 launch-template-data 指定 ImageId，例如 "ami-0abcdef1234567890"。`);
  if (typeof instanceType !== "string" || !/^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(instanceType)) return fail(ctx, "InvalidParameterValue", operation, `這個模擬終端機需要在 launch-template-data 指定 InstanceType，例如 "t3.micro"。`);
  const groups = Array.isArray(data.SecurityGroupIds) ? data.SecurityGroupIds.filter((g): g is string => typeof g === "string") : [];
  const missing = groups.find((g) => !ctx.state.aws.ec2.securityGroups.has(g));
  if (missing) return fail(ctx, "InvalidGroupId.NotFound", operation, `The security group '${missing}' does not exist`);
  const id = `lt-0${hex16("lt", ++ctx.state.aws.ec2.created)}`;
  templates.set(name, { id, imageId, instanceType, securityGroups: groups });
  json(ctx, { LaunchTemplate: { ...describe(name), CreatedBy: `arn:aws:iam::${ACCOUNT}:user/learner` } });
  return 0;
}

// ------------------------------------------------------------------ elbv2

export function elbv2(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !ELBV2_COMMANDS.includes(sub)) {
    ctx.err(sub ? `aws: 不支援的 elbv2 指令 '${sub}'。支援：${ELBV2_COMMANDS.join("、")}` : `usage: aws elbv2 <command> [parameters]\n支援：${ELBV2_COMMANDS.join("、")}`);
    return 252;
  }
  const parsed = parse(
    rest,
    [
      "--name", "--protocol", "--port", "--vpc-id", "--target-type", "--health-check-path", "--subnets", "--type", "--scheme",
      "--security-groups", "--load-balancer-arn", "--default-actions", "--target-group-arn", "--targets", "--names",
      "--listener-arn", "--certificates", "--region", "--output",
    ],
    ["--subnets", "--targets", "--names", "--security-groups"],
  );
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const { targetGroups, loadBalancers, listeners } = ctx.state.aws.elbv2;
  const { vpc } = ctx.state.aws;
  const operation = operationName(sub);
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  function required(...names: string[]): boolean {
    const missing = names.filter((n) => !parsed.options.has(`--${n}`));
    if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
    return missing.length === 0;
  }
  const byArn = <T extends { arn: string }>(map: Map<string, T>, arn: string) => [...map].find(([, v]) => v.arn === arn);
  const tgNotFound = () => fail(ctx, "TargetGroupNotFound", operation, "One or more target groups not found");
  const lbNotFound = () => fail(ctx, "LoadBalancerNotFound", operation, "One or more load balancers not found");
  const tgJson = (name: string) => {
    const t = targetGroups.get(name)!;
    return {
      TargetGroupArn: t.arn,
      TargetGroupName: name,
      Protocol: t.protocol,
      Port: t.port,
      VpcId: t.vpcId,
      HealthCheckProtocol: t.protocol,
      HealthCheckPort: "traffic-port",
      HealthCheckEnabled: true,
      HealthCheckIntervalSeconds: 30,
      HealthCheckTimeoutSeconds: 5,
      HealthyThresholdCount: 5,
      UnhealthyThresholdCount: 2,
      HealthCheckPath: t.healthCheckPath,
      Matcher: { HttpCode: "200" },
      LoadBalancerArns: [...listeners.values()].filter((l) => l.targetGroup === name).map((l) => loadBalancers.get(l.loadBalancer)!.arn),
      TargetType: "instance",
    };
  };
  const lbJson = (name: string, state: string) => {
    const lb = loadBalancers.get(name)!;
    return {
      LoadBalancerArn: lb.arn,
      DNSName: lb.dnsName,
      LoadBalancerName: name,
      Scheme: lb.scheme,
      VpcId: lb.vpcId,
      State: { Code: state },
      Type: lb.type,
      AvailabilityZones: lb.subnets.map((s) => ({ ZoneName: vpc.subnets.get(s)!.availabilityZone, SubnetId: s })),
      IpAddressType: "ipv4",
    };
  };
  const listenerJson = (arn: string) => {
    const l = listeners.get(arn)!;
    const tgArn = targetGroups.get(l.targetGroup)!.arn;
    return { ListenerArn: arn, LoadBalancerArn: loadBalancers.get(l.loadBalancer)!.arn, Port: l.port, Protocol: l.protocol, DefaultActions: [{ Type: "forward", TargetGroupArn: tgArn }] };
  };
  const nameProblem = (name: string) =>
    !ELB_NAME.test(name) || name.startsWith("internal-")
      ? fail(ctx, "ValidationError", operation, `名稱 '${name}' 不符合規則：最多 32 個字元，只能有英數字和連字號，不能以連字號開頭或結尾。（模擬終端機的檢查）`)
      : null;

  switch (sub) {
    case "create-target-group": {
      if (!required("name", "protocol", "port", "vpc-id")) return 252;
      const name = opt("name")!;
      const problem = nameProblem(name);
      if (problem !== null) return problem;
      if (targetGroups.has(name)) return fail(ctx, "DuplicateTargetGroupName", operation, "A target group with the same name exists, but with different settings");
      const protocol = opt("protocol")!.toUpperCase();
      if (protocol !== "HTTP" && protocol !== "HTTPS") return fail(ctx, "ValidationError", operation, "這個模擬終端機的目標群組只支援 HTTP 和 HTTPS（Application Load Balancer）。");
      const port = Number(opt("port"));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(ctx, "ValidationError", operation, `Port '${opt("port")}' must be between 1 and 65535`);
      if (!vpc.vpcs.has(opt("vpc-id")!)) return fail(ctx, "ValidationError", operation, `The VPC ID '${opt("vpc-id")}' is not found`);
      if ((opt("target-type") ?? "instance") !== "instance") return fail(ctx, "ValidationError", operation, "這個模擬終端機只支援 --target-type instance。");
      const path = opt("health-check-path") ?? "/";
      if (!path.startsWith("/")) return fail(ctx, "ValidationError", operation, "Health check path must begin with a '/' character");
      const arn = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/${name}/${hex16("tg", ++ctx.state.aws.ec2.created)}`;
      targetGroups.set(name, { arn, protocol, port, vpcId: opt("vpc-id")!, healthCheckPath: path, targets: new Set() });
      json(ctx, { TargetGroups: [tgJson(name)] });
      return 0;
    }
    case "describe-target-groups": {
      const names = parsed.options.get("--names") ?? [];
      if (names.some((n) => !targetGroups.has(n))) return tgNotFound();
      json(ctx, { TargetGroups: [...targetGroups.keys()].filter((n) => !names.length || names.includes(n)).map(tgJson) });
      return 0;
    }
    case "delete-target-group": {
      if (!required("target-group-arn")) return 252;
      const found = byArn(targetGroups, opt("target-group-arn")!);
      if (!found) return tgNotFound();
      const lb = [...listeners.values()].find((l) => l.targetGroup === found[0]);
      if (lb) return fail(ctx, "ResourceInUse", operation, `Target group '${found[1].arn}' is currently in use by a listener or a rule`);
      targetGroups.delete(found[0]);
      for (const g of ctx.state.aws.autoscaling.groups.values()) g.targetGroups = g.targetGroups.filter((t) => t !== found[0]);
      return 0;
    }
    case "register-targets":
    case "deregister-targets": {
      if (!required("target-group-arn", "targets")) return 252;
      const found = byArn(targetGroups, opt("target-group-arn")!);
      if (!found) return tgNotFound();
      const ids = parsed.options.get("--targets")!.map((t) => shorthand(t)?.Id ?? "");
      const bad = ids.find((id) => !ctx.state.aws.ec2.instances.has(id) || ctx.state.aws.ec2.instances.get(id)!.state === "terminated");
      if (bad !== undefined) return fail(ctx, "InvalidTarget", operation, `The following targets are not in a running state and cannot be registered: '${bad}'（格式是 --targets Id=i-0123…）`);
      for (const id of ids) {
        if (sub === "register-targets") found[1].targets.add(id);
        else found[1].targets.delete(id);
      }
      return 0;
    }
    case "describe-target-health": {
      if (!required("target-group-arn")) return 252;
      const found = byArn(targetGroups, opt("target-group-arn")!);
      if (!found) return tgNotFound();
      json(ctx, {
        TargetHealthDescriptions: [...found[1].targets].map((id) => {
          const health = targetHealth(ctx.state, found[0], id);
          return {
            Target: { Id: id, Port: found[1].port },
            HealthCheckPort: String(found[1].port),
            TargetHealth:
              health === "healthy"
                ? { State: "healthy" }
                : health === "unused"
                  ? { State: "unused", Reason: "Target.NotInUse", Description: "Target group is not configured to receive traffic from the load balancer" }
                  : { State: "unhealthy", Reason: "Target.FailedHealthChecks", Description: "Health checks failed" },
          };
        }),
      });
      return 0;
    }
    case "create-load-balancer": {
      if (!required("name", "subnets")) return 252;
      const name = opt("name")!;
      const problem = nameProblem(name);
      if (problem !== null) return problem;
      if (loadBalancers.has(name)) return fail(ctx, "DuplicateLoadBalancerName", operation, "A load balancer with the same name already exists");
      if ((opt("type") ?? "application") !== "application") return fail(ctx, "ValidationError", operation, "這個模擬終端機只支援 Application Load Balancer（--type application）。");
      const scheme = opt("scheme") ?? "internet-facing";
      if (scheme !== "internet-facing" && scheme !== "internal") return fail(ctx, "ValidationError", operation, `Scheme '${scheme}' must be 'internet-facing' or 'internal'`);
      const subnets = parsed.options.get("--subnets")!.flatMap((s) => s.split(",")).filter(Boolean);
      const missing = subnets.find((s) => !vpc.subnets.has(s));
      if (missing) return fail(ctx, "SubnetNotFound", operation, `The subnet ID '${missing}' is not valid`);
      const vpcIds = new Set(subnets.map((s) => vpc.subnets.get(s)!.vpcId));
      if (vpcIds.size > 1) return fail(ctx, "InvalidConfigurationRequest", operation, "The subnets must belong to the same VPC");
      const zones = new Set(subnets.map((s) => vpc.subnets.get(s)!.availabilityZone));
      if (zones.size < 2) return fail(ctx, "ValidationError", operation, "At least two subnets in two different Availability Zones must be specified");
      const n = ++ctx.state.aws.ec2.created;
      const arn = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/${name}/${hex16("lb", n)}`;
      const dnsName = `${scheme === "internal" ? "internal-" : ""}${name}-${parseInt(hex16("dns", n).slice(0, 7), 16)}.${REGION}.elb.amazonaws.com`;
      loadBalancers.set(name, { arn, type: "application", scheme, vpcId: [...vpcIds][0], subnets, dnsName });
      json(ctx, { LoadBalancers: [lbJson(name, "provisioning")] });
      return 0;
    }
    case "describe-load-balancers": {
      const names = parsed.options.get("--names") ?? [];
      if (names.some((n) => !loadBalancers.has(n))) return lbNotFound();
      json(ctx, { LoadBalancers: [...loadBalancers.keys()].filter((n) => !names.length || names.includes(n)).map((n) => lbJson(n, "active")) });
      return 0;
    }
    case "delete-load-balancer": {
      if (!required("load-balancer-arn")) return 252;
      const found = byArn(loadBalancers, opt("load-balancer-arn")!);
      if (!found) return lbNotFound();
      for (const [arn, l] of listeners) if (l.loadBalancer === found[0]) listeners.delete(arn);
      loadBalancers.delete(found[0]);
      return 0;
    }
    case "create-listener": {
      if (!required("load-balancer-arn", "protocol", "port", "default-actions")) return 252;
      const lb = byArn(loadBalancers, opt("load-balancer-arn")!);
      if (!lb) return lbNotFound();
      const protocol = opt("protocol")!.toUpperCase();
      if (protocol !== "HTTP" && protocol !== "HTTPS") return fail(ctx, "ValidationError", operation, "Application Load Balancer 的接聽程式只支援 HTTP 和 HTTPS。");
      if (protocol === "HTTPS" && !parsed.options.has("--certificates")) return fail(ctx, "CertificateNotFound", operation, "A certificate must be specified for HTTPS listeners");
      const port = Number(opt("port"));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(ctx, "ValidationError", operation, `Port '${opt("port")}' must be between 1 and 65535`);
      const action = shorthand(opt("default-actions")!);
      if (!action || action.Type !== "forward" || !action.TargetGroupArn) {
        return fail(ctx, "ValidationError", operation, "這個模擬終端機的 --default-actions 只支援 Type=forward,TargetGroupArn=目標群組的ARN。");
      }
      const tg = byArn(targetGroups, action.TargetGroupArn);
      if (!tg) return tgNotFound();
      if (tg[1].vpcId !== lb[1].vpcId) return fail(ctx, "ValidationError", operation, `The VPC ID '${tg[1].vpcId}' of the target group does not match the VPC ID of the load balancer`);
      if ([...listeners.values()].some((l) => l.loadBalancer === lb[0] && l.port === port)) return fail(ctx, "DuplicateListener", operation, "A listener already exists on this port for this load balancer");
      const arn = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/${lb[0]}/${lb[1].arn.slice(-16)}/${hex16("ln", ++ctx.state.aws.ec2.created)}`;
      listeners.set(arn, { loadBalancer: lb[0], protocol, port, targetGroup: tg[0] });
      json(ctx, { Listeners: [listenerJson(arn)] });
      return 0;
    }
    case "describe-listeners": {
      if (!required("load-balancer-arn")) return 252;
      const lb = byArn(loadBalancers, opt("load-balancer-arn")!);
      if (!lb) return lbNotFound();
      json(ctx, { Listeners: [...listeners].filter(([, l]) => l.loadBalancer === lb[0]).map(([arn]) => listenerJson(arn)) });
      return 0;
    }
    case "delete-listener": {
      if (!required("listener-arn")) return 252;
      if (!listeners.delete(opt("listener-arn")!)) return fail(ctx, "ListenerNotFound", operation, "One or more listeners not found");
      return 0;
    }
    default:
      return 252;
  }
}

// ------------------------------------------------------------ autoscaling

export function autoscaling(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !AUTOSCALING_COMMANDS.includes(sub)) {
    ctx.err(sub ? `aws: 不支援的 autoscaling 指令 '${sub}'。支援：${AUTOSCALING_COMMANDS.join("、")}` : `usage: aws autoscaling <command> [parameters]\n支援：${AUTOSCALING_COMMANDS.join("、")}`);
    return 252;
  }
  const parsed = parse(
    rest,
    [
      "--auto-scaling-group-name", "--launch-template", "--min-size", "--max-size", "--desired-capacity", "--vpc-zone-identifier",
      "--target-group-arns", "--health-check-type", "--health-check-grace-period", "--policy-name", "--policy-type",
      "--target-tracking-configuration", "--auto-scaling-group-names", "--region", "--output",
    ],
    ["--target-group-arns", "--auto-scaling-group-names"],
    ["--force-delete", "--honor-cooldown", "--no-honor-cooldown"],
  );
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const aws = ctx.state.aws;
  const groups = aws.autoscaling.groups;
  const operation = operationName(sub);
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  function required(...names: string[]): boolean {
    const missing = names.filter((n) => !parsed.options.has(`--${n}`));
    if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
    return missing.length === 0;
  }
  const validation = (message: string) => fail(ctx, "ValidationError", operation, message);
  const notFound = (name: string) => validation(`AutoScalingGroup name not found - AutoScalingGroup '${name}' not found`);
  const intOpt = (n: string): number | null | undefined => {
    const v = opt(n);
    if (v === undefined) return undefined;
    const num = Number(v);
    return Number.isInteger(num) && num >= 0 ? num : null;
  };
  const groupJson = (name: string) => {
    const g = groups.get(name)!;
    return {
      AutoScalingGroupName: name,
      AutoScalingGroupARN: `arn:aws:autoscaling:${REGION}:${ACCOUNT}:autoScalingGroup:00000000-0000-0000-0000-000000000000:autoScalingGroupName/${name}`,
      LaunchTemplate: { LaunchTemplateId: aws.ec2.launchTemplates.get(g.launchTemplate)?.id, LaunchTemplateName: g.launchTemplate, Version: "$Default" },
      MinSize: g.min,
      MaxSize: g.max,
      DesiredCapacity: g.desired,
      AvailabilityZones: [...new Set(g.subnets.map((s) => aws.vpc.subnets.get(s)?.availabilityZone))],
      TargetGroupARNs: g.targetGroups.map((t) => aws.elbv2.targetGroups.get(t)?.arn),
      HealthCheckType: g.healthCheckType,
      HealthCheckGracePeriod: g.gracePeriod,
      Instances: g.instances.map((id) => ({
        InstanceId: id,
        AvailabilityZone: aws.ec2.instances.get(id)!.availabilityZone,
        LifecycleState: "InService",
        HealthStatus: "Healthy",
        InstanceType: aws.ec2.instances.get(id)!.instanceType,
      })),
      VPCZoneIdentifier: g.subnets.join(","),
    };
  };
  /** Checks min <= desired <= max; reports and returns false otherwise. */
  function sizesOk(min: number, max: number, desired: number): boolean {
    if (min > max) {
      validation(`Max bound, ${max}, must be greater than or equal to min bound, ${min}`);
      return false;
    }
    if (desired < min || desired > max) {
      validation(`Desired capacity:${desired} must be between the specified min size:${min} and max size:${max}`);
      return false;
    }
    return true;
  }

  switch (sub) {
    case "create-auto-scaling-group": {
      if (!required("auto-scaling-group-name", "min-size", "max-size")) return 252;
      const name = opt("auto-scaling-group-name")!;
      if (groups.has(name)) return fail(ctx, "AlreadyExists", operation, `AutoScalingGroup by this name already exists - A group with the name ${name} already exists`);
      const lt = opt("launch-template") === undefined ? null : shorthand(opt("launch-template")!);
      const templateName = lt?.LaunchTemplateName ?? [...aws.ec2.launchTemplates].find(([, t]) => t.id === lt?.LaunchTemplateId)?.[0];
      if (!lt) return validation("這個模擬終端機需要用 --launch-template LaunchTemplateName=範本名稱 指定啟動範本。");
      if (!templateName || !aws.ec2.launchTemplates.has(templateName)) return validation(`You must use a valid fully-formed launch template. The specified launch template does not exist.`);
      const min = intOpt("min-size");
      const max = intOpt("max-size");
      const desiredOpt = intOpt("desired-capacity");
      if (min === null || max === null || desiredOpt === null || min === undefined || max === undefined) return validation("min-size、max-size、desired-capacity 要是 0 以上的整數。");
      const desired = desiredOpt ?? min;
      if (!sizesOk(min, max, desired)) return 254;
      if (opt("vpc-zone-identifier") === undefined) return validation("這個模擬終端機需要用 --vpc-zone-identifier \"subnet-a,subnet-b\" 指定子網路。");
      const subnets = opt("vpc-zone-identifier")!.split(",").map((s) => s.trim()).filter(Boolean);
      const badSubnet = subnets.find((s) => !aws.vpc.subnets.has(s));
      if (badSubnet) return validation(`The subnet ID '${badSubnet}' does not exist`);
      const tgs: string[] = [];
      for (const arn of (parsed.options.get("--target-group-arns") ?? []).flatMap((a) => a.split(","))) {
        const found = [...aws.elbv2.targetGroups].find(([, t]) => t.arn === arn);
        if (!found) return validation(`Provided Target Groups may not be valid. Please ensure they exist and try again.（${arn}）`);
        tgs.push(found[0]);
      }
      const type = (opt("health-check-type") ?? "EC2").toUpperCase();
      if (type !== "EC2" && type !== "ELB") return validation("這個模擬終端機的 --health-check-type 支援 EC2 和 ELB。");
      const grace = intOpt("health-check-grace-period");
      if (grace === null) return validation("--health-check-grace-period 要是 0 以上的整數（秒）。");
      groups.set(name, {
        launchTemplate: templateName,
        min,
        max,
        desired,
        subnets,
        targetGroups: tgs,
        healthCheckType: type,
        gracePeriod: grace ?? 0,
        instances: [],
        policies: new Map(),
        replaced: 0,
      });
      reconcileGroups(ctx.state);
      return 0;
    }
    case "describe-auto-scaling-groups": {
      const names = parsed.options.get("--auto-scaling-group-names") ?? [];
      json(ctx, { AutoScalingGroups: [...groups.keys()].filter((n) => !names.length || names.includes(n)).map(groupJson) });
      return 0;
    }
    case "update-auto-scaling-group":
    case "set-desired-capacity": {
      if (!required("auto-scaling-group-name", ...(sub === "set-desired-capacity" ? ["desired-capacity"] : []))) return 252;
      const name = opt("auto-scaling-group-name")!;
      const g = groups.get(name);
      if (!g) return notFound(name);
      const min = intOpt("min-size");
      const max = intOpt("max-size");
      const desiredOpt = intOpt("desired-capacity");
      if (min === null || max === null || desiredOpt === null) return validation("min-size、max-size、desired-capacity 要是 0 以上的整數。");
      const nextMin = min ?? g.min;
      const nextMax = max ?? g.max;
      // Like the real service, changing only min or max pulls desired into range.
      const desired = desiredOpt ?? Math.min(Math.max(g.desired, nextMin), nextMax);
      if (!sizesOk(nextMin, nextMax, desired)) return 254;
      const zoneIds = opt("vpc-zone-identifier");
      if (zoneIds !== undefined) {
        const subnets = zoneIds.split(",").map((s) => s.trim()).filter(Boolean);
        const badSubnet = subnets.find((s) => !aws.vpc.subnets.has(s));
        if (badSubnet) return validation(`The subnet ID '${badSubnet}' does not exist`);
        if (!subnets.length) return validation("--vpc-zone-identifier 至少要有一個子網路。");
        // Existing instances stay where they are; new ones go to the least-used zone.
        g.subnets = subnets;
      }
      g.min = nextMin;
      g.max = nextMax;
      g.desired = desired;
      reconcileGroups(ctx.state);
      return 0;
    }
    case "delete-auto-scaling-group": {
      if (!required("auto-scaling-group-name")) return 252;
      const name = opt("auto-scaling-group-name")!;
      const g = groups.get(name);
      if (!g) return notFound(name);
      if (g.instances.length && !parsed.flags.has("--force-delete")) {
        return fail(ctx, "ResourceInUse", operation, "You cannot delete an AutoScalingGroup while there are instances still in the group.（先把 desired、min 設成 0，或加上 --force-delete）");
      }
      for (const id of g.instances) aws.ec2.instances.get(id)!.state = "terminated";
      for (const id of [...g.instances]) removeFromGroup(aws, name, id);
      groups.delete(name);
      return 0;
    }
    case "put-scaling-policy": {
      if (!required("auto-scaling-group-name", "policy-name")) return 252;
      const name = opt("auto-scaling-group-name")!;
      const g = groups.get(name);
      if (!g) return notFound(name);
      if ((opt("policy-type") ?? "SimpleScaling") !== "TargetTrackingScaling") {
        return validation("這個模擬終端機只支援目標追蹤政策：--policy-type TargetTrackingScaling。");
      }
      if (opt("target-tracking-configuration") === undefined) {
        ctx.err("\naws: error: --target-tracking-configuration is required for TargetTrackingScaling");
        return 252;
      }
      const config = readJson(ctx, "--target-tracking-configuration", opt("target-tracking-configuration")!);
      if (!config) return 252;
      const spec = config.PredefinedMetricSpecification as { PredefinedMetricType?: unknown } | undefined;
      const metric = spec?.PredefinedMetricType;
      const target = Number(config.TargetValue);
      if (typeof metric !== "string" || !METRICS.includes(metric)) return validation(`這個模擬終端機支援的預先定義指標：${METRICS.join("、")}`);
      if (!(target > 0)) return validation("TargetValue 要大於 0。");
      if (metric === "ASGAverageCPUUtilization" && target > 100) return validation("CPU 使用率的目標值要介於 0 到 100。");
      if (metric === "ALBRequestCountPerTarget" && !g.targetGroups.length) return validation("ALBRequestCountPerTarget 需要 Auto Scaling 群組連接到目標群組。");
      g.policies.set(opt("policy-name")!, { metric, target });
      const id = hex16("policy", ++aws.ec2.created);
      json(ctx, {
        PolicyARN: `arn:aws:autoscaling:${REGION}:${ACCOUNT}:scalingPolicy:${id}:autoScalingGroupName/${name}:policyName/${opt("policy-name")}`,
        Alarms: ["High", "Low"].map((h) => ({ AlarmName: `TargetTracking-${name}-Alarm${h}-${id.slice(0, 8)}` })),
      });
      return 0;
    }
    case "describe-policies": {
      const only = opt("auto-scaling-group-name");
      json(ctx, {
        ScalingPolicies: [...groups].filter(([n]) => only === undefined || n === only).flatMap(([n, g]) =>
          [...g.policies].map(([p, v]) => ({
            AutoScalingGroupName: n,
            PolicyName: p,
            PolicyType: "TargetTrackingScaling",
            TargetTrackingConfiguration: { PredefinedMetricSpecification: { PredefinedMetricType: v.metric }, TargetValue: v.target },
          })),
        ),
      });
      return 0;
    }
    default:
      return 252;
  }
}
