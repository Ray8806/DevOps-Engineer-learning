import { parseArgs, type Ctx } from "./context";

const saEmail = (name: string, project: string) => `${name}@${project}.iam.gserviceaccount.com`;
const MEMBER = /^(?:(user|group|serviceAccount):[^\s:@]+@[^\s:@]+|allUsers|allAuthenticatedUsers)$/;
const ROLE = /^roles\/[A-Za-z][A-Za-z0-9.]*$/;

function error(ctx: Ctx, command: string, message: string): number {
  ctx.err(`ERROR: (${command}) ${message}`);
  return 1;
}

/** `gcloud iam service-accounts create | list | delete`. */
export function serviceAccounts(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.iam.service-accounts.${action}`;
  const parsed = parseArgs(rest, { options: ["--display-name", "--description", "--project"], flags: ["--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;

  switch (action) {
    case "create": {
      const name = parsed.positional[0];
      if (!name) return error(ctx, command, "argument NAME: Must be specified.");
      if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(name)) {
        return error(ctx, command, `INVALID_ARGUMENT: 服務帳戶 ID '${name}' 不合規定。必須是 6 到 30 個字元，只能用小寫字母、數字和連字號，並以小寫字母開頭。`);
      }
      const email = saEmail(name, gcp.project);
      if (gcp.serviceAccounts.has(email)) return error(ctx, command, `Resource in projects [${gcp.project}] is the subject of a conflict: Service account ${name} already exists within project projects/${gcp.project}.`);
      gcp.serviceAccounts.set(email, { displayName: parsed.options.get("--display-name") ?? "" });
      ctx.out(`Created service account [${name}].\n`);
      return 0;
    }
    case "list": {
      if (gcp.serviceAccounts.size === 0) {
        ctx.out("Listed 0 items.\n");
        return 0;
      }
      const rows = [...gcp.serviceAccounts].sort(([a], [b]) => (a < b ? -1 : 1));
      const width = Math.max(12, ...rows.map(([, sa]) => sa.displayName.length)) + 2;
      ctx.out(`${"DISPLAY NAME".padEnd(width)}EMAIL\n`);
      for (const [email, sa] of rows) ctx.out(`${sa.displayName.padEnd(width)}${email}\n`);
      return 0;
    }
    case "delete": {
      const email = parsed.positional[0];
      if (!email) return error(ctx, command, "argument SERVICE_ACCOUNT: Must be specified.");
      if (!gcp.serviceAccounts.delete(email)) return error(ctx, command, `NOT_FOUND: Unknown service account（請使用完整的電子郵件，例如 ${saEmail("NAME", gcp.project)}）`);
      ctx.out(`deleted service account [${email}]\n`);
      return 0;
    }
    default:
      return error(ctx, "gcloud.iam.service-accounts", `不支援的指令 '${action ?? ""}'。支援 create、list、delete。`);
  }
}

function printPolicy(ctx: Ctx) {
  const roles = [...ctx.state.gcp.bindings].filter(([, members]) => members.size > 0).sort(([a], [b]) => (a < b ? -1 : 1));
  if (roles.length) {
    ctx.out("bindings:\n");
    for (const [role, members] of roles) {
      ctx.out(`- members:\n${[...members].sort().map((m) => `  - ${m}\n`).join("")}  role: ${role}\n`);
    }
  }
  ctx.out("version: 1\n");
}

/** `gcloud projects add-iam-policy-binding | remove-iam-policy-binding | get-iam-policy | list`. */
export function projects(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.projects.${action}`;
  const parsed = parseArgs(rest, { options: ["--member", "--role", "--condition", "--format"], flags: ["--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;

  if (action === "list") {
    ctx.out(`PROJECT_ID  NAME        PROJECT_NUMBER\n${gcp.project}  ${gcp.project}  123456789012\n`);
    return 0;
  }
  if (!["add-iam-policy-binding", "remove-iam-policy-binding", "get-iam-policy"].includes(action ?? "")) {
    return error(ctx, "gcloud.projects", `不支援的指令 '${action ?? ""}'。支援 list、get-iam-policy、add-iam-policy-binding、remove-iam-policy-binding。`);
  }
  const project = parsed.positional[0];
  if (!project) return error(ctx, command, "argument PROJECT_ID: Must be specified.");
  if (project !== gcp.project) {
    return error(ctx, command, `[${project}] 不存在，或你沒有權限。這個模擬環境的專案 ID 是 ${gcp.project}。`);
  }
  if (action === "get-iam-policy") {
    printPolicy(ctx);
    return 0;
  }

  const member = parsed.options.get("--member");
  const role = parsed.options.get("--role");
  const missing = [member === undefined ? "--member" : "", role === undefined ? "--role" : ""].filter(Boolean);
  if (missing.length || member === undefined || role === undefined) {
    return error(ctx, command, `argument ${missing.join(" ")}: Must be specified.`);
  }
  if (!MEMBER.test(member)) {
    return error(ctx, command, `INVALID_ARGUMENT: 成員 '${member}' 的格式不正確。請使用 user:電子郵件、group:電子郵件 或 serviceAccount:電子郵件。`);
  }
  if (!ROLE.test(role)) return error(ctx, command, `INVALID_ARGUMENT: Role ${role} is not supported for this resource. 角色的格式是 roles/服務.角色名稱。`);
  const ownSa = member.startsWith("serviceAccount:") && member.endsWith(`@${gcp.project}.iam.gserviceaccount.com`);
  if (action === "add-iam-policy-binding") {
    if (ownSa && !gcp.serviceAccounts.has(member.slice("serviceAccount:".length))) {
      return error(ctx, command, `INVALID_ARGUMENT: Service account ${member.slice("serviceAccount:".length)} does not exist.`);
    }
    if (!gcp.bindings.has(role)) gcp.bindings.set(role, new Set());
    gcp.bindings.get(role)!.add(member);
  } else {
    const members = gcp.bindings.get(role);
    if (!members?.delete(member)) return error(ctx, command, `Policy binding with the specified principal, role, and condition not found!`);
    if (members.size === 0) gcp.bindings.delete(role);
  }
  ctx.out(`Updated IAM policy for project [${project}].\n`);
  printPolicy(ctx);
  return 0;
}
