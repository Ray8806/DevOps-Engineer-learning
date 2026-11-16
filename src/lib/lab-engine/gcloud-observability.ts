import { parseArgs, type Ctx } from "./context";
import { error, list, table } from "./gcloud-common";
import type { LogEntry } from "./state";

const SEVERITIES = ["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"];
const FIELDS: Record<string, keyof LogEntry> = { severity: "severity", "resource.type": "resourceType", logName: "logName", textPayload: "text" };

interface Clause {
  field: keyof LogEntry | null;
  op: string;
  value: string;
}

/** Collapses whitespace around operators so equivalent filters compare equal. */
export const normaliseFilter = (filter: string) =>
  filter.trim().replace(/\s*(>=|<=|!=|=|>|<|:)\s*/g, "$1").replace(/\s+/g, " ");

/**
 * The common subset of the Logging query language: comparisons on severity,
 * resource.type, logName and textPayload, bare words searched in the text,
 * joined by AND (or just spaces). Returns null when something is unsupported.
 */
function parseFilter(filter: string): Clause[] | null {
  const tokens = [...normaliseFilter(filter).matchAll(/(?:[^\s"]|"[^"]*")+/g)].map((m) => m[0]).filter((t) => t !== "AND");
  const clauses: Clause[] = [];
  for (const token of tokens) {
    const m = /^([A-Za-z_.]+)(>=|<=|!=|=|>|<|:)(.+)$/.exec(token);
    if (!m) {
      if (token === "OR" || token === "NOT") return null;
      clauses.push({ field: null, op: ":", value: token.replace(/^"|"$/g, "") });
      continue;
    }
    const field = FIELDS[m[1]];
    if (!field) return null;
    const value = m[3].replace(/^"|"$/g, "");
    if (field === "severity" && !SEVERITIES.includes(value.toUpperCase())) return null;
    clauses.push({ field, op: m[2], value });
  }
  return clauses;
}

function matches(entry: LogEntry, clause: Clause): boolean {
  if (clause.field === null) return entry.text.includes(clause.value);
  const actual = String(entry[clause.field]);
  if (clause.field === "severity") {
    const a = SEVERITIES.indexOf(actual);
    const b = SEVERITIES.indexOf(clause.value.toUpperCase());
    return { "=": a === b, "!=": a !== b, ">": a > b, ">=": a >= b, "<": a < b, "<=": a <= b, ":": a === b }[clause.op] ?? false;
  }
  if (clause.op === ":") return actual.includes(clause.value);
  if (clause.op === "=") return actual === clause.value;
  if (clause.op === "!=") return actual !== clause.value;
  return false;
}

function logging(ctx: Ctx, args: string[]): number {
  const [group, ...rest] = args;
  const gcp = ctx.state.gcp;
  const log = gcp.logging;
  const project = gcp.project;

  if (group === "read") {
    const command = "gcloud.logging.read";
    const parsed = parseArgs(rest, { options: ["--limit", "--freshness", "--format", "--order", "--project"] });
    if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
    const filter = parsed.positional.join(" ");
    const clauses = parseFilter(filter);
    if (!clauses) {
      return error(ctx, command, "這個模擬終端機支援的篩選條件：severity>=ERROR、resource.type=gce_instance、logName:syslog、textPayload:\"關鍵字\"、直接寫關鍵字，以及用 AND 串接。");
    }
    const limit = parsed.options.has("--limit") ? Number(parsed.options.get("--limit")) : Infinity;
    // Newest entries first, like gcloud's default order.
    const found = log.entries.filter((e) => clauses.every((c) => matches(e, c))).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, limit);
    log.queries.add(normaliseFilter(filter));
    for (const e of found) {
      ctx.out(`---\nlogName: projects/${project}/logs/${e.logName}\nresource:\n  type: ${e.resourceType}\nseverity: ${e.severity}\ntextPayload: ${e.text}\ntimestamp: '${e.timestamp}'\n`);
    }
    if (!found.length) ctx.out("（沒有符合的記錄）\n");
    return 0;
  }

  const [action, ...more] = rest;
  const command = `gcloud.logging.${group}.${action}`;
  const parsed = parseArgs(more, { options: ["--description", "--log-filter", "--location", "--retention-days", "--project", "--format"], flags: ["--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const name = parsed.positional[0];

  switch (group) {
    case "metrics": {
      if (action === "list") {
        table(ctx, ["NAME", "DESCRIPTION", "FILTER"], [...log.metrics].map(([n, m]) => [n, m.description, m.filter]));
        return 0;
      }
      if (!name) return error(ctx, command, "argument METRIC_NAME: Must be specified.");
      if (action === "delete") {
        if (!log.metrics.delete(name)) return error(ctx, command, `NOT_FOUND: Metric ${name} does not exist.`);
        ctx.out(`Deleted [${name}].\n`);
        return 0;
      }
      if (action !== "create") return error(ctx, "gcloud.logging.metrics", `不支援的指令 '${action ?? ""}'。支援 create、list、delete。`);
      if (!/^[A-Za-z0-9_.\-/]{1,100}$/.test(name)) return error(ctx, command, `INVALID_ARGUMENT: Invalid metric name '${name}'.`);
      if (log.metrics.has(name)) return error(ctx, command, `ALREADY_EXISTS: Metric ${name} already exists.`);
      const filter = parsed.options.get("--log-filter");
      if (filter === undefined) return error(ctx, command, "argument --log-filter: Must be specified.");
      if (!parseFilter(filter)) return error(ctx, command, "這個模擬終端機看不懂這個篩選條件，請用 severity>=ERROR 這類寫法。");
      log.metrics.set(name, { filter: normaliseFilter(filter), description: parsed.options.get("--description") ?? "" });
      ctx.out(`Created [${name}].\n`);
      return 0;
    }
    case "buckets": {
      const row = (n: string) => [n, "global", String(log.buckets.get(n)!.retentionDays), log.buckets.get(n)!.locked ? "yes" : "no"];
      if (action === "list") {
        table(ctx, ["BUCKET_ID", "LOCATION", "RETENTION_DAYS", "LOCKED"], [...log.buckets.keys()].map(row));
        return 0;
      }
      if (!name) return error(ctx, command, "argument BUCKET_ID: Must be specified.");
      if (parsed.options.get("--location") !== "global") return error(ctx, command, "這個模擬終端機只有 global 位置的記錄 bucket，請加上 --location=global。");
      const bucket = log.buckets.get(name);
      if (!bucket) return error(ctx, command, `NOT_FOUND: Bucket ${name} does not exist.（這個專案只有 _Required 和 _Default）`);
      if (action === "describe") {
        ctx.out(`name: projects/${project}/locations/global/buckets/${name}\nretentionDays: ${bucket.retentionDays}\n`);
        return 0;
      }
      if (action !== "update") return error(ctx, "gcloud.logging.buckets", `不支援的指令 '${action ?? ""}'。支援 list、describe、update。`);
      const daysText = parsed.options.get("--retention-days");
      if (daysText === undefined) return error(ctx, command, "請用 --retention-days 指定保留天數。");
      if (bucket.locked) return error(ctx, command, "FAILED_PRECONDITION: _Required 記錄 bucket 的保留期限固定是 400 天，不能更改。");
      const days = Number(daysText);
      if (!Number.isInteger(days) || days < 1 || days > 3650) return error(ctx, command, "INVALID_ARGUMENT: 保留天數要介於 1 到 3650 天。");
      bucket.retentionDays = days;
      ctx.out(`Updated [${name}].\n`);
      return 0;
    }
    case "sinks": {
      if (action === "list") {
        table(ctx, ["NAME", "DESTINATION", "FILTER"], [...log.sinks].map(([n, s]) => [n, s.destination, s.filter]));
        return 0;
      }
      if (!name) return error(ctx, command, "argument SINK_NAME: Must be specified.");
      if (action === "describe") {
        const sink = log.sinks.get(name);
        if (!sink) return error(ctx, command, `NOT_FOUND: Sink ${name} does not exist.`);
        ctx.out(`destination: ${sink.destination}\nfilter: ${sink.filter}\nname: ${name}\n`);
        return 0;
      }
      if (action === "delete") {
        if (!log.sinks.delete(name)) return error(ctx, command, `NOT_FOUND: Sink ${name} does not exist.`);
        ctx.out(`Deleted [https://logging.googleapis.com/v2/projects/${project}/sinks/${name}].\n`);
        return 0;
      }
      if (action !== "create") return error(ctx, "gcloud.logging.sinks", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、delete。`);
      if (log.sinks.has(name)) return error(ctx, command, `ALREADY_EXISTS: Sink ${name} already exists.`);
      const destination = parsed.positional[1];
      if (!destination) return error(ctx, command, "argument DESTINATION: Must be specified.（例如 storage.googleapis.com/my-bucket）");
      const gcs = /^storage\.googleapis\.com\/([a-z0-9][a-z0-9._-]*)$/.exec(destination);
      const other = /^(bigquery\.googleapis\.com\/projects\/[^/]+\/datasets\/\w+|pubsub\.googleapis\.com\/projects\/[^/]+\/topics\/[\w.-]+|logging\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/buckets\/[\w-]+)$/.test(destination);
      if (!gcs && !other) {
        return error(ctx, command, "INVALID_ARGUMENT: 目的地的格式像 storage.googleapis.com/BUCKET、bigquery.googleapis.com/projects/PROJECT/datasets/DATASET 或 pubsub.googleapis.com/projects/PROJECT/topics/TOPIC。");
      }
      if (gcs && !ctx.state.gcs.has(gcs[1])) return error(ctx, command, `這個模擬終端機找不到 bucket gs://${gcs[1]}，請先建立它。`);
      const filter = parsed.options.get("--log-filter") ?? "";
      if (filter && !parseFilter(filter)) return error(ctx, command, "這個模擬終端機看不懂這個篩選條件，請用 severity>=WARNING 這類寫法。");
      log.sinks.set(name, { destination, filter: normaliseFilter(filter) });
      ctx.out(
        `Created [https://logging.googleapis.com/v2/projects/${project}/sinks/${name}].\nPlease remember to grant \`serviceAccount:service-498765432109@gcp-sa-logging.iam.gserviceaccount.com\` the appropriate role on the destination.\n（模擬終端機的提醒：sink 的寫入者身分需要目的地的寫入權限，記錄才送得過去）\n`,
      );
      return 0;
    }
    default:
      return error(ctx, "gcloud.logging", `不支援 '${group ?? ""}'。這個模擬終端機支援 gcloud logging read、metrics、buckets、sinks。`);
  }
}

function monitoring(ctx: Ctx, args: string[]): number {
  const [group, action, ...rest] = args;
  const command = `gcloud.monitoring.${group}.${action}`;
  const parsed = parseArgs(rest, {
    options: [
      "--resource-type", "--resource-labels", "--path", "--period", "--display-name", "--condition-display-name", "--condition-filter",
      "--if", "--duration", "--notification-channels", "--project", "--format",
    ],
    flags: ["--quiet", "-q"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const mon = ctx.state.gcp.monitoring;
  const project = ctx.state.gcp.project;

  if (group === "uptime") {
    if (action === "list-configs") {
      table(ctx, ["DISPLAY_NAME", "RESOURCE_TYPE", "HOST", "PATH", "PERIOD"], [...mon.uptimeChecks].map(([n, u]) => [n, u.resourceType, u.host, u.path, `${u.period}min`]));
      return 0;
    }
    const name = parsed.positional[0];
    if (!name) return error(ctx, command, "argument DISPLAY_NAME: Must be specified.");
    if (action === "delete") {
      if (!mon.uptimeChecks.delete(name)) return error(ctx, command, `NOT_FOUND: Uptime check ${name} does not exist.`);
      ctx.out(`Deleted uptime check [${name}].\n`);
      return 0;
    }
    if (action !== "create") return error(ctx, "gcloud.monitoring.uptime", `不支援的指令 '${action ?? ""}'。支援 create、list-configs、delete。`);
    if (mon.uptimeChecks.has(name)) return error(ctx, command, `這個模擬終端機裡已經有名為 ${name} 的正常運作時間檢查。`);
    const type = parsed.options.get("--resource-type") ?? "uptime-url";
    if (type !== "uptime-url") return error(ctx, command, "這個模擬終端機只支援 --resource-type=uptime-url。");
    const labels = Object.fromEntries(list(parsed.options.get("--resource-labels")).map((p) => p.split("=")));
    if (!labels.host) return error(ctx, command, "argument --resource-labels: 需要 host，例如 --resource-labels=host=example.com。");
    const period = Number(parsed.options.get("--period") ?? 1);
    if (![1, 5, 10, 15].includes(period)) return error(ctx, command, "argument --period: 這個模擬終端機接受 1、5、10、15（分鐘）。");
    mon.uptimeChecks.set(name, { resourceType: type, host: labels.host, path: parsed.options.get("--path") ?? "/", period });
    ctx.out(`Created uptime check [projects/${project}/uptimeCheckConfigs/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}].\n`);
    return 0;
  }

  if (group === "policies") {
    if (action === "list") {
      table(ctx, ["DISPLAY_NAME", "CONDITION", "DURATION"], [...mon.policies].map(([n, p]) => [n, `${p.conditionFilter} ${p.comparison} ${p.threshold ?? ""}`.trim(), p.duration]));
      return 0;
    }
    if (action !== "create") return error(ctx, "gcloud.monitoring.policies", `不支援的指令 '${action ?? ""}'。支援 create、list。`);
    const displayName = parsed.options.get("--display-name");
    if (displayName === undefined) return error(ctx, command, "這個模擬終端機需要 --display-name。");
    if (mon.policies.has(displayName)) return error(ctx, command, `這個模擬終端機裡已經有名為「${displayName}」的快訊政策。`);
    const filter = parsed.options.get("--condition-filter");
    if (filter === undefined) return error(ctx, command, "請用 --condition-filter 指定要監看的指標，例如 metric.type=\"logging.googleapis.com/user/error_count\"。");
    const ifValue = parsed.options.get("--if");
    if (ifValue === undefined) return error(ctx, command, "請用 --if 指定條件，例如 --if=\"> 5\"。");
    const m = /^\s*(absent|([<>])\s*(-?\d+(?:\.\d+)?))\s*$/.exec(ifValue);
    if (!m) return error(ctx, command, `argument --if: One of "absent", "< THRESHOLD", "> THRESHOLD"（收到 '${ifValue}'）`);
    const duration = parsed.options.get("--duration") ?? "0s";
    if (!/^\d+(s|min|h)$/.test(duration)) return error(ctx, command, `argument --duration: 格式像 60s 或 2min，收到 '${duration}'。`);
    mon.policies.set(displayName, {
      conditionFilter: normaliseFilter(filter),
      comparison: m[1] === "absent" ? "absent" : m[2],
      threshold: m[3] === undefined ? null : Number(m[3]),
      duration,
      channels: list(parsed.options.get("--notification-channels")),
    });
    ctx.out(`Created alert policy [projects/${project}/alertPolicies/${mon.policies.size}].\n`);
    return 0;
  }
  return error(ctx, "gcloud.monitoring", `不支援 '${group ?? ""}'。這個模擬終端機支援 gcloud monitoring uptime 和 gcloud monitoring policies。`);
}

export function observability(ctx: Ctx, args: string[]): number | null {
  if (args[0] === "logging") return logging(ctx, args.slice(1));
  if (args[0] === "monitoring") return monitoring(ctx, args.slice(1));
  return null;
}
