import { parseArgs, type Ctx } from "./context";
import { error, list, table } from "./gcloud-common";

/** gcloud billing accounts | projects | budgets. */
export function billing(ctx: Ctx, args: string[]): number {
  const [group, action, ...raw] = args;
  const command = `gcloud.billing.${group}.${action}`;
  // --threshold-rule may be repeated; collect every occurrence before the usual parsing.
  const rules: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--threshold-rule") rules.push(raw[++i] ?? "");
    else if (raw[i].startsWith("--threshold-rule=")) rules.push(raw[i].slice("--threshold-rule=".length));
    else rest.push(raw[i]);
  }
  const parsed = parseArgs(rest, {
    options: ["--billing-account", "--display-name", "--budget-amount", "--filter-labels", "--filter-projects", "--calendar-period", "--project", "--format"],
    flags: ["--quiet", "-q"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const b = ctx.state.gcp.billing;
  const project = ctx.state.gcp.project;
  const accountOk = () => {
    const id = parsed.options.get("--billing-account")?.replace(/^billingAccounts\//, "");
    if (id === undefined) {
      error(ctx, command, "argument --billing-account: Must be specified.");
      return false;
    }
    if (id !== b.accountId) {
      error(ctx, command, `NOT_FOUND: Billing account billingAccounts/${id} not found.（用 gcloud billing accounts list 查帳單帳戶 ID）`);
      return false;
    }
    return true;
  };

  if (group === "accounts" && action === "list") {
    table(ctx, ["ACCOUNT_ID", "NAME", "OPEN", "MASTER_ACCOUNT_ID"], [[b.accountId, b.accountName, "True", ""]]);
    return 0;
  }
  if (group === "projects") {
    const target = parsed.positional[0];
    if (!target) return error(ctx, command, "argument PROJECT_ID: Must be specified.");
    if (target !== project) return error(ctx, command, `PERMISSION_DENIED: 這個模擬終端機只有專案 ${project}。`);
    if (action === "describe") {
      ctx.out(`billingAccountName: ${b.linked ? `billingAccounts/${b.accountId}` : "''"}\nbillingEnabled: ${b.linked}\nname: projects/${project}/billingInfo\nprojectId: ${project}\n`);
      return 0;
    }
    if (action === "link") {
      if (!accountOk()) return 1;
      b.linked = true;
      ctx.out(`billingAccountName: billingAccounts/${b.accountId}\nbillingEnabled: true\nname: projects/${project}/billingInfo\nprojectId: ${project}\n`);
      return 0;
    }
    if (action === "unlink") {
      b.linked = false;
      ctx.out(`billingAccountName: ''\nbillingEnabled: false\nname: projects/${project}/billingInfo\nprojectId: ${project}\n（模擬終端機的提醒：專案停用帳單後，需要付費的服務會停止，部分資源可能被刪除）\n`);
      return 0;
    }
    return error(ctx, "gcloud.billing.projects", `不支援的指令 '${action ?? ""}'。支援 describe、link、unlink。`);
  }
  if (group === "budgets") {
    if (action === "list") {
      if (!accountOk()) return 1;
      for (const [name, x] of b.budgets) {
        ctx.out(
          `---\namount:\n  specifiedAmount:\n    currencyCode: ${x.currency}\n    units: '${x.amount}'\ndisplayName: ${name}\nthresholdRules:\n${x.thresholds
            .map((t) => `- spendBasis: ${t.basis === "forecasted-spend" ? "FORECASTED_SPEND" : "CURRENT_SPEND"}\n  thresholdPercent: ${t.percent}\n`)
            .join("")}`,
        );
      }
      if (!b.budgets.size) ctx.out("Listed 0 items.\n");
      return 0;
    }
    if (action === "delete") {
      const name = parsed.positional[0];
      if (!name || !b.budgets.delete(name)) return error(ctx, command, `NOT_FOUND: 找不到預算 ${name ?? ""}（這個模擬終端機用顯示名稱指定預算）`);
      ctx.out(`Deleted budget [${name}].\n`);
      return 0;
    }
    if (action !== "create") return error(ctx, "gcloud.billing.budgets", `不支援的指令 '${action ?? ""}'。支援 create、list、delete。`);
    if (!accountOk()) return 1;
    const name = parsed.options.get("--display-name");
    if (name === undefined) return error(ctx, command, "argument --display-name: Must be specified.");
    if (b.budgets.has(name)) return error(ctx, command, `這個模擬終端機裡已經有名為「${name}」的預算。`);
    const amountText = parsed.options.get("--budget-amount");
    if (amountText === undefined) return error(ctx, command, "Exactly one of (--budget-amount | --last-period-amount) must be specified.");
    const m = /^(\d+(?:\.\d+)?)([A-Z]{3})?$/.exec(amountText);
    if (!m) return error(ctx, command, `argument --budget-amount: 格式像 300USD 或 300，收到 '${amountText}'。`);
    if (m[2] && m[2] !== "USD") return error(ctx, command, "INVALID_ARGUMENT: 幣別要和帳單帳戶一致（這個模擬帳單帳戶用 USD）。");
    const thresholds: { percent: number; basis: string }[] = [];
    for (const rule of rules) {
      const fields = Object.fromEntries(list(rule).map((p) => p.split("=")));
      const percent = Number(fields.percent);
      const basis = fields.basis ?? "current-spend";
      if (!(percent > 0) || percent > 10) return error(ctx, command, `argument --threshold-rule: percent 是 1.0 為基準的比例，例如 percent=0.9 代表 90%（收到 '${rule}'）。`);
      if (basis !== "current-spend" && basis !== "forecasted-spend") return error(ctx, command, "argument --threshold-rule: basis 要是 current-spend 或 forecasted-spend。");
      thresholds.push({ percent, basis });
    }
    const filterLabels: Record<string, string> = {};
    for (const pair of list(parsed.options.get("--filter-labels"))) {
      const [k, v] = pair.split("=");
      if (!k || v === undefined) return error(ctx, command, "argument --filter-labels: 格式是 KEY=VALUE，例如 --filter-labels=team=data。");
      filterLabels[k] = v;
    }
    const filterProjects = list(parsed.options.get("--filter-projects")).map((p) => p.replace(/^projects\//, ""));
    const unknownProject = filterProjects.find((p) => p !== project);
    if (unknownProject) return error(ctx, command, `INVALID_ARGUMENT: 專案 ${unknownProject} 沒有連結到這個帳單帳戶。`);
    b.budgets.set(name, { amount: Number(m[1]), currency: "USD", thresholds, filterLabels, filterProjects });
    ctx.out(
      `Created budget [billingAccounts/${b.accountId}/budgets/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}].\n${
        thresholds.length ? "" : "（模擬終端機的提醒：沒有設定 --threshold-rule，預算不會寄出任何快訊）\n"
      }（預算只會發出快訊，不會自動停止花費）\n`,
    );
    return 0;
  }
  return error(ctx, "gcloud.billing", `不支援 '${group ?? ""} ${action ?? ""}'。這個模擬終端機支援 gcloud billing accounts list、projects describe | link | unlink、budgets create | list | delete。`);
}
