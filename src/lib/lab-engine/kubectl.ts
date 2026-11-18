import { parseAllDocuments } from "yaml";
import { parseArgs, type Command, type Ctx } from "./context";
import { ECR_REGISTRY, parseTarget, remoteImage } from "./docker";
import { resolvePath, type K8sDeployment, type K8sObjects, type K8sService, type LabState } from "./state";

export const DEFAULT_NAMESPACES = ["default", "kube-node-lease", "kube-public", "kube-system"];

export const newObjects = (): K8sObjects => ({ namespaces: new Set(DEFAULT_NAMESPACES), deployments: new Map(), services: new Map() });

function hash(text: string, length: number, alphabet = "bcdfghjklmnpqrstvwxz2456789"): string {
  let x = 2166136261;
  for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 16777619) >>> 0;
  let out = "";
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += alphabet[(x >>> 16) % alphabet.length];
  }
  return out;
}

/** The cluster kubectl currently talks to. */
export interface Target {
  context: string;
  objects: K8sObjects;
  /** Nodes available to run Pods: Infinity for GKE Autopilot. */
  nodes: number;
  provider: "aws" | "gcp";
}

export function currentTarget(state: LabState): Target | null {
  const name = state.kube.current;
  const ctx = name ? state.kube.contexts.get(name) : undefined;
  if (!name || !ctx) return null;
  if (ctx.provider === "aws") {
    const c = state.aws.eks.clusters.get(ctx.cluster);
    if (!c) return null;
    return { context: name, objects: c.k8s, nodes: [...c.nodegroups.values()].reduce((s, g) => s + g.desired, 0), provider: "aws" };
  }
  const c = state.gcp.gke.clusters.get(ctx.cluster);
  if (!c) return null;
  return { context: name, objects: c.k8s, nodes: c.mode === "autopilot" ? Infinity : c.numNodes, provider: "gcp" };
}

const specOf = (d: K8sDeployment) => JSON.stringify(d.containers);
const templateHash = (key: string, d: K8sDeployment) => hash(`${key}|${specOf(d)}`, 10);

/** Why containers of this Deployment cannot start, or null. */
function imageProblem(state: LabState, d: K8sDeployment): string | null {
  for (const c of d.containers) {
    // Only this account's ECR and this project's Artifact Registry are simulated; other images are treated as public.
    const t = parseTarget(c.image);
    const ours = (t.kind === "ecr" && t.registry === ECR_REGISTRY) || (t.kind === "ar" && t.project === state.gcp.project);
    if (ours && !remoteImage(state, c.image)) return "ImagePullBackOff";
  }
  return null;
}

export interface PodView {
  name: string;
  namespace: string;
  deployment: string;
  status: "Running" | "Pending" | "ImagePullBackOff";
  ip: string;
  labels: Record<string, string>;
}

/** Pods are derived from Deployments: replicas, scheduled while nodes allow. */
export function pods(state: LabState, target: Target): PodView[] {
  const out: PodView[] = [];
  // A simple capacity model: up to 30 Pods per node.
  let capacity = target.nodes * 30;
  for (const [key, d] of target.objects.deployments) {
    const [namespace, name] = key.split("/");
    const rs = templateHash(key, d);
    const problem = imageProblem(state, d);
    for (let i = 0; i < d.replicas; i++) {
      const scheduled = capacity-- > 0;
      out.push({
        name: `${name}-${rs}-${hash(`${key}|${rs}|${i}|${d.restarts}`, 5)}`,
        namespace,
        deployment: key,
        status: !scheduled ? "Pending" : problem ? "ImagePullBackOff" : "Running",
        ip: scheduled ? `10.8.${(out.length * 7) % 250}.${(out.length * 13 + 2) % 250}` : "<none>",
        labels: d.templateLabels,
      });
    }
  }
  return out;
}

const matches = (labels: Record<string, string>, selector: Record<string, string>) =>
  Object.keys(selector).length > 0 && Object.entries(selector).every(([k, v]) => labels[k] === v);

/** External address of a LoadBalancer Service, once the cluster has nodes. */
export function externalIp(target: Target, key: string): string | null {
  const s = target.objects.services.get(key);
  if (!s || s.type !== "LoadBalancer" || target.nodes === 0) return null;
  return target.provider === "gcp" ? `34.118.${hash(key, 1, "123456789").charCodeAt(0) % 200}.${(key.length * 17) % 250}` : `a${hash(key, 31, "0123456789abcdef")}-${hash(key, 9, "0123456789")}.us-east-1.elb.amazonaws.com`;
}

export function endpoints(state: LabState, target: Target, key: string): string[] {
  const s = target.objects.services.get(key)!;
  const ns = key.split("/")[0];
  return pods(state, target)
    .filter((p) => p.namespace === ns && p.status === "Running" && matches(p.labels, s.selector))
    .map((p) => `${p.ip}:${s.ports[0]?.targetPort ?? 80}`);
}

// ---------------------------------------------------------------- manifests

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strMap = (v: unknown): Record<string, string> => (isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : {});

/** Validates and stores one manifest; returns the "kind/name verb" line or an error. */
function applyObject(target: Target, doc: Obj, defaultNs: string): { ok: string } | { error: string } {
  const kind = doc.kind;
  const meta = isObj(doc.metadata) ? doc.metadata : {};
  const name = meta.name;
  if (typeof kind !== "string" || typeof doc.apiVersion !== "string") return { error: 'error: error validating data: [apiVersion not set, kind not set]（每份資訊清單都要有 apiVersion 和 kind）' };
  if (typeof name !== "string" || !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name)) return { error: `The ${kind} "${String(name ?? "")}" is invalid: metadata.name: Invalid value（名稱要用小寫字母、數字和連字號）` };
  const ns = typeof meta.namespace === "string" ? meta.namespace : defaultNs;
  const o = target.objects;
  if (kind === "Namespace") {
    if (doc.apiVersion !== "v1") return { error: `error: resource mapping not found for name: "${name}" kind: "Namespace" in version "${doc.apiVersion}"（Namespace 的 apiVersion 是 v1）` };
    const verb = o.namespaces.has(name) ? "unchanged" : "created";
    o.namespaces.add(name);
    return { ok: `namespace/${name} ${verb}` };
  }
  if (!o.namespaces.has(ns)) return { error: `Error from server (NotFound): error when creating: namespaces "${ns}" not found（先用 kubectl create namespace ${ns} 建立命名空間）` };
  const key = `${ns}/${name}`;
  const spec = isObj(doc.spec) ? doc.spec : {};
  if (kind === "Deployment") {
    if (doc.apiVersion !== "apps/v1") return { error: `error: resource mapping not found for name: "${name}" namespace: "${ns}" from "": no matches for kind "Deployment" in version "${doc.apiVersion}"（Deployment 的 apiVersion 是 apps/v1）` };
    const selector = strMap(isObj(spec.selector) ? spec.selector.matchLabels : undefined);
    const template = isObj(spec.template) ? spec.template : {};
    const templateLabels = strMap(isObj(template.metadata) ? template.metadata.labels : undefined);
    if (!Object.keys(selector).length) return { error: `The Deployment "${name}" is invalid: spec.selector: Required value` };
    if (!matches(templateLabels, selector)) return { error: `The Deployment "${name}" is invalid: spec.template.metadata.labels: Invalid value: ${JSON.stringify(templateLabels)}: \`selector\` does not match template \`labels\`` };
    const podSpec = isObj(template.spec) ? template.spec : {};
    const raw = Array.isArray(podSpec.containers) ? podSpec.containers.filter(isObj) : [];
    if (!raw.length) return { error: `The Deployment "${name}" is invalid: spec.template.spec.containers: Required value` };
    const containers = [];
    for (const c of raw) {
      if (typeof c.name !== "string" || typeof c.image !== "string") return { error: `The Deployment "${name}" is invalid: spec.template.spec.containers[0]: 每個容器都要有 name 和 image` };
      containers.push({ name: c.name, image: c.image, ports: Array.isArray(c.ports) ? c.ports.filter(isObj).map((p) => Number(p.containerPort)).filter((p) => p > 0) : [] });
    }
    const replicas = spec.replicas === undefined ? 1 : Number(spec.replicas);
    if (!Number.isInteger(replicas) || replicas < 0) return { error: `The Deployment "${name}" is invalid: spec.replicas: Invalid value` };
    const existing = o.deployments.get(key);
    const next: K8sDeployment = existing
      ? { ...existing, labels: strMap(meta.labels), selector, templateLabels, containers, replicas, history: [...existing.history] }
      : { labels: strMap(meta.labels), selector, templateLabels, containers, replicas, history: [], restarts: 0 };
    if (existing && JSON.stringify(existing.selector) !== JSON.stringify(selector)) return { error: `The Deployment "${name}" is invalid: spec.selector: Invalid value: field is immutable` };
    recordRevision(next);
    o.deployments.set(key, next);
    const verb = !existing ? "created" : JSON.stringify({ ...existing, history: [] }) === JSON.stringify({ ...next, history: [] }) ? "unchanged" : "configured";
    return { ok: `deployment.apps/${name} ${verb}` };
  }
  if (kind === "Service") {
    if (doc.apiVersion !== "v1") return { error: `error: no matches for kind "Service" in version "${doc.apiVersion}"（Service 的 apiVersion 是 v1）` };
    const type = (spec.type ?? "ClusterIP") as string;
    if (!["ClusterIP", "NodePort", "LoadBalancer"].includes(type)) return { error: `The Service "${name}" is invalid: spec.type: Unsupported value: "${type}"（這個模擬終端機支援 ClusterIP、NodePort、LoadBalancer）` };
    const ports = Array.isArray(spec.ports) ? spec.ports.filter(isObj) : [];
    if (!ports.length) return { error: `The Service "${name}" is invalid: spec.ports: Required value` };
    const existing = o.services.get(key);
    const service: K8sService = {
      type: type as K8sService["type"],
      selector: strMap(spec.selector),
      ports: ports.map((p, i) => ({
        port: Number(p.port),
        targetPort: Number(p.targetPort ?? p.port),
        nodePort: type === "ClusterIP" ? null : 30000 + (Number(hash(`${key}${i}`, 3, "0123456789")) % 2768),
      })),
      clusterIP: existing?.clusterIP ?? `10.100.${hash(key, 2, "0123456789")}.${(key.length * 11) % 250}`,
    };
    if (service.ports.some((p) => !(p.port > 0) || !(p.targetPort > 0))) return { error: `The Service "${name}" is invalid: spec.ports[0].port: Invalid value` };
    const verb = !existing ? "created" : JSON.stringify(existing) === JSON.stringify(service) ? "unchanged" : "configured";
    o.services.set(key, service);
    return { ok: `service/${name} ${verb}` };
  }
  return { error: `error: resource mapping not found for name: "${name}" kind: "${kind}"（這個模擬終端機支援 Deployment、Service、Namespace）` };
}

/** Adds a rollout revision when the Pod template changed. */
function recordRevision(d: K8sDeployment) {
  const spec = specOf(d);
  const last = d.history.at(-1);
  if (last?.spec === spec) return;
  // Rolling back to an old template moves it to a new revision number, like Kubernetes.
  const revision = Math.max(0, ...d.history.map((h) => h.revision)) + 1;
  d.history = d.history.filter((h) => h.spec !== spec);
  d.history.push({ revision, spec });
}

// ------------------------------------------------------------------ kubectl

const RESOURCES: Record<string, "pods" | "deployments" | "services" | "nodes" | "namespaces" | "all" | "replicasets"> = {
  pod: "pods", pods: "pods", po: "pods",
  deployment: "deployments", deployments: "deployments", deploy: "deployments", "deployment.apps": "deployments",
  service: "services", services: "services", svc: "services",
  node: "nodes", nodes: "nodes", no: "nodes",
  namespace: "namespaces", namespaces: "namespaces", ns: "namespaces",
  replicaset: "replicasets", replicasets: "replicasets", rs: "replicasets",
  all: "all",
};

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + 3))).join("").trimEnd()).join("\n") + "\n";
}

/** "deployment/name" or "deployment name" -> [kind, name]. */
function resourceName(args: string[]): [string | undefined, string | undefined, number] {
  if (args[0]?.includes("/")) {
    const [k, n] = args[0].split("/");
    return [RESOURCES[k], n, 1];
  }
  return [RESOURCES[args[0] ?? ""], args[1], 2];
}

export const kubectl: Command = (ctx, argv) => {
  // Global flags such as -n may come before the subcommand: kubectl -n NS get pods.
  const args = [...argv];
  const leading: string[] = [];
  while (args[0] === "-n" || args[0] === "--namespace" || args[0]?.startsWith("--namespace=")) {
    const flag = args.shift()!;
    leading.push(flag);
    if (!flag.includes("=") && args.length) leading.push(args.shift()!);
  }
  const [sub, ...afterSub] = args;
  const rest = [...afterSub, ...leading];
  const err = (message: string, code = 1) => {
    ctx.err(message);
    return code;
  };
  if (sub === "version") {
    ctx.out("Client Version: v1.34.1（模擬終端機）\n");
    return 0;
  }
  if (sub === "config") return config(ctx, rest);
  const target = currentTarget(ctx.state);
  if (!target) {
    return err(
      'E1118 08:00:00.000000   memcache.go:265] couldn\'t get current server API group list: Get "http://localhost:8080/api?timeout=32s": dial tcp 127.0.0.1:8080: connect: connection refused\nThe connection to the server localhost:8080 was refused - did you specify the right host or port?\n（kubectl 還沒有設定叢集：EKS 用 aws eks update-kubeconfig，GKE 用 gcloud container clusters get-credentials）',
    );
  }
  const parsed = parseArgs(rest, {
    options: ["-n", "--namespace", "-f", "--filename", "-l", "--selector", "--image", "--replicas", "--type", "--port", "--target-port", "--name", "--to-revision", "-o", "--output"],
    flags: ["-A", "--all-namespaces", "--watch", "-w"],
  });
  if (parsed.unknown) return err(`error: unknown flag: ${parsed.unknown}`);
  const ns = parsed.options.get("-n") ?? parsed.options.get("--namespace") ?? "default";
  const all = parsed.flags.has("-A") || parsed.flags.has("--all-namespaces");
  const o = target.objects;
  if (!all && !o.namespaces.has(ns) && sub !== "create") return err(`Error from server (NotFound): namespaces "${ns}" not found`);
  const pos = parsed.positional;
  const notFound = (kind: string, name: string) => err(`Error from server (NotFound): ${kind} "${name}" not found`);

  switch (sub) {
    case "apply":
    case "delete": {
      const file = parsed.options.get("-f") ?? parsed.options.get("--filename");
      if (sub === "delete" && file === undefined) return deleteByName(ctx, target, pos, ns);
      if (file === undefined) return err("error: must specify one of -f and -k");
      const abs = resolvePath(ctx.state.cwd, file);
      const text = ctx.state.files.get(abs);
      if (text === undefined) return err(`error: the path "${file}" does not exist`);
      let docs: Obj[];
      try {
        docs = parseAllDocuments(text)
          .map((d) => {
            if (d.errors.length) throw new Error(d.errors[0].message.split("\n")[0]);
            return d.toJS() as unknown;
          })
          .filter(isObj);
      } catch (e) {
        return err(`error: error parsing ${file}: error converting YAML to JSON: ${(e as Error).message}\n（YAML 用空白縮排，不能用 Tab；冒號後面要有空格）`);
      }
      if (!docs.length) return err(`error: no objects passed to ${sub}`);
      let code = 0;
      for (const doc of docs) {
        if (sub === "apply") {
          const r = applyObject(target, doc, ns);
          if ("ok" in r) ctx.out(`${r.ok}\n`);
          else {
            ctx.err(r.error);
            code = 1;
          }
        } else {
          const meta = isObj(doc.metadata) ? doc.metadata : {};
          code = Math.max(code, deleteByName(ctx, target, [String(doc.kind ?? "").toLowerCase(), String(meta.name ?? "")], typeof meta.namespace === "string" ? meta.namespace : ns));
        }
      }
      return code;
    }
    case "create": {
      const [kind, name] = pos;
      if (kind === "namespace" || kind === "ns") {
        if (!name) return err("error: exactly one NAME is required, got 0");
        if (o.namespaces.has(name)) return err(`Error from server (AlreadyExists): namespaces "${name}" already exists`);
        o.namespaces.add(name);
        ctx.out(`namespace/${name} created\n`);
        return 0;
      }
      if (kind === "deployment" || kind === "deploy") {
        if (!name) return err("error: exactly one NAME is required, got 0");
        const image = parsed.options.get("--image");
        if (!image) return err("error: required flag(s) \"image\" not set");
        if (!o.namespaces.has(ns)) return err(`error: failed to create deployment: namespaces "${ns}" not found`);
        if (o.deployments.has(`${ns}/${name}`)) return err(`error: failed to create deployment: deployments.apps "${name}" already exists`);
        const replicas = Number(parsed.options.get("--replicas") ?? 1);
        const containerName = image.split("/").at(-1)!.split(":")[0].split("@")[0];
        const r = applyObject(target, {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name, namespace: ns, labels: { app: name } },
          spec: { replicas, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: containerName, image }] } } },
        }, ns);
        if ("error" in r) return err(r.error);
        ctx.out(`deployment.apps/${name} created\n`);
        return 0;
      }
      return err(`這個模擬終端機的 kubectl create 支援 namespace 和 deployment，其他資源請寫成 YAML 用 kubectl apply -f。`);
    }
    case "expose": {
      const [kind, name] = resourceName(pos);
      if (kind !== "deployments" || !name) return err("這個模擬終端機的 kubectl expose 支援 deployment，例如 kubectl expose deployment hello --type LoadBalancer --port 80 --target-port 8080");
      const d = o.deployments.get(`${ns}/${name}`);
      if (!d) return notFound("deployments.apps", name);
      const port = parsed.options.get("--port");
      if (port === undefined) return err("error: couldn't find port via --port flag or introspection\n（請用 --port 指定 Service 的連接埠）");
      const serviceName = parsed.options.get("--name") ?? name;
      if (o.services.has(`${ns}/${serviceName}`)) return err(`Error from server (AlreadyExists): services "${serviceName}" already exists`);
      const r = applyObject(target, {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: serviceName, namespace: ns },
        spec: { type: parsed.options.get("--type") ?? "ClusterIP", selector: d.selector, ports: [{ port: Number(port), targetPort: Number(parsed.options.get("--target-port") ?? port) }] },
      }, ns);
      if ("error" in r) return err(r.error);
      ctx.out(`service/${serviceName} exposed\n`);
      return 0;
    }
    case "get":
      return get(ctx, target, pos, ns, all, parsed.options.get("-l") ?? parsed.options.get("--selector"));
    case "describe":
      return describe(ctx, target, pos, ns);
    case "scale": {
      const [kind, name] = resourceName(pos);
      if (kind !== "deployments" || !name) return err("這個模擬終端機的 kubectl scale 支援 deployment，例如 kubectl scale deployment hello --replicas 3");
      const d = o.deployments.get(`${ns}/${name}`);
      if (!d) return notFound("deployments.apps", name);
      const n = Number(parsed.options.get("--replicas"));
      if (!parsed.options.has("--replicas") || !Number.isInteger(n) || n < 0) return err("error: --replicas=COUNT is required, and COUNT must be greater than or equal to 0");
      d.replicas = n;
      ctx.out(`deployment.apps/${name} scaled\n`);
      return 0;
    }
    case "set": {
      if (pos[0] !== "image") return err("這個模擬終端機的 kubectl set 支援 image，例如 kubectl set image deployment/hello hello=IMAGE:TAG");
      const [kind, name, used] = resourceName(pos.slice(1));
      if (kind !== "deployments" || !name) return err("error: you must specify a deployment, for example deployment/hello");
      const d = o.deployments.get(`${ns}/${name}`);
      if (!d) return notFound("deployments.apps", name);
      const pairs = pos.slice(1 + used);
      if (!pairs.length) return err("error: at least one image update is required");
      const containers = d.containers.map((c) => ({ ...c }));
      for (const pair of pairs) {
        const [cname, image] = pair.split("=");
        const c = containers.find((x) => x.name === cname);
        if (!c || !image) return err(`error: unable to find container named "${cname}"（用 kubectl describe deployment ${name} 查容器名稱）`);
        c.image = image;
      }
      d.containers = containers;
      recordRevision(d);
      ctx.out(`deployment.apps/${name} image updated\n`);
      return 0;
    }
    case "rollout": {
      const [action, ...more] = pos;
      const [kind, name] = resourceName(more);
      if (kind !== "deployments" || !name) return err("這個模擬終端機的 kubectl rollout 支援 status、history、undo，例如 kubectl rollout undo deployment/hello");
      const d = o.deployments.get(`${ns}/${name}`);
      if (!d) return notFound("deployments.apps", name);
      if (action === "status") {
        const ready = pods(ctx.state, target).filter((p) => p.deployment === `${ns}/${name}` && p.status === "Running").length;
        if (ready < d.replicas) return err(`Waiting for deployment "${name}" rollout to finish: ${ready} of ${d.replicas} updated replicas are available...\n（模擬終端機：Pod 沒有全部就緒，用 kubectl get pods 看原因）`);
        ctx.out(`deployment "${name}" successfully rolled out\n`);
        return 0;
      }
      if (action === "history") {
        ctx.out(`deployment.apps/${name}\n${table([["REVISION", "CHANGE-CAUSE"], ...d.history.map((h) => [String(h.revision), "<none>"])])}`);
        return 0;
      }
      if (action === "undo") {
        const to = parsed.options.get("--to-revision");
        const current = d.history.at(-1)!;
        const back = to === undefined ? d.history.at(-2) : d.history.find((h) => h.revision === Number(to));
        if (!back) return err(to === undefined ? `error: no rollout history found for deployment "${name}"（只有一個版本，沒有可以回復的）` : `error: unable to find specified revision ${to} in history`);
        if (back === current) return err(`deployment.apps/${name} skipped rollback (current template already matches revision ${to})`);
        d.containers = JSON.parse(back.spec);
        recordRevision(d);
        ctx.out(`deployment.apps/${name} rolled back\n`);
        return 0;
      }
      return err(`error: unknown command "${action ?? ""}" for "kubectl rollout"`);
    }
    default:
      return err(sub ? `error: unknown command "${sub}" for "kubectl"\n這個模擬終端機支援 kubectl apply、create、expose、get、describe、scale、set image、rollout、delete、config。` : "kubectl controls the Kubernetes cluster manager.\n這個模擬終端機支援 kubectl apply、create、expose、get、describe、scale、set image、rollout、delete、config。");
  }
};

function deleteByName(ctx: Ctx, target: Target, pos: string[], ns: string): number {
  const [kind, name] = resourceName(pos);
  if (!kind || !name) return (ctx.err("error: resource(s) were provided, but no name was specified"), 1);
  const o = target.objects;
  const key = `${ns}/${name}`;
  if (kind === "pods") {
    const pod = pods(ctx.state, target).find((p) => p.name === name && p.namespace === ns);
    if (!pod) return (ctx.err(`Error from server (NotFound): pods "${name}" not found`), 1);
    // The ReplicaSet notices the missing Pod and creates a replacement with a new name.
    o.deployments.get(pod.deployment)!.restarts++;
    ctx.out(`pod "${name}" deleted\n`);
    return 0;
  }
  if (kind === "deployments" && o.deployments.delete(key)) return (ctx.out(`deployment.apps "${name}" deleted\n`), 0);
  if (kind === "services" && o.services.delete(key)) return (ctx.out(`service "${name}" deleted\n`), 0);
  if (kind === "namespaces" && !DEFAULT_NAMESPACES.includes(name) && o.namespaces.delete(name)) {
    for (const k of [...o.deployments.keys()]) if (k.startsWith(`${name}/`)) o.deployments.delete(k);
    for (const k of [...o.services.keys()]) if (k.startsWith(`${name}/`)) o.services.delete(k);
    ctx.out(`namespace "${name}" deleted\n`);
    return 0;
  }
  ctx.err(`Error from server (NotFound): ${kind === "deployments" ? "deployments.apps" : kind} "${name}" not found`);
  return 1;
}

function get(ctx: Ctx, target: Target, pos: string[], ns: string, all: boolean, selector: string | undefined): number {
  const kind = RESOURCES[pos[0] ?? ""];
  if (!kind) return (ctx.err(pos[0] ? `error: the server doesn't have a resource type "${pos[0]}"` : "error: You must specify the type of resource to get."), 1);
  const name = pos[1];
  const o = target.objects;
  const inNs = (key: string) => all || key.startsWith(`${ns}/`);
  const labelFilter = selector ? Object.fromEntries(selector.split(",").map((p) => p.split("="))) : null;
  const nsCol = (key: string) => (all ? [key.split("/")[0]] : []);
  const head = (cols: string[]) => (all ? ["NAMESPACE", ...cols] : cols);
  const allPods = pods(ctx.state, target);
  let printed = false;
  const print = (rows: string[][], prefix = "") => {
    if (rows.length <= 1) return;
    if (printed) ctx.out("\n");
    printed = true;
    ctx.out(table(rows.map((r, i) => (i === 0 || !prefix ? r : [...r.slice(0, all ? 1 : 0), prefix + r[all ? 1 : 0], ...r.slice(all ? 2 : 1)]))));
  };
  const podRows = () =>
    allPods
      .filter((p) => inNs(`${p.namespace}/`) && (!name || p.name === name) && (!labelFilter || matches(p.labels, labelFilter)))
      .map((p) => [...(all ? [p.namespace] : []), p.name, p.status === "Running" ? "1/1" : "0/1", p.status, "0", "1m"]);
  const svcRows = () =>
    [...o.services]
      .filter(([k]) => inNs(k) && (!name || k.endsWith(`/${name}`)))
      .map(([k, s]) => [
        ...nsCol(k),
        k.split("/")[1],
        s.type,
        s.clusterIP,
        s.type === "LoadBalancer" ? (externalIp(target, k) ?? "<pending>") : "<none>",
        s.ports.map((p) => (p.nodePort ? `${p.port}:${p.nodePort}/TCP` : `${p.port}/TCP`)).join(","),
        "1m",
      ]);
  const deployRows = () =>
    [...o.deployments]
      .filter(([k]) => inNs(k) && (!name || k.endsWith(`/${name}`)))
      .map(([k, d]) => {
        const ready = allPods.filter((p) => p.deployment === k && p.status === "Running").length;
        return [...nsCol(k), k.split("/")[1], `${ready}/${d.replicas}`, String(d.replicas), String(ready), "1m"];
      });
  switch (kind) {
    case "pods": {
      const rows = podRows();
      if (name && !rows.length) return (ctx.err(`Error from server (NotFound): pods "${name}" not found`), 1);
      if (!rows.length) ctx.out(`No resources found in ${all ? "any" : ns} namespace.\n`);
      else print([head(["NAME", "READY", "STATUS", "RESTARTS", "AGE"]), ...rows]);
      return 0;
    }
    case "services": {
      const rows = svcRows();
      if (name && !rows.length) return (ctx.err(`Error from server (NotFound): services "${name}" not found`), 1);
      if (!rows.length) ctx.out(`No resources found in ${all ? "any" : ns} namespace.\n`);
      else print([head(["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE"]), ...rows]);
      return 0;
    }
    case "deployments": {
      const rows = deployRows();
      if (name && !rows.length) return (ctx.err(`Error from server (NotFound): deployments.apps "${name}" not found`), 1);
      if (!rows.length) ctx.out(`No resources found in ${all ? "any" : ns} namespace.\n`);
      else print([head(["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"]), ...rows]);
      return 0;
    }
    case "replicasets": {
      const rows = [...o.deployments].filter(([k]) => inNs(k)).map(([k, d]) => {
        const ready = allPods.filter((p) => p.deployment === k && p.status === "Running").length;
        return [...nsCol(k), `${k.split("/")[1]}-${templateHash(k, d)}`, String(d.replicas), String(d.replicas), String(ready), "1m"];
      });
      if (!rows.length) ctx.out(`No resources found in ${all ? "any" : ns} namespace.\n`);
      else print([head(["NAME", "DESIRED", "CURRENT", "READY", "AGE"]), ...rows]);
      return 0;
    }
    case "nodes": {
      if (target.nodes === 0) {
        ctx.out("No resources found\n（叢集還沒有節點：EKS 要建立節點群組）\n");
        return 0;
      }
      const count = target.nodes === Infinity ? Math.max(1, Math.ceil(allPods.length / 30)) : target.nodes;
      const nodeName = (i: number) => (target.provider === "aws" ? `ip-10-0-${i + 1}-${(i * 37 + 12) % 250}.ec2.internal` : `gk3-cluster-pool-${hash(`n${i}`, 8, "0123456789abcdef")}-${hash(`m${i}`, 4)}`);
      print([["NAME", "STATUS", "ROLES", "AGE", "VERSION"], ...Array.from({ length: count }, (_, i) => [nodeName(i), "Ready", "<none>", "5m", "v1.34.1"])]);
      return 0;
    }
    case "namespaces":
      print([["NAME", "STATUS", "AGE"], ...[...o.namespaces].sort().map((n) => [n, "Active", "5m"])]);
      return 0;
    default: {
      const p = podRows();
      const s = svcRows();
      const d = deployRows();
      if (!p.length && !s.length && !d.length) {
        ctx.out(`No resources found in ${all ? "any" : ns} namespace.\n`);
        return 0;
      }
      print([head(["NAME", "READY", "STATUS", "RESTARTS", "AGE"]), ...p], "pod/");
      print([head(["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE"]), ...s], "service/");
      print([head(["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"]), ...d], "deployment.apps/");
      return 0;
    }
  }
}

function describe(ctx: Ctx, target: Target, pos: string[], ns: string): number {
  const [kind, name] = resourceName(pos);
  if (!kind || !name) return (ctx.err("error: 這個模擬終端機的 describe 要指定資源和名稱，例如 kubectl describe service hello"), 1);
  const o = target.objects;
  const key = `${ns}/${name}`;
  const labels = (l: Record<string, string>) => Object.entries(l).map(([k, v]) => `${k}=${v}`).join(",") || "<none>";
  if (kind === "services") {
    const s = o.services.get(key);
    if (!s) return (ctx.err(`Error from server (NotFound): services "${name}" not found`), 1);
    const eps = endpoints(ctx.state, target, key);
    const ext = externalIp(target, key);
    ctx.out(
      `Name:              ${name}\nNamespace:         ${ns}\nSelector:          ${labels(s.selector)}\nType:              ${s.type}\nIP:                ${s.clusterIP}\n${s.type === "LoadBalancer" ? `LoadBalancer Ingress:     ${ext ?? "<pending>"}\n` : ""}Port:              <unset>  ${s.ports[0].port}/TCP\nTargetPort:        ${s.ports[0].targetPort}/TCP\n${s.ports[0].nodePort ? `NodePort:          <unset>  ${s.ports[0].nodePort}/TCP\n` : ""}Endpoints:         ${eps.join(",") || "<none>"}\n${eps.length ? "" : "（沒有就緒的 Pod 符合 Selector：確認 Pod 的標籤和 Service 的 selector 一致，而且 Pod 是 Running）\n"}`,
    );
    return 0;
  }
  if (kind === "deployments") {
    const d = o.deployments.get(key);
    if (!d) return (ctx.err(`Error from server (NotFound): deployments.apps "${name}" not found`), 1);
    const ready = pods(ctx.state, target).filter((p) => p.deployment === key && p.status === "Running").length;
    ctx.out(
      `Name:                   ${name}\nNamespace:              ${ns}\nSelector:               ${labels(d.selector)}\nReplicas:               ${d.replicas} desired | ${d.replicas} updated | ${d.replicas} total | ${ready} available | ${d.replicas - ready} unavailable\nStrategyType:           RollingUpdate\nRollingUpdateStrategy:  25% max unavailable, 25% max surge\nPod Template:\n  Labels:  ${labels(d.templateLabels)}\n  Containers:\n${d.containers.map((c) => `   ${c.name}:\n    Image:      ${c.image}\n    Port:       ${c.ports.length ? `${c.ports[0]}/TCP` : "<none>"}\n`).join("")}`,
    );
    return 0;
  }
  if (kind === "pods") {
    const p = pods(ctx.state, target).find((x) => x.name === name && x.namespace === ns);
    if (!p) return (ctx.err(`Error from server (NotFound): pods "${name}" not found`), 1);
    const d = o.deployments.get(p.deployment)!;
    const events =
      p.status === "Pending"
        ? "  Warning  FailedScheduling  default-scheduler  0/0 nodes are available: no nodes available to schedule pods.\n"
        : p.status === "ImagePullBackOff"
          ? `  Warning  Failed  kubelet  Failed to pull image "${d.containers[0].image}": not found\n`
          : "  Normal  Started  kubelet  Started container\n";
    ctx.out(`Name:         ${p.name}\nNamespace:    ${p.namespace}\nLabels:       ${labels(p.labels)}\nStatus:       ${p.status === "Running" ? "Running" : "Pending"}\nIP:           ${p.ip}\nControlled By:  ReplicaSet/${p.deployment.split("/")[1]}-${templateHash(p.deployment, d)}\nContainers:\n${d.containers.map((c) => `  ${c.name}:\n    Image:  ${c.image}\n`).join("")}Events:\n${events}`);
    return 0;
  }
  ctx.err("error: 這個模擬終端機的 describe 支援 pod、deployment、service");
  return 1;
}

function config(ctx: Ctx, args: string[]): number {
  const kube = ctx.state.kube;
  switch (args[0]) {
    case "current-context":
      if (!kube.current) return (ctx.err("error: current-context is not set"), 1);
      ctx.out(`${kube.current}\n`);
      return 0;
    case "get-contexts":
      ctx.out(table([["CURRENT", "NAME", "CLUSTER"], ...[...kube.contexts.keys()].map((n) => [n === kube.current ? "*" : "", n, n])]));
      return 0;
    case "use-context": {
      const name = args[1];
      if (!name || !kube.contexts.has(name)) return (ctx.err(`error: no context exists with the name: "${name ?? ""}"`), 1);
      kube.current = name;
      ctx.out(`Switched to context "${name}".\n`);
      return 0;
    }
    default:
      ctx.err("這個模擬終端機支援 kubectl config current-context、get-contexts、use-context。");
      return 1;
  }
}

/** Plain view of a cluster's objects for lab checks. */
export function k8sView(state: LabState, target: Target) {
  const all = pods(state, target);
  return {
    namespaces: Object.fromEntries([...target.objects.namespaces].map((n) => [n, true])),
    deployments: Object.fromEntries(
      [...target.objects.deployments].map(([k, d]) => [
        k,
        {
          replicas: d.replicas,
          readyReplicas: all.filter((p) => p.deployment === k && p.status === "Running").length,
          images: d.containers.map((c) => c.image),
          revision: d.history.at(-1)?.revision ?? 0,
        },
      ]),
    ),
    services: Object.fromEntries(
      [...target.objects.services].map(([k, s]) => [k, { type: s.type, port: s.ports[0].port, targetPort: s.ports[0].targetPort, endpoints: endpoints(state, target, k).length, externalIp: externalIp(target, k) !== null }]),
    ),
  };
}
