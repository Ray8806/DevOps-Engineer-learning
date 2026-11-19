import { parseArgs, type Ctx } from "./context";
import { NAME, error, table } from "./gcloud-common";
import type { CloudSqlInstance } from "./state";

const instanceUrl = (project: string, name: string) => `https://sqladmin.googleapis.com/sql/v1beta4/projects/${project}/instances/${name}`;

const VERSIONS = [
  "MYSQL_5_6", "MYSQL_5_7", "MYSQL_8_0", "MYSQL_8_4",
  "POSTGRES_12", "POSTGRES_13", "POSTGRES_14", "POSTGRES_15", "POSTGRES_16", "POSTGRES_17", "POSTGRES_18",
];
/** Versions whose default edition (when --edition is omitted) is Enterprise Plus. */
const PLUS_BY_DEFAULT = ["MYSQL_8_4", "POSTGRES_16", "POSTGRES_17", "POSTGRES_18"];
const REGION = /^[a-z]+-[a-z]+\d+$|^us-central$/;

/** "3840MiB", "8GiB", "4GB", "7680MB" or a bare number of GiB -> MiB. */
function memoryMiB(text: string): number | null {
  const m = /^(\d+)(MiB|MB|GiB|GB)?$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return /^m/i.test(m[2] ?? "") ? n : n * 1024;
}

/** Works out the tier from --tier or --cpu/--memory, checking them against the edition. */
function machineTier(ctx: Ctx, command: string, edition: CloudSqlInstance["edition"], opts: Map<string, string>): string | null {
  const tier = opts.get("--tier") ?? opts.get("-t");
  const cpu = opts.get("--cpu");
  const memory = opts.get("--memory");
  const fail = (message: string) => {
    error(ctx, command, message);
    return null;
  };
  if (edition === "ENTERPRISE_PLUS") {
    if (cpu !== undefined || memory !== undefined) {
      return fail("--cpu and --memory flags are not compatible with the Enterprise Plus edition. 這個版本要用 --tier 指定預先定義的機器類型（例如 db-perf-optimized-N-2），或加上 --edition=enterprise 改用 Enterprise 版本。");
    }
    if (tier === undefined) return fail("Enterprise Plus 版本需要用 --tier 指定機器類型，例如 --tier=db-perf-optimized-N-2。");
    if (!/^db-perf-optimized-N-\d+$|^db-c4a-highmem-\d+$/.test(tier)) return fail(`Invalid Tier (${tier}) for (ENTERPRISE_PLUS) Edition.`);
    return tier;
  }
  if (tier !== undefined) {
    if (cpu !== undefined || memory !== undefined) return fail("--tier 不能和 --cpu、--memory 一起使用。");
    if (!/^db-(f1-micro|g1-small|custom-\d+-\d+)$/.test(tier)) return fail(`Invalid Tier (${tier}) for (ENTERPRISE) Edition.`);
    return tier;
  }
  if (cpu === undefined && memory === undefined) {
    return fail("這個模擬終端機需要指定規格：用 --cpu 和 --memory 指定專用核心的機器（例如 --cpu=2 --memory=8GiB），或用 --tier 指定共用核心的 db-f1-micro、db-g1-small。");
  }
  if (cpu === undefined || memory === undefined) return fail("Both --cpu and --memory must be specified if a custom machine type is desired.");
  const cores = Number(cpu);
  const mib = memoryMiB(memory);
  if (!Number.isInteger(cores) || cores < 1) return fail(`argument --cpu: 請輸入正整數，收到 '${cpu}'。`);
  if (mib === null) return fail(`argument --memory: 無法解讀 '${memory}'，格式像 3840MiB 或 8GiB。`);
  // Dedicated-core machines take 0.9 GB to 6.5 GB per vCPU.
  if (mib / cores < 0.9 * 1024 || mib / cores > 6.5 * 1024) {
    return fail(`Invalid machine type: ${cores} vCPU 搭配 ${mib} MiB。每個 vCPU 要搭配 0.9 GB 到 6.5 GB 的記憶體。`);
  }
  return `db-custom-${cores}-${mib}`;
}

function describe(ctx: Ctx, name: string, i: CloudSqlInstance) {
  ctx.out(
    [
      `backendType: SECOND_GEN`,
      `databaseVersion: ${i.databaseVersion}`,
      `instanceType: ${i.masterInstanceName ? "READ_REPLICA_INSTANCE" : "CLOUD_SQL_INSTANCE"}`,
      ...(i.masterInstanceName ? [`masterInstanceName: ${ctx.state.gcp.project}:${i.masterInstanceName}`] : []),
      `name: ${name}`,
      `region: ${i.region}`,
      `settings:`,
      `  availabilityType: ${i.availabilityType}`,
      `  backupConfiguration:`,
      `    enabled: ${i.backupsEnabled}`,
      `  deletionProtectionEnabled: ${i.deletionProtection}`,
      `  edition: ${i.edition}`,
      `  tier: ${i.tier}`,
      `state: RUNNABLE`,
      "",
    ].join("\n"),
  );
}

function instances(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.sql.instances.${action}`;
  const parsed = parseArgs(rest, {
    options: [
      "--database-version", "--edition", "--tier", "-t", "--cpu", "--memory", "--region", "--availability-type",
      "--master-instance-name", "--root-password", "--backup-start-time", "--storage-size", "--network", "--project", "--format",
    ],
    flags: [
      "--backup", "--no-backup", "--deletion-protection", "--no-deletion-protection", "--enable-point-in-time-recovery",
      "--assign-ip", "--no-assign-ip", "--quiet", "-q", "--async",
    ],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;
  const all = gcp.sql.instances;
  const opt = (name: string) => parsed.options.get(name);
  const row = (n: string, i: CloudSqlInstance) => [n, i.databaseVersion, i.region, i.tier, "RUNNABLE"];

  if (action === "list") {
    table(ctx, ["NAME", "DATABASE_VERSION", "LOCATION", "TIER", "STATUS"], [...all].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, i]) => row(n, i)));
    return 0;
  }
  if (!["create", "describe", "patch", "delete", "promote-replica"].includes(action ?? "")) {
    return error(ctx, "gcloud.sql.instances", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、patch、delete、promote-replica。`);
  }
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument INSTANCE: Must be specified.");
  const availability = opt("--availability-type")?.toUpperCase();
  if (availability !== undefined && availability !== "ZONAL" && availability !== "REGIONAL") {
    return error(ctx, command, `argument --availability-type: Invalid choice: '${opt("--availability-type")}'. 請使用 zonal 或 regional。`);
  }

  if (action === "promote-replica") {
    const replica = all.get(name);
    if (!replica) return error(ctx, command, `HTTPError 404: The Cloud SQL instance does not exist. (${name})`);
    if (!replica.masterInstanceName) return error(ctx, command, `HTTPError 400: The instance ${name} is not a read replica.（只有唯讀複本可以升格）`);
    // The promoted replica becomes a standalone primary; it keeps its settings (backups stay off until enabled).
    replica.masterInstanceName = null;
    ctx.out(`Promoting a Cloud SQL read replica...done.\nPromoted [${instanceUrl(gcp.project, name)}].\n`);
    return 0;
  }

  if (action === "create") {
    if (!NAME.test(name)) return error(ctx, command, `Invalid instance name '${name}'. 名稱只能包含小寫字母、數字和連字號，並以小寫字母開頭。`);
    if (all.has(name)) return error(ctx, command, "HTTPError 409: The Cloud SQL instance already exists.");
    const masterName = opt("--master-instance-name");
    if (masterName !== undefined) {
      // A read replica copies its primary's engine, edition and machine.
      const master = all.get(masterName);
      if (!master) return error(ctx, command, `HTTPError 404: The Cloud SQL instance does not exist. (${masterName})`);
      const replica: CloudSqlInstance = {
        ...master,
        region: opt("--region") ?? master.region,
        availabilityType: availability ?? "ZONAL",
        backupsEnabled: false,
        deletionProtection: parsed.flags.has("--deletion-protection"),
        masterInstanceName: masterName,
        databases: new Set(master.databases),
        users: new Set(master.users),
        backups: [],
      };
      all.set(name, replica);
      ctx.out(`Creating Cloud SQL instance for ${replica.databaseVersion}...done.\nCreated [${instanceUrl(gcp.project, name)}].\n`);
      table(ctx, ["NAME", "DATABASE_VERSION", "LOCATION", "TIER", "STATUS"], [row(name, replica)]);
      return 0;
    }
    // Without --database-version, gcloud uses MYSQL_8_0.
    const version = (opt("--database-version") ?? "MYSQL_8_0").toUpperCase();
    if (!VERSIONS.includes(version)) {
      return error(ctx, command, `argument --database-version: Invalid choice: '${opt("--database-version")}'. 這個模擬終端機支援：${VERSIONS.join(", ")}。`);
    }
    const editionArg = opt("--edition")?.toLowerCase();
    if (editionArg !== undefined && editionArg !== "enterprise" && editionArg !== "enterprise-plus") {
      return error(ctx, command, `argument --edition: Invalid choice: '${opt("--edition")}'. 請使用 enterprise 或 enterprise-plus。`);
    }
    const edition = editionArg === undefined ? (PLUS_BY_DEFAULT.includes(version) ? "ENTERPRISE_PLUS" : "ENTERPRISE") : editionArg === "enterprise" ? "ENTERPRISE" : "ENTERPRISE_PLUS";
    const tier = machineTier(ctx, command, edition, parsed.options);
    if (!tier) return 1;
    const region = opt("--region") ?? "us-central";
    if (!REGION.test(region)) return error(ctx, command, `Invalid value for field 'region': '${region}'. 區域的格式像 asia-east1。`);
    const backupsEnabled = !parsed.flags.has("--no-backup");
    if (availability === "REGIONAL" && !backupsEnabled) {
      return error(ctx, command, "高可用（REGIONAL）執行個體必須啟用自動備份，請拿掉 --no-backup。");
    }
    const instance: CloudSqlInstance = {
      databaseVersion: version,
      edition,
      tier,
      region,
      availabilityType: availability ?? "ZONAL",
      backupsEnabled,
      deletionProtection: parsed.flags.has("--deletion-protection"),
      masterInstanceName: null,
      databases: new Set(version.startsWith("POSTGRES") ? ["postgres"] : ["information_schema", "mysql", "performance_schema", "sys"]),
      users: new Set([version.startsWith("POSTGRES") ? "postgres" : "root"]),
      backups: [],
    };
    all.set(name, instance);
    ctx.out(`Creating Cloud SQL instance for ${version}...done.\nCreated [${instanceUrl(gcp.project, name)}].\n`);
    table(ctx, ["NAME", "DATABASE_VERSION", "LOCATION", "TIER", "STATUS"], [row(name, instance)]);
    return 0;
  }

  const instance = all.get(name);
  if (!instance) return error(ctx, command, `HTTPError 404: The Cloud SQL instance does not exist. (${name})`);

  if (action === "describe") {
    describe(ctx, name, instance);
    return 0;
  }

  if (action === "patch") {
    if (parsed.flags.has("--no-backup") && instance.availabilityType === "REGIONAL" && availability !== "ZONAL") {
      return error(ctx, command, "高可用（REGIONAL）執行個體必須啟用自動備份，不能停用。");
    }
    const backupsEnabled = parsed.flags.has("--no-backup") ? false : parsed.flags.has("--backup") || opt("--backup-start-time") !== undefined ? true : instance.backupsEnabled;
    if (availability === "REGIONAL" && !instance.masterInstanceName && !backupsEnabled) {
      return error(ctx, command, "高可用（REGIONAL）需要先啟用自動備份與時間點復原。可以加上 --backup-start-time=HH:MM 啟用自動備份。");
    }
    if (instance.masterInstanceName && (parsed.flags.has("--backup") || opt("--backup-start-time") !== undefined)) {
      return error(ctx, command, "Backups cannot be enabled on replica instances.");
    }
    instance.backupsEnabled = backupsEnabled;
    if (availability !== undefined) instance.availabilityType = availability;
    if (parsed.flags.has("--deletion-protection")) instance.deletionProtection = true;
    if (parsed.flags.has("--no-deletion-protection")) instance.deletionProtection = false;
    if (opt("--tier") !== undefined || opt("--cpu") !== undefined || opt("--memory") !== undefined) {
      const tier = machineTier(ctx, command, instance.edition, parsed.options);
      if (!tier) return 1;
      instance.tier = tier;
    }
    ctx.out(`Patching Cloud SQL instance...done.\nUpdated [${instanceUrl(gcp.project, name)}].\n`);
    return 0;
  }

  // delete
  if (instance.deletionProtection) {
    return error(ctx, command, "HTTPError 400: Invalid request: The instance is protected from deletion. 請先執行 gcloud sql instances patch 加上 --no-deletion-protection。");
  }
  const replicas = [...all].filter(([, i]) => i.masterInstanceName === name).map(([n]) => n);
  if (replicas.length) {
    return error(ctx, command, `HTTPError 400: The instance has read replicas: ${replicas.join(", ")}. 要刪除主要執行個體，必須先刪除它的所有唯讀備用資源。`);
  }
  all.delete(name);
  ctx.out(`Deleting Cloud SQL instance...done.\nDeleted [${instanceUrl(gcp.project, name)}].\n`);
  return 0;
}

/** `gcloud sql databases …` and `gcloud sql users …`: named things inside an instance. */
function members(ctx: Ctx, kind: "databases" | "users", args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.sql.${kind}.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--instance", "-i", "--password", "--host", "--charset", "--collation", "--type", "--project", "--format"],
    flags: ["--quiet", "-q", "--async"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  if (!["create", "list", "delete"].includes(action ?? "")) {
    return error(ctx, `gcloud.sql.${kind}`, `不支援的指令 '${action ?? ""}'。支援 create、list、delete。`);
  }
  const instanceName = parsed.options.get("--instance") ?? parsed.options.get("-i");
  if (instanceName === undefined) return error(ctx, command, "argument --instance/-i: Must be specified.");
  const instance = ctx.state.gcp.sql.instances.get(instanceName);
  if (!instance) return error(ctx, command, `HTTPError 404: The Cloud SQL instance does not exist. (${instanceName})`);
  const names = instance[kind];
  const label = kind === "databases" ? "database" : "user";

  if (action === "list") {
    const sorted = [...names].sort();
    if (kind === "databases") table(ctx, ["NAME", "CHARSET", "COLLATION"], sorted.map((n) => [n, "UTF8", "en_US.UTF8"]));
    else table(ctx, ["NAME", "HOST", "TYPE"], sorted.map((n) => [n, instance.databaseVersion.startsWith("MYSQL") ? "%" : "", "BUILT_IN"]));
    return 0;
  }
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, `argument ${kind === "databases" ? "DATABASE" : "USERNAME"}: Must be specified.`);
  if (instance.masterInstanceName) {
    return error(ctx, command, `${instanceName} 是唯讀備用資源（read replica），不能直接修改。請在主要執行個體 ${instance.masterInstanceName} 上操作，變更會複製過來。`);
  }
  if (action === "create") {
    if (!/^[A-Za-z_][A-Za-z0-9_$-]*$/.test(name)) return error(ctx, command, `Invalid ${label} name '${name}'.`);
    if (names.has(name)) return error(ctx, command, `HTTPError 409: The ${label} '${name}' already exists.`);
    names.add(name);
    // Replicas copy everything from their primary.
    for (const replica of ctx.state.gcp.sql.instances.values()) if (replica.masterInstanceName === instanceName) replica[kind].add(name);
    if (kind === "databases") ctx.out(`Creating Cloud SQL database...done.\nCreated database [${name}].\ninstance: ${instanceName}\nname: ${name}\nproject: ${ctx.state.gcp.project}\n`);
    else ctx.out(`Creating Cloud SQL user...done.\nCreated user [${name}].\n`);
    return 0;
  }
  if (!names.delete(name)) return error(ctx, command, `HTTPError 404: The ${label} '${name}' does not exist.`);
  for (const replica of ctx.state.gcp.sql.instances.values()) if (replica.masterInstanceName === instanceName) replica[kind].delete(name);
  ctx.out(`Deleting Cloud SQL ${label}...done.\n`);
  return 0;
}

function backups(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.sql.backups.${action}`;
  const parsed = parseArgs(rest, { options: ["--instance", "-i", "--description", "--project", "--format"], flags: ["--async", "--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  if (action !== "create" && action !== "list") return error(ctx, "gcloud.sql.backups", `不支援的指令 '${action ?? ""}'。支援 create、list。`);
  const instanceName = parsed.options.get("--instance") ?? parsed.options.get("-i");
  if (instanceName === undefined) return error(ctx, command, "argument --instance/-i: Must be specified.");
  const sql = ctx.state.gcp.sql;
  const instance = sql.instances.get(instanceName);
  if (!instance) return error(ctx, command, `HTTPError 404: The Cloud SQL instance does not exist. (${instanceName})`);
  if (action === "list") {
    table(ctx, ["ID", "STATUS", "TYPE"], instance.backups.map((id) => [id, "SUCCESSFUL", "ON_DEMAND"]));
    return 0;
  }
  if (instance.masterInstanceName) return error(ctx, command, "Backups cannot be enabled on replica instances. 請對主要執行個體建立備份。");
  const id = String(1763251200000 + ++sql.backupsCreated);
  instance.backups.push(id);
  ctx.out(`Backing up Cloud SQL instance...done.\n[${instanceName}] backed up. Backup ID: ${id}\n`);
  return 0;
}

export function sql(ctx: Ctx, args: string[]): number {
  switch (args[0]) {
    case "instances":
      return instances(ctx, args.slice(1));
    case "databases":
    case "users":
      return members(ctx, args[0], args.slice(1));
    case "backups":
      return backups(ctx, args.slice(1));
    default:
      return error(ctx, "gcloud.sql", `不支援 '${args[0] ?? ""}'。這個模擬終端機支援 gcloud sql instances、databases、users、backups。`);
  }
}
