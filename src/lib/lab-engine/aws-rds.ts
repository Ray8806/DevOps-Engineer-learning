import { parseArgs, type Ctx } from "./context";
import type { RdsInstance } from "./state";

export const RDS_COMMANDS = [
  "create-db-subnet-group", "describe-db-subnet-groups", "delete-db-subnet-group",
  "create-db-instance", "describe-db-instances", "modify-db-instance", "delete-db-instance",
  "create-db-instance-read-replica", "create-db-snapshot", "describe-db-snapshots",
];

const ENGINES: Record<string, { port: number; maxPassword: number }> = {
  mysql: { port: 3306, maxPassword: 41 },
  mariadb: { port: 3306, maxPassword: 41 },
  postgres: { port: 5432, maxPassword: 128 },
};
/** 1–63 letters, digits or hyphens; starts with a letter; no trailing or double hyphen. */
const IDENTIFIER = /^[a-z](?!.*--)[a-z0-9-]{0,62}$/;
const IDENTIFIER_RULE = "識別碼必須以字母開頭，只能包含字母、數字和連字號（1 到 63 個字元），不能以連字號結尾或有連續兩個連字號。";
const MAX_REPLICAS = 15;

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

export function rds(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !RDS_COMMANDS.includes(sub)) {
    const supported = RDS_COMMANDS.join("、");
    if (sub === "create-db-cluster") ctx.err("aws: Aurora 叢集（create-db-cluster）不在這個模擬終端機的範圍內，請參考課文的說明。");
    else ctx.err(sub ? `aws: 不支援的 rds 指令 '${sub}'。支援：${supported}` : `usage: aws rds <command> [parameters]\n支援：${supported}`);
    return 252;
  }
  const parsed = parseArgs(rest, {
    options: [
      "--db-instance-identifier", "--db-instance-class", "--engine", "--engine-version", "--allocated-storage", "--storage-type",
      "--master-username", "--master-user-password", "--db-subnet-group-name", "--db-subnet-group-description", "--subnet-ids",
      "--vpc-security-group-ids", "--backup-retention-period", "--source-db-instance-identifier", "--db-snapshot-identifier",
      "--final-db-snapshot-identifier", "--availability-zone", "--region", "--output",
    ],
    flags: [
      "--manage-master-user-password", "--no-manage-master-user-password", "--multi-az", "--no-multi-az",
      "--publicly-accessible", "--no-publicly-accessible", "--deletion-protection", "--no-deletion-protection",
      "--apply-immediately", "--no-apply-immediately", "--skip-final-snapshot", "--no-skip-final-snapshot",
      "--delete-automated-backups", "--no-delete-automated-backups",
    ],
  });
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const { rds: db, vpc } = ctx.state.aws;
  const operation = sub.split("-").map((w) => (w === "db" ? "DB" : w.charAt(0).toUpperCase() + w.slice(1))).join("");
  const opt = (name: string) => parsed.options.get(`--${name}`);
  const flag = (name: string) => parsed.flags.has(`--${name}`);
  const list = (name: string) => (parsed.options.has(`--${name}`) ? [opt(name)!, ...parsed.positional] : []);
  function required(...names: string[]): boolean {
    const missing = names.filter((n) => !parsed.options.has(`--${n}`));
    if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
    return missing.length === 0;
  }
  const noInstance = (id: string) => fail(ctx, "DBInstanceNotFound", operation, `DBInstance ${id} not found.`);
  const replicasOf = (id: string) => [...db.instances].filter(([, i]) => i.readReplicaSource === id).map(([r]) => r);

  const groupJson = (name: string) => {
    const g = db.subnetGroups.get(name)!;
    return {
      DBSubnetGroupName: name,
      DBSubnetGroupDescription: g.description,
      VpcId: vpc.subnets.get(g.subnetIds[0])?.vpcId ?? null,
      SubnetGroupStatus: "Complete",
      Subnets: g.subnetIds.map((id) => ({ SubnetIdentifier: id, SubnetAvailabilityZone: { Name: vpc.subnets.get(id)?.availabilityZone ?? "?" }, SubnetStatus: "Active" })),
    };
  };
  const instanceJson = (id: string, status: string) => {
    const i = db.instances.get(id)!;
    return {
      DBInstanceIdentifier: id,
      DBInstanceClass: i.instanceClass,
      Engine: i.engine,
      DBInstanceStatus: status,
      MasterUsername: i.masterUsername,
      ...(status === "available" ? { Endpoint: { Address: `${id}.c0example1abc.us-east-1.rds.amazonaws.com`, Port: ENGINES[i.engine].port } } : {}),
      AllocatedStorage: i.allocatedStorage,
      BackupRetentionPeriod: i.backupRetentionPeriod,
      DBSubnetGroup: i.subnetGroup ? groupJson(i.subnetGroup) : { DBSubnetGroupName: "default" },
      PendingModifiedValues: i.pendingMultiAZ === null ? {} : { MultiAZ: i.pendingMultiAZ },
      MultiAZ: i.multiAZ,
      ...(i.readReplicaSource ? { ReadReplicaSourceDBInstanceIdentifier: i.readReplicaSource } : {}),
      ReadReplicaDBInstanceIdentifiers: replicasOf(id),
      PubliclyAccessible: i.publiclyAccessible,
      DeletionProtection: i.deletionProtection,
      ...(i.managedPassword
        ? { MasterUserSecret: { SecretArn: `arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-${id}`, SecretStatus: status === "creating" ? "creating" : "active" } }
        : {}),
    };
  };

  switch (sub) {
    // ------------------------------------------------------- subnet groups
    case "create-db-subnet-group": {
      if (!required("db-subnet-group-name", "db-subnet-group-description", "subnet-ids")) return 252;
      const name = opt("db-subnet-group-name")!.toLowerCase();
      if (!/^[a-z][a-z0-9._ -]{0,254}$/.test(name) || name === "default") {
        return fail(ctx, "InvalidParameterValue", operation, "名稱必須以字母開頭，只能包含字母、數字、句點、底線、空格和連字號，而且不能是 default。");
      }
      if (db.subnetGroups.has(name)) return fail(ctx, "DBSubnetGroupAlreadyExists", operation, `The DB subnet group '${name}' already exists.`);
      const ids = [...new Set(list("subnet-ids"))];
      const missing = ids.filter((id) => !vpc.subnets.has(id));
      if (missing.length) return fail(ctx, "InvalidSubnet", operation, `Some input subnets in :[${missing.join(", ")}] are invalid. 可以用 aws ec2 describe-subnets 查詢子網路 ID。`);
      if (new Set(ids.map((id) => vpc.subnets.get(id)!.vpcId)).size > 1) {
        return fail(ctx, "InvalidParameterValue", operation, "Subnets in a DB subnet group must be in the same VPC.");
      }
      const zones = [...new Set(ids.map((id) => vpc.subnets.get(id)!.availabilityZone))];
      if (zones.length < 2) {
        return fail(ctx, "DBSubnetGroupDoesNotCoverEnoughAZs", operation, `The DB subnet group doesn't meet Availability Zone (AZ) coverage requirement. Current AZ coverage: ${zones.join(", ")}. Add subnets to cover at least 2 AZs.`);
      }
      db.subnetGroups.set(name, { description: opt("db-subnet-group-description")!, subnetIds: ids });
      json(ctx, { DBSubnetGroup: groupJson(name) });
      return 0;
    }
    case "describe-db-subnet-groups": {
      const name = opt("db-subnet-group-name")?.toLowerCase();
      if (name !== undefined && !db.subnetGroups.has(name)) return fail(ctx, "DBSubnetGroupNotFoundFault", operation, `DBSubnetGroup '${name}' not found.`);
      json(ctx, { DBSubnetGroups: [...db.subnetGroups.keys()].filter((n) => name === undefined || n === name).map(groupJson) });
      return 0;
    }
    case "delete-db-subnet-group": {
      if (!required("db-subnet-group-name")) return 252;
      const name = opt("db-subnet-group-name")!.toLowerCase();
      if (!db.subnetGroups.has(name)) return fail(ctx, "DBSubnetGroupNotFoundFault", operation, `DBSubnetGroup '${name}' not found.`);
      const user = [...db.instances].find(([, i]) => i.subnetGroup === name);
      if (user) return fail(ctx, "InvalidDBSubnetGroupStateFault", operation, `Cannot delete the subnet group '${name}' because at least one database instance: ${user[0]} is still using it.`);
      db.subnetGroups.delete(name);
      return 0;
    }

    // ----------------------------------------------------------- instances
    case "create-db-instance": {
      if (!required("db-instance-identifier", "db-instance-class", "engine")) return 252;
      const id = opt("db-instance-identifier")!.toLowerCase();
      if (!IDENTIFIER.test(id) || id.endsWith("-")) return fail(ctx, "InvalidParameterValue", operation, `Invalid DB instance identifier: ${id}. ${IDENTIFIER_RULE}`);
      if (db.instances.has(id)) return fail(ctx, "DBInstanceAlreadyExists", operation, "DB instance already exists");
      const engine = opt("engine")!.toLowerCase();
      if (engine.startsWith("aurora")) {
        return fail(ctx, "InvalidParameterCombination", operation, "Aurora 的資料庫執行個體要放在 DB 叢集裡（先用 create-db-cluster 建立叢集），這個模擬終端機不支援 Aurora 叢集。請改用 mysql、mariadb 或 postgres。");
      }
      if (!ENGINES[engine]) return fail(ctx, "InvalidParameterValue", operation, `這個模擬終端機支援的引擎：${Object.keys(ENGINES).join("、")}，收到 '${engine}'。`);
      const instanceClass = opt("db-instance-class")!;
      if (!/^db\.[a-z0-9]+\.[a-z0-9]+$/.test(instanceClass)) return fail(ctx, "InvalidParameterValue", operation, `Invalid DB Instance class: ${instanceClass}. 格式像 db.t3.micro。`);
      if (!required("allocated-storage", "master-username")) return 252;
      const storage = Number(opt("allocated-storage"));
      if (!Number.isInteger(storage) || storage < 20 || storage > 65536) {
        return fail(ctx, "InvalidParameterValue", operation, "Invalid storage size. 一般用途 SSD（gp2、gp3）的儲存空間要介於 20 到 65536 GiB。");
      }
      const username = opt("master-username")!;
      if (!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(username)) {
        return fail(ctx, "InvalidParameterValue", operation, "MasterUsername 必須以字母開頭，只能包含字母、數字和底線，最多 16 個字元。");
      }
      const password = opt("master-user-password");
      const managed = flag("manage-master-user-password");
      if (password !== undefined && managed) {
        return fail(ctx, "InvalidParameterCombination", operation, "Can't specify MasterUserPassword when ManageMasterUserPassword is enabled.");
      }
      if (password === undefined && !managed) {
        return fail(ctx, "InvalidParameterValue", operation, "請用 --master-user-password 設定密碼，或加上 --manage-master-user-password 讓 Secrets Manager 產生並保管密碼（建議）。");
      }
      if (password !== undefined && (password.length < 8 || password.length > ENGINES[engine].maxPassword || /[/"@]/.test(password))) {
        return fail(ctx, "InvalidParameterValue", operation, `The parameter MasterUserPassword is not a valid password. ${engine} 的密碼要 8 到 ${ENGINES[engine].maxPassword} 個字元，不能包含 /、" 或 @。`);
      }
      const groupName = opt("db-subnet-group-name")?.toLowerCase() ?? null;
      if (groupName !== null && !db.subnetGroups.has(groupName)) return fail(ctx, "DBSubnetGroupNotFoundFault", operation, `DBSubnetGroup '${groupName}' not found.`);
      // Defaults: public only when no subnet group is given.
      const publiclyAccessible = flag("publicly-accessible") ? true : flag("no-publicly-accessible") ? false : groupName === null;
      if (publiclyAccessible && groupName !== null) {
        const vpcId = vpc.subnets.get(db.subnetGroups.get(groupName)!.subnetIds[0])?.vpcId;
        if (![...vpc.internetGateways.values()].some((g) => g.vpcId === vpcId)) {
          return fail(ctx, "InvalidVPCNetworkStateFault", operation, `Cannot create a publicly accessible DBInstance. The specified VPC ${vpcId} has no internet gateway attached.`);
        }
      }
      const retention = opt("backup-retention-period") === undefined ? 1 : Number(opt("backup-retention-period"));
      if (!Number.isInteger(retention) || retention < 0 || retention > 35) return fail(ctx, "InvalidParameterValue", operation, "BackupRetentionPeriod 必須介於 0 到 35 天。");
      const instance: RdsInstance = {
        engine,
        instanceClass,
        allocatedStorage: storage,
        masterUsername: username,
        managedPassword: managed,
        subnetGroup: groupName,
        multiAZ: flag("multi-az"),
        pendingMultiAZ: null,
        publiclyAccessible,
        backupRetentionPeriod: retention,
        deletionProtection: flag("deletion-protection"),
        readReplicaSource: null,
      };
      db.instances.set(id, instance);
      json(ctx, { DBInstance: instanceJson(id, "creating") });
      return 0;
    }
    case "describe-db-instances": {
      const id = opt("db-instance-identifier")?.toLowerCase();
      if (id !== undefined && !db.instances.has(id)) return noInstance(id);
      json(ctx, { DBInstances: [...db.instances.keys()].filter((i) => id === undefined || i === id).map((i) => instanceJson(i, "available")) });
      return 0;
    }
    case "modify-db-instance": {
      if (!required("db-instance-identifier")) return 252;
      const id = opt("db-instance-identifier")!.toLowerCase();
      const instance = db.instances.get(id);
      if (!instance) return noInstance(id);
      if (opt("backup-retention-period") !== undefined) {
        const retention = Number(opt("backup-retention-period"));
        if (!Number.isInteger(retention) || retention < 0 || retention > 35) return fail(ctx, "InvalidParameterValue", operation, "BackupRetentionPeriod 必須介於 0 到 35 天。");
        if (retention === 0 && replicasOf(id).length) {
          return fail(ctx, "InvalidParameterCombination", operation, "Can't set the backup retention period to 0 while the DB instance is a source for read replicas.");
        }
        instance.backupRetentionPeriod = retention;
      }
      if (flag("deletion-protection")) instance.deletionProtection = true;
      if (flag("no-deletion-protection")) instance.deletionProtection = false;
      if (opt("db-instance-class") !== undefined) instance.instanceClass = opt("db-instance-class")!;
      if (flag("multi-az") || flag("no-multi-az")) {
        // Without --apply-immediately the change waits for the next maintenance window.
        if (flag("apply-immediately")) {
          instance.multiAZ = flag("multi-az");
          instance.pendingMultiAZ = null;
        } else instance.pendingMultiAZ = flag("multi-az");
      }
      json(ctx, { DBInstance: instanceJson(id, flag("apply-immediately") && (flag("multi-az") || flag("no-multi-az")) ? "modifying" : "available") });
      return 0;
    }
    case "delete-db-instance": {
      if (!required("db-instance-identifier")) return 252;
      const id = opt("db-instance-identifier")!.toLowerCase();
      const instance = db.instances.get(id);
      if (!instance) return noInstance(id);
      if (instance.deletionProtection) {
        return fail(ctx, "InvalidParameterCombination", operation, "Cannot delete protected DB Instance, please disable deletion protection and try again.");
      }
      const finalSnapshot = opt("final-db-snapshot-identifier");
      const skip = flag("skip-final-snapshot");
      if (skip && finalSnapshot !== undefined) {
        return fail(ctx, "InvalidParameterCombination", operation, "Cannot specify both SkipFinalSnapshot and FinalDBSnapshotIdentifier.");
      }
      if (instance.readReplicaSource && !skip) {
        return fail(ctx, "InvalidParameterCombination", operation, "刪除唯讀複本時必須加上 --skip-final-snapshot（複本不能建立最終快照）。");
      }
      if (!skip && finalSnapshot === undefined) {
        return fail(ctx, "InvalidParameterCombination", operation, "FinalDBSnapshotIdentifier is required unless SkipFinalSnapshot is specified.");
      }
      if (finalSnapshot !== undefined) {
        if (db.snapshots.has(finalSnapshot.toLowerCase())) return fail(ctx, "DBSnapshotAlreadyExists", operation, `Cannot create the snapshot because a snapshot with the identifier ${finalSnapshot} already exists.`);
        db.snapshots.set(finalSnapshot.toLowerCase(), { instance: id, engine: instance.engine, allocatedStorage: instance.allocatedStorage });
      }
      const output = instanceJson(id, "deleting");
      // Replicas of a deleted source in the same Region become standalone instances.
      for (const replica of replicasOf(id)) db.instances.get(replica)!.readReplicaSource = null;
      db.instances.delete(id);
      json(ctx, { DBInstance: output });
      return 0;
    }
    case "create-db-instance-read-replica": {
      if (!required("db-instance-identifier", "source-db-instance-identifier")) return 252;
      const id = opt("db-instance-identifier")!.toLowerCase();
      const sourceId = opt("source-db-instance-identifier")!.toLowerCase();
      if (!IDENTIFIER.test(id) || id.endsWith("-")) return fail(ctx, "InvalidParameterValue", operation, `Invalid DB instance identifier: ${id}. ${IDENTIFIER_RULE}`);
      if (db.instances.has(id)) return fail(ctx, "DBInstanceAlreadyExists", operation, "DB instance already exists");
      const source = db.instances.get(sourceId);
      if (!source) return noInstance(sourceId);
      if (source.backupRetentionPeriod === 0) {
        return fail(ctx, "InvalidDBInstanceState", operation, `Automated backups are not enabled for this database instance (${sourceId}). 建立唯讀複本前，來源必須啟用自動備份（備份保留期間不是 0）。`);
      }
      if (replicasOf(sourceId).length >= MAX_REPLICAS) return fail(ctx, "InvalidParameterValue", operation, `一個資料庫執行個體最多只能有 ${MAX_REPLICAS} 個唯讀複本。`);
      db.instances.set(id, {
        ...source,
        instanceClass: opt("db-instance-class") ?? source.instanceClass,
        multiAZ: false,
        pendingMultiAZ: null,
        backupRetentionPeriod: 0,
        deletionProtection: false,
        managedPassword: false,
        readReplicaSource: sourceId,
      });
      json(ctx, { DBInstance: instanceJson(id, "creating") });
      return 0;
    }

    // ----------------------------------------------------------- snapshots
    case "create-db-snapshot": {
      if (!required("db-snapshot-identifier", "db-instance-identifier")) return 252;
      const snapshotId = opt("db-snapshot-identifier")!.toLowerCase();
      const id = opt("db-instance-identifier")!.toLowerCase();
      const instance = db.instances.get(id);
      if (!instance) return noInstance(id);
      if (!IDENTIFIER.test(snapshotId) || snapshotId.endsWith("-")) return fail(ctx, "InvalidParameterValue", operation, `Invalid snapshot identifier: ${snapshotId}. ${IDENTIFIER_RULE}`);
      if (db.snapshots.has(snapshotId)) return fail(ctx, "DBSnapshotAlreadyExists", operation, `Cannot create the snapshot because a snapshot with the identifier ${snapshotId} already exists.`);
      db.snapshots.set(snapshotId, { instance: id, engine: instance.engine, allocatedStorage: instance.allocatedStorage });
      json(ctx, {
        DBSnapshot: { DBSnapshotIdentifier: snapshotId, DBInstanceIdentifier: id, Engine: instance.engine, AllocatedStorage: instance.allocatedStorage, Status: "creating", SnapshotType: "manual" },
      });
      return 0;
    }
    case "describe-db-snapshots": {
      const id = opt("db-instance-identifier")?.toLowerCase();
      json(ctx, {
        DBSnapshots: [...db.snapshots]
          .filter(([, s]) => id === undefined || s.instance === id)
          .map(([snapshotId, s]) => ({ DBSnapshotIdentifier: snapshotId, DBInstanceIdentifier: s.instance, Engine: s.engine, AllocatedStorage: s.allocatedStorage, Status: "available", SnapshotType: "manual" })),
      });
      return 0;
    }
    default:
      return 252;
  }
}
