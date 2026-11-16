import type { Ctx } from "./context";
import { resolvePath, type DynamoTable, type DynamoValue } from "./state";

export const DYNAMODB_COMMANDS = [
  "create-table", "describe-table", "list-tables", "delete-table", "put-item", "get-item", "delete-item", "query", "scan",
  "update-time-to-live", "describe-time-to-live",
];

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
const TYPES = ["S", "N", "B", "BOOL", "NULL", "L", "M", "SS", "NS", "BS"];
/** Options that take several space-separated shorthand values. */
const LIST_OPTIONS = ["--attribute-definitions", "--key-schema"];
const VALUE_OPTIONS = [
  ...LIST_OPTIONS, "--table-name", "--billing-mode", "--provisioned-throughput", "--item", "--key", "--key-condition-expression",
  "--expression-attribute-values", "--expression-attribute-names", "--time-to-live-specification", "--projection-expression",
  "--limit", "--region", "--output",
];
const FLAGS = ["--consistent-read", "--no-consistent-read", "--scan-index-forward", "--no-scan-index-forward"];

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

function parse(args: string[]): Parsed {
  const result: Parsed = { options: new Map(), flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
    if (FLAGS.includes(arg)) result.flags.add(arg);
    else if (VALUE_OPTIONS.includes(name)) {
      const values = eq !== -1 && arg.startsWith("--") ? [arg.slice(eq + 1)] : [];
      if (values.length === 0) {
        if (args[i + 1] === undefined) return { ...result, unknown: arg };
        values.push(args[++i]);
      }
      // List options keep taking values until the next option.
      if (LIST_OPTIONS.includes(name)) while (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) values.push(args[++i]);
      result.options.set(name, values);
    } else return { ...result, unknown: arg };
  }
  return result;
}

/** "AttributeName=Id,AttributeType=S" -> { AttributeName: "Id", AttributeType: "S" }. */
function shorthand(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const pair of text.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

const scalarType = (v: DynamoValue): string | null => {
  const keys = Object.keys(v ?? {});
  return keys.length === 1 && TYPES.includes(keys[0]) ? keys[0] : null;
};

/** Key part of an item as stored: numbers normalised so 1 and 1.0 match. */
function keyPart(v: DynamoValue): string {
  return "N" in v ? String(Number(v.N)) : String(Object.values(v)[0]);
}

function compare(a: DynamoValue, b: DynamoValue): number {
  if ("N" in a && "N" in b) return Number(a.N) - Number(b.N);
  const x = String(Object.values(a)[0]);
  const y = String(Object.values(b)[0]);
  return x < y ? -1 : x > y ? 1 : 0;
}

interface Condition {
  attribute: string;
  op: "=" | "<" | "<=" | ">" | ">=" | "between" | "begins_with";
  values: string[];
}

/** Splits a key condition expression into its conditions (joined by AND). */
function parseKeyCondition(expression: string): Condition[] | null {
  const name = String.raw`(#?[A-Za-z_][A-Za-z0-9_]*)`;
  const value = String.raw`(:[A-Za-z0-9_]+)`;
  const patterns: [RegExp, (m: RegExpExecArray) => Condition][] = [
    [new RegExp(String.raw`^begins_with\s*\(\s*${name}\s*,\s*${value}\s*\)`, "i"), (m) => ({ attribute: m[1], op: "begins_with", values: [m[2]] })],
    [new RegExp(String.raw`^${name}\s+BETWEEN\s+${value}\s+AND\s+${value}`, "i"), (m) => ({ attribute: m[1], op: "between", values: [m[2], m[3]] })],
    [new RegExp(String.raw`^${name}\s*(<=|>=|=|<|>)\s*${value}`), (m) => ({ attribute: m[1], op: m[2] as Condition["op"], values: [m[3]] })],
  ];
  const conditions: Condition[] = [];
  let rest = expression.trim();
  while (rest) {
    const match = patterns.map(([re, build]) => [re.exec(rest), build] as const).find(([m]) => m);
    if (!match) return null;
    const [m, build] = match;
    conditions.push(build(m!));
    rest = rest.slice(m![0].length).trim();
    if (rest) {
      const and = /^AND\s+/i.exec(rest);
      if (!and) return null;
      rest = rest.slice(and[0].length);
    }
  }
  return conditions.length ? conditions : null;
}

export function dynamodb(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !DYNAMODB_COMMANDS.includes(sub)) {
    const supported = DYNAMODB_COMMANDS.join("、");
    ctx.err(sub ? `aws: 不支援的 dynamodb 指令 '${sub}'。支援：${supported}` : `usage: aws dynamodb <command> [parameters]\n支援：${supported}`);
    return 252;
  }
  const parsed = parse(rest);
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const tables = ctx.state.aws.dynamodb.tables;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const opt = (name: string) => parsed.options.get(`--${name}`)?.[0];
  function required(...names: string[]): boolean {
    const missing = names.filter((n) => !parsed.options.has(`--${n}`));
    if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
    return missing.length === 0;
  }
  const validation = (message: string) => fail(ctx, "ValidationException", operation, message);
  const notFound = (name: string) =>
    fail(ctx, "ResourceNotFoundException", operation, `Requested resource not found: Table: ${name} not found`);

  /** Reads a JSON option, inline or from file://path. */
  function jsonOption(name: string): Record<string, unknown> | null {
    let text = opt(name)!;
    if (text.startsWith("file://")) {
      const content = ctx.state.files.get(resolvePath(ctx.state.cwd, text.slice(7)));
      if (content === undefined) {
        ctx.err(`\nError parsing parameter '--${name}': Unable to load paramfile ${text}: [Errno 2] No such file or directory: '${text.slice(7)}'`);
        return null;
      }
      text = content;
    }
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // reported below
    }
    ctx.err(`\nError parsing parameter '--${name}': Invalid JSON: ${text}\n（JSON 要用單引號包起來，例如 --${name} '{"Id": {"S": "001"}}'）`);
    return null;
  }

  /** Checks typed attribute values ({"S": "..."}); returns false after reporting. */
  function typed(values: Record<string, unknown>): values is Record<string, DynamoValue> {
    for (const [attr, v] of Object.entries(values)) {
      const type = typeof v === "object" && v !== null ? scalarType(v as DynamoValue) : null;
      if (!type) {
        validation(`Supplied AttributeValue is empty, must contain exactly one of the supported datatypes（${attr} 的值要寫成 {"S": "文字"}、{"N": "123"} 這種帶型別的格式）`);
        return false;
      }
      if (type === "N" && Number.isNaN(Number((v as DynamoValue).N))) {
        validation(`A value provided cannot be converted into a number（${attr}）`);
        return false;
      }
    }
    return true;
  }

  function table(): [string, DynamoTable] | null {
    const name = opt("table-name")!;
    const t = tables.get(name);
    if (!t) {
      notFound(name);
      return null;
    }
    return [name, t];
  }

  /** The storage key of an item or key object, or null after reporting a schema mismatch. */
  function itemKey(t: DynamoTable, values: Record<string, DynamoValue>, isKey: boolean): string | null {
    const keys = [t.partitionKey, ...(t.sortKey ? [t.sortKey] : [])];
    for (const k of keys) {
      const v = values[k.name];
      if (!v) {
        validation(isKey ? "The provided key element does not match the schema" : `One or more parameter values were invalid: Missing the key ${k.name} in the item`);
        return null;
      }
      const type = scalarType(v);
      if (type !== k.type) {
        validation(`One or more parameter values were invalid: Type mismatch for key ${k.name} expected: ${k.type} actual: ${type}`);
        return null;
      }
    }
    if (isKey && Object.keys(values).length !== keys.length) {
      validation("The provided key element does not match the schema");
      return null;
    }
    return keys.map((k) => keyPart(values[k.name])).join("|");
  }

  const describe = (name: string, status: string) => {
    const t = tables.get(name)!;
    const keyAttrs = [t.partitionKey, ...(t.sortKey ? [t.sortKey] : [])];
    return {
      TableDescription: {
        AttributeDefinitions: keyAttrs.map((k) => ({ AttributeName: k.name, AttributeType: k.type })),
        TableName: name,
        KeySchema: [{ AttributeName: t.partitionKey.name, KeyType: "HASH" }, ...(t.sortKey ? [{ AttributeName: t.sortKey.name, KeyType: "RANGE" }] : [])],
        TableStatus: status,
        ...(t.provisioned
          ? { ProvisionedThroughput: { NumberOfDecreasesToday: 0, ReadCapacityUnits: t.provisioned.read, WriteCapacityUnits: t.provisioned.write } }
          : { BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" } }),
        TableSizeBytes: JSON.stringify([...t.items.values()]).length,
        ItemCount: t.items.size,
        TableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${name}`,
      },
    };
  };

  switch (sub) {
    case "create-table": {
      if (!required("table-name", "attribute-definitions", "key-schema")) return 252;
      const name = opt("table-name")!;
      if (!TABLE_NAME.test(name)) return validation(`TableName must be between 3 and 255 characters and contain only a-z, A-Z, 0-9, '_', '-', and '.'（收到 '${name}'）`);
      if (tables.has(name)) return fail(ctx, "ResourceInUseException", operation, `Table already exists: ${name}`);
      const defs = parsed.options.get("--attribute-definitions")!.map(shorthand);
      const schema = parsed.options.get("--key-schema")!.map(shorthand);
      if (defs.some((d) => !d?.AttributeName || !d.AttributeType) || schema.some((k) => !k?.AttributeName || !k.KeyType)) {
        ctx.err("\nError parsing parameter: 格式是 --attribute-definitions AttributeName=名稱,AttributeType=S 與 --key-schema AttributeName=名稱,KeyType=HASH");
        return 252;
      }
      const hash = schema.filter((k) => k!.KeyType === "HASH");
      const range = schema.filter((k) => k!.KeyType === "RANGE");
      if (hash.length !== 1 || range.length > 1 || hash.length + range.length !== schema.length) {
        return validation("1 validation error detected: KeySchema 要有一個 KeyType=HASH（分割區索引鍵），最多再加一個 KeyType=RANGE（排序索引鍵）。");
      }
      if (defs.length !== schema.length || !schema.every((k) => defs.some((d) => d!.AttributeName === k!.AttributeName))) {
        return validation("One or more parameter values were invalid: Number of attributes in KeySchema does not exactly match number of attributes defined in AttributeDefinitions");
      }
      const typeOf = (attr: string) => defs.find((d) => d!.AttributeName === attr)!.AttributeType;
      const bad = defs.find((d) => !["S", "N", "B"].includes(d!.AttributeType));
      if (bad) return validation(`主鍵的型別只能是 S（字串）、N（數字）或 B（二進位），收到 '${bad.AttributeType}'。`);
      const billing = opt("billing-mode");
      const throughput = opt("provisioned-throughput");
      let provisioned: DynamoTable["provisioned"] = null;
      if (billing !== undefined && billing !== "PAY_PER_REQUEST" && billing !== "PROVISIONED") {
        return validation(`1 validation error detected: Value '${billing}' at 'billingMode' failed to satisfy constraint: Member must satisfy enum value set: [PROVISIONED, PAY_PER_REQUEST]`);
      }
      if (billing === "PAY_PER_REQUEST" && throughput !== undefined) {
        return validation("One or more parameter values were invalid: Neither ReadCapacityUnits nor WriteCapacityUnits can be specified when BillingMode is PAY_PER_REQUEST");
      }
      if (billing !== "PAY_PER_REQUEST") {
        const p = throughput === undefined ? null : shorthand(throughput);
        const read = Number(p?.ReadCapacityUnits);
        const write = Number(p?.WriteCapacityUnits);
        if (!p || !(read >= 1) || !(write >= 1)) {
          return validation(
            "這個模擬終端機需要明確指定容量模式：隨需（on-demand）用 --billing-mode PAY_PER_REQUEST；佈建模式用 --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5。",
          );
        }
        provisioned = { read, write };
      }
      const hashName = hash[0]!.AttributeName;
      const rangeName = range[0]?.AttributeName;
      tables.set(name, {
        partitionKey: { name: hashName, type: typeOf(hashName) as "S" },
        sortKey: rangeName ? { name: rangeName, type: typeOf(rangeName) as "S" } : null,
        billingMode: provisioned ? "PROVISIONED" : "PAY_PER_REQUEST",
        provisioned,
        ttlAttribute: null,
        items: new Map(),
        queried: new Set(),
      });
      json(ctx, describe(name, "CREATING"));
      return 0;
    }
    case "describe-table": {
      if (!required("table-name")) return 252;
      if (!table()) return 254;
      json(ctx, { Table: describe(opt("table-name")!, "ACTIVE").TableDescription });
      return 0;
    }
    case "list-tables":
      json(ctx, { TableNames: [...tables.keys()].sort() });
      return 0;
    case "delete-table": {
      if (!required("table-name")) return 252;
      if (!table()) return 254;
      const output = describe(opt("table-name")!, "DELETING");
      tables.delete(opt("table-name")!);
      json(ctx, output);
      return 0;
    }
    case "put-item": {
      if (!required("table-name", "item")) return 252;
      const found = table();
      if (!found) return 254;
      const item = jsonOption("item");
      if (!item || !typed(item)) return 254;
      const key = itemKey(found[1], item, false);
      if (key === null) return 254;
      // PutItem replaces any existing item with the same key.
      found[1].items.set(key, item);
      return 0;
    }
    case "get-item":
    case "delete-item": {
      if (!required("table-name", "key")) return 252;
      const found = table();
      if (!found) return 254;
      const keyValues = jsonOption("key");
      if (!keyValues || !typed(keyValues)) return 254;
      const key = itemKey(found[1], keyValues, true);
      if (key === null) return 254;
      const item = found[1].items.get(key);
      if (sub === "delete-item") found[1].items.delete(key);
      else if (item) json(ctx, { Item: item });
      return 0;
    }
    case "scan": {
      if (!required("table-name")) return 252;
      const found = table();
      if (!found) return 254;
      const items = [...found[1].items.values()];
      json(ctx, { Items: items, Count: items.length, ScannedCount: items.length, ConsumedCapacity: null });
      return 0;
    }
    case "query": {
      if (!required("table-name", "key-condition-expression")) return 252;
      const found = table();
      if (!found) return 254;
      const [, t] = found;
      const conditions = parseKeyCondition(opt("key-condition-expression")!);
      if (!conditions) {
        return validation(`Invalid KeyConditionExpression: Syntax error（支援 名稱 = :值，以及 AND 排序鍵的 =、<、<=、>、>=、BETWEEN、begins_with）`);
      }
      const names = parsed.options.has("--expression-attribute-names") ? jsonOption("expression-attribute-names") : {};
      if (!names) return 254;
      const values = parsed.options.has("--expression-attribute-values") ? jsonOption("expression-attribute-values") : {};
      if (!values || !typed(values)) return 254;
      for (const c of conditions) {
        if (c.attribute.startsWith("#")) {
          const real = names[c.attribute];
          if (typeof real !== "string") return validation(`Value provided in ExpressionAttributeNames unused in expressions or an expression attribute name used in expression is not defined; attribute name: ${c.attribute}`);
          c.attribute = real;
        }
        const missing = c.values.find((v) => !values[v]);
        if (missing) return validation(`Invalid KeyConditionExpression: An expression attribute value used in expression is not defined; attribute value: ${missing}`);
      }
      const pk = conditions.find((c) => c.attribute === t.partitionKey.name);
      if (!pk || pk.op !== "=") return validation(`Query condition missed key schema element: ${t.partitionKey.name}（Query 一定要用 = 指定分割區索引鍵）`);
      const others = conditions.filter((c) => c !== pk);
      if (others.length > 1 || (others[0] && others[0].attribute !== t.sortKey?.name)) {
        return validation(`Query key condition not supported（Key condition 只能使用主鍵：分割區索引鍵 ${t.partitionKey.name}${t.sortKey ? `、排序索引鍵 ${t.sortKey.name}` : ""}；其他屬性要用 scan 或次要索引）`);
      }
      const pkValue = values[pk.values[0]];
      if (scalarType(pkValue) !== t.partitionKey.type || (others[0] && others[0].values.some((v) => scalarType(values[v]) !== t.sortKey!.type))) {
        return validation("One or more parameter values were invalid: Condition parameter type does not match schema type");
      }
      const sk = others[0];
      const matches = [...t.items.values()].filter((item) => {
        if (keyPart(item[t.partitionKey.name]) !== keyPart(pkValue)) return false;
        if (!sk) return true;
        const v = item[t.sortKey!.name];
        const [a, b] = sk.values.map((name) => values[name]);
        switch (sk.op) {
          case "=": return compare(v, a) === 0;
          case "<": return compare(v, a) < 0;
          case "<=": return compare(v, a) <= 0;
          case ">": return compare(v, a) > 0;
          case ">=": return compare(v, a) >= 0;
          case "between": return compare(v, a) >= 0 && compare(v, b) <= 0;
          default: return String(Object.values(v)[0]).startsWith(String(Object.values(a)[0]));
        }
      });
      if (t.sortKey) matches.sort((x, y) => compare(x[t.sortKey!.name], y[t.sortKey!.name]));
      if (parsed.flags.has("--no-scan-index-forward")) matches.reverse();
      t.queried.add(keyPart(pkValue));
      json(ctx, { Items: matches, Count: matches.length, ScannedCount: matches.length, ConsumedCapacity: null });
      return 0;
    }
    case "update-time-to-live": {
      if (!required("table-name", "time-to-live-specification")) return 252;
      const found = table();
      if (!found) return 254;
      const spec = shorthand(opt("time-to-live-specification")!);
      if (!spec || !spec.AttributeName || !["true", "false"].includes(spec.Enabled)) {
        ctx.err("\nError parsing parameter '--time-to-live-specification': 格式是 Enabled=true,AttributeName=屬性名稱");
        return 252;
      }
      const enable = spec.Enabled === "true";
      if (enable && found[1].ttlAttribute) return validation("TimeToLive is already enabled");
      if (!enable && found[1].ttlAttribute !== spec.AttributeName) return validation("TimeToLive is already disabled");
      found[1].ttlAttribute = enable ? spec.AttributeName : null;
      json(ctx, { TimeToLiveSpecification: { Enabled: enable, AttributeName: spec.AttributeName } });
      return 0;
    }
    case "describe-time-to-live": {
      if (!required("table-name")) return 252;
      const found = table();
      if (!found) return 254;
      const attr = found[1].ttlAttribute;
      json(ctx, { TimeToLiveDescription: attr ? { TimeToLiveStatus: "ENABLED", AttributeName: attr } : { TimeToLiveStatus: "DISABLED" } });
      return 0;
    }
    default:
      return 252;
  }
}
