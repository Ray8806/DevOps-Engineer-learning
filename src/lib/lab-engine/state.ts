/**
 * Virtual machine + cloud account a lab runs against. Maps and Sets are used
 * for anything keyed by learner input, so names like "__proto__" are safe.
 */
export const HOME = "/home/learner";

export interface Bucket {
  /** AWS region or GCP location, lowercase. */
  location: string;
  storageClass: string;
  objects: Map<string, string>;
}

export interface GitCommit {
  id: string;
  message: string;
  parents: string[];
  /** Snapshot: path relative to the repository root -> content. */
  files: Map<string, string>;
}

export interface GitRepo {
  /** Current branch name. */
  head: string;
  /** Branch -> commit id, or null for a branch with no commits yet. */
  branches: Map<string, string | null>;
  commits: Map<string, GitCommit>;
  /** Staging area: relative path -> content. */
  index: Map<string, string>;
}

export interface AwsState {
  iam: {
    users: Map<string, { groups: Set<string>; policies: Set<string> }>;
    groups: Map<string, { policies: Set<string> }>;
    /** Roles: the services allowed to assume them (from the trust policy) and attached policies. */
    roles: Map<string, { trustedServices: Set<string>; policies: Set<string> }>;
  };
  ec2: {
    /** Keyed by instance id. */
    instances: Map<
      string,
      { imageId: string; instanceType: string; state: "running" | "stopped" | "terminated"; securityGroups: string[]; availabilityZone: string }
    >;
    /** EBS volumes, keyed by volume id. */
    volumes: Map<
      string,
      { availabilityZone: string; size: number; type: string; snapshotId: string | null; attachment: { instanceId: string; device: string } | null }
    >;
    /** EBS snapshots, keyed by snapshot id. */
    snapshots: Map<string, { volumeId: string; size: number; description: string }>;
    /** Keyed by security group id. Ingress entries look like "tcp:443:0.0.0.0/0". */
    securityGroups: Map<string, { name: string; description: string; ingress: Set<string> }>;
    /** Number of ids handed out so far (instances, groups, VPC resources), so new ids are deterministic. */
    created: number;
  };
  vpc: AwsVpcState;
  lambda: { functions: Map<string, LambdaFunction> };
  rds: {
    subnetGroups: Map<string, { description: string; subnetIds: string[] }>;
    instances: Map<string, RdsInstance>;
    /** Manual and final snapshots: id -> source instance. */
    snapshots: Map<string, { instance: string; engine: string; allocatedStorage: number }>;
  };
}

export interface AwsVpcState {
  vpcs: Map<string, { cidr: string }>;
  subnets: Map<string, { vpcId: string; cidr: string; availabilityZone: string; mapPublicIpOnLaunch: boolean }>;
  /** vpcId is null while the gateway is detached. */
  internetGateways: Map<string, { vpcId: string | null }>;
  routeTables: Map<
    string,
    {
      vpcId: string;
      main: boolean;
      /** Destination CIDR -> target ("local" or an internet gateway id). */
      routes: Map<string, string>;
      /** Association id -> subnet id (explicit associations only). */
      associations: Map<string, string>;
    }
  >;
}

export interface LambdaFunction {
  runtime: string;
  handler: string;
  role: string;
  /** Files in the deployment package: name -> content. */
  code: Record<string, string>;
  timeout: number;
  memorySize: number;
  environment: Record<string, string>;
  invocations: number;
}

export interface CloudRunService {
  region: string;
  image: string;
  /** Cloud Run's invoker IAM check; disabling it makes the service public. */
  invokerIamCheck: boolean;
  /** Members holding roles/run.invoker on the service. */
  invokers: Set<string>;
  concurrency: number;
  memory: string;
  timeout: number;
  minInstances: number;
  maxInstances: number;
  env: Record<string, string>;
  /** Revision names, oldest first; the last one serves all traffic. */
  revisions: string[];
}

export interface RdsInstance {
  engine: string;
  instanceClass: string;
  allocatedStorage: number;
  masterUsername: string;
  /** Password kept in Secrets Manager (--manage-master-user-password). */
  managedPassword: boolean;
  /** null means the default subnet group. */
  subnetGroup: string | null;
  multiAZ: boolean;
  /** Multi-AZ change waiting for the maintenance window (no --apply-immediately). */
  pendingMultiAZ: boolean | null;
  publiclyAccessible: boolean;
  backupRetentionPeriod: number;
  deletionProtection: boolean;
  readReplicaSource: string | null;
}

export interface CloudSqlInstance {
  databaseVersion: string;
  edition: "ENTERPRISE" | "ENTERPRISE_PLUS";
  tier: string;
  region: string;
  availabilityType: "ZONAL" | "REGIONAL";
  backupsEnabled: boolean;
  deletionProtection: boolean;
  masterInstanceName: string | null;
  databases: Set<string>;
  users: Set<string>;
  /** On-demand backup ids. */
  backups: string[];
}

export interface GcpState {
  project: string;
  /** Keyed by service account email. */
  serviceAccounts: Map<string, { displayName: string }>;
  /** Project IAM policy: role -> members. */
  bindings: Map<string, Set<string>>;
  instances: Map<
    string,
    {
      zone: string;
      machineType: string;
      status: "RUNNING" | "TERMINATED";
      tags: Set<string>;
      network: string;
      subnet: string;
      /** False when created with --no-address. */
      externalIp: boolean;
    }
  >;
  /** Allow entries look like "tcp:80". */
  firewallRules: Map<string, { network: string; allow: Set<string>; sourceRanges: Set<string>; targetTags: Set<string> }>;
  /** Auto mode networks implicitly have a subnet named after the network in every region. */
  networks: Map<string, { mode: "auto" | "custom" }>;
  /** Keyed by "region/name": subnet names are unique per region. */
  subnets: Map<string, { name: string; network: string; region: string; range: string }>;
  /** Cloud Routers, keyed by "region/name"; each NAT lists "ALL" or the subnets it serves. */
  routers: Map<string, { name: string; network: string; region: string; nats: Map<string, string[] | "ALL"> }>;
  sql: { instances: Map<string, CloudSqlInstance>; backupsCreated: number };
  /** Zonal Persistent Disk volumes (data disks) by name; users maps instance name -> "rw" | "ro". */
  disks: Map<string, { zone: string; sizeGb: number; type: string; sourceSnapshot: string | null; users: Map<string, "rw" | "ro"> }>;
  /** Disk snapshots by name. */
  snapshots: Map<string, { sourceDisk: string; sizeGb: number }>;
  run: { services: Map<string, CloudRunService>; revisionsCreated: number };
}

export interface LabState {
  cwd: string;
  /** Absolute path -> content. */
  files: Map<string, string>;
  /** Absolute paths of every directory, including "/" and HOME. */
  dirs: Set<string>;
  s3: Map<string, Bucket>;
  gcs: Map<string, Bucket>;
  /** Git repositories by the absolute path of their working directory. */
  git: Map<string, GitRepo>;
  aws: AwsState;
  gcp: GcpState;
}

export interface InitialState {
  files?: Record<string, string>;
  cloud?: Record<string, unknown>;
}

// --------------------------------------------------------------------- paths

/** Resolves a path typed by the learner to a normalised absolute path. */
export function resolvePath(cwd: string, input: string): string {
  let path = input;
  if (path === "~" || path.startsWith("~/")) path = HOME + path.slice(1);
  else if (!path.startsWith("/")) path = `${cwd}/${path}`;

  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Absolute path as shown to the learner and used in lab checks ("~/x"). */
export function displayPath(abs: string): string {
  if (abs === HOME) return "~";
  return abs.startsWith(`${HOME}/`) ? `~${abs.slice(HOME.length)}` : abs;
}

export function dirname(abs: string): string {
  const i = abs.lastIndexOf("/");
  return i <= 0 ? "/" : abs.slice(0, i);
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** True when `path` is `dir` itself or somewhere below it. */
export function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);
}

export function addDirWithParents(dirs: Set<string>, abs: string) {
  for (let d = abs; ; d = dirname(d)) {
    dirs.add(d);
    if (d === "/") break;
  }
}

/** Names directly inside a directory: [name, isDirectory], sorted by name. */
export function listDir(state: LabState, dir: string): [string, boolean][] {
  const prefix = dir === "/" ? "/" : `${dir}/`;
  const entries = new Map<string, boolean>();
  for (const d of state.dirs) {
    if (d !== dir && d.startsWith(prefix) && !d.slice(prefix.length).includes("/")) entries.set(d.slice(prefix.length), true);
  }
  for (const f of state.files.keys()) {
    if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) entries.set(f.slice(prefix.length), false);
  }
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// ----------------------------------------------------------- create / clone

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bucketsFrom(cloud: Record<string, unknown>, service: string, defaultLocation: string): Map<string, Bucket> {
  const result = new Map<string, Bucket>();
  const svc = cloud[service];
  const buckets = isRecord(svc) && isRecord(svc.buckets) ? svc.buckets : {};
  for (const [name, raw] of Object.entries(buckets)) {
    const b = isRecord(raw) ? raw : {};
    const location = typeof b.location === "string" ? b.location : typeof b.region === "string" ? b.region : defaultLocation;
    const objects = new Map<string, string>();
    if (isRecord(b.objects)) {
      for (const [key, content] of Object.entries(b.objects)) objects.set(key, typeof content === "string" ? content : "");
    }
    result.set(name, {
      location: location.toLowerCase(),
      storageClass: typeof b.storageClass === "string" ? b.storageClass : "STANDARD",
      objects,
    });
  }
  return result;
}

export const DEFAULT_S3_REGION = "us-east-1";
export const DEFAULT_GCS_LOCATION = "us";

export function createLabState(initial: InitialState = {}): LabState {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  addDirWithParents(dirs, HOME);
  for (const [path, content] of Object.entries(initial.files ?? {})) {
    const abs = resolvePath(HOME, path);
    files.set(abs, content);
    addDirWithParents(dirs, dirname(abs));
  }
  const cloud = initial.cloud ?? {};
  return {
    cwd: HOME,
    files,
    dirs,
    s3: bucketsFrom(cloud, "s3", DEFAULT_S3_REGION),
    gcs: bucketsFrom(cloud, "gcs", DEFAULT_GCS_LOCATION),
    git: new Map(),
    aws: awsFrom(cloud),
    gcp: gcpFrom(cloud),
  };
}

/**
 * Seeds the simulated AWS account from `initialState.cloud.aws`:
 * { vpcs: { [vpcId]: { cidr, subnets: { [subnetId]: { cidr, availabilityZone } } } } }.
 * Each seeded VPC gets a main route table with only the local route.
 */
function awsFrom(cloud: Record<string, unknown>): AwsState {
  const aws: AwsState = {
    iam: { users: new Map(), groups: new Map(), roles: new Map() },
    ec2: { instances: new Map(), securityGroups: new Map(), volumes: new Map(), snapshots: new Map(), created: 0 },
    lambda: { functions: new Map() },
    vpc: { vpcs: new Map(), subnets: new Map(), internetGateways: new Map(), routeTables: new Map() },
    rds: { subnetGroups: new Map(), instances: new Map(), snapshots: new Map() },
  };
  const seed = isRecord(cloud.aws) && isRecord(cloud.aws.vpcs) ? cloud.aws.vpcs : {};
  for (const [vpcId, raw] of Object.entries(seed)) {
    if (!isRecord(raw) || typeof raw.cidr !== "string") continue;
    aws.vpc.vpcs.set(vpcId, { cidr: raw.cidr });
    aws.vpc.routeTables.set(`rtb-0seed${String(aws.vpc.routeTables.size).padStart(12, "0")}`, {
      vpcId,
      main: true,
      routes: new Map([[raw.cidr, "local"]]),
      associations: new Map(),
    });
    for (const [subnetId, sub] of Object.entries(isRecord(raw.subnets) ? raw.subnets : {})) {
      if (!isRecord(sub) || typeof sub.cidr !== "string") continue;
      aws.vpc.subnets.set(subnetId, {
        vpcId,
        cidr: sub.cidr,
        availabilityZone: typeof sub.availabilityZone === "string" ? sub.availabilityZone : "us-east-1a",
        mapPublicIpOnLaunch: false,
      });
    }
  }
  return aws;
}

export const DEFAULT_GCP_PROJECT = "my-project";

/** Seeds the simulated GCP project from `initialState.cloud.gcp` ({ project, bindings: { role: [members] } }). */
function gcpFrom(cloud: Record<string, unknown>): GcpState {
  const gcp = isRecord(cloud.gcp) ? cloud.gcp : {};
  const bindings = new Map<string, Set<string>>();
  if (isRecord(gcp.bindings)) {
    for (const [role, members] of Object.entries(gcp.bindings)) {
      if (Array.isArray(members)) bindings.set(role, new Set(members.filter((m): m is string => typeof m === "string")));
    }
  }
  return {
    project: typeof gcp.project === "string" ? gcp.project : DEFAULT_GCP_PROJECT,
    serviceAccounts: new Map(),
    bindings,
    instances: new Map(),
    firewallRules: new Map(),
    // Every new project starts with the auto mode "default" network.
    networks: new Map([["default", { mode: "auto" as const }]]),
    subnets: new Map(),
    routers: new Map(),
    sql: { instances: new Map(), backupsCreated: 0 },
    disks: new Map(),
    snapshots: new Map(),
    run: { services: new Map(), revisionsCreated: 0 },
  };
}

export function cloneRepo(repo: GitRepo): GitRepo {
  // Commits are never modified after creation, so they can be shared.
  return { head: repo.head, branches: new Map(repo.branches), commits: new Map(repo.commits), index: new Map(repo.index) };
}

function cloneBuckets(buckets: Map<string, Bucket>): Map<string, Bucket> {
  return new Map([...buckets].map(([name, b]) => [name, { ...b, objects: new Map(b.objects) }]));
}

export function cloneState(state: LabState): LabState {
  return {
    cwd: state.cwd,
    files: new Map(state.files),
    dirs: new Set(state.dirs),
    s3: cloneBuckets(state.s3),
    gcs: cloneBuckets(state.gcs),
    git: new Map([...state.git].map(([root, repo]) => [root, cloneRepo(repo)])),
    // Plain data made of Maps, Sets, arrays and primitives.
    aws: structuredClone(state.aws),
    gcp: structuredClone(state.gcp),
  };
}

/** Commit ids reachable from `start`, newest first (first-parent order, then merged-in history). */
export function history(repo: GitRepo, start: string | null): GitCommit[] {
  const seen = new Set<string>();
  const result: GitCommit[] = [];
  const queue = start ? [start] : [];
  while (queue.length) {
    const id = queue.shift()!;
    const commit = repo.commits.get(id);
    if (!commit || seen.has(id)) continue;
    seen.add(id);
    result.push(commit);
    queue.push(...commit.parents);
  }
  return result;
}

/** Files tracked at the tip of a branch (empty for a branch with no commits). */
export function branchFiles(repo: GitRepo, branch: string): Map<string, string> {
  const tip = repo.branches.get(branch);
  return (tip && repo.commits.get(tip)?.files) || new Map();
}

/** Working-tree files of a repository: relative path -> content (the .git directory is not a file). */
export function workingFiles(state: LabState, root: string): Map<string, string> {
  const prefix = root === "/" ? "/" : `${root}/`;
  const result = new Map<string, string>();
  for (const [path, content] of state.files) {
    if (!path.startsWith(prefix)) continue;
    // Files inside a nested repository belong to that repository.
    const nested = [...state.git.keys()].some((r) => r !== root && isWithin(r, root) && isWithin(path, r));
    if (!nested) result.set(path.slice(prefix.length), content);
  }
  return result;
}

// ---------------------------------------------------------------- check view

function bucketsView(buckets: Map<string, Bucket>, locationKey: "region" | "location") {
  return {
    buckets: Object.fromEntries(
      [...buckets].map(([name, b]) => [
        name,
        { [locationKey]: b.location, storageClass: b.storageClass, objects: Object.fromEntries(b.objects) },
      ]),
    ),
  };
}

/** Maps become objects, Sets become { member: true }, so checks can walk them. */
function plain(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), plain(v)]));
  if (value instanceof Set) return Object.fromEntries([...value].map((k) => [String(k), true]));
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

/** The route table a subnet uses: its explicit association, or else the VPC's main table. */
export function subnetRouteTable(vpc: AwsVpcState, subnetId: string): string | undefined {
  const subnet = vpc.subnets.get(subnetId);
  if (!subnet) return undefined;
  const tables = [...vpc.routeTables].filter(([, t]) => t.vpcId === subnet.vpcId);
  return (tables.find(([, t]) => [...t.associations.values()].includes(subnetId)) ?? tables.find(([, t]) => t.main))?.[0];
}

/** A route to an internet gateway counts only while that gateway is attached to the route table's VPC. */
export function routesToInternet(vpc: AwsVpcState, tableId: string): boolean {
  const table = vpc.routeTables.get(tableId);
  return !!table && [...table.routes.values()].some((target) => vpc.internetGateways.get(target)?.vpcId === table.vpcId);
}

/** Public subnet = its route table has a route to an attached internet gateway. */
export function isPublicSubnet(vpc: AwsVpcState, subnetId: string): boolean {
  const table = subnetRouteTable(vpc, subnetId);
  return table !== undefined && routesToInternet(vpc, table);
}

/** VPCs keyed by CIDR (ids are generated, so labs cannot know them). With duplicate CIDRs the oldest wins. */
function vpcsView(vpc: AwsVpcState) {
  const result: Record<string, unknown> = {};
  for (const [vpcId, v] of vpc.vpcs) {
    if (Object.hasOwn(result, v.cidr)) continue;
    const subnets = [...vpc.subnets].filter(([, s]) => s.vpcId === vpcId);
    result[v.cidr] = {
      id: vpcId,
      internetGateway: [...vpc.internetGateways.values()].some((g) => g.vpcId === vpcId),
      internetRoute: [...vpc.routeTables].some(([id, t]) => t.vpcId === vpcId && routesToInternet(vpc, id)),
      publicSubnets: keysTrue(subnets.filter(([id]) => isPublicSubnet(vpc, id)).map(([, s]) => s.cidr)),
      subnets: Object.fromEntries(
        subnets.map(([id, s]) => [
          s.cidr,
          { id, availabilityZone: s.availabilityZone, public: isPublicSubnet(vpc, id), mapPublicIpOnLaunch: s.mapPublicIpOnLaunch },
        ]),
      ),
    };
  }
  return result;
}

function rdsView(aws: AwsState) {
  const { rds, vpc } = aws;
  return {
    subnetGroups: Object.fromEntries(
      [...rds.subnetGroups].map(([name, g]) => [
        name,
        {
          subnets: keysTrue(g.subnetIds),
          availabilityZones: keysTrue(g.subnetIds.map((id) => vpc.subnets.get(id)?.availabilityZone ?? "")),
        },
      ]),
    ),
    instances: Object.fromEntries(
      [...rds.instances].map(([id, i]) => [
        id,
        {
          engine: i.engine,
          instanceClass: i.instanceClass,
          multiAZ: i.multiAZ,
          publiclyAccessible: i.publiclyAccessible,
          subnetGroup: i.subnetGroup ?? "default",
          backupRetentionPeriod: i.backupRetentionPeriod,
          deletionProtection: i.deletionProtection,
          readReplicaSource: i.readReplicaSource,
        },
      ]),
    ),
    snapshots: Object.fromEntries([...rds.snapshots].map(([id, snap]) => [id, { instance: snap.instance }])),
  };
}

/**
 * EBS volumes grouped by "availabilityZone/type/sizeGiB", because volume ids
 * are generated: how many exist, how many are attached, how many came from a snapshot.
 */
function volumeSpecs(aws: AwsState) {
  const specs: Record<string, { count: number; attached: number; fromSnapshot: number }> = {};
  for (const v of aws.ec2.volumes.values()) {
    const key = `${v.availabilityZone}/${v.type}/${v.size}`;
    specs[key] ??= { count: 0, attached: 0, fromSnapshot: 0 };
    specs[key].count++;
    if (v.attachment) specs[key].attached++;
    if (v.snapshotId) specs[key].fromSnapshot++;
  }
  return specs;
}

function lambdaView(aws: AwsState) {
  return {
    functions: Object.fromEntries(
      [...aws.lambda.functions].map(([name, f]) => [
        name,
        { runtime: f.runtime, handler: f.handler, role: f.role, timeout: f.timeout, memorySize: f.memorySize, environment: f.environment, invoked: f.invocations > 0 },
      ]),
    ),
  };
}

function awsView(aws: AwsState) {
  const instances = [...aws.ec2.instances.values()];
  const count = (state: string, groupId?: string) =>
    instances.filter((i) => i.state === state && (groupId === undefined || i.securityGroups.includes(groupId))).length;
  return {
    iam: plain(aws.iam),
    ec2: {
      instances: plain(aws.ec2.instances),
      counts: { running: count("running"), stopped: count("stopped"), terminated: count("terminated") },
      volumes: plain(aws.ec2.volumes),
      volumeSpecs: volumeSpecs(aws),
      snapshotCount: aws.ec2.snapshots.size,
      // By name, because ids are generated and a lab cannot know them in advance.
      securityGroups: Object.fromEntries(
        [...aws.ec2.securityGroups].map(([id, g]) => [
          g.name,
          { id, ingress: plain(g.ingress), runningInstances: count("running", id) },
        ]),
      ),
    },
    vpcs: vpcsView(aws.vpc),
    rds: rdsView(aws),
    lambda: lambdaView(aws),
  };
}

function gcpView(gcp: GcpState) {
  const subnets = [...gcp.subnets.values()];
  const routers = [...gcp.routers.values()];
  return {
    project: gcp.project,
    serviceAccounts: plain(gcp.serviceAccounts),
    bindings: plain(gcp.bindings),
    instances: Object.fromEntries(
      [...gcp.instances].map(([name, i]) => [
        name,
        {
          zone: i.zone,
          machineType: i.machineType,
          status: i.status,
          tags: keysTrue(i.tags),
          networkInterface: { network: i.network, subnet: i.subnet, externalIp: i.externalIp },
        },
      ]),
    ),
    firewallRules: plain(gcp.firewallRules),
    networks: Object.fromEntries(
      [...gcp.networks].map(([name, n]) => [
        name,
        {
          mode: n.mode,
          subnets: Object.fromEntries(subnets.filter((s) => s.network === name).map((s) => [s.name, { region: s.region, range: s.range }])),
          // Regions where a Cloud NAT gateway serves this network.
          natRegions: keysTrue(routers.filter((r) => r.network === name && r.nats.size > 0).map((r) => r.region)),
        },
      ]),
    ),
    routers: Object.fromEntries(
      routers.map((r) => [r.name, { network: r.network, region: r.region, nats: Object.fromEntries([...r.nats].map(([n, served]) => [n, plain(served)])) }]),
    ),
    disks: Object.fromEntries(
      [...gcp.disks].map(([name, d]) => [name, { zone: d.zone, sizeGb: d.sizeGb, type: d.type, sourceSnapshot: d.sourceSnapshot, users: plain(d.users) }]),
    ),
    snapshots: plain(gcp.snapshots),
    run: {
      services: Object.fromEntries(
        [...gcp.run.services].map(([name, r]) => [
          name,
          {
            region: r.region,
            image: r.image,
            public: !r.invokerIamCheck || r.invokers.has("allUsers"),
            concurrency: r.concurrency,
            memory: r.memory,
            timeout: r.timeout,
            minInstances: r.minInstances,
            maxInstances: r.maxInstances,
            env: r.env,
            revisionCount: r.revisions.length,
          },
        ]),
      ),
    },
    sql: {
      instances: Object.fromEntries(
        [...gcp.sql.instances].map(([name, i]) => [
          name,
          {
            databaseVersion: i.databaseVersion,
            edition: i.edition,
            tier: i.tier,
            region: i.region,
            availabilityType: i.availabilityType,
            backupsEnabled: i.backupsEnabled,
            deletionProtection: i.deletionProtection,
            masterInstanceName: i.masterInstanceName,
            databases: keysTrue(i.databases),
            users: keysTrue(i.users),
            backupCount: i.backups.length,
          },
        ]),
      ),
    },
  };
}

const keysTrue = (keys: Iterable<string>) => Object.fromEntries([...keys].map((k) => [k, true]));

function repoView(state: LabState, root: string, repo: GitRepo) {
  const head = branchFiles(repo, repo.head);
  const staged = [...new Set([...repo.index.keys(), ...head.keys()])].filter((p) => repo.index.get(p) !== head.get(p));
  const working = workingFiles(state, root);
  const dirty = [...new Set([...repo.index.keys(), ...working.keys()])].some((p) => repo.index.get(p) !== working.get(p));
  const commits = history(repo, repo.branches.get(repo.head) ?? null);
  return {
    branch: repo.head,
    branches: keysTrue(repo.branches.keys()),
    commitCount: commits.length,
    lastMessage: commits[0]?.message ?? null,
    staged: keysTrue(staged),
    clean: staged.length === 0 && !dirty,
    branchFiles: Object.fromEntries([...repo.branches.keys()].map((b) => [b, keysTrue(branchFiles(repo, b).keys())])),
  };
}

/**
 * Plain-object view that lab checks walk with their `path`:
 *   files["~/a.txt"], dirs["~/projects"], cwd,
 *   cloud.s3.buckets[name].{region,storageClass,objects[key]},
 *   cloud.gcs.buckets[name].{location,storageClass,objects[name]},
 *   cloud.aws.iam.users[name].{groups[name],policies[arn]}, cloud.aws.iam.groups[name].policies[arn],
 *   cloud.aws.ec2.counts.{running,stopped,terminated}, cloud.aws.ec2.instances[id].{state,instanceType},
 *   cloud.aws.ec2.securityGroups[name].{id,ingress["tcp:443:0.0.0.0/0"],runningInstances},
 *   cloud.gcp.{project, serviceAccounts[email], bindings[role][member]},
 *   cloud.gcp.instances[name].{zone,machineType,status,tags[tag]},
 *   cloud.aws.vpcs[vpcCidr].{id, internetGateway, internetRoute, publicSubnets[cidr],
 *     subnets[cidr].{id, availabilityZone, public, mapPublicIpOnLaunch}},
 *   cloud.aws.rds.subnetGroups[name].{subnets[id], availabilityZones[az]},
 *   cloud.aws.rds.instances[id].{engine, instanceClass, multiAZ, publiclyAccessible, subnetGroup,
 *     backupRetentionPeriod, deletionProtection, readReplicaSource}, cloud.aws.rds.snapshots[id].instance,
 *   cloud.gcp.instances[name].networkInterface = { network, subnet, externalIp },
 *   cloud.gcp.firewallRules[name].{network, allow["tcp:80"],sourceRanges[cidr],targetTags[tag]},
 *   cloud.gcp.networks[name].{mode, subnets[name].{region, range}, natRegions[region]},
 *   cloud.gcp.routers[name].{network, region, nats[name]},
 *   cloud.aws.iam.roles[name].{trustedServices[service], policies[arn]},
 *   cloud.aws.lambda.functions[name].{runtime, handler, role, timeout, memorySize, environment[key], invoked},
 *   cloud.aws.ec2.volumeSpecs["az/type/size"].{count, attached, fromSnapshot}, cloud.aws.ec2.snapshotCount,
 *   cloud.gcp.disks[name].{zone, sizeGb, type, sourceSnapshot, users[instance]}, cloud.gcp.snapshots[name].{sourceDisk, sizeGb},
 *   cloud.gcp.run.services[name].{region, image, public, concurrency, memory, timeout, minInstances, maxInstances, env[key], revisionCount},
 *   cloud.gcp.sql.instances[name].{databaseVersion, edition, tier, region, availabilityType, backupsEnabled,
 *     deletionProtection, masterInstanceName, databases[name], users[name], backupCount},
 *   git["~/project"].{branch, branches[name], commitCount, lastMessage,
 *     staged[path], clean, branchFiles[branch][path]}.
 */
export function checkView(state: LabState): Record<string, unknown> {
  return {
    cwd: displayPath(state.cwd),
    files: Object.fromEntries([...state.files].map(([p, c]) => [displayPath(p), c])),
    dirs: Object.fromEntries([...state.dirs].map((d) => [displayPath(d), true])),
    cloud: {
      s3: bucketsView(state.s3, "region"),
      gcs: bucketsView(state.gcs, "location"),
      aws: awsView(state.aws),
      gcp: gcpView(state.gcp),
    },
    git: Object.fromEntries([...state.git].map(([root, repo]) => [displayPath(root), repoView(state, root, repo)])),
  };
}
