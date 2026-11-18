import { parseArgs, type Ctx } from "./context";
import { ACCOUNT, ECR_REGION } from "./docker";
import { error, table } from "./gcloud-common";
import { newObjects } from "./kubectl";

export const EKS_COMMANDS = ["create-cluster", "describe-cluster", "list-clusters", "create-nodegroup", "describe-nodegroup", "update-nodegroup-config", "update-kubeconfig"];
const VERSION = "1.34";

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

function shorthand(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // subnetIds=a,b,securityGroupIds=c: a value runs until the next "key=".
  let key = "";
  for (const part of text.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0 && /^[A-Za-z]+$/.test(part.slice(0, eq))) {
      key = part.slice(0, eq);
      out[key] = part.slice(eq + 1);
    } else if (key) out[key] += `,${part}`;
  }
  return out;
}

export const eksContext = (name: string) => `arn:aws:eks:${ECR_REGION}:${ACCOUNT}:cluster/${name}`;

export function eks(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !EKS_COMMANDS.includes(sub)) {
    ctx.err(sub ? `aws: 不支援的 eks 指令 '${sub}'。支援：${EKS_COMMANDS.join("、")}` : `usage: aws eks <command> [parameters]\n支援：${EKS_COMMANDS.join("、")}`);
    return 252;
  }
  const lists = ["--subnets", "--instance-types"];
  const options = ["--name", "--cluster-name", "--nodegroup-name", "--role-arn", "--node-role", "--resources-vpc-config", "--kubernetes-version", "--subnets", "--scaling-config", "--instance-types", "--region", "--output"];
  const opts = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const eq = rest[i].indexOf("=");
    const name = rest[i].startsWith("--") && eq !== -1 ? rest[i].slice(0, eq) : rest[i];
    if (!options.includes(name)) {
      ctx.err(`\nUnknown options: ${rest[i]}`);
      return 252;
    }
    const values = eq !== -1 ? [rest[i].slice(eq + 1)] : rest[i + 1] !== undefined ? [rest[++i]] : [];
    if (lists.includes(name)) while (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) values.push(rest[++i]);
    opts.set(name, values.flatMap((v) => (lists.includes(name) ? v.split(",") : [v])).filter(Boolean));
  }
  const opt = (n: string) => opts.get(`--${n}`)?.[0];
  const required = (names: string[]) => {
    const missing = names.filter((n) => !opts.has(`--${n}`));
    if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
    return missing.length === 0;
  };
  const clusters = ctx.state.aws.eks.clusters;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const subnets = ctx.state.aws.vpc.subnets;
  const roleOk = (arn: string) => /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn);
  const clusterJson = (name: string) => {
    const c = clusters.get(name)!;
    return {
      name,
      arn: eksContext(name),
      version: c.version,
      endpoint: `https://${name.toUpperCase().replace(/[^A-Z0-9]/g, "")}0A1B2C3D.gr7.${ECR_REGION}.eks.amazonaws.com`,
      roleArn: c.roleArn,
      resourcesVpcConfig: { subnetIds: c.subnets, vpcId: subnets.get(c.subnets[0])?.vpcId },
      status: "ACTIVE",
    };
  };
  const getCluster = (name: string | undefined) => {
    const c = name ? clusters.get(name) : undefined;
    if (!c) fail(ctx, "ResourceNotFoundException", operation, `No cluster found for name: ${name ?? ""}.`);
    return c;
  };

  switch (sub) {
    case "create-cluster": {
      if (!required(["name", "role-arn", "resources-vpc-config"])) return 252;
      const name = opt("name")!;
      if (!/^[0-9A-Za-z][A-Za-z0-9\-_]{0,99}$/.test(name)) return fail(ctx, "InvalidParameterException", operation, "叢集名稱要以英數字開頭，只能用英數字、- 和 _。");
      if (clusters.has(name)) return fail(ctx, "ResourceInUseException", operation, `Cluster already exists with name: ${name}`);
      if (!roleOk(opt("role-arn")!)) return fail(ctx, "InvalidParameterException", operation, "--role-arn 要是 EKS 叢集 IAM 角色的 ARN，例如 arn:aws:iam::123456789012:role/eksClusterRole");
      const ids = (shorthand(opt("resources-vpc-config")!).subnetIds ?? "").split(",").filter(Boolean);
      const missing = ids.find((id) => !subnets.has(id));
      if (missing) return fail(ctx, "InvalidParameterException", operation, `The subnet ID '${missing}' does not exist（用 aws ec2 describe-subnets 查子網路 ID）`);
      const azs = new Set(ids.map((id) => subnets.get(id)!.availabilityZone));
      if (azs.size < 2) return fail(ctx, "InvalidParameterException", operation, "Subnets specified must be in at least two different AZs");
      clusters.set(name, { roleArn: opt("role-arn")!, subnets: ids, version: opt("kubernetes-version") ?? VERSION, nodegroups: new Map(), k8s: newObjects() });
      json(ctx, { cluster: { ...clusterJson(name), status: "CREATING" } });
      ctx.out("（模擬終端機：叢集立即就緒；實際上建立控制平面要等一段時間，可以用 aws eks describe-cluster 看 status）\n");
      return 0;
    }
    case "describe-cluster":
      if (!required(["name"])) return 252;
      if (!getCluster(opt("name"))) return 254;
      json(ctx, { cluster: clusterJson(opt("name")!) });
      return 0;
    case "list-clusters":
      json(ctx, { clusters: [...clusters.keys()] });
      return 0;
    case "update-kubeconfig": {
      if (!required(["name"])) return 252;
      const name = opt("name")!;
      if (!getCluster(name)) return 254;
      const context = eksContext(name);
      const existed = ctx.state.kube.contexts.has(context);
      ctx.state.kube.contexts.set(context, { provider: "aws", cluster: name });
      ctx.state.kube.current = context;
      ctx.out(`${existed ? "Updated" : "Added new"} context ${context} to /home/learner/.kube/config\n`);
      return 0;
    }
    case "create-nodegroup": {
      if (!required(["cluster-name", "nodegroup-name", "node-role", "subnets"])) return 252;
      const c = getCluster(opt("cluster-name"));
      if (!c) return 254;
      const name = opt("nodegroup-name")!;
      if (c.nodegroups.has(name)) return fail(ctx, "ResourceInUseException", operation, `NodeGroup already exists with name ${name} and cluster name ${opt("cluster-name")}`);
      if (!roleOk(opt("node-role")!)) return fail(ctx, "InvalidParameterException", operation, "--node-role 要是節點 IAM 角色的 ARN，例如 arn:aws:iam::123456789012:role/eksNodeRole");
      const ids = opts.get("--subnets")!;
      const missing = ids.find((id) => !subnets.has(id));
      if (missing) return fail(ctx, "InvalidParameterException", operation, `The subnet ID '${missing}' does not exist`);
      const vpc = subnets.get(c.subnets[0])!.vpcId;
      if (ids.some((id) => subnets.get(id)!.vpcId !== vpc)) return fail(ctx, "InvalidParameterException", operation, "節點要和叢集在同一個 VPC。");
      const scaling = shorthand(opt("scaling-config") ?? "minSize=1,maxSize=2,desiredSize=2");
      const [min, max, desired] = [Number(scaling.minSize), Number(scaling.maxSize), Number(scaling.desiredSize)];
      if (![min, max, desired].every(Number.isInteger) || min > desired || desired > max || min < 0) {
        return fail(ctx, "InvalidParameterException", operation, "--scaling-config 的格式是 minSize=1,maxSize=3,desiredSize=2，而且 minSize ≤ desiredSize ≤ maxSize");
      }
      c.nodegroups.set(name, { nodeRole: opt("node-role")!, subnets: ids, min, max, desired, instanceTypes: opts.get("--instance-types") ?? ["t3.medium"] });
      json(ctx, { nodegroup: { nodegroupName: name, clusterName: opt("cluster-name"), status: "CREATING", scalingConfig: { minSize: min, maxSize: max, desiredSize: desired }, instanceTypes: opts.get("--instance-types") ?? ["t3.medium"], subnets: ids } });
      return 0;
    }
    case "describe-nodegroup":
    case "update-nodegroup-config": {
      if (!required(["cluster-name", "nodegroup-name"])) return 252;
      const c = getCluster(opt("cluster-name"));
      if (!c) return 254;
      const g = c.nodegroups.get(opt("nodegroup-name")!);
      if (!g) return fail(ctx, "ResourceNotFoundException", operation, `No node group found for name: ${opt("nodegroup-name")}.`);
      if (sub === "update-nodegroup-config") {
        const scaling = shorthand(opt("scaling-config") ?? "");
        const next = { min: Number(scaling.minSize ?? g.min), max: Number(scaling.maxSize ?? g.max), desired: Number(scaling.desiredSize ?? g.desired) };
        if (next.min > next.desired || next.desired > next.max) return fail(ctx, "InvalidParameterException", operation, "minSize ≤ desiredSize ≤ maxSize");
        Object.assign(g, next);
      }
      json(ctx, { nodegroup: { nodegroupName: opt("nodegroup-name"), status: "ACTIVE", scalingConfig: { minSize: g.min, maxSize: g.max, desiredSize: g.desired }, instanceTypes: g.instanceTypes } });
      return 0;
    }
  }
  return 0;
}

export const gkeContext = (project: string, location: string, name: string) => `gke_${project}_${location}_${name}`;

/** gcloud container clusters … */
export function container(ctx: Ctx, args: string[]): number {
  const [group, action, ...rest] = args;
  if (group !== "clusters") return error(ctx, "gcloud.container", `不支援 '${group ?? ""}'。這個模擬終端機支援 gcloud container clusters。`);
  const command = `gcloud.container.clusters.${action}`;
  const parsed = parseArgs(rest, { options: ["--location", "--region", "--zone", "--num-nodes", "--machine-type", "--project", "--format"], flags: ["--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gke = ctx.state.gcp.gke.clusters;
  const project = ctx.state.gcp.project;
  if (action === "list") {
    table(ctx, ["NAME", "LOCATION", "MASTER_VERSION", "NUM_NODES", "STATUS"], [...gke].map(([n, c]) => [n, c.location, `${VERSION}.1-gke.1000`, c.mode === "autopilot" ? "" : String(c.numNodes), "RUNNING"]));
    return 0;
  }
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument NAME: Must be specified.");
  const location = parsed.options.get("--location") ?? parsed.options.get("--region") ?? parsed.options.get("--zone");
  if (location === undefined) return error(ctx, command, "這個模擬終端機需要用 --location 指定位置，例如 --location=us-east4。");
  const setContext = () => {
    const context = gkeContext(project, location, name);
    ctx.state.kube.contexts.set(context, { provider: "gcp", cluster: name });
    ctx.state.kube.current = context;
  };
  switch (action) {
    case "create-auto":
    case "create": {
      if (!/^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/.test(name)) return error(ctx, command, "Invalid value for field 'cluster.name': 名稱要以小寫字母開頭，只能用小寫字母、數字和連字號，最多 40 個字元。");
      if (gke.has(name)) return error(ctx, command, `ResponseError: code=409, message=Already exists: projects/${project}/locations/${location}/clusters/${name}.`);
      const numNodes = Number(parsed.options.get("--num-nodes") ?? 3);
      if (action === "create" && (!Number.isInteger(numNodes) || numNodes < 0)) return error(ctx, command, "argument --num-nodes: 要是 0 以上的整數。");
      gke.set(name, { location, mode: action === "create-auto" ? "autopilot" : "standard", numNodes: action === "create-auto" ? 0 : numNodes, k8s: newObjects() });
      setContext();
      ctx.out(`Creating cluster ${name} in ${location}...done.\nCreated [https://container.googleapis.com/v1/projects/${project}/locations/${location}/clusters/${name}].\nkubeconfig entry generated for ${name}.\n`);
      table(ctx, ["NAME", "LOCATION", "MASTER_VERSION", "NUM_NODES", "STATUS"], [[name, location, `${VERSION}.1-gke.1000`, action === "create-auto" ? "" : String(numNodes), "RUNNING"]]);
      return 0;
    }
    case "get-credentials": {
      const c = gke.get(name);
      if (!c || c.location !== location) return error(ctx, command, `ResponseError: code=404, message=Not found: projects/${project}/locations/${location}/clusters/${name}.`);
      setContext();
      ctx.out(`Fetching cluster endpoint and auth data.\nkubeconfig entry generated for ${name}.\n`);
      return 0;
    }
    case "describe": {
      const c = gke.get(name);
      if (!c || c.location !== location) return error(ctx, command, `ResponseError: code=404, message=Not found: projects/${project}/locations/${location}/clusters/${name}.`);
      ctx.out(`${c.mode === "autopilot" ? "autopilot:\n  enabled: true\n" : `currentNodeCount: ${c.numNodes}\n`}location: ${location}\nname: ${name}\nstatus: RUNNING\n`);
      return 0;
    }
    case "resize": {
      const c = gke.get(name);
      if (!c || c.location !== location) return error(ctx, command, `ResponseError: code=404, message=Not found: projects/${project}/locations/${location}/clusters/${name}.`);
      if (c.mode === "autopilot") return error(ctx, command, "Autopilot 叢集的節點由 GKE 管理，不能手動調整。");
      const n = Number(parsed.options.get("--num-nodes"));
      if (!Number.isInteger(n) || n < 0) return error(ctx, command, "argument --num-nodes: Must be specified.");
      c.numNodes = n;
      ctx.out(`Resizing ${name}...done.\n`);
      return 0;
    }
    case "delete": {
      if (!gke.delete(name)) return error(ctx, command, `ResponseError: code=404, message=Not found: projects/${project}/locations/${location}/clusters/${name}.`);
      ctx.state.kube.contexts.delete(gkeContext(project, location, name));
      if (ctx.state.kube.current === gkeContext(project, location, name)) ctx.state.kube.current = null;
      ctx.out(`Deleting cluster ${name}...done.\n`);
      return 0;
    }
    default:
      return error(ctx, "gcloud.container.clusters", `不支援的指令 '${action ?? ""}'。支援 create-auto、create、list、describe、get-credentials、resize、delete。`);
  }
}
