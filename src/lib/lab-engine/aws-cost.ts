import type { Ctx } from "./context";
import { resolvePath, type Budget } from "./state";

export const CE_COMMANDS = ["get-cost-and-usage", "get-cost-forecast", "list-cost-allocation-tags", "update-cost-allocation-tags-status"];
export const BUDGETS_COMMANDS = ["create-budget", "describe-budgets", "delete-budget"];

const ACCOUNT = "123456789012";
/** The simulator's "today": cost data runs through the day before. */
export const COST_TODAY = "2026-11-16";
const METRICS: Record<string, string> = {
  UnblendedCost: "UNBLENDED_COST",
  BlendedCost: "BLENDED_COST",
  AmortizedCost: "AMORTIZED_COST",
  NetUnblendedCost: "NET_UNBLENDED_COST",
  NetAmortizedCost: "NET_AMORTIZED_COST",
};

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

interface Parsed {
  options: Map<string, string[]>;
  unknown?: string;
}

function parse(args: string[], options: string[], lists: string[] = []): Parsed {
  const result: Parsed = { options: new Map() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
    if (!options.includes(name)) return { ...result, unknown: arg };
    const values = eq !== -1 && arg.startsWith("--") ? [arg.slice(eq + 1)] : [];
    if (values.length === 0) {
      if (args[i + 1] === undefined) return { ...result, unknown: arg };
      values.push(args[++i]);
    }
    if (lists.includes(name)) while (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) values.push(args[++i]);
    result.options.set(name, values);
  }
  return result;
}

function required(ctx: Ctx, parsed: Parsed, names: string[]): boolean {
  const missing = names.filter((n) => !parsed.options.has(`--${n}`));
  if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
  return missing.length === 0;
}

function unsupported(ctx: Ctx, service: string, sub: string | undefined, supported: string[]): number {
  ctx.err(sub ? `aws: 不支援的 ${service} 指令 '${sub}'。支援：${supported.join("、")}` : `usage: aws ${service} <command> [parameters]\n支援：${supported.join("、")}`);
  return 252;
}

function shorthand(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const pair of text.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

/** Inline JSON or file://path; null after reporting. */
function readJson(ctx: Ctx, option: string, text: string): unknown {
  let source = text;
  if (text.startsWith("file://")) {
    const content = ctx.state.files.get(resolvePath(ctx.state.cwd, text.slice(7)));
    if (content === undefined) {
      ctx.err(`\nError parsing parameter '${option}': Unable to load paramfile ${text}: [Errno 2] No such file or directory`);
      return null;
    }
    source = content;
  }
  try {
    return JSON.parse(source);
  } catch {
    ctx.err(`\nError parsing parameter '${option}': Invalid JSON: ${source.slice(0, 60)}`);
    return null;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const money = (n: number) => n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
const addMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** --time-period Start=…,End=…; null after reporting. */
function period(ctx: Ctx, operation: string, text: string): { start: string; end: string } | null {
  const p = shorthand(text);
  if (!p?.Start || !p.End || !DATE.test(p.Start) || !DATE.test(p.End)) {
    fail(ctx, "ValidationException", operation, "--time-period 的格式是 Start=2026-10-01,End=2026-11-01（End 不包含在內）");
    return null;
  }
  if (p.Start >= p.End) {
    fail(ctx, "ValidationException", operation, "Start date (inclusive) must be before End date (exclusive).");
    return null;
  }
  return { start: p.Start, end: p.End };
}

export function ce(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !CE_COMMANDS.includes(sub)) return unsupported(ctx, "ce", sub, CE_COMMANDS);
  const parsed = parse(
    rest,
    ["--time-period", "--granularity", "--metrics", "--metric", "--group-by", "--filter", "--cost-allocation-tags-status", "--status", "--output", "--region"],
    ["--metrics", "--group-by", "--cost-allocation-tags-status"],
  );
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const data = ctx.state.aws.ce;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const tagKeys = [...new Set(data.costs.flatMap((c) => Object.keys(c.tags)))].sort();

  switch (sub) {
    case "get-cost-and-usage": {
      if (!required(ctx, parsed, ["time-period", "granularity", "metrics"])) return 252;
      const range = period(ctx, operation, opt("time-period")!);
      if (!range) return 254;
      if (opt("granularity") !== "MONTHLY") return fail(ctx, "ValidationException", operation, "這個模擬終端機的費用資料以月為單位，請用 --granularity MONTHLY。");
      const metrics = parsed.options.get("--metrics")!;
      const bad = metrics.find((m) => !METRICS[m]);
      if (bad) return fail(ctx, "ValidationException", operation, `這個模擬終端機支援的 metrics：${Object.keys(METRICS).join("、")}（收到 ${bad}）`);
      if (parsed.options.has("--filter")) return fail(ctx, "ValidationException", operation, "這個模擬終端機不支援 --filter，請用 --group-by 分組來看。");
      const groups = (parsed.options.get("--group-by") ?? []).map(shorthand);
      if (groups.length > 2) return fail(ctx, "ValidationException", operation, "You can group by up to two different groups.");
      for (const g of groups) {
        if (!g || !g.Type || !g.Key) return fail(ctx, "ValidationException", operation, "--group-by 的格式是 Type=DIMENSION,Key=SERVICE 或 Type=TAG,Key=Project");
        if (g.Type === "DIMENSION" && g.Key !== "SERVICE") return fail(ctx, "ValidationException", operation, "這個模擬終端機的 DIMENSION 只支援 SERVICE。");
        if (g.Type !== "DIMENSION" && g.Type !== "TAG") return fail(ctx, "ValidationException", operation, "這個模擬終端機的 group-by Type 支援 DIMENSION 和 TAG。");
      }
      const keyOf = (c: (typeof data.costs)[number]) =>
        groups.map((g) => {
          if (g!.Type === "DIMENSION") return c.service;
          // Inactive tags are not available in Cost Explorer: everything falls into "Key$".
          const active = data.tagStatus.get(g!.Key) === "Active";
          return `${g!.Key}$${active ? (c.tags[g!.Key] ?? "") : ""}`;
        });
      const results = [];
      const first = range.start.slice(0, 7);
      for (let month = first; `${month}-01` < range.end; month = addMonth(month)) {
        const items = data.costs.filter((c) => c.month === month);
        const metricValues = (amount: number) => Object.fromEntries(metrics.map((m) => [m, { Amount: money(amount), Unit: "USD" }]));
        const entry: Record<string, unknown> = { TimePeriod: { Start: `${month}-01` < range.start ? range.start : `${month}-01`, End: `${addMonth(month)}-01` > range.end ? range.end : `${addMonth(month)}-01` } };
        if (groups.length) {
          const sums = new Map<string, { keys: string[]; amount: number }>();
          for (const c of items) {
            const keys = keyOf(c);
            const k = keys.join("|");
            sums.set(k, { keys, amount: (sums.get(k)?.amount ?? 0) + c.amount });
          }
          entry.Total = {};
          entry.Groups = [...sums.values()].sort((a, b) => b.amount - a.amount).map((s) => ({ Keys: s.keys, Metrics: metricValues(s.amount) }));
        } else {
          entry.Total = metricValues(items.reduce((sum, c) => sum + c.amount, 0));
          entry.Groups = [];
        }
        entry.Estimated = month === COST_TODAY.slice(0, 7);
        results.push(entry);
      }
      for (const g of groups) data.queries.add(g!.Type === "DIMENSION" ? "SERVICE" : `TAG:${g!.Key}:${data.tagStatus.get(g!.Key) === "Active" ? "active" : "inactive"}`);
      json(ctx, {
        GroupDefinitions: groups.map((g) => ({ Type: g!.Type, Key: g!.Key })),
        ResultsByTime: results,
        DimensionValueAttributes: [],
      });
      return 0;
    }
    case "get-cost-forecast": {
      if (!required(ctx, parsed, ["time-period", "metric", "granularity"])) return 252;
      const range = period(ctx, operation, opt("time-period")!);
      if (!range) return 254;
      if (range.start < COST_TODAY) return fail(ctx, "ValidationException", operation, `Start date must be equal to or no later than the current date to avoid mismatched dates.（模擬終端機的今天是 ${COST_TODAY}）`);
      if (!Object.values(METRICS).includes(opt("metric")!)) return fail(ctx, "ValidationException", operation, `--metric 要是 ${Object.values(METRICS).join("、")} 之一`);
      // Forecast from the daily average of the last full month.
      const lastMonth = [...new Set(data.costs.map((c) => c.month))].filter((m) => m < COST_TODAY.slice(0, 7)).sort().at(-1);
      if (!lastMonth) return fail(ctx, "DataUnavailableException", operation, "Insufficient amount of historical data to generate forecast.");
      const total = data.costs.filter((c) => c.month === lastMonth).reduce((s, c) => s + c.amount, 0);
      const [y, m] = lastMonth.split("-").map(Number);
      const daily = total / new Date(Date.UTC(y, m, 0)).getUTCDate();
      const days = (Date.parse(range.end) - Date.parse(range.start)) / 86400000;
      data.forecasts++;
      data.queries.add("FORECAST");
      json(ctx, {
        Total: { Amount: money(daily * days), Unit: "USD" },
        ForecastResultsByTime: [{ TimePeriod: { Start: range.start, End: range.end }, MeanValue: money(daily * days), PredictionIntervalLowerBound: money(daily * days * 0.9), PredictionIntervalUpperBound: money(daily * days * 1.1) }],
      });
      return 0;
    }
    case "list-cost-allocation-tags":
      json(ctx, {
        CostAllocationTags: tagKeys.map((k) => ({ TagKey: k, Type: "UserDefined", Status: data.tagStatus.get(k) ?? "Inactive", LastUpdatedDate: "2026-11-15T00:00:00Z" })),
      });
      return 0;
    default: {
      if (!required(ctx, parsed, ["cost-allocation-tags-status"])) return 252;
      const entries = parsed.options.get("--cost-allocation-tags-status")!.map(shorthand);
      const errors: object[] = [];
      for (const e of entries) {
        if (!e?.TagKey || (e.Status !== "Active" && e.Status !== "Inactive")) {
          return fail(ctx, "ValidationException", operation, "格式是 TagKey=Project,Status=Active");
        }
        if (!tagKeys.includes(e.TagKey)) errors.push({ TagKey: e.TagKey, Code: "TagKeysNotFoundException", Message: "Failed to update Cost Allocation Tag: " + e.TagKey });
        else data.tagStatus.set(e.TagKey, e.Status as "Active" | "Inactive");
      }
      json(ctx, { Errors: errors });
      if (!errors.length) ctx.out("（模擬終端機立即生效；實際上啟用標籤最多要 24 小時）\n");
      return 0;
    }
  }
}

// ------------------------------------------------------------------ Budgets

const BUDGET_TYPES = ["COST", "USAGE", "RI_UTILIZATION", "RI_COVERAGE", "SAVINGS_PLANS_UTILIZATION", "SAVINGS_PLANS_COVERAGE"];
const TIME_UNITS = ["DAILY", "MONTHLY", "QUARTERLY", "ANNUALLY", "CUSTOM"];
const OPERATORS: Record<string, string> = { GREATER_THAN: ">", LESS_THAN: "<", EQUAL_TO: "=" };

/** Validates the notifications JSON; returns them or an error message. */
function notifications(value: unknown): Budget["notifications"] | string {
  if (!Array.isArray(value)) return "--notifications-with-subscribers 要是 JSON 陣列";
  if (value.length > 5) return "一個預算最多 5 個通知（模擬終端機的檢查）";
  const result: Budget["notifications"] = [];
  for (const raw of value as Record<string, Record<string, unknown> | unknown[]>[]) {
    const n = raw?.Notification as Record<string, unknown> | undefined;
    if (!n) return "每一項都要有 Notification 和 Subscribers";
    if (n.NotificationType !== "ACTUAL" && n.NotificationType !== "FORECASTED") return "NotificationType 要是 ACTUAL 或 FORECASTED";
    if (typeof n.ComparisonOperator !== "string" || !OPERATORS[n.ComparisonOperator]) return "ComparisonOperator 要是 GREATER_THAN、LESS_THAN 或 EQUAL_TO";
    if (typeof n.Threshold !== "number" || n.Threshold <= 0) return "Threshold 要是大於 0 的數字";
    const thresholdType = n.ThresholdType ?? "PERCENTAGE";
    if (thresholdType !== "PERCENTAGE" && thresholdType !== "ABSOLUTE_VALUE") return "ThresholdType 要是 PERCENTAGE 或 ABSOLUTE_VALUE";
    const subscribers = raw.Subscribers;
    if (!Array.isArray(subscribers) || !subscribers.length) return "每個通知至少要有一個 Subscribers";
    const subs: string[] = [];
    for (const s of subscribers as Record<string, unknown>[]) {
      if (s?.SubscriptionType === "EMAIL" && typeof s.Address === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.Address)) subs.push(`email:${s.Address}`);
      else if (s?.SubscriptionType === "SNS" && typeof s.Address === "string" && s.Address.startsWith("arn:aws:sns:")) subs.push(`sns:${s.Address.split(":").at(-1)}`);
      else return "Subscribers 的格式是 {\"SubscriptionType\": \"EMAIL\", \"Address\": \"ops@example.com\"} 或 SNS 主題 ARN";
    }
    result.push({ type: n.NotificationType, operator: n.ComparisonOperator, threshold: n.Threshold, thresholdType: String(thresholdType), subscribers: subs });
  }
  return result;
}

export function budgets(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !BUDGETS_COMMANDS.includes(sub)) return unsupported(ctx, "budgets", sub, BUDGETS_COMMANDS);
  const parsed = parse(rest, ["--account-id", "--budget", "--notifications-with-subscribers", "--budget-name", "--output", "--region"]);
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const store = ctx.state.aws.budgets;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  if (!required(ctx, parsed, ["account-id"])) return 252;
  if (opt("account-id") !== ACCOUNT) return fail(ctx, "AccessDeniedException", operation, `這個模擬終端機的帳戶 ID 是 ${ACCOUNT}`);

  switch (sub) {
    case "create-budget": {
      if (!required(ctx, parsed, ["budget"])) return 252;
      const raw = readJson(ctx, "--budget", opt("budget")!) as Record<string, unknown> | null;
      if (raw === null) return 252;
      const name = raw.BudgetName;
      if (typeof name !== "string" || !name || /[:\\]/.test(name)) return fail(ctx, "InvalidParameterException", operation, "BudgetName 要有值，而且不能包含 : 或 \\");
      if (store.has(name)) return fail(ctx, "DuplicateRecordException", operation, `Error creating budget: ${name} - the budget already exists.`);
      if (typeof raw.BudgetType !== "string" || !BUDGET_TYPES.includes(raw.BudgetType)) return fail(ctx, "InvalidParameterException", operation, `BudgetType 要是 ${BUDGET_TYPES.join("、")} 之一`);
      if (raw.BudgetType !== "COST") return fail(ctx, "InvalidParameterException", operation, "這個模擬終端機只支援成本預算（BudgetType COST）。");
      if (typeof raw.TimeUnit !== "string" || !TIME_UNITS.includes(raw.TimeUnit)) return fail(ctx, "InvalidParameterException", operation, `TimeUnit 要是 ${TIME_UNITS.join("、")} 之一`);
      const limit = raw.BudgetLimit as { Amount?: unknown; Unit?: unknown } | undefined;
      if (typeof limit?.Amount !== "string" || !(Number(limit.Amount) > 0) || typeof limit.Unit !== "string") {
        return fail(ctx, "InvalidParameterException", operation, "BudgetLimit 的格式是 {\"Amount\": \"500\", \"Unit\": \"USD\"}（Amount 是字串）");
      }
      let notes: Budget["notifications"] = [];
      if (parsed.options.has("--notifications-with-subscribers")) {
        const value = readJson(ctx, "--notifications-with-subscribers", opt("notifications-with-subscribers")!);
        if (value === null) return 252;
        const result = notifications(value);
        if (typeof result === "string") return fail(ctx, "InvalidParameterException", operation, result);
        notes = result;
      }
      store.set(name, { timeUnit: raw.TimeUnit, amount: Number(limit.Amount), unit: limit.Unit, notifications: notes });
      return 0;
    }
    case "describe-budgets": {
      const spent = ctx.state.aws.ce.costs.filter((c) => c.month === COST_TODAY.slice(0, 7)).reduce((s, c) => s + c.amount, 0);
      json(ctx, {
        Budgets: [...store].map(([n, b]) => ({
          BudgetName: n,
          BudgetLimit: { Amount: String(b.amount), Unit: b.unit },
          TimeUnit: b.timeUnit,
          BudgetType: "COST",
          CalculatedSpend: { ActualSpend: { Amount: money(spent), Unit: "USD" } },
        })),
      });
      return 0;
    }
    default: {
      if (!required(ctx, parsed, ["budget-name"])) return 252;
      if (!store.delete(opt("budget-name")!)) return fail(ctx, "NotFoundException", operation, `Unable to delete budget: ${opt("budget-name")} - the budget doesn't exist.`);
      return 0;
    }
  }
}

export const notificationLabel = (n: Budget["notifications"][number]) =>
  `${n.type} ${OPERATORS[n.operator]} ${n.threshold}${n.thresholdType === "PERCENTAGE" ? "%" : " USD"}`;
