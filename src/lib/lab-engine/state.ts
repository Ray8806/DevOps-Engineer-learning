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
  };
  ec2: {
    /** Keyed by instance id. */
    instances: Map<string, { imageId: string; instanceType: string; state: "running" | "stopped" | "terminated"; securityGroups: string[] }>;
    /** Keyed by security group id. Ingress entries look like "tcp:443:0.0.0.0/0". */
    securityGroups: Map<string, { name: string; description: string; ingress: Set<string> }>;
    /** Number of ids handed out so far, so new ids are deterministic. */
    created: number;
  };
}

export interface GcpState {
  project: string;
  /** Keyed by service account email. */
  serviceAccounts: Map<string, { displayName: string }>;
  /** Project IAM policy: role -> members. */
  bindings: Map<string, Set<string>>;
  instances: Map<string, { zone: string; machineType: string; status: "RUNNING" | "TERMINATED"; tags: Set<string> }>;
  /** Allow entries look like "tcp:80". */
  firewallRules: Map<string, { allow: Set<string>; sourceRanges: Set<string>; targetTags: Set<string> }>;
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
    aws: {
      iam: { users: new Map(), groups: new Map() },
      ec2: { instances: new Map(), securityGroups: new Map(), created: 0 },
    },
    gcp: gcpFrom(cloud),
  };
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

function awsView(aws: AwsState) {
  const instances = [...aws.ec2.instances.values()];
  const count = (state: string, groupId?: string) =>
    instances.filter((i) => i.state === state && (groupId === undefined || i.securityGroups.includes(groupId))).length;
  return {
    iam: plain(aws.iam),
    ec2: {
      instances: plain(aws.ec2.instances),
      counts: { running: count("running"), stopped: count("stopped"), terminated: count("terminated") },
      // By name, because ids are generated and a lab cannot know them in advance.
      securityGroups: Object.fromEntries(
        [...aws.ec2.securityGroups].map(([id, g]) => [
          g.name,
          { id, ingress: plain(g.ingress), runningInstances: count("running", id) },
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
 *   cloud.gcp.firewallRules[name].{allow["tcp:80"],sourceRanges[cidr],targetTags[tag]},
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
      gcp: plain(state.gcp),
    },
    git: Object.fromEntries([...state.git].map(([root, repo]) => [displayPath(root), repoView(state, root, repo)])),
  };
}
