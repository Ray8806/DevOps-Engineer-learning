/**
 * Virtual machine + cloud account a lab runs against. Maps and Sets are used
 * for anything keyed by learner input, so names like "__proto__" are safe.
 */
import { healthyBackends, ruleServing } from "./gcloud-lb";
import { notificationLabel } from "./aws-cost";
import { taskProblem } from "./aws-ecs";
import { k8sView } from "./kubectl";
import type { TfWorkspace } from "./terraform";
import { aliasTarget } from "./aws-dns-cdn";

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
    /** Launch templates by name. */
    launchTemplates: Map<string, { id: string; imageId: string; instanceType: string; securityGroups: string[] }>;
    /** Keyed by security group id. Ingress entries look like "tcp:443:0.0.0.0/0". */
    securityGroups: Map<string, { name: string; description: string; ingress: Set<string> }>;
    /** Number of ids handed out so far (instances, groups, VPC resources), so new ids are deterministic. */
    created: number;
  };
  vpc: AwsVpcState;
  lambda: { functions: Map<string, LambdaFunction> };
  dynamodb: { tables: Map<string, DynamoTable> };
  elbv2: {
    /** Target groups by name; targets are instance ids. */
    targetGroups: Map<string, { arn: string; protocol: string; port: number; vpcId: string; healthCheckPath: string; targets: Set<string> }>;
    /** Load balancers by name. */
    loadBalancers: Map<string, { arn: string; type: "application"; scheme: string; vpcId: string; subnets: string[]; dnsName: string }>;
    /** Listeners by ARN. */
    listeners: Map<string, { loadBalancer: string; protocol: string; port: number; targetGroup: string }>;
  };
  autoscaling: { groups: Map<string, AutoScalingGroup> };
  /** SNS topics by name; subscriptions keyed "protocol:endpoint" -> status. */
  sns: { topics: Map<string, { subscriptions: Map<string, string>; published: number }> };
  cloudwatch: { alarms: Map<string, CloudWatchAlarm> };
  logs: { groups: Map<string, LogGroup> };
  /** CloudTrail event history (seeded by the lab). */
  cloudtrail: { events: TrailEvent[] };
  /** Hosted zones by id. */
  route53: { zones: Map<string, HostedZone>; created: number };
  /** Distributions by id. */
  cloudfront: { distributions: Map<string, Distribution>; created: number };
  /** KMS keys by key id; aliases map "alias/name" to a key id. */
  kms: { keys: Map<string, KmsKey>; aliases: Map<string, string>; created: number };
  ecr: { repositories: Map<string, { mutability: "MUTABLE" | "IMMUTABLE"; scanOnPush: boolean; images: Map<string, string> }> };
  /** Stacks by name; deleted stacks stay with status DELETE_COMPLETE. */
  cloudformation: { stacks: Map<string, CfnStack> };
  /** S3 event notification configurations by bucket name. */
  s3Notifications: Map<string, S3QueueNotification[]>;
  /** SQS queues by name. */
  sqs: { queues: Map<string, SqsQueue>; counter: number };
  /** CodeBuild projects by name and builds by id ("project:uuid"). */
  codebuild: { projects: Map<string, CodeBuildProject>; builds: Map<string, { project: string } & BuildRecord>; counter: number };
  eks: {
    clusters: Map<
      string,
      {
        roleArn: string;
        subnets: string[];
        version: string;
        nodegroups: Map<string, { nodeRole: string; subnets: string[]; min: number; max: number; desired: number; instanceTypes: string[] }>;
        k8s: K8sObjects;
      }
    >;
  };
  ecs: {
    clusters: Set<string>;
    /** Revisions per family, revision 1 first. */
    taskDefinitions: Map<string, EcsTaskDefinition[]>;
    /** Keyed "cluster/service". */
    services: Map<string, { taskDefinition: string; desiredCount: number; launchType: string; subnets: string[]; assignPublicIp: string }>;
  };
  /** Cost Explorer data (seeded by the lab) and cost allocation tag status. */
  ce: { costs: CostItem[]; tagStatus: Map<string, "Active" | "Inactive">; queries: Set<string>; forecasts: number };
  budgets: Map<string, Budget>;
  wafv2: {
    ipSets: Map<string, { id: string; arn: string; scope: string; addresses: string[] }>;
    webAcls: Map<string, { id: string; arn: string; scope: string; defaultAction: string; rules: WafRule[]; associations: string[] }>;
  };
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

export interface AutoScalingGroup {
  launchTemplate: string;
  min: number;
  max: number;
  desired: number;
  subnets: string[];
  targetGroups: string[];
  healthCheckType: "EC2" | "ELB";
  gracePeriod: number;
  /** Instance ids the group manages, oldest first. */
  instances: string[];
  /** Target tracking policies by name. */
  policies: Map<string, { metric: string; target: number }>;
  /** Unhealthy instances the group has replaced. */
  replaced: number;
}

export interface CloudWatchAlarm {
  namespace: string;
  metricName: string;
  statistic: string;
  period: number;
  evaluationPeriods: number;
  threshold: number;
  comparisonOperator: string;
  dimensions: Record<string, string>;
  /** SNS topic names notified when the alarm goes to ALARM. */
  alarmActions: string[];
  state: "OK" | "ALARM" | "INSUFFICIENT_DATA";
}

export interface S3QueueNotification {
  id: string;
  /** SQS queue ARN or SNS topic ARN. */
  destination: string;
  kind: "queue" | "topic";
  /** e.g. "s3:ObjectCreated:*" */
  events: string[];
  prefix: string;
  suffix: string;
}

export interface GcsNotification {
  id: string;
  topic: string;
  /** Empty means every event type. */
  eventTypes: string[];
  prefix: string;
  payload: "json" | "none";
}

export interface SqsMessage {
  id: string;
  body: string;
  /** Simulated clock (seconds) when it was sent. */
  sentAt: number;
  receiveCount: number;
  /** Hidden from receivers until this time (delay or visibility timeout). */
  invisibleUntil: number;
  /** Receipt handle of the latest receive; deleting needs this one. */
  receipt: string | null;
  fromSns: boolean;
  /** An S3 event notification (not the s3:TestEvent). */
  fromS3Event?: boolean;
}

export interface SqsQueue {
  /** Settable attributes as strings, the way SQS returns them. */
  attributes: Record<string, string>;
  createdAt: number;
  messages: SqsMessage[];
  stats: { sent: number; deleted: number; redelivered: boolean; movedToDeadLetter: number; receivedFromSns: boolean; receivedS3Event?: boolean };
}

export interface PubsubMessage {
  id: string;
  data: string;
  attributes: Record<string, string>;
  publishedAt: number;
  /** Times delivered to a subscriber. */
  attempts: number;
  /** Attempts Pub/Sub counts towards the dead-letter limit (only with the IAM roles in place). */
  countedAttempts: number;
  /** Outstanding (not redelivered) until this time. */
  outstandingUntil: number;
  ackId: string | null;
}

export interface PubsubSubscription {
  topic: string;
  ackDeadline: number;
  deadLetter: { topic: string; maxAttempts: number } | null;
  /** Resource IAM policy: role -> members. */
  iam: Map<string, Set<string>>;
  messages: PubsubMessage[];
  stats: { acked: number; redelivered: boolean; ackedAfterRedelivery: boolean; forwarded: number };
}

export interface CodeBuildProject {
  /** "bucket/key.zip" */
  source: string;
  image: string;
  privileged: boolean;
  env: Record<string, string>;
  serviceRole: string;
}

export interface BuildRecord {
  status: "SUCCEEDED" | "FAILED" | "SUCCESS" | "FAILURE";
  /** CodeBuild phases or Cloud Build steps, with their status. */
  steps: { name: string; status: string }[];
  log: string[];
}

export interface LogGroup {
  /** null means never expire (the default). */
  retentionInDays: number | null;
  events: { stream: string; timestamp: number; message: string }[];
  /** Filter patterns used with filter-log-events, so labs can check a search was run. */
  searches: Set<string>;
  metricFilters: Map<string, { pattern: string; metricName: string; metricNamespace: string }>;
}

export interface Route53Record {
  /** Fully qualified, with the trailing dot. */
  name: string;
  type: string;
  ttl: number | null;
  values: string[];
  setIdentifier: string | null;
  weight: number | null;
  alias: { hostedZoneId: string; dnsName: string; evaluateTargetHealth: boolean } | null;
}

export interface HostedZone {
  /** Fully qualified, with the trailing dot. */
  name: string;
  callerReference: string;
  comment: string;
  nameServers: string[];
  /** Keyed "name|type|setIdentifier". */
  records: Map<string, Route53Record>;
  /** test-dns-answer calls so far; rotates weighted answers. */
  queries: number;
}

export interface Distribution {
  domainName: string;
  origin: string;
  defaultRootObject: string;
  /** Every path submitted in an invalidation, in order. */
  invalidations: string[];
}

export type CfnJson = string | number | boolean | null | CfnJson[] | { [k: string]: CfnJson };

export interface CfnChange {
  action: "Add" | "Modify" | "Remove";
  logical: string;
  type: string;
  replacement: string;
  details: string[];
}

export interface CfnStack {
  id: string;
  status: string;
  template: string;
  params: Record<string, string>;
  resources: Map<string, { type: string; physicalId: string; props: { [k: string]: CfnJson }; deletionPolicy: string }>;
  outputs: Record<string, string>;
  /** Newest first. */
  events: { logical: string; status: string; reason: string }[];
  drift: "DRIFTED" | "IN_SYNC" | null;
  changeSets: Map<string, { template: string; params: Record<string, string>; changes: CfnChange[] }>;
  /** Logical ids kept by DeletionPolicy: Retain when the stack was deleted. */
  retained?: string[];
}

export interface EcsTaskDefinition {
  cpu: string;
  memory: string;
  networkMode: string;
  compatibilities: string[];
  executionRoleArn: string | null;
  containers: { name: string; image: string; ports: number[]; essential: boolean }[];
}

export interface CostItem {
  /** "2026-10" */
  month: string;
  service: string;
  amount: number;
  tags: Record<string, string>;
}

export interface Budget {
  timeUnit: string;
  amount: number;
  unit: string;
  notifications: { type: string; operator: string; threshold: number; thresholdType: string; subscribers: string[] }[];
}

export interface GcpBudget {
  amount: number;
  currency: string;
  /** Thresholds as fractions with their basis, e.g. { percent: 0.9, basis: "current-spend" }. */
  thresholds: { percent: number; basis: string }[];
  filterLabels: Record<string, string>;
  filterProjects: string[];
}

export interface KmsKey {
  description: string;
  state: "Enabled" | "Disabled" | "PendingDeletion";
  /** null while automatic rotation is off. */
  rotationPeriodInDays: number | null;
  pendingWindowInDays: number | null;
}

export interface WafRule {
  name: string;
  priority: number;
  /** "managed:AWS/Name", "ipset:name:Block", "geo:CN,RU:Block" or "rate:1000:Block". */
  summary: string;
}

export interface GcpKmsKey {
  purpose: string;
  /** For example "7776000s"; null without automatic rotation. */
  rotationPeriod: string | null;
  nextRotationTime: string | null;
  /** Version states in order, version 1 first: ENABLED, DISABLED, DESTROY_SCHEDULED. */
  versions: string[];
  primary: number;
  /** Version numbers brought back with `versions restore`. */
  restored: number[];
}

export interface TrailEvent {
  eventName: string;
  username: string;
  eventSource: string;
  resourceName: string;
  eventTime: string;
}

export interface LogEntry {
  severity: string;
  resourceType: string;
  logName: string;
  text: string;
  timestamp: string;
}

export interface ManagedInstanceGroup {
  zone: string;
  template: string;
  targetSize: number;
  instances: string[];
  namedPorts: Map<string, number>;
  autoscaler: { min: number; max: number; cpu: number } | null;
  /** Instances the group recreated after they were deleted. */
  recreated: number;
  /** Running counter for instance name suffixes. */
  created: number;
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

/** A DynamoDB attribute value in the API's typed JSON form, e.g. { "S": "abc" } or { "N": "42" }. */
export type DynamoValue = Record<string, unknown>;

export interface DynamoTable {
  partitionKey: { name: string; type: "S" | "N" | "B" };
  sortKey: { name: string; type: "S" | "N" | "B" } | null;
  billingMode: "PAY_PER_REQUEST" | "PROVISIONED";
  provisioned: { read: number; write: number } | null;
  ttlAttribute: string | null;
  /** Keyed by the key values: "pk" or "pk|sk". */
  items: Map<string, Record<string, DynamoValue>>;
  /** Partition key values used in Query calls, so labs can check that a query was run. */
  queried: Set<string>;
}

export interface FirestoreDatabase {
  location: string;
  type: "firestore-native" | "datastore-mode";
  edition: "standard" | "enterprise";
  deleteProtection: boolean;
  /** Manual (composite) indexes, e.g. "orders(customerId ASCENDING, createdAt DESCENDING)". */
  indexes: Set<string>;
  /** TTL fields as "collectionGroup.field". */
  ttlFields: Set<string>;
  exports: number;
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
  /** Port requests are sent to inside the container (PORT); 8080 by default. */
  port: number;
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
      /** Key-value labels, used to break down costs. */
      labels: Map<string, string>;
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
  firestore: { databases: Map<string, FirestoreDatabase> };
  instanceTemplates: Map<string, { machineType: string; tags: Set<string>; network: string }>;
  migs: Map<string, ManagedInstanceGroup>;
  healthChecks: Map<string, { port: number; path: string }>;
  backendServices: Map<
    string,
    {
      protocol: string;
      portName: string;
      healthCheck: string;
      scheme: string;
      backends: Set<string>;
      cdn: boolean;
      cacheMode: string | null;
      securityPolicy: string | null;
    }
  >;
  /** Backend buckets: a Cloud Storage bucket behind the load balancer, optionally with Cloud CDN. */
  backendBuckets: Map<string, { gcsBucket: string; cdn: boolean; cacheMode: string | null }>;
  /** Exactly one of defaultService / defaultBackendBucket is set. */
  urlMaps: Map<string, { defaultService: string | null; defaultBackendBucket: string | null; invalidations: string[] }>;
  httpProxies: Map<string, { urlMap: string }>;
  forwardingRules: Map<string, { target: string; port: number; ipAddress: string }>;
  logging: {
    entries: LogEntry[];
    /** Normalised filters used with `gcloud logging read`. */
    queries: Set<string>;
    metrics: Map<string, { filter: string; description: string }>;
    /** Log buckets: _Required and _Default exist in every project. */
    buckets: Map<string, { retentionDays: number; locked: boolean }>;
    sinks: Map<string, { destination: string; filter: string }>;
  };
  /** GKE clusters by name. */
  gke: { clusters: Map<string, { location: string; mode: "autopilot" | "standard"; numNodes: number; k8s: K8sObjects }> };
  /** Artifact Registry repositories keyed "location/name"; images keyed "image:tag" -> image id. */
  artifacts: { repositories: Map<string, { format: string; description: string; immutableTags: boolean; images: Map<string, string> }> };
  /** Cloud Storage → Pub/Sub notification configurations by bucket name. */
  storageNotifications: Map<string, GcsNotification[]>;
  /** Pub/Sub topics and subscriptions by id. */
  pubsub: {
    topics: Map<string, { iam: Map<string, Set<string>>; published: number }>;
    subscriptions: Map<string, PubsubSubscription>;
    counter: number;
  };
  /** Cloud Build builds by id. */
  cloudbuild: { builds: Map<string, BuildRecord>; counter: number };
  /** The billing account linked to the project and its budgets (by display name). */
  billing: { accountId: string; accountName: string; linked: boolean; budgets: Map<string, GcpBudget> };
  /** Key rings keyed "location/name". */
  kms: { keyRings: Map<string, { keys: Map<string, GcpKmsKey> }> };
  /** Cloud Armor security policies; rules keyed by priority. */
  securityPolicies: Map<string, { description: string; rules: Map<number, { action: string; srcIpRanges: string[]; description: string; preview: boolean }> }>;
  /** Cloud DNS managed zones by name; records keyed "name|type". */
  dns: { zones: Map<string, { dnsName: string; description: string; visibility: string; nameServers: string[]; records: Map<string, { ttl: number; rrdatas: string[] }> }> };
  monitoring: {
    uptimeChecks: Map<string, { resourceType: string; host: string; path: string; period: number }>;
    /** Alert policies by display name. */
    policies: Map<string, { conditionFilter: string; comparison: string; threshold: number | null; duration: string; channels: string[] }>;
  };
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
  /** The local Docker engine: images by "repository:tag", containers by name, registries logged in to. */
  docker: DockerState;
  /** kubectl's kubeconfig: contexts point at an EKS or GKE cluster. */
  kube: { contexts: Map<string, { provider: "aws" | "gcp"; cluster: string }>; current: string | null };
  /** Terraform working directories (absolute path) and their state. */
  terraform: Map<string, TfWorkspace>;
  aws: AwsState;
  gcp: GcpState;
  /** Simulated seconds since the lab started; `sleep` moves it forward. */
  clock: number;
}

export interface DockerImage {
  id: string;
  base: string;
  exposed: number[];
  cmd: string;
  sizeMb: number;
  /** Content of an index.html copied into the image, served by `curl` against a running container. */
  index: string | null;
}

export interface K8sDeployment {
  labels: Record<string, string>;
  selector: Record<string, string>;
  templateLabels: Record<string, string>;
  containers: { name: string; image: string; ports: number[] }[];
  replicas: number;
  /** Container specs (as JSON) per rollout revision, oldest first; the last is current. */
  history: { revision: number; spec: string }[];
  /** Bumped when a Pod is deleted, so the replacement gets a new name. */
  restarts: number;
}

export interface K8sService {
  type: "ClusterIP" | "NodePort" | "LoadBalancer";
  selector: Record<string, string>;
  ports: { port: number; targetPort: number; nodePort: number | null }[];
  clusterIP: string;
}

/** Kubernetes objects inside one cluster; keys are "namespace/name". */
export interface K8sObjects {
  namespaces: Set<string>;
  deployments: Map<string, K8sDeployment>;
  services: Map<string, K8sService>;
}

export interface DockerState {
  images: Map<string, DockerImage>;
  containers: Map<string, { image: string; ports: string[]; status: "running" | "exited" }>;
  logins: Set<string>;
}

export interface InitialState {
  files?: Record<string, string>;
  /** Commands run by startLab() after the files and cloud are seeded. */
  setup?: string[];
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
    docker: { images: new Map(), containers: new Map(), logins: new Set() },
    kube: { contexts: new Map(), current: null },
    terraform: new Map(),
    clock: 0,
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
    ec2: { instances: new Map(), securityGroups: new Map(), volumes: new Map(), snapshots: new Map(), launchTemplates: new Map(), created: 0 },
    lambda: { functions: new Map() },
    dynamodb: { tables: new Map() },
    elbv2: { targetGroups: new Map(), loadBalancers: new Map(), listeners: new Map() },
    autoscaling: { groups: new Map() },
    sns: { topics: new Map() },
    cloudwatch: { alarms: new Map() },
    logs: { groups: new Map() },
    cloudtrail: { events: [] },
    route53: { zones: new Map(), created: 0 },
    cloudfront: { distributions: new Map(), created: 0 },
    kms: { keys: new Map(), aliases: new Map(), created: 0 },
    ce: { costs: [], tagStatus: new Map(), queries: new Set(), forecasts: 0 },
    ecr: { repositories: new Map() },
    cloudformation: { stacks: new Map() },
    codebuild: { projects: new Map(), builds: new Map(), counter: 0 },
    sqs: { queues: new Map(), counter: 0 },
    s3Notifications: new Map(),
    ecs: { clusters: new Set(), taskDefinitions: new Map(), services: new Map() },
    eks: { clusters: new Map() },
    budgets: new Map(),
    wafv2: { ipSets: new Map(), webAcls: new Map() },
    vpc: { vpcs: new Map(), subnets: new Map(), internetGateways: new Map(), routeTables: new Map() },
    rds: { subnetGroups: new Map(), instances: new Map(), snapshots: new Map() },
  };
  // { logs: { "/app/web": [{ stream, message }] }, cloudtrail: [{ eventName, username, eventSource, resourceName, eventTime }] }
  const awsSeed = isRecord(cloud.aws) ? cloud.aws : {};
  // { costs: [{ month: "2026-10", service, amount, tags: { Project: "web" } }] }: Cost Explorer data.
  if (Array.isArray(awsSeed.costs)) {
    aws.ce.costs = awsSeed.costs.filter(isRecord).map((c) => ({
      month: String(c.month ?? ""),
      service: String(c.service ?? ""),
      amount: Number(c.amount ?? 0),
      tags: isRecord(c.tags) ? Object.fromEntries(Object.entries(c.tags).map(([k, v]) => [k, String(v)])) : {},
    }));
  }
  // { ec2: { instances: { id: { instanceType, state, availabilityZone } }, volumes: { id: { size, type, availabilityZone, attachedTo } } } }
  if (isRecord(awsSeed.ec2)) {
    const ec2 = awsSeed.ec2;
    if (isRecord(ec2.instances)) {
      for (const [id, raw] of Object.entries(ec2.instances)) {
        const i = isRecord(raw) ? raw : {};
        aws.ec2.instances.set(id, {
          imageId: String(i.imageId ?? "ami-0abcdef1234567890"),
          instanceType: String(i.instanceType ?? "t3.micro"),
          state: i.state === "stopped" ? "stopped" : "running",
          securityGroups: [],
          availabilityZone: String(i.availabilityZone ?? "us-east-1a"),
        });
      }
    }
    if (isRecord(ec2.volumes)) {
      for (const [id, raw] of Object.entries(ec2.volumes)) {
        const v = isRecord(raw) ? raw : {};
        aws.ec2.volumes.set(id, {
          availabilityZone: String(v.availabilityZone ?? "us-east-1a"),
          size: Number(v.size ?? 8),
          type: String(v.type ?? "gp3"),
          snapshotId: null,
          attachment: typeof v.attachedTo === "string" ? { instanceId: v.attachedTo, device: String(v.device ?? "/dev/xvda") } : null,
        });
      }
    }
  }
  // { kms: { "alias/name": { description } } }: existing symmetric keys, each with an alias.
  if (isRecord(awsSeed.kms)) {
    Object.entries(awsSeed.kms).forEach(([alias, raw], i) => {
      const id = `0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1${String(i).padStart(2, "0")}`;
      aws.kms.keys.set(id, { description: isRecord(raw) && typeof raw.description === "string" ? raw.description : "", state: "Enabled", rotationPeriodInDays: null, pendingWindowInDays: null });
      aws.kms.aliases.set(alias, id);
    });
  }
  if (isRecord(awsSeed.logs)) {
    for (const [group, events] of Object.entries(awsSeed.logs)) {
      const list = Array.isArray(events) ? events.filter(isRecord) : [];
      aws.logs.groups.set(group, {
        retentionInDays: null,
        events: list.map((e, i) => ({ stream: String(e.stream ?? "app"), timestamp: 1763251200000 + i * 60000, message: String(e.message ?? "") })),
        searches: new Set(),
        metricFilters: new Map(),
      });
    }
  }
  if (Array.isArray(awsSeed.cloudtrail)) {
    aws.cloudtrail.events = awsSeed.cloudtrail.filter(isRecord).map((e) => ({
      eventName: String(e.eventName ?? ""),
      username: String(e.username ?? ""),
      eventSource: String(e.eventSource ?? ""),
      resourceName: String(e.resourceName ?? ""),
      eventTime: String(e.eventTime ?? "2026-11-15T00:00:00Z"),
    }));
  }
  const seed = isRecord(cloud.aws) && isRecord(cloud.aws.vpcs) ? cloud.aws.vpcs : {};
  for (const [vpcId, raw] of Object.entries(seed)) {
    if (!isRecord(raw) || typeof raw.cidr !== "string") continue;
    aws.vpc.vpcs.set(vpcId, { cidr: raw.cidr });
    const routes = new Map([[raw.cidr, "local"]]);
    // { internetGateway: true } attaches a gateway and routes the main table to it, making every subnet public.
    if (raw.internetGateway === true) {
      const igw = `igw-0seed${String(aws.vpc.internetGateways.size).padStart(12, "0")}`;
      aws.vpc.internetGateways.set(igw, { vpcId });
      routes.set("0.0.0.0/0", igw);
    }
    aws.vpc.routeTables.set(`rtb-0seed${String(aws.vpc.routeTables.size).padStart(12, "0")}`, {
      vpcId,
      main: true,
      routes,
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
  // { instances: { name: { zone, machineType, status, labels } } }
  const instances: GcpState["instances"] = new Map();
  if (isRecord(gcp.instances)) {
    for (const [name, raw] of Object.entries(gcp.instances)) {
      const i = isRecord(raw) ? raw : {};
      instances.set(name, {
        zone: String(i.zone ?? "asia-east1-b"),
        machineType: String(i.machineType ?? "e2-medium"),
        status: i.status === "TERMINATED" ? "TERMINATED" : "RUNNING",
        tags: new Set(),
        labels: new Map(isRecord(i.labels) ? Object.entries(i.labels).map(([k, v]) => [k, String(v)]) : []),
        network: "default",
        subnet: "default",
        externalIp: true,
      });
    }
  }
  // { disks: { name: { zone, sizeGb, type, users: [instance] } } }
  const disks: GcpState["disks"] = new Map();
  if (isRecord(gcp.disks)) {
    for (const [name, raw] of Object.entries(gcp.disks)) {
      const d = isRecord(raw) ? raw : {};
      const users = Array.isArray(d.users) ? d.users.filter((u): u is string => typeof u === "string") : [];
      disks.set(name, { zone: String(d.zone ?? "asia-east1-b"), sizeGb: Number(d.sizeGb ?? 10), type: String(d.type ?? "pd-balanced"), sourceSnapshot: null, users: new Map(users.map((u) => [u, "rw" as const])) });
    }
  }
  return {
    project: typeof gcp.project === "string" ? gcp.project : DEFAULT_GCP_PROJECT,
    serviceAccounts: new Map(),
    bindings,
    instances,
    firewallRules: new Map(),
    // Every new project starts with the auto mode "default" network.
    networks: new Map([["default", { mode: "auto" as const }]]),
    subnets: new Map(),
    routers: new Map(),
    sql: { instances: new Map(), backupsCreated: 0 },
    disks,
    snapshots: new Map(),
    run: { services: new Map(), revisionsCreated: 0 },
    firestore: { databases: new Map() },
    instanceTemplates: new Map(),
    migs: new Map(),
    healthChecks: new Map(),
    backendServices: new Map(),
    backendBuckets: new Map(),
    urlMaps: new Map(),
    httpProxies: new Map(),
    forwardingRules: new Map(),
    logging: {
      // { gcp: { logs: [{ severity, resourceType, logName, text, timestamp }] } }
      entries: (Array.isArray(gcp.logs) ? gcp.logs.filter(isRecord) : []).map((e, i) => ({
        severity: String(e.severity ?? "INFO"),
        resourceType: String(e.resourceType ?? "gce_instance"),
        logName: String(e.logName ?? "syslog"),
        text: String(e.text ?? ""),
        timestamp: String(e.timestamp ?? `2026-11-16T08:${String(i % 60).padStart(2, "0")}:00Z`),
      })),
      queries: new Set(),
      metrics: new Map(),
      // Default retention: _Required 400 days (fixed), _Default 30 days.
      buckets: new Map([
        ["_Required", { retentionDays: 400, locked: true }],
        ["_Default", { retentionDays: 30, locked: false }],
      ]),
      sinks: new Map(),
    },
    monitoring: { uptimeChecks: new Map(), policies: new Map() },
    dns: { zones: new Map() },
    kms: { keyRings: new Map() },
    securityPolicies: new Map(),
    artifacts: { repositories: new Map() },
    cloudbuild: { builds: new Map(), counter: 0 },
    pubsub: { topics: new Map(), subscriptions: new Map(), counter: 0 },
    storageNotifications: new Map(),
    gke: { clusters: new Map() },
    billing: {
      accountId: isRecord(gcp.billingAccount) && typeof gcp.billingAccount.id === "string" ? gcp.billingAccount.id : "0X0X0X-0X0X0X-0X0X0X",
      accountName: isRecord(gcp.billingAccount) && typeof gcp.billingAccount.name === "string" ? gcp.billingAccount.name : "My Billing Account",
      linked: true,
      budgets: new Map(),
    },
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
    docker: structuredClone(state.docker),
    kube: structuredClone(state.kube),
    terraform: structuredClone(state.terraform),
    clock: state.clock,
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

/**
 * Health of a target in a target group: "unused" until a listener forwards to
 * the group, then "healthy" while the instance is running.
 */
export function targetHealth(state: LabState, targetGroup: string, instanceId: string): "healthy" | "unhealthy" | "unused" {
  const used = [...state.aws.elbv2.listeners.values()].some((l) => l.targetGroup === targetGroup);
  if (!used) return "unused";
  return state.aws.ec2.instances.get(instanceId)?.state === "running" ? "healthy" : "unhealthy";
}

function elbView(state: LabState) {
  const { targetGroups, loadBalancers, listeners } = state.aws.elbv2;
  return {
    targetGroups: Object.fromEntries(
      [...targetGroups].map(([name, t]) => {
        const health = Object.fromEntries([...t.targets].map((id) => [id, targetHealth(state, name, id)]));
        return [
          name,
          {
            protocol: t.protocol,
            port: t.port,
            healthCheckPath: t.healthCheckPath,
            targets: health,
            healthyTargets: Object.values(health).filter((h) => h === "healthy").length,
          },
        ];
      }),
    ),
    loadBalancers: Object.fromEntries(
      [...loadBalancers].map(([name, lb]) => [
        name,
        {
          scheme: lb.scheme,
          availabilityZones: keysTrue(lb.subnets.map((sub) => state.aws.vpc.subnets.get(sub)?.availabilityZone ?? "")),
          listeners: Object.fromEntries([...listeners.values()].filter((l) => l.loadBalancer === name).map((l) => [`${l.protocol}:${l.port}`, l.targetGroup])),
        },
      ]),
    ),
  };
}

function autoscalingView(state: LabState) {
  return {
    groups: Object.fromEntries(
      [...state.aws.autoscaling.groups].map(([name, g]) => [
        name,
        {
          launchTemplate: g.launchTemplate,
          min: g.min,
          max: g.max,
          desired: g.desired,
          inService: g.instances.length,
          availabilityZones: keysTrue(g.subnets.map((sub) => state.aws.vpc.subnets.get(sub)?.availabilityZone ?? "")),
          instanceZones: keysTrue(g.instances.map((id) => state.aws.ec2.instances.get(id)?.availabilityZone ?? "")),
          healthCheckType: g.healthCheckType,
          targetGroups: keysTrue(g.targetGroups),
          policies: Object.fromEntries([...g.policies].map(([p, v]) => [p, { metric: v.metric, target: v.target }])),
          replacedInstances: g.replaced,
        },
      ]),
    ),
  };
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

function awsView(state: LabState) {
  const aws = state.aws;
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
      launchTemplates: Object.fromEntries([...aws.ec2.launchTemplates].map(([n, t]) => [n, { imageId: t.imageId, instanceType: t.instanceType }])),
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
    sns: { topics: Object.fromEntries([...aws.sns.topics].map(([n, t]) => [n, { subscriptions: Object.fromEntries(t.subscriptions) }])) },
    cloudwatch: {
      alarms: Object.fromEntries(
        [...aws.cloudwatch.alarms].map(([n, a]) => {
          const ops: Record<string, string> = { GreaterThanThreshold: ">", GreaterThanOrEqualToThreshold: ">=", LessThanThreshold: "<", LessThanOrEqualToThreshold: "<=" };
          return [
            n,
            {
              namespace: a.namespace,
              metricName: a.metricName,
              statistic: a.statistic,
              // A readable summary, e.g. "CPUUtilization > 80 for 2 x 300s".
              condition: `${a.metricName} ${ops[a.comparisonOperator]} ${a.threshold} for ${a.evaluationPeriods} x ${a.period}s`,
              dimensions: a.dimensions,
              notifies: keysTrue(a.alarmActions),
              state: a.state,
            },
          ];
        }),
      ),
    },
    route53: {
      zones: Object.fromEntries(
        [...aws.route53.zones.values()].map((z) => {
          const records = [...z.records.values()];
          return [
            z.name,
            {
              nameServerCount: z.nameServers.length,
              records: Object.fromEntries(
                records
                  .filter((r) => r.setIdentifier === null)
                  .map((r) => [`${r.name}/${r.type}`, { ttl: r.ttl, values: r.values, aliasTo: aliasTarget(state, z, r) }]),
              ),
              weighted: records
                .filter((r) => r.setIdentifier !== null)
                .reduce<Record<string, Record<string, number>>>((acc, r) => {
                  (acc[`${r.name}/${r.type}`] ??= {})[r.setIdentifier!] = r.weight!;
                  return acc;
                }, {}),
            },
          ];
        }),
      ),
    },
    ecr: {
      repositories: Object.fromEntries(
        [...aws.ecr.repositories].map(([n, r]) => [n, { mutability: r.mutability, scanOnPush: r.scanOnPush, images: Object.fromEntries(r.images) }]),
      ),
    },
    s3Notifications: Object.fromEntries([...aws.s3Notifications].map(([b, cs]) => [b, Object.fromEntries(cs.map((c) => [c.id, c.destination.split(":").at(-1)!]))])),
    sqs: {
      queues: Object.fromEntries(
        [...aws.sqs.queues].map(([n, q]) => {
          const redrive = q.attributes.RedrivePolicy ? (JSON.parse(q.attributes.RedrivePolicy) as { deadLetterTargetArn: string; maxReceiveCount: number | string }) : null;
          return [
            n,
            {
              messages: q.messages.length,
              visibilityTimeout: Number(q.attributes.VisibilityTimeout),
              deadLetterQueue: redrive ? redrive.deadLetterTargetArn.split(":").at(-1)! : null,
              maxReceiveCount: redrive ? Number(redrive.maxReceiveCount) : null,
              hasPolicy: Boolean(q.attributes.Policy),
              sent: q.stats.sent,
              deletedAny: q.stats.deleted > 0,
              redelivered: q.stats.redelivered,
              movedToDeadLetter: q.stats.movedToDeadLetter > 0,
              receivedFromSns: q.stats.receivedFromSns,
              receivedS3Event: q.stats.receivedS3Event ?? false,
            },
          ];
        }),
      ),
    },
    codebuild: {
      projects: Object.fromEntries(
        [...aws.codebuild.projects].map(([n, p]) => {
          const runs = [...aws.codebuild.builds.values()].filter((b) => b.project === n);
          return [n, { source: p.source, image: p.image, privilegedMode: p.privileged, lastBuild: runs.at(-1)?.status ?? null, failedBuilds: runs.filter((b) => b.status === "FAILED").length }];
        }),
      ),
      builds: Object.fromEntries([...aws.codebuild.builds].map(([id, b]) => [id, { project: b.project, status: b.status, phases: Object.fromEntries(b.steps.map((x) => [x.name, x.status])) }])),
    },
    cloudformation: {
      stacks: Object.fromEntries(
        [...aws.cloudformation.stacks].map(([n, s]) => [
          n,
          {
            status: s.status,
            resources: Object.fromEntries([...s.resources].map(([l, r]) => [l, r.physicalId])),
            outputs: s.outputs,
            parameters: s.params,
            drift: s.drift,
            retained: keysTrue(s.retained ?? []),
          },
        ]),
      ),
    },
    eks: {
      clusters: Object.fromEntries(
        [...aws.eks.clusters].map(([n, c]) => [
          n,
          {
            status: "ACTIVE",
            nodegroups: Object.fromEntries([...c.nodegroups].map(([g, x]) => [g, { desired: x.desired, min: x.min, max: x.max }])),
            k8s: k8sView(state, { context: n, objects: c.k8s, nodes: [...c.nodegroups.values()].reduce((s, g) => s + g.desired, 0), provider: "aws" }),
          },
        ]),
      ),
    },
    ecs: {
      clusters: keysTrue(aws.ecs.clusters),
      taskDefinitions: Object.fromEntries(
        [...aws.ecs.taskDefinitions].flatMap(([family, revs]) =>
          revs.map((d, i) => [
            `${family}:${i + 1}`,
            { cpu: d.cpu, memory: d.memory, networkMode: d.networkMode, executionRole: d.executionRoleArn !== null, images: d.containers.map((c) => c.image) },
          ]),
        ),
      ),
      services: Object.fromEntries(
        [...aws.ecs.services].map(([k, s]) => {
          const [family, rev] = s.taskDefinition.split(":");
          const def = aws.ecs.taskDefinitions.get(family)![Number(rev) - 1];
          return [k, { taskDefinition: s.taskDefinition, desiredCount: s.desiredCount, runningCount: taskProblem(state, def) ? 0 : s.desiredCount, launchType: s.launchType }];
        }),
      ),
    },
    ce: {
      queries: keysTrue(aws.ce.queries),
      forecastCount: aws.ce.forecasts,
      costAllocationTags: Object.fromEntries([...new Set(aws.ce.costs.flatMap((c) => Object.keys(c.tags)))].map((k) => [k, aws.ce.tagStatus.get(k) ?? "Inactive"])),
    },
    budgets: Object.fromEntries(
      [...aws.budgets].map(([n, b]) => [
        n,
        {
          limit: `${b.amount} ${b.unit}`,
          timeUnit: b.timeUnit,
          notifications: Object.fromEntries(b.notifications.map((x) => [notificationLabel(x), keysTrue(x.subscribers)])),
        },
      ]),
    ),
    kms: {
      keyCount: aws.kms.keys.size,
      aliases: Object.fromEntries(
        [...aws.kms.aliases].map(([alias, id]) => {
          const k = aws.kms.keys.get(id)!;
          return [alias, { description: k.description, state: k.state, rotationPeriodInDays: k.rotationPeriodInDays, pendingWindowInDays: k.pendingWindowInDays }];
        }),
      ),
    },
    wafv2: {
      ipSets: Object.fromEntries([...aws.wafv2.ipSets].map(([n, i]) => [n, { scope: i.scope, addresses: keysTrue(i.addresses) }])),
      webAcls: Object.fromEntries(
        [...aws.wafv2.webAcls].map(([n, a]) => [
          n,
          {
            scope: a.scope,
            defaultAction: a.defaultAction,
            rules: Object.fromEntries(a.rules.map((r) => [r.name, r.summary])),
            associatedLoadBalancers: keysTrue(a.associations.map((arn) => [...aws.elbv2.loadBalancers].find(([, l]) => l.arn === arn)?.[0] ?? arn)),
          },
        ]),
      ),
    },
    cloudfront: {
      distributions: Object.fromEntries(
        [...aws.cloudfront.distributions.values()].map((d) => [d.origin, { defaultRootObject: d.defaultRootObject, invalidations: keysTrue(d.invalidations) }]),
      ),
    },
    logs: {
      groups: Object.fromEntries(
        [...aws.logs.groups].map(([n, g]) => [
          n,
          { retentionInDays: g.retentionInDays, eventCount: g.events.length, searches: keysTrue(g.searches), metricFilters: plain(g.metricFilters) },
        ]),
      ),
    },
    dynamodb: {
      tables: Object.fromEntries(
        [...aws.dynamodb.tables].map(([name, t]) => [
          name,
          {
            definition: { partitionKey: t.partitionKey.name, sortKey: t.sortKey?.name ?? null, billingMode: t.billingMode },
            itemCount: t.items.size,
            items: keysTrue(t.items.keys()),
            ttlAttribute: t.ttlAttribute,
            queriedPartitions: keysTrue(t.queried),
          },
        ]),
      ),
    },
  };
}

function gcpView(state: LabState) {
  const gcp = state.gcp;
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
          labels: Object.fromEntries(i.labels),
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
    instanceTemplates: Object.fromEntries([...gcp.instanceTemplates].map(([n, t]) => [n, { machineType: t.machineType, tags: keysTrue(t.tags) }])),
    migs: Object.fromEntries(
      [...gcp.migs].map(([n, g]) => [
        n,
        { zone: g.zone, template: g.template, targetSize: g.targetSize, size: g.instances.length, namedPorts: Object.fromEntries(g.namedPorts), autoscaler: g.autoscaler, recreated: g.recreated },
      ]),
    ),
    healthChecks: plain(gcp.healthChecks),
    backendServices: Object.fromEntries(
      [...gcp.backendServices].map(([n, b]) => [
        n,
        { portName: b.portName, healthCheck: b.healthCheck, scheme: b.scheme, backends: keysTrue(b.backends), healthyInstances: healthyBackends(state, n).length, cdn: b.cdn, cacheMode: b.cacheMode, securityPolicy: b.securityPolicy },
      ]),
    ),
    forwardingRules: Object.fromEntries(
      [...gcp.forwardingRules].map(([n, r]) => [n, { ipAddress: r.ipAddress, port: r.port, ...ruleServing(state, n) }]),
    ),
    firestore: {
      databases: Object.fromEntries(
        [...gcp.firestore.databases].map(([id, d]) => [
          id,
          {
            location: d.location,
            type: d.type,
            edition: d.edition,
            deleteProtection: d.deleteProtection,
            indexes: keysTrue(d.indexes),
            ttlFields: keysTrue(d.ttlFields),
            exportCount: d.exports,
          },
        ]),
      ),
    },
    logging: {
      queries: keysTrue(gcp.logging.queries),
      metrics: Object.fromEntries([...gcp.logging.metrics].map(([n, m]) => [n, { filter: m.filter }])),
      buckets: Object.fromEntries([...gcp.logging.buckets].map(([n, b]) => [n, { retentionDays: b.retentionDays }])),
      sinks: Object.fromEntries([...gcp.logging.sinks].map(([n, x]) => [n, { destination: x.destination, filter: x.filter }])),
    },
    backendBuckets: Object.fromEntries([...gcp.backendBuckets].map(([n, b]) => [n, { gcsBucket: b.gcsBucket, cdn: b.cdn, cacheMode: b.cacheMode }])),
    urlMaps: Object.fromEntries(
      [...gcp.urlMaps].map(([n, m]) => [n, { defaultService: m.defaultService, defaultBackendBucket: m.defaultBackendBucket, invalidations: keysTrue(m.invalidations) }]),
    ),
    kms: {
      keyRings: Object.fromEntries(
        [...gcp.kms.keyRings].map(([id, r]) => [
          id,
          {
            keys: Object.fromEntries(
              [...r.keys].map(([n, k]) => [
                n,
                {
                  purpose: k.purpose,
                  rotationPeriod: k.rotationPeriod,
                  primary: k.primary,
                  versions: Object.fromEntries(k.versions.map((v, i) => [String(i + 1), v])),
                  recovered: keysTrue(k.restored.filter((n) => k.versions[n - 1] === "ENABLED").map(String)),
                },
              ]),
            ),
          },
        ]),
      ),
    },
    gke: {
      clusters: Object.fromEntries(
        [...gcp.gke.clusters].map(([n, c]) => [
          n,
          {
            location: c.location,
            mode: c.mode,
            k8s: k8sView(state, { context: n, objects: c.k8s, nodes: c.mode === "autopilot" ? Infinity : c.numNodes, provider: "gcp" }),
          },
        ]),
      ),
    },
    artifacts: {
      repositories: Object.fromEntries([...gcp.artifacts.repositories].map(([k, r]) => [k, { format: r.format, images: Object.fromEntries(r.images) }])),
    },
    storageNotifications: Object.fromEntries([...gcp.storageNotifications].map(([b, cs]) => [b, Object.fromEntries(cs.map((c) => [c.id, c.topic]))])),
    pubsub: {
      topics: Object.fromEntries([...gcp.pubsub.topics].map(([n, t]) => [n, { published: t.published, iam: Object.fromEntries([...t.iam].map(([r, m]) => [r, keysTrue([...m])])) }])),
      subscriptions: Object.fromEntries(
        [...gcp.pubsub.subscriptions].map(([n, sub]) => [
          n,
          {
            topic: sub.topic,
            ackDeadline: sub.ackDeadline,
            backlog: sub.messages.length,
            deadLetterTopic: sub.deadLetter?.topic ?? null,
            maxDeliveryAttempts: sub.deadLetter?.maxAttempts ?? null,
            iam: Object.fromEntries([...sub.iam].map(([r, m]) => [r, keysTrue([...m])])),
            ackedAny: sub.stats.acked > 0,
            redelivered: sub.stats.redelivered,
            ackedAfterRedelivery: sub.stats.ackedAfterRedelivery,
            forwardedToDeadLetter: sub.stats.forwarded > 0,
          },
        ]),
      ),
    },
    cloudbuild: {
      builds: Object.fromEntries([...gcp.cloudbuild.builds].map(([id, b]) => [id, { status: b.status, steps: b.steps.map((x) => x.status) }])),
      lastBuild: [...gcp.cloudbuild.builds.values()].at(-1)?.status ?? null,
      failedBuilds: [...gcp.cloudbuild.builds.values()].filter((b) => b.status === "FAILURE").length,
    },
    billing: {
      linked: gcp.billing.linked,
      budgets: Object.fromEntries(
        [...gcp.billing.budgets].map(([n, b]) => [
          n,
          {
            amount: `${b.amount} ${b.currency}`,
            thresholds: Object.fromEntries(b.thresholds.map((t) => [`${Math.round(t.percent * 100)}%`, t.basis])),
            filterLabels: b.filterLabels,
            filterProjects: keysTrue(b.filterProjects),
          },
        ]),
      ),
    },
    securityPolicies: Object.fromEntries(
      [...gcp.securityPolicies].map(([n, p]) => [
        n,
        { rules: Object.fromEntries([...p.rules].map(([pr, r]) => [String(pr), { action: r.action, srcIpRanges: r.srcIpRanges, preview: r.preview }])) },
      ]),
    ),
    dns: {
      zones: Object.fromEntries(
        [...gcp.dns.zones].map(([n, z]) => [
          n,
          {
            dnsName: z.dnsName,
            visibility: z.visibility,
            records: Object.fromEntries(
              [...z.records].map(([k, r]) => {
                const [name, type] = k.split("|");
                const rule = type === "A" ? [...gcp.forwardingRules].find(([, f]) => r.rrdatas.includes(f.ipAddress))?.[0] ?? null : null;
                return [`${name}/${type}`, { ttl: r.ttl, rrdatas: r.rrdatas, forwardingRule: rule }];
              }),
            ),
          },
        ]),
      ),
    },
    monitoring: {
      uptimeChecks: Object.fromEntries([...gcp.monitoring.uptimeChecks].map(([n, u]) => [n, { host: u.host, path: u.path, period: u.period }])),
      policies: Object.fromEntries(
        [...gcp.monitoring.policies].map(([n, p]) => [
          n,
          { conditionFilter: p.conditionFilter, condition: `${p.comparison}${p.threshold === null ? "" : ` ${p.threshold}`} for ${p.duration}` },
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
 *   cloud.aws.dynamodb.tables[name].{definition, itemCount, items["pk|sk"], ttlAttribute, queriedPartitions[pk]},
 *   cloud.gcp.firestore.databases[id].{location, type, edition, deleteProtection, indexes[spec], ttlFields["group.field"], exportCount},
 *   cloud.aws.ec2.launchTemplates[name].{imageId, instanceType},
 *   cloud.aws.elbv2.targetGroups[name].{protocol, port, healthCheckPath, targets[id], healthyTargets},
 *   cloud.aws.elbv2.loadBalancers[name].{scheme, availabilityZones[az], listeners["HTTP:80"]},
 *   cloud.aws.autoscaling.groups[name].{launchTemplate, min, max, desired, inService, healthCheckType, targetGroups[name], policies[name], replacedInstances},
 *   cloud.gcp.instanceTemplates[name], cloud.gcp.migs[name].{zone, template, targetSize, size, namedPorts[name], autoscaler, recreated},
 *   cloud.gcp.backendServices[name].{portName, healthCheck, backends[mig], healthyInstances},
 *   cloud.gcp.forwardingRules[name].{ipAddress, port, backendService, serving},
 *   cloud.aws.sns.topics[name].subscriptions["protocol:endpoint"] = status,
 *   cloud.aws.cloudwatch.alarms[name].{namespace, metricName, statistic, condition, dimensions, notifies[topic], state},
 *   cloud.aws.logs.groups[name].{retentionInDays, eventCount, searches[pattern], metricFilters[name]},
 *   cloud.gcp.logging.{queries[filter], metrics[name].filter, buckets[id].retentionDays, sinks[name].{destination, filter}},
 *   cloud.aws.route53.zones["example.com."].{nameServerCount, records["www.example.com./A"].{ttl, values, aliasTo}, weighted["name./A"][setId] = weight},
 *     aliasTo is "cloudfront:<origin>", "elb:<name>", "record:<name>" or a DNS name,
 *   cloud.aws.cloudfront.distributions[origin].{defaultRootObject, invalidations[path]},
 *   cloud.gcp.backendBuckets[name].{gcsBucket, cdn, cacheMode}, cloud.gcp.backendServices[name].{cdn, cacheMode},
 *   cloud.gcp.urlMaps[name].{defaultService, defaultBackendBucket, invalidations[path]},
 *   cloud.gcp.dns.zones[name].{dnsName, visibility, records["www.example.com./A"].{ttl, rrdatas, forwardingRule}},
 *   cloud.aws.kms.{keyCount, aliases["alias/name"].{description, state, rotationPeriodInDays, pendingWindowInDays}},
 *   cloud.aws.wafv2.ipSets[name].{scope, addresses[cidr]}, cloud.aws.wafv2.webAcls[name].{scope, defaultAction, rules[name], associatedLoadBalancers[name]},
 *   cloud.gcp.kms.keyRings["location/ring"].keys[name].{purpose, rotationPeriod, primary, versions["1"], recovered["1"]},
 *   cloud.gcp.securityPolicies[name].rules["1000"].{action, srcIpRanges, preview}, cloud.gcp.backendServices[name].securityPolicy,
 *   cloud.aws.ce.{queries["SERVICE" | "TAG:Project:active"], forecastCount, costAllocationTags[key] = "Active" | "Inactive"},
 *   cloud.aws.budgets[name].{limit: "500 USD", timeUnit, notifications["ACTUAL > 80%"][subscriber]},
 *   cloud.gcp.billing.{linked, budgets[displayName].{amount, thresholds["90%"] = basis, filterLabels, filterProjects}},
 *   cloud.gcp.instances[name].labels,
 *   docker.{images["name:tag"].{id, base, exposed}, containers[name].{image, ports, status}, logins[registry]},
 *   cloud.aws.ecr.repositories[name].{mutability, scanOnPush, images[tag] = image id},
 *   cloud.aws.ecs.{clusters[name], taskDefinitions["family:1"].{cpu, memory, networkMode, executionRole, images}, services["cluster/name"].{taskDefinition, desiredCount, runningCount, launchType}},
 *   cloud.gcp.artifacts.repositories["location/name"].{format, images["image:tag"] = image id},
 *   kube.currentContext, terraform["~/dir"].{initialized, resources[address], outputs, driftRepairs, applies},
 *   cloud.aws.cloudformation.stacks[name].{status, resources[logicalId] = physical id, outputs, parameters, drift, retained[logicalId]},
 *   cloud.aws.s3Notifications[bucket][id] = queue name, cloud.gcp.storageNotifications[bucket][id] = topic,
 *   cloud.aws.sqs.queues[name].{messages, visibilityTimeout, deadLetterQueue, maxReceiveCount, hasPolicy, sent, deletedAny, redelivered, movedToDeadLetter, receivedFromSns, receivedS3Event},
 *   cloud.gcp.pubsub.topics[id].{published, iam[role][member]}, cloud.gcp.pubsub.subscriptions[id].{topic, ackDeadline, backlog, deadLetterTopic, maxDeliveryAttempts, iam[role][member], ackedAny, redelivered, ackedAfterRedelivery, forwardedToDeadLetter},
 *   cloud.aws.codebuild.projects[name].{source, image, privilegedMode, lastBuild, failedBuilds}, cloud.gcp.cloudbuild.{lastBuild, failedBuilds, builds[id].{status, steps}},
 *   cloud.aws.eks.clusters[name].{status, nodegroups[name].{desired, min, max}, k8s}, cloud.gcp.gke.clusters[name].{location, mode, k8s},
 *     k8s = {namespaces[name], deployments["ns/name"].{replicas, readyReplicas, images, revision}, services["ns/name"].{type, port, targetPort, endpoints, externalIp}},
 *   cloud.gcp.monitoring.{uptimeChecks[name].{host, path, period}, policies[displayName].{conditionFilter, condition}},
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
      aws: { ...awsView(state), elbv2: elbView(state), autoscaling: autoscalingView(state) },
      gcp: gcpView(state),
    },
    git: Object.fromEntries([...state.git].map(([root, repo]) => [displayPath(root), repoView(state, root, repo)])),
    docker: {
      images: Object.fromEntries([...state.docker.images].map(([ref, i]) => [ref, { id: i.id, base: i.base, exposed: i.exposed }])),
      containers: Object.fromEntries([...state.docker.containers].map(([n, c]) => [n, { image: c.image, ports: c.ports, status: c.status }])),
      logins: keysTrue(state.docker.logins),
    },
    kube: { currentContext: state.kube.current },
    terraform: Object.fromEntries(
      [...state.terraform].map(([dir, w]) => [
        displayPath(dir),
        { initialized: w.initialized, resources: keysTrue(w.resources.keys()), outputs: w.outputs, driftRepairs: w.driftRepairs, applies: w.applies },
      ]),
    ),
  };
}
