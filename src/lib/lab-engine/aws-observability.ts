import type { Ctx } from "./context";

export const SNS_COMMANDS = ["create-topic", "list-topics", "delete-topic", "subscribe", "list-subscriptions-by-topic"];
export const CLOUDWATCH_COMMANDS = ["put-metric-alarm", "describe-alarms", "delete-alarms", "set-alarm-state"];
export const LOGS_COMMANDS = [
  "create-log-group", "describe-log-groups", "delete-log-group", "put-retention-policy", "delete-retention-policy",
  "filter-log-events", "put-metric-filter", "describe-metric-filters",
];
export const CLOUDTRAIL_COMMANDS = ["lookup-events"];

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
/** Values CloudWatch Logs accepts for a retention period. */
const RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];
const COMPARISONS: Record<string, string> = {
  GreaterThanThreshold: ">",
  GreaterThanOrEqualToThreshold: ">=",
  LessThanThreshold: "<",
  LessThanOrEqualToThreshold: "<=",
};
const STATISTICS = ["Average", "Sum", "Minimum", "Maximum", "SampleCount"];
const LOOKUP_KEYS = ["EventName", "Username", "ResourceName", "EventSource"];

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

interface Parsed {
  options: Map<string, string[]>;
  flags: Set<string>;
  unknown?: string;
}

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

function shorthand(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const pair of text.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

const operationName = (sub: string) => sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");

function unsupported(ctx: Ctx, service: string, sub: string | undefined, supported: string[]): number {
  ctx.err(sub ? `aws: 不支援的 ${service} 指令 '${sub}'。支援：${supported.join("、")}` : `usage: aws ${service} <command> [parameters]\n支援：${supported.join("、")}`);
  return 252;
}

function requiredCheck(ctx: Ctx, parsed: Parsed, names: string[]): boolean {
  const missing = names.filter((n) => !parsed.options.has(`--${n}`));
  if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
  return missing.length === 0;
}

const topicArn = (name: string) => `arn:aws:sns:${REGION}:${ACCOUNT}:${name}`;

// ---------------------------------------------------------------------- SNS

export function sns(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !SNS_COMMANDS.includes(sub)) return unsupported(ctx, "sns", sub, SNS_COMMANDS);
  const parsed = parse(rest, ["--name", "--topic-arn", "--protocol", "--notification-endpoint", "--region", "--output"], []);
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const topics = ctx.state.aws.sns.topics;
  const operation = operationName(sub);
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const topicName = (arn: string) => (arn.startsWith(`arn:aws:sns:${REGION}:${ACCOUNT}:`) ? arn.split(":").at(-1)! : null);
  const notFound = () => fail(ctx, "NotFound", operation, "Topic does not exist");
  switch (sub) {
    case "create-topic": {
      if (!requiredCheck(ctx, parsed, ["name"])) return 252;
      const name = opt("name")!;
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(name)) return fail(ctx, "InvalidParameter", operation, "Invalid parameter: Topic Name（只能用英數字、連字號和底線）");
      // CreateTopic returns the existing topic when the name is already used.
      if (!topics.has(name)) topics.set(name, { subscriptions: new Map() });
      json(ctx, { TopicArn: topicArn(name) });
      return 0;
    }
    case "list-topics":
      json(ctx, { Topics: [...topics.keys()].sort().map((n) => ({ TopicArn: topicArn(n) })) });
      return 0;
    case "delete-topic": {
      if (!requiredCheck(ctx, parsed, ["topic-arn"])) return 252;
      const name = topicName(opt("topic-arn")!);
      if (name !== null) topics.delete(name);
      return 0;
    }
    case "subscribe": {
      if (!requiredCheck(ctx, parsed, ["topic-arn", "protocol"])) return 252;
      const name = topicName(opt("topic-arn")!);
      const topic = name === null ? undefined : topics.get(name);
      if (!topic) return notFound();
      const protocol = opt("protocol")!;
      if (!["email", "email-json", "sms", "sqs", "lambda", "https", "http"].includes(protocol)) {
        return fail(ctx, "InvalidParameter", operation, `Invalid parameter: Protocol（收到 '${protocol}'）`);
      }
      const endpoint = opt("notification-endpoint");
      if (endpoint === undefined) return fail(ctx, "InvalidParameter", operation, "Invalid parameter: Endpoint");
      if (protocol.startsWith("email") && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(endpoint)) return fail(ctx, "InvalidParameter", operation, "Invalid parameter: Email address");
      // Email subscriptions wait until the recipient clicks the confirmation link.
      const status = protocol.startsWith("email") || protocol.startsWith("http") ? "PendingConfirmation" : "Confirmed";
      topic.subscriptions.set(`${protocol}:${endpoint}`, status);
      json(ctx, { SubscriptionArn: status === "PendingConfirmation" ? "pending confirmation" : `${topicArn(name!)}:00000000-0000-0000-0000-00000000000${topic.subscriptions.size}` });
      return 0;
    }
    default: {
      if (!requiredCheck(ctx, parsed, ["topic-arn"])) return 252;
      const name = topicName(opt("topic-arn")!);
      const topic = name === null ? undefined : topics.get(name);
      if (!topic) return notFound();
      json(ctx, {
        Subscriptions: [...topic.subscriptions].map(([key, status]) => {
          const [protocol, ...endpoint] = key.split(":");
          return { SubscriptionArn: status === "PendingConfirmation" ? "PendingConfirmation" : `${topicArn(name!)}:sub`, Protocol: protocol, Endpoint: endpoint.join(":"), TopicArn: topicArn(name!) };
        }),
      });
      return 0;
    }
  }
}

// --------------------------------------------------------------- CloudWatch

export function cloudwatch(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !CLOUDWATCH_COMMANDS.includes(sub)) return unsupported(ctx, "cloudwatch", sub, CLOUDWATCH_COMMANDS);
  const parsed = parse(
    rest,
    [
      "--alarm-name", "--alarm-names", "--alarm-description", "--metric-name", "--namespace", "--statistic", "--period", "--threshold",
      "--comparison-operator", "--evaluation-periods", "--datapoints-to-alarm", "--dimensions", "--alarm-actions", "--unit",
      "--state-value", "--state-reason", "--treat-missing-data", "--region", "--output",
    ],
    ["--dimensions", "--alarm-actions", "--alarm-names"],
  );
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const alarms = ctx.state.aws.cloudwatch.alarms;
  const operation = operationName(sub);
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const validation = (message: string) => fail(ctx, "ValidationError", operation, message);
  switch (sub) {
    case "put-metric-alarm": {
      const needed = ["alarm-name", "evaluation-periods", "comparison-operator"];
      if (!requiredCheck(ctx, parsed, needed)) return 252;
      for (const n of ["metric-name", "namespace", "period", "threshold"]) {
        if (!parsed.options.has(`--${n}`)) return validation(`這個模擬終端機需要 --${n}（一般的單一指標警示都要指定 metric-name、namespace、statistic、period、threshold）。`);
      }
      const statistic = opt("statistic") ?? "";
      if (!STATISTICS.includes(statistic)) return validation(`請用 --statistic 指定統計方式：${STATISTICS.join("、")}。`);
      const comparison = opt("comparison-operator")!;
      if (!COMPARISONS[comparison]) {
        return validation(`1 validation error detected: Value '${comparison}' at 'comparisonOperator' failed to satisfy constraint. 可用的值：${Object.keys(COMPARISONS).join("、")}`);
      }
      const period = Number(opt("period"));
      if (!Number.isInteger(period) || !(period === 10 || period === 20 || period === 30 || (period >= 60 && period % 60 === 0))) {
        return validation("Period 必須是 10、20、30，或 60 的倍數（秒）。（模擬終端機的檢查）");
      }
      const evaluationPeriods = Number(opt("evaluation-periods"));
      if (!Number.isInteger(evaluationPeriods) || evaluationPeriods < 1) return validation("EvaluationPeriods 要是 1 以上的整數。");
      const threshold = Number(opt("threshold"));
      if (Number.isNaN(threshold)) return validation(`Threshold 要是數字，收到 '${opt("threshold")}'。`);
      const dimensions: Record<string, string> = {};
      for (const d of parsed.options.get("--dimensions") ?? []) {
        const parsedDim = shorthand(d);
        if (!parsedDim?.Name || parsedDim.Value === undefined) return validation("--dimensions 的格式是 Name=InstanceId,Value=i-0123456789abcdef0");
        dimensions[parsedDim.Name] = parsedDim.Value;
      }
      const actions: string[] = [];
      for (const arn of parsed.options.get("--alarm-actions") ?? []) {
        const name = arn.startsWith(`arn:aws:sns:${REGION}:${ACCOUNT}:`) ? arn.split(":").at(-1)! : null;
        if (name === null || !ctx.state.aws.sns.topics.has(name)) return validation(`Invalid alarm action: ${arn}（這個模擬終端機的警示動作要指定已存在的 SNS 主題 ARN）`);
        actions.push(name);
      }
      // Putting an alarm with an existing name replaces it; new alarms start without data.
      alarms.set(opt("alarm-name")!, {
        namespace: opt("namespace")!,
        metricName: opt("metric-name")!,
        statistic,
        period,
        evaluationPeriods,
        threshold,
        comparisonOperator: comparison,
        dimensions,
        alarmActions: actions,
        state: "INSUFFICIENT_DATA",
      });
      return 0;
    }
    case "describe-alarms": {
      const names = parsed.options.get("--alarm-names") ?? [];
      json(ctx, {
        MetricAlarms: [...alarms]
          .filter(([n]) => !names.length || names.includes(n))
          .map(([n, a]) => ({
            AlarmName: n,
            AlarmArn: `arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:${n}`,
            AlarmActions: a.alarmActions.map(topicArn),
            StateValue: a.state,
            MetricName: a.metricName,
            Namespace: a.namespace,
            Statistic: a.statistic,
            Dimensions: Object.entries(a.dimensions).map(([Name, Value]) => ({ Name, Value })),
            Period: a.period,
            EvaluationPeriods: a.evaluationPeriods,
            Threshold: a.threshold,
            ComparisonOperator: a.comparisonOperator,
          })),
      });
      return 0;
    }
    case "delete-alarms": {
      if (!requiredCheck(ctx, parsed, ["alarm-names"])) return 252;
      for (const n of parsed.options.get("--alarm-names")!) alarms.delete(n);
      return 0;
    }
    default: {
      if (!requiredCheck(ctx, parsed, ["alarm-name", "state-value", "state-reason"])) return 252;
      const alarm = alarms.get(opt("alarm-name")!);
      if (!alarm) return fail(ctx, "ResourceNotFound", operation, `Alarm ${opt("alarm-name")} not found`);
      const state = opt("state-value")!;
      if (state !== "OK" && state !== "ALARM" && state !== "INSUFFICIENT_DATA") return validation("StateValue 要是 OK、ALARM 或 INSUFFICIENT_DATA。");
      alarm.state = state;
      return 0;
    }
  }
}

// ---------------------------------------------------------- CloudWatch Logs

/**
 * CloudWatch Logs filter patterns for unstructured events (the common subset):
 * space-separated terms that must all appear, case-sensitively; a quoted
 * phrase counts as one term; an empty pattern matches everything.
 */
export function matchesPattern(pattern: string, message: string): boolean {
  const terms = [...pattern.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  return terms.every((t) => message.includes(t));
}

export function logs(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !LOGS_COMMANDS.includes(sub)) return unsupported(ctx, "logs", sub, LOGS_COMMANDS);
  const parsed = parse(
    rest,
    ["--log-group-name", "--log-group-name-prefix", "--retention-in-days", "--filter-pattern", "--filter-name", "--metric-transformations", "--log-stream-names", "--limit", "--region", "--output"],
    ["--log-stream-names"],
  );
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const groups = ctx.state.aws.logs.groups;
  const operation = operationName(sub);
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const notFound = () => fail(ctx, "ResourceNotFoundException", operation, "The specified log group does not exist.");
  const group = () => groups.get(opt("log-group-name")!);
  if (sub !== "describe-log-groups" && !requiredCheck(ctx, parsed, ["log-group-name"])) return 252;

  switch (sub) {
    case "create-log-group": {
      const name = opt("log-group-name")!;
      if (!/^[A-Za-z0-9_\-/.#]{1,512}$/.test(name)) return fail(ctx, "InvalidParameterException", operation, "1 validation error detected: Value at 'logGroupName' failed to satisfy constraint");
      if (groups.has(name)) return fail(ctx, "ResourceAlreadyExistsException", operation, "The specified log group already exists");
      groups.set(name, { retentionInDays: null, events: [], searches: new Set(), metricFilters: new Map() });
      return 0;
    }
    case "describe-log-groups": {
      const prefix = opt("log-group-name-prefix") ?? "";
      json(ctx, {
        logGroups: [...groups]
          .filter(([n]) => n.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([n, g]) => ({
            logGroupName: n,
            ...(g.retentionInDays === null ? {} : { retentionInDays: g.retentionInDays }),
            metricFilterCount: g.metricFilters.size,
            arn: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${n}:*`,
            storedBytes: g.events.reduce((sum, e) => sum + e.message.length, 0),
            logGroupClass: "STANDARD",
          })),
      });
      return 0;
    }
    case "delete-log-group":
      if (!groups.delete(opt("log-group-name")!)) return notFound();
      return 0;
    case "put-retention-policy": {
      if (!requiredCheck(ctx, parsed, ["retention-in-days"])) return 252;
      const g = group();
      if (!g) return notFound();
      const days = Number(opt("retention-in-days"));
      if (!RETENTION_DAYS.includes(days)) {
        return fail(ctx, "InvalidParameterException", operation, `1 validation error detected: Value '${opt("retention-in-days")}' at 'retentionInDays' failed to satisfy constraint: Member must satisfy enum value set: [${RETENTION_DAYS.join(", ")}]`);
      }
      g.retentionInDays = days;
      return 0;
    }
    case "delete-retention-policy": {
      const g = group();
      if (!g) return notFound();
      g.retentionInDays = null;
      return 0;
    }
    case "filter-log-events": {
      const g = group();
      if (!g) return notFound();
      const pattern = opt("filter-pattern") ?? "";
      const streams = parsed.options.get("--log-stream-names");
      const limit = opt("limit") === undefined ? Infinity : Number(opt("limit"));
      const events = g.events.filter((e) => (!streams || streams.includes(e.stream)) && matchesPattern(pattern, e.message)).slice(0, limit);
      g.searches.add(pattern);
      json(ctx, {
        events: events.map((e, i) => ({ logStreamName: e.stream, timestamp: e.timestamp, message: e.message, ingestionTime: e.timestamp + 1000, eventId: `3${String(e.timestamp)}${i}` })),
        searchedLogStreams: [],
      });
      return 0;
    }
    case "put-metric-filter": {
      if (!requiredCheck(ctx, parsed, ["filter-name", "filter-pattern", "metric-transformations"])) return 252;
      const g = group();
      if (!g) return notFound();
      const t = shorthand(opt("metric-transformations")!);
      if (!t?.metricName || !t.metricNamespace || t.metricValue === undefined) {
        ctx.err("\nError parsing parameter '--metric-transformations': 格式是 metricName=名稱,metricNamespace=命名空間,metricValue=1");
        return 252;
      }
      g.metricFilters.set(opt("filter-name")!, { pattern: opt("filter-pattern")!, metricName: t.metricName, metricNamespace: t.metricNamespace });
      return 0;
    }
    default: {
      const g = group();
      if (!g) return notFound();
      json(ctx, {
        metricFilters: [...g.metricFilters].map(([n, f]) => ({
          filterName: n,
          filterPattern: f.pattern,
          metricTransformations: [{ metricName: f.metricName, metricNamespace: f.metricNamespace, metricValue: "1" }],
          logGroupName: opt("log-group-name"),
        })),
      });
      return 0;
    }
  }
}

// --------------------------------------------------------------- CloudTrail

export function cloudtrail(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !CLOUDTRAIL_COMMANDS.includes(sub)) return unsupported(ctx, "cloudtrail", sub, CLOUDTRAIL_COMMANDS);
  const parsed = parse(rest, ["--lookup-attributes", "--max-results", "--region", "--output"], ["--lookup-attributes"]);
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const attrs = (parsed.options.get("--lookup-attributes") ?? []).map(shorthand);
  if (attrs.length > 1) return fail(ctx, "InvalidLookupAttributesException", "LookupEvents", "You cannot specify more than one lookup attribute.");
  const attr = attrs[0];
  if (attr !== undefined && (!attr?.AttributeKey || attr.AttributeValue === undefined || !LOOKUP_KEYS.includes(attr.AttributeKey))) {
    return fail(ctx, "InvalidLookupAttributesException", "LookupEvents", `格式是 AttributeKey=EventName,AttributeValue=DeleteBucket；這個模擬終端機支援的 AttributeKey：${LOOKUP_KEYS.join("、")}`);
  }
  const field: Record<string, "eventName" | "username" | "resourceName" | "eventSource"> = {
    EventName: "eventName",
    Username: "username",
    ResourceName: "resourceName",
    EventSource: "eventSource",
  };
  const max = parsed.options.has("--max-results") ? Number(parsed.options.get("--max-results")![0]) : 50;
  const events = ctx.state.aws.cloudtrail.events
    .filter((e) => !attr || e[field[attr.AttributeKey]] === attr.AttributeValue)
    .sort((a, b) => (a.eventTime < b.eventTime ? 1 : -1))
    .slice(0, max);
  json(ctx, {
    Events: events.map((e, i) => ({
      EventId: `a1b2c3d4-5678-90ab-cdef-${String(i).padStart(12, "0")}`,
      EventName: e.eventName,
      ReadOnly: "false",
      EventTime: e.eventTime,
      EventSource: e.eventSource,
      Username: e.username,
      Resources: e.resourceName ? [{ ResourceName: e.resourceName }] : [],
    })),
  });
  return 0;
}
