import { parseArgs, type Ctx } from "./context";
import { error, table } from "./gcloud-common";
import { parseLocation } from "./object-store";
import type { FirestoreDatabase } from "./state";

const DEFAULT_DB = "(default)";
/** Regional locations look like asia-east1; multi-region ones are nam5, nam7 and eur3. */
const LOCATION = /^[a-z]+-[a-z]+\d+$|^(nam5|nam7|eur3)$/;
const DATABASE_ID = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** Pulls out every value of a repeatable option such as --field-config, leaving the other arguments. */
function takeRepeated(args: string[], name: string): { values: string[]; rest: string[] } {
  const values: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] !== undefined) values.push(args[++i]);
    else if (args[i].startsWith(`${name}=`)) values.push(args[i].slice(name.length + 1));
    else rest.push(args[i]);
  }
  return { values, rest };
}

function database(ctx: Ctx, command: string, id: string): FirestoreDatabase | null {
  const db = ctx.state.gcp.firestore.databases.get(id);
  if (!db) {
    error(ctx, command, `NOT_FOUND: The database ${id} does not exist for project ${ctx.state.gcp.project}. 請先用 gcloud firestore databases create --location=… 建立資料庫。`);
    return null;
  }
  return db;
}

function describe(ctx: Ctx, id: string, db: FirestoreDatabase) {
  ctx.out(
    [
      `databaseEdition: ${db.edition.toUpperCase()}`,
      `deleteProtectionState: ${db.deleteProtection ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"}`,
      `locationId: ${db.location}`,
      `name: projects/${ctx.state.gcp.project}/databases/${id}`,
      `type: ${db.type === "firestore-native" ? "FIRESTORE_NATIVE" : "DATASTORE_MODE"}`,
      "",
    ].join("\n"),
  );
}

function databases(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.firestore.databases.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--location", "--database", "--type", "--edition", "--project", "--format"],
    flags: ["--delete-protection", "--no-delete-protection", "--enable-pitr", "--quiet", "-q", "--async"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const all = ctx.state.gcp.firestore.databases;
  const id = parsed.options.get("--database") ?? DEFAULT_DB;
  switch (action) {
    case "list":
      table(ctx, ["NAME", "LOCATION", "TYPE"], [...all].map(([n, d]) => [n, d.location, d.type === "firestore-native" ? "FIRESTORE_NATIVE" : "DATASTORE_MODE"]));
      return 0;
    case "create": {
      const location = parsed.options.get("--location");
      if (location === undefined) return error(ctx, command, "argument --location: Must be specified.");
      if (!LOCATION.test(location)) return error(ctx, command, `INVALID_ARGUMENT: Invalid locationId: ${location}. 單一區域像 asia-east1，多區域是 nam5、nam7 或 eur3。`);
      if (id !== DEFAULT_DB && !DATABASE_ID.test(id)) {
        return error(ctx, command, `INVALID_ARGUMENT: Database ID '${id}' is not valid. 要 4 到 63 個字元，只能用小寫字母、數字和連字號，以字母開頭、字母或數字結尾。`);
      }
      if (all.has(id)) return error(ctx, command, `ALREADY_EXISTS: Database '${id}' already exists. 資料庫建立後不能更改位置。`);
      const type = parsed.options.get("--type") ?? "firestore-native";
      if (type !== "firestore-native" && type !== "datastore-mode") return error(ctx, command, `argument --type: Invalid choice: '${type}'. 請使用 firestore-native 或 datastore-mode。`);
      const edition = parsed.options.get("--edition") ?? "standard";
      if (edition !== "standard" && edition !== "enterprise") return error(ctx, command, `argument --edition: Invalid choice: '${edition}'. 請使用 standard 或 enterprise。`);
      const db: FirestoreDatabase = { location, type, edition, deleteProtection: parsed.flags.has("--delete-protection"), indexes: new Set(), ttlFields: new Set(), exports: 0 };
      all.set(id, db);
      ctx.out(`Created database [${id}].\n`);
      describe(ctx, id, db);
      return 0;
    }
    case "describe": {
      const db = database(ctx, command, id);
      if (!db) return 1;
      describe(ctx, id, db);
      return 0;
    }
    case "update": {
      if (parsed.options.has("--location")) return error(ctx, command, "unrecognized arguments: --location（資料庫建立後不能更改位置）");
      const db = database(ctx, command, id);
      if (!db) return 1;
      if (parsed.flags.has("--delete-protection")) db.deleteProtection = true;
      if (parsed.flags.has("--no-delete-protection")) db.deleteProtection = false;
      ctx.out(`Updated database [${id}].\n`);
      describe(ctx, id, db);
      return 0;
    }
    case "delete": {
      if (!parsed.options.has("--database")) return error(ctx, command, "argument --database: Must be specified.");
      const db = database(ctx, command, id);
      if (!db) return 1;
      if (db.deleteProtection) {
        return error(ctx, command, `FAILED_PRECONDITION: Delete protection is enabled for database '${id}'. 請先執行 gcloud firestore databases update --database='${id}' --no-delete-protection。`);
      }
      all.delete(id);
      ctx.out(`Deleted database [${id}].\n`);
      return 0;
    }
    default:
      return error(ctx, "gcloud.firestore.databases", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、update、delete。`);
  }
}

function indexes(ctx: Ctx, args: string[]): number {
  if (args[0] !== "composite") return error(ctx, "gcloud.firestore.indexes", `不支援 '${args[0] ?? ""}'。這個模擬終端機支援 gcloud firestore indexes composite create | list。`);
  const [action, ...raw] = args.slice(1);
  const command = `gcloud.firestore.indexes.composite.${action}`;
  const { values: fieldConfigs, rest } = takeRepeated(raw, "--field-config");
  const parsed = parseArgs(rest, { options: ["--collection-group", "--database", "--query-scope", "--project", "--format"], flags: ["--async", "--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const id = parsed.options.get("--database") ?? DEFAULT_DB;
  const db = database(ctx, command, id);
  if (!db) return 1;
  if (action === "list") {
    table(ctx, ["INDEX"], [...db.indexes].sort().map((i) => [i]));
    return 0;
  }
  if (action !== "create") return error(ctx, "gcloud.firestore.indexes.composite", `不支援的指令 '${action ?? ""}'。支援 create、list。`);
  const group = parsed.options.get("--collection-group");
  if (group === undefined) return error(ctx, command, "argument --collection-group: Must be specified.");
  if (fieldConfigs.length === 0) return error(ctx, command, "argument --field-config: Must be specified.（例如 --field-config=field-path=customerId,order=ascending）");
  const fields: string[] = [];
  for (const config of fieldConfigs) {
    const props = Object.fromEntries(config.split(",").map((p) => p.split("=").map((s) => s.trim())));
    const path = props["field-path"];
    if (!path || !FIELD.test(path)) return error(ctx, command, `argument --field-config: 需要 field-path，收到 '${config}'。`);
    const order = props.order?.toLowerCase();
    const array = props["array-config"]?.toLowerCase();
    if ((order === undefined) === (array === undefined)) return error(ctx, command, "argument --field-config: Exactly one of 'order', 'array-config', or 'vector-config' must be specified.");
    if (order !== undefined && order !== "ascending" && order !== "descending") return error(ctx, command, `argument --field-config: order 只能是 ascending 或 descending，收到 '${props.order}'。`);
    if (array !== undefined && array !== "contains") return error(ctx, command, "argument --field-config: The only valid option for array-config is 'contains'.");
    fields.push(`${path} ${order ? order.toUpperCase() : "CONTAINS"}`);
  }
  if (fields.length < 2) {
    return error(ctx, command, "INVALID_ARGUMENT: this index is not necessary, configure using single field index controls（只有一個欄位的查詢會使用自動建立的索引，手動索引至少要兩個欄位）");
  }
  const spec = `${group}(${fields.join(", ")})`;
  if (db.indexes.has(spec)) return error(ctx, command, "ALREADY_EXISTS: index already exists");
  db.indexes.add(spec);
  ctx.out(`Create request issued for index [${spec}].\nCreated index [${spec}].\n`);
  return 0;
}

function fields(ctx: Ctx, args: string[]): number {
  if (args[0] !== "ttls") return error(ctx, "gcloud.firestore.fields", `不支援 '${args[0] ?? ""}'。這個模擬終端機支援 gcloud firestore fields ttls update | list。`);
  const [action, ...rest] = args.slice(1);
  const command = `gcloud.firestore.fields.ttls.${action}`;
  const parsed = parseArgs(rest, { options: ["--collection-group", "--database", "--expiration-offset", "--project", "--format"], flags: ["--enable-ttl", "--disable-ttl", "--async"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const id = parsed.options.get("--database") ?? DEFAULT_DB;
  const db = database(ctx, command, id);
  if (!db) return 1;
  if (action === "list") {
    const group = parsed.options.get("--collection-group");
    table(
      ctx,
      ["COLLECTION_GROUP", "FIELD", "TTL_STATE"],
      [...db.ttlFields].sort().filter((f) => group === undefined || f.startsWith(`${group}.`)).map((f) => [f.slice(0, f.indexOf(".")), f.slice(f.indexOf(".") + 1), "ACTIVE"]),
    );
    return 0;
  }
  if (action !== "update") return error(ctx, "gcloud.firestore.fields.ttls", `不支援的指令 '${action ?? ""}'。支援 update、list。`);
  const field = parsed.positional[0];
  if (!field) return error(ctx, command, "argument FIELD: Must be specified.");
  if (!FIELD.test(field)) return error(ctx, command, `Invalid field path '${field}'.`);
  const group = parsed.options.get("--collection-group");
  if (group === undefined) return error(ctx, command, "argument --collection-group: Must be specified.");
  const enable = parsed.flags.has("--enable-ttl");
  if (enable === parsed.flags.has("--disable-ttl")) return error(ctx, command, "Exactly one of (--disable-ttl | --enable-ttl) must be specified.");
  const key = `${group}.${field}`;
  if (enable) db.ttlFields.add(key);
  else db.ttlFields.delete(key);
  ctx.out(`Updated field [${field}] in collection group [${group}]: TTL ${enable ? "enabled" : "disabled"}.\n`);
  return 0;
}

function exportData(ctx: Ctx, args: string[]): number {
  const command = "gcloud.firestore.export";
  const parsed = parseArgs(args, { options: ["--database", "--collection-ids", "--project", "--format"], flags: ["--async"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const uri = parsed.positional[0];
  if (!uri) return error(ctx, command, "argument OUTPUT_URI_PREFIX: Must be specified.（例如 gs://my-bucket）");
  const loc = parseLocation(uri, "gs");
  if (loc.kind !== "remote" || loc.bucket === "") return error(ctx, command, `INVALID_ARGUMENT: Invalid output URI '${uri}'. 匯出的位置要是 gs:// 開頭的 Cloud Storage 路徑。`);
  const bucket = ctx.state.gcs.get(loc.bucket);
  if (!bucket) return error(ctx, command, `NOT_FOUND: Bucket ${loc.bucket} does not exist. 請先建立 Cloud Storage bucket。`);
  const id = parsed.options.get("--database") ?? DEFAULT_DB;
  const db = database(ctx, command, id);
  if (!db) return 1;
  db.exports++;
  // Without a folder in the URI, each export goes into its own timestamped folder.
  const stamp = `2026-11-16T00:00:00_${String(db.exports).padStart(5, "0")}`;
  const folder = `${loc.key ? `${loc.key.replace(/\/+$/, "")}/` : ""}${stamp}`;
  bucket.objects.set(`${folder}/${stamp}.overall_export_metadata`, "（模擬的 Firestore 匯出中繼資料）\n");
  ctx.out(
    `Waiting for [projects/${ctx.state.gcp.project}/databases/${id}/operations/export-${db.exports}] to finish...done.\nmetadata:\n  '@type': type.googleapis.com/google.firestore.admin.v1.ExportDocumentsMetadata\n  operationState: SUCCESSFUL\n  outputUriPrefix: gs://${loc.bucket}/${folder}\n`,
  );
  return 0;
}

export function firestore(ctx: Ctx, args: string[]): number {
  switch (args[0]) {
    case "databases":
      return databases(ctx, args.slice(1));
    case "indexes":
      return indexes(ctx, args.slice(1));
    case "fields":
      return fields(ctx, args.slice(1));
    case "export":
      return exportData(ctx, args.slice(1));
    default:
      return error(ctx, "gcloud.firestore", `不支援 '${args[0] ?? ""}'。這個模擬終端機支援 gcloud firestore databases、indexes composite、fields ttls、export。`);
  }
}
