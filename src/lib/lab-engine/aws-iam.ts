import { parseArgs, type Ctx } from "./context";
import { resolvePath } from "./state";

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

const ACCOUNT = "123456789012";
const userArn = (name: string) => `arn:aws:iam::${ACCOUNT}:user/${name}`;
const groupArn = (name: string) => `arn:aws:iam::${ACCOUNT}:group/${name}`;
export const roleArn = (name: string) => `arn:aws:iam::${ACCOUNT}:role/${name}`;
const NAME = /^[A-Za-z0-9+=,.@_-]{1,64}$/;

/** AWS managed policies the simulator knows about. */
const MANAGED_POLICIES = [
  "AdministratorAccess",
  "PowerUserAccess",
  "ReadOnlyAccess",
  "IAMReadOnlyAccess",
  "AmazonS3ReadOnlyAccess",
  "AmazonS3FullAccess",
  "AmazonEC2ReadOnlyAccess",
  "AmazonEC2FullAccess",
  "AmazonRDSReadOnlyAccess",
  "AmazonDynamoDBReadOnlyAccess",
  "CloudWatchReadOnlyAccess",
  "service-role/AWSLambdaBasicExecutionRole",
];
const POLICY_PREFIX = "arn:aws:iam::aws:policy/";

export const IAM_COMMANDS =
  "create-user、delete-user、list-users、create-group、delete-group、list-groups、add-user-to-group、remove-user-from-group、list-groups-for-user、attach-group-policy、detach-group-policy、list-attached-group-policies、attach-user-policy、detach-user-policy、list-attached-user-policies、create-role、delete-role、get-role、list-roles、attach-role-policy、detach-role-policy、list-attached-role-policies";

export function iam(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  // Say the command is unsupported before complaining about its options.
  if (sub === undefined || !IAM_COMMANDS.split("、").includes(sub)) {
    ctx.err(sub ? `aws: 不支援的 iam 指令 '${sub}'。支援：${IAM_COMMANDS}` : `usage: aws iam <command> [parameters]\n支援：${IAM_COMMANDS}`);
    return 252;
  }
  const parsed = parseArgs(rest, {
    options: ["--user-name", "--group-name", "--policy-arn", "--role-name", "--assume-role-policy-document", "--description", "--region", "--output"],
  });
  if (parsed.unknown || parsed.positional.length) {
    ctx.err(`\nUnknown options: ${parsed.unknown ?? parsed.positional.join(", ")}`);
    return 252;
  }
  const { users, groups, roles } = ctx.state.aws.iam;
  const operation = (sub ?? "").split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");

  /** Reads required options; reports the missing ones the way the AWS CLI does. */
  function need<K extends string>(...names: K[]): Record<K, string> | null {
    const missing = names.filter((n) => !parsed.options.has(`--${n}`));
    if (missing.length) {
      ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
      return null;
    }
    return Object.fromEntries(names.map((n) => [n, parsed.options.get(`--${n}`)!])) as Record<K, string>;
  }
  const noUser = (name: string) => fail(ctx, "NoSuchEntity", operation, `The user with name ${name} cannot be found.`);
  const noGroup = (name: string) => fail(ctx, "NoSuchEntity", operation, `The group with name ${name} cannot be found.`);
  const noRole = (name: string) => fail(ctx, "NoSuchEntity", operation, `The role with name ${name} cannot be found.`);
  const roleJson = (name: string) => ({
    Path: "/",
    RoleName: name,
    Arn: roleArn(name),
    AssumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [...roles.get(name)!.trustedServices].map((service) => ({ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" })),
    },
  });

  /**
   * Reads a trust policy (inline JSON or file://path) and returns the services
   * it lets assume the role, or null after reporting a malformed document.
   */
  function trustedServices(source: string): Set<string> | null {
    let text = source;
    if (source.startsWith("file://")) {
      const path = source.slice("file://".length);
      const content = ctx.state.files.get(resolvePath(ctx.state.cwd, path));
      if (content === undefined) {
        ctx.err(`
Error parsing parameter '--assume-role-policy-document': Unable to load paramfile ${source}: [Errno 2] No such file or directory: '${path}'`);
        return null;
      }
      text = content;
    }
    const malformed = (why: string) => {
      fail(ctx, "MalformedPolicyDocument", operation, why);
      return null;
    };
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return malformed("This policy contains invalid Json");
    }
    const raw = (doc as { Statement?: unknown })?.Statement;
    const statements = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const services = new Set<string>();
    for (const st of statements as { Effect?: string; Action?: unknown; Principal?: { Service?: unknown } }[]) {
      const actions = Array.isArray(st.Action) ? st.Action : [st.Action];
      if (st.Effect !== "Allow" || !actions.includes("sts:AssumeRole")) continue;
      const principal = st.Principal?.Service;
      for (const service of Array.isArray(principal) ? principal : [principal]) if (typeof service === "string") services.add(service);
    }
    if (services.size === 0) return malformed("信任政策裡沒有允許任何服務 sts:AssumeRole 的陳述式（例如 Principal 的 Service 是 lambda.amazonaws.com）。");
    return services;
  }
  function policy(arn: string): boolean {
    if (arn.startsWith(POLICY_PREFIX) && MANAGED_POLICIES.includes(arn.slice(POLICY_PREFIX.length))) return true;
    fail(
      ctx,
      "NoSuchEntity",
      operation,
      `Policy ${arn} does not exist or is not attachable.\n（模擬終端機認得的受管政策：${MANAGED_POLICIES.join("、")}；ARN 的格式是 ${POLICY_PREFIX}<政策名稱>）`,
    );
    return false;
  }
  const attached = (policies: Set<string>) => ({
    AttachedPolicies: [...policies].sort().map((arn) => ({ PolicyName: arn.slice(arn.lastIndexOf("/") + 1), PolicyArn: arn })),
  });

  switch (sub) {
    case "create-user": {
      const o = need("user-name");
      if (!o) return 252;
      const name = o["user-name"];
      if (!NAME.test(name)) return fail(ctx, "ValidationError", operation, "The specified value for userName is invalid. It must contain only alphanumeric characters and/or the following: +=,.@_-");
      if (users.has(name)) return fail(ctx, "EntityAlreadyExists", operation, `User with name ${name} already exists.`);
      users.set(name, { groups: new Set(), policies: new Set() });
      json(ctx, { User: { Path: "/", UserName: name, Arn: userArn(name) } });
      return 0;
    }
    case "delete-user": {
      const o = need("user-name");
      if (!o) return 252;
      const user = users.get(o["user-name"]);
      if (!user) return noUser(o["user-name"]);
      if (user.groups.size || user.policies.size) {
        return fail(ctx, "DeleteConflict", operation, "Cannot delete entity, must remove users from group and detach all policies first.");
      }
      users.delete(o["user-name"]);
      return 0;
    }
    case "list-users":
      json(ctx, { Users: [...users.keys()].sort().map((n) => ({ Path: "/", UserName: n, Arn: userArn(n) })) });
      return 0;
    case "create-group": {
      const o = need("group-name");
      if (!o) return 252;
      const name = o["group-name"];
      if (!NAME.test(name)) return fail(ctx, "ValidationError", operation, "The specified value for groupName is invalid. It must contain only alphanumeric characters and/or the following: +=,.@_-");
      if (groups.has(name)) return fail(ctx, "EntityAlreadyExists", operation, `Group with name ${name} already exists.`);
      groups.set(name, { policies: new Set() });
      json(ctx, { Group: { Path: "/", GroupName: name, Arn: groupArn(name) } });
      return 0;
    }
    case "delete-group": {
      const o = need("group-name");
      if (!o) return 252;
      const group = groups.get(o["group-name"]);
      if (!group) return noGroup(o["group-name"]);
      const members = [...users.values()].some((u) => u.groups.has(o["group-name"]));
      if (members || group.policies.size) {
        return fail(ctx, "DeleteConflict", operation, "Cannot delete entity, must remove all users and detach all policies first.");
      }
      groups.delete(o["group-name"]);
      return 0;
    }
    case "list-groups":
      json(ctx, { Groups: [...groups.keys()].sort().map((n) => ({ Path: "/", GroupName: n, Arn: groupArn(n) })) });
      return 0;
    case "add-user-to-group":
    case "remove-user-from-group": {
      const o = need("group-name", "user-name");
      if (!o) return 252;
      const user = users.get(o["user-name"]);
      if (!user) return noUser(o["user-name"]);
      if (!groups.has(o["group-name"])) return noGroup(o["group-name"]);
      if (sub === "add-user-to-group") user.groups.add(o["group-name"]);
      else user.groups.delete(o["group-name"]);
      return 0;
    }
    case "list-groups-for-user": {
      const o = need("user-name");
      if (!o) return 252;
      const user = users.get(o["user-name"]);
      if (!user) return noUser(o["user-name"]);
      json(ctx, { Groups: [...user.groups].sort().map((n) => ({ Path: "/", GroupName: n, Arn: groupArn(n) })) });
      return 0;
    }
    case "attach-group-policy":
    case "detach-group-policy": {
      const o = need("group-name", "policy-arn");
      if (!o) return 252;
      const group = groups.get(o["group-name"]);
      if (!group) return noGroup(o["group-name"]);
      if (!policy(o["policy-arn"])) return 254;
      if (sub === "attach-group-policy") group.policies.add(o["policy-arn"]);
      else if (!group.policies.delete(o["policy-arn"])) return fail(ctx, "NoSuchEntity", operation, `Policy ${o["policy-arn"]} was not found.`);
      return 0;
    }
    case "attach-user-policy":
    case "detach-user-policy": {
      const o = need("user-name", "policy-arn");
      if (!o) return 252;
      const user = users.get(o["user-name"]);
      if (!user) return noUser(o["user-name"]);
      if (!policy(o["policy-arn"])) return 254;
      if (sub === "attach-user-policy") user.policies.add(o["policy-arn"]);
      else if (!user.policies.delete(o["policy-arn"])) return fail(ctx, "NoSuchEntity", operation, `Policy ${o["policy-arn"]} was not found.`);
      return 0;
    }
    case "list-attached-group-policies": {
      const o = need("group-name");
      if (!o) return 252;
      const group = groups.get(o["group-name"]);
      if (!group) return noGroup(o["group-name"]);
      json(ctx, attached(group.policies));
      return 0;
    }
    case "list-attached-user-policies": {
      const o = need("user-name");
      if (!o) return 252;
      const user = users.get(o["user-name"]);
      if (!user) return noUser(o["user-name"]);
      json(ctx, attached(user.policies));
      return 0;
    }
    case "create-role": {
      const o = need("role-name", "assume-role-policy-document");
      if (!o) return 252;
      const name = o["role-name"];
      if (!NAME.test(name)) return fail(ctx, "ValidationError", operation, "The specified value for roleName is invalid. It must contain only alphanumeric characters and/or the following: +=,.@_-");
      if (roles.has(name)) return fail(ctx, "EntityAlreadyExists", operation, `Role with name ${name} already exists.`);
      const services = trustedServices(o["assume-role-policy-document"]);
      if (!services) return 254;
      roles.set(name, { trustedServices: services, policies: new Set() });
      json(ctx, { Role: roleJson(name) });
      return 0;
    }
    case "get-role": {
      const o = need("role-name");
      if (!o) return 252;
      if (!roles.has(o["role-name"])) return noRole(o["role-name"]);
      json(ctx, { Role: roleJson(o["role-name"]) });
      return 0;
    }
    case "list-roles":
      json(ctx, { Roles: [...roles.keys()].sort().map(roleJson) });
      return 0;
    case "delete-role": {
      const o = need("role-name");
      if (!o) return 252;
      const role = roles.get(o["role-name"]);
      if (!role) return noRole(o["role-name"]);
      if (role.policies.size) return fail(ctx, "DeleteConflict", operation, "Cannot delete entity, must detach all policies first.");
      roles.delete(o["role-name"]);
      return 0;
    }
    case "attach-role-policy":
    case "detach-role-policy": {
      const o = need("role-name", "policy-arn");
      if (!o) return 252;
      const role = roles.get(o["role-name"]);
      if (!role) return noRole(o["role-name"]);
      if (!policy(o["policy-arn"])) return 254;
      if (sub === "attach-role-policy") role.policies.add(o["policy-arn"]);
      else if (!role.policies.delete(o["policy-arn"])) return fail(ctx, "NoSuchEntity", operation, `Policy ${o["policy-arn"]} was not found.`);
      return 0;
    }
    case "list-attached-role-policies": {
      const o = need("role-name");
      if (!o) return 252;
      const role = roles.get(o["role-name"]);
      if (!role) return noRole(o["role-name"]);
      json(ctx, attached(role.policies));
      return 0;
    }
    default:
      return 252;
  }
}
