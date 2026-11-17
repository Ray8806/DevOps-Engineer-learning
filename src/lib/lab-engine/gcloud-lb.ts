import { cidrContains, parseCidr } from "./cidr";
import { parseArgs, type Ctx } from "./context";
import { NAME, NAME_RULE, error, list, table } from "./gcloud-common";
import type { LabState } from "./state";

const ZONE = /^[a-z]+-[a-z]+\d+-[a-z]$/;
/** Google's health check probes come from this range (IPv4). */
export const HEALTH_CHECK_RANGE = "35.191.0.0/16";

const url = (state: LabState, path: string) => `https://www.googleapis.com/compute/v1/projects/${state.gcp.project}/${path}`;
const notFound = (ctx: Ctx, command: string, path: string) =>
  error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${ctx.state.gcp.project}/${path}' was not found`);

/** Deterministic four-letter suffix for MIG instance names (real ones are random). */
function suffix(group: string, n: number): string {
  let hash = 0x811c9dc5;
  for (const ch of `${group}${n}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return [0, 1, 2, 3].map((i) => "abcdefghijklmnopqrstuvwxyz0123456789"[(hash >>> (i * 6)) % 36]).join("");
}

// ------------------------------------------------------------ health logic

/** True when some ingress firewall rule lets Google's health check probes reach the instance on `port`. */
export function probesAllowed(state: LabState, instanceName: string, port: number): boolean {
  const instance = state.gcp.instances.get(instanceName);
  if (!instance) return false;
  const probes = parseCidr(HEALTH_CHECK_RANGE)!;
  return [...state.gcp.firewallRules.values()].some((rule) => {
    if (rule.network !== instance.network) return false;
    if (rule.targetTags.size && ![...rule.targetTags].some((t) => instance.tags.has(t))) return false;
    if (![...rule.sourceRanges].some((r) => parseCidr(r) && cidrContains(parseCidr(r)!, probes))) return false;
    return [...rule.allow].some((a) => {
      const m = /^tcp(?::(\d+)(?:-(\d+))?)?$/.exec(a);
      if (!m) return false;
      if (m[1] === undefined) return true;
      return port >= Number(m[1]) && port <= Number(m[2] ?? m[1]);
    });
  });
}

/** Instances of a backend service that pass its health check. */
export function healthyBackends(state: LabState, serviceName: string): string[] {
  const service = state.gcp.backendServices.get(serviceName);
  const hc = service && state.gcp.healthChecks.get(service.healthCheck);
  if (!service || !hc) return [];
  return [...service.backends].flatMap((mig) =>
    (state.gcp.migs.get(mig)?.instances ?? []).filter(
      (name) => state.gcp.instances.get(name)?.status === "RUNNING" && probesAllowed(state, name, hc.port),
    ),
  );
}

/**
 * A forwarding rule serves traffic when its proxy, URL map and backend service
 * exist, some backend instance is healthy, and that instance's group maps the
 * service's named port.
 */
export function ruleServing(state: LabState, ruleName: string): { backendService: string | null; serving: boolean } {
  const rule = state.gcp.forwardingRules.get(ruleName);
  const proxy = rule && state.gcp.httpProxies.get(rule.target);
  const map = proxy && state.gcp.urlMaps.get(proxy.urlMap);
  if (map?.defaultBackendBucket) {
    // A backend bucket serves straight from Cloud Storage: no health checks.
    const bucket = state.gcp.backendBuckets.get(map.defaultBackendBucket);
    return { backendService: null, serving: !!bucket && state.gcs.has(bucket.gcsBucket) };
  }
  const service = map?.defaultService ? state.gcp.backendServices.get(map.defaultService) : undefined;
  if (!map?.defaultService || !service) return { backendService: null, serving: false };
  const healthy = new Set(healthyBackends(state, map.defaultService));
  const serving = [...service.backends].some((mig) => {
    const group = state.gcp.migs.get(mig);
    return !!group?.namedPorts.has(service.portName) && group.instances.some((i) => healthy.has(i));
  });
  return { backendService: map.defaultService, serving };
}

// ------------------------------------------------------- managed groups

function createInstance(state: LabState, groupName: string, name?: string): string {
  const group = state.gcp.migs.get(groupName)!;
  const template = state.gcp.instanceTemplates.get(group.template)!;
  let vm = name;
  if (vm === undefined) {
    do vm = `${groupName}-${suffix(groupName, ++group.created)}`;
    while (state.gcp.instances.has(vm));
    group.instances.push(vm);
  }
  state.gcp.instances.set(vm, {
    zone: group.zone,
    machineType: template.machineType,
    status: "RUNNING",
    tags: new Set(template.tags),
    labels: new Map(),
    network: template.network,
    subnet: template.network,
    externalIp: true,
  });
  return vm;
}

/**
 * Keeps every managed instance group at its target size. A VM that was
 * stopped or deleted from outside the group is recreated with the same name
 * and template (counted in `recreated`).
 */
export function reconcileMigs(state: LabState) {
  for (const [name, group] of state.gcp.migs) {
    for (const vm of group.instances) {
      if (state.gcp.instances.get(vm)?.status === "RUNNING") continue;
      createInstance(state, name, vm);
      group.recreated++;
    }
    while (group.instances.length < group.targetSize) createInstance(state, name);
    while (group.instances.length > group.targetSize) state.gcp.instances.delete(group.instances.pop()!);
  }
}

function instanceTemplates(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.compute.instance-templates.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--machine-type", "--tags", "--network", "--subnet", "--region", "--image-family", "--image-project", "--image", "--metadata", "--metadata-from-file", "--boot-disk-size", "--project"],
    flags: ["--quiet", "-q", "--no-address"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const templates = ctx.state.gcp.instanceTemplates;
  const name = parsed.positional[0];
  switch (action) {
    case "list":
      table(ctx, ["NAME", "MACHINE_TYPE"], [...templates].map(([n, t]) => [n, t.machineType]));
      return 0;
    case "create": {
      if (!name) return error(ctx, command, "argument NAME: Must be specified.");
      if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
      if (templates.has(name)) return error(ctx, command, `The resource 'projects/${ctx.state.gcp.project}/global/instanceTemplates/${name}' already exists`);
      const network = parsed.options.get("--network") ?? "default";
      if (!ctx.state.gcp.networks.has(network)) return notFound(ctx, command, `global/networks/${network}`);
      const machineType = parsed.options.get("--machine-type") ?? "n1-standard-1";
      templates.set(name, { machineType, tags: new Set(list(parsed.options.get("--tags"))), network });
      ctx.out(`Created [${url(ctx.state, `global/instanceTemplates/${name}`)}].\n`);
      table(ctx, ["NAME", "MACHINE_TYPE"], [[name, machineType]]);
      return 0;
    }
    case "delete": {
      if (!name) return error(ctx, command, "argument NAME: Must be specified.");
      if (!templates.has(name)) return notFound(ctx, command, `global/instanceTemplates/${name}`);
      const user = [...ctx.state.gcp.migs].find(([, g]) => g.template === name);
      if (user) return error(ctx, command, `The instance_template resource '${name}' is already being used by '${user[0]}'`);
      templates.delete(name);
      ctx.out(`Deleted [${url(ctx.state, `global/instanceTemplates/${name}`)}].\n`);
      return 0;
    }
    default:
      return error(ctx, "gcloud.compute.instance-templates", `不支援的指令 '${action ?? ""}'。支援 create、list、delete。`);
  }
}

function setNamedPorts(ctx: Ctx, command: string, args: string[]): number {
  const parsed = parseArgs(args, { options: ["--named-ports", "--zone", "--project"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument GROUP: Must be specified.");
  const group = ctx.state.gcp.migs.get(name);
  if (!group || (parsed.options.has("--zone") && parsed.options.get("--zone") !== group.zone)) {
    return notFound(ctx, command, `zones/${parsed.options.get("--zone") ?? "?"}/instanceGroups/${name}`);
  }
  const ports = parsed.options.get("--named-ports");
  if (ports === undefined) return error(ctx, command, "argument --named-ports: Must be specified.");
  const next = new Map<string, number>();
  for (const pair of list(ports)) {
    const m = /^([a-z][a-z0-9-]*):(\d{1,5})$/.exec(pair);
    if (!m) return error(ctx, command, `argument --named-ports: 格式是 名稱:連接埠，例如 http:80，收到 '${pair}'。`);
    next.set(m[1], Number(m[2]));
  }
  group.namedPorts = next;
  ctx.out(`Updated [${url(ctx.state, `zones/${group.zone}/instanceGroups/${name}`)}].\n`);
  return 0;
}

function managed(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.compute.instance-groups.managed.${action}`;
  if (action === "set-named-ports") return setNamedPorts(ctx, command, rest);
  const parsed = parseArgs(rest, {
    options: ["--template", "--size", "--zone", "--min-num-replicas", "--max-num-replicas", "--target-cpu-utilization", "--cool-down-period", "--base-instance-name", "--project"],
    flags: ["--quiet", "-q"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const migs = ctx.state.gcp.migs;
  const row = (n: string) => {
    const g = migs.get(n)!;
    return [n, g.zone, "zone", g.template, String(g.instances.length), String(g.targetSize), g.autoscaler ? "yes" : "no"];
  };
  if (action === "list") {
    table(ctx, ["NAME", "LOCATION", "SCOPE", "INSTANCE_TEMPLATE", "SIZE", "TARGET_SIZE", "AUTOSCALED"], [...migs.keys()].map(row));
    return 0;
  }
  const actions = ["create", "describe", "list-instances", "resize", "set-autoscaling", "delete"];
  if (!actions.includes(action ?? "")) {
    return error(ctx, "gcloud.compute.instance-groups.managed", `不支援的指令 '${action ?? ""}'。支援 list、${actions.join("、")}、set-named-ports。`);
  }
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument NAME: Must be specified.");
  const zone = parsed.options.get("--zone");
  if (zone === undefined) return error(ctx, command, "這個模擬終端機不會互動詢問可用區，請加上 --zone，例如 --zone=asia-east1-b。（這個模擬終端機只支援可用區的 MIG）");
  if (!ZONE.test(zone)) return error(ctx, command, `Invalid value for field 'zone': '${zone}'.`);
  const size = (flag: string): number | null => {
    const v = parsed.options.get(flag);
    const n = Number(v);
    return v !== undefined && Number.isInteger(n) && n >= 0 ? n : null;
  };

  if (action === "create") {
    if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
    if (migs.has(name)) return error(ctx, command, `The resource 'projects/${ctx.state.gcp.project}/zones/${zone}/instanceGroupManagers/${name}' already exists`);
    const template = parsed.options.get("--template");
    if (template === undefined) return error(ctx, command, "argument --template: Must be specified.");
    if (!ctx.state.gcp.instanceTemplates.has(template)) return notFound(ctx, command, `global/instanceTemplates/${template}`);
    const target = size("--size");
    if (target === null) return error(ctx, command, "argument --size: Must be specified.（0 以上的整數）");
    migs.set(name, { zone, template, targetSize: target, instances: [], namedPorts: new Map(), autoscaler: null, recreated: 0, created: 0 });
    reconcileMigs(ctx.state);
    ctx.out(`Created [${url(ctx.state, `zones/${zone}/instanceGroupManagers/${name}`)}].\n`);
    table(ctx, ["NAME", "LOCATION", "SCOPE", "INSTANCE_TEMPLATE", "SIZE", "TARGET_SIZE", "AUTOSCALED"], [row(name)]);
    return 0;
  }
  const group = migs.get(name);
  if (!group || group.zone !== zone) return notFound(ctx, command, `zones/${zone}/instanceGroupManagers/${name}`);
  switch (action) {
    case "describe":
      ctx.out(
        `${group.autoscaler ? `autoscaler:\n  autoscalingPolicy:\n    cpuUtilization:\n      utilizationTarget: ${group.autoscaler.cpu}\n    maxNumReplicas: ${group.autoscaler.max}\n    minNumReplicas: ${group.autoscaler.min}\n` : ""}instanceTemplate: ${url(ctx.state, `global/instanceTemplates/${group.template}`)}\nname: ${name}\n${
          group.namedPorts.size ? `namedPorts:\n${[...group.namedPorts].map(([n, p]) => `- name: ${n}\n  port: ${p}\n`).join("")}` : ""
        }targetSize: ${group.targetSize}\nzone: ${zone}\n`,
      );
      return 0;
    case "list-instances":
      table(ctx, ["NAME", "ZONE", "STATUS", "ACTION"], group.instances.map((i) => [i, zone, ctx.state.gcp.instances.get(i)!.status, "NONE"]));
      return 0;
    case "resize": {
      const target = size("--size");
      if (target === null) return error(ctx, command, "argument --size: Must be specified.");
      if (group.autoscaler) {
        return error(ctx, command, "這個群組已經開啟自動調度，大小由自動調度器決定；要調整範圍請用 set-autoscaling 修改 --min-num-replicas 和 --max-num-replicas。");
      }
      group.targetSize = target;
      reconcileMigs(ctx.state);
      ctx.out(`Updated [${url(ctx.state, `zones/${zone}/instanceGroupManagers/${name}`)}].\n`);
      return 0;
    }
    case "set-autoscaling": {
      const max = size("--max-num-replicas");
      if (max === null || max < 1) return error(ctx, command, "argument --max-num-replicas: Must be specified.（1 以上的整數）");
      const min = parsed.options.has("--min-num-replicas") ? size("--min-num-replicas") : 1;
      if (min === null || min > max) return error(ctx, command, "--min-num-replicas 要是 0 以上、不大於 --max-num-replicas 的整數。");
      const cpuText = parsed.options.get("--target-cpu-utilization");
      const cpu = cpuText === undefined ? 0.6 : Number(cpuText);
      if (!(cpu > 0 && cpu <= 1)) return error(ctx, command, "argument --target-cpu-utilization: 目標使用率要介於 0.0 到 1.0，例如 0.6 代表 60%。");
      group.autoscaler = { min, max, cpu };
      // Without load the simulated autoscaler keeps the group at its minimum.
      group.targetSize = Math.min(Math.max(group.targetSize, min), max);
      reconcileMigs(ctx.state);
      ctx.out(`Created [${url(ctx.state, `zones/${zone}/autoscalers/${name}`)}].\n`);
      return 0;
    }
    default: {
      const service = [...ctx.state.gcp.backendServices].find(([, s]) => s.backends.has(name));
      if (service) return error(ctx, command, `The instance_group resource '${name}' is already being used by 'backendServices/${service[0]}'`);
      for (const i of group.instances) ctx.state.gcp.instances.delete(i);
      migs.delete(name);
      ctx.out(`Deleted [${url(ctx.state, `zones/${zone}/instanceGroupManagers/${name}`)}].\n`);
      return 0;
    }
  }
}

export function instanceGroups(ctx: Ctx, args: string[]): number {
  if (args[0] === "managed") return managed(ctx, args.slice(1));
  if (args[0] === "set-named-ports") return setNamedPorts(ctx, "gcloud.compute.instance-groups.set-named-ports", args.slice(1));
  return error(ctx, "gcloud.compute.instance-groups", `不支援 '${args[0] ?? ""}'。這個模擬終端機支援 instance-groups managed 和 instance-groups set-named-ports。`);
}

// --------------------------------------------------- load balancer pieces

function healthChecks(ctx: Ctx, args: string[]): number {
  const [action, ...more] = args;
  const command = `gcloud.compute.health-checks.${action}`;
  const checks = ctx.state.gcp.healthChecks;
  if (action === "list") {
    table(ctx, ["NAME", "PROTOCOL", "PORT", "REQUEST_PATH"], [...checks].map(([n, c]) => [n, "HTTP", String(c.port), c.path]));
    return 0;
  }
  if (action === "create") {
    if (more[0] !== "http") return error(ctx, command, `這個模擬終端機只支援 gcloud compute health-checks create http，收到 '${more[0] ?? ""}'。`);
    const parsed = parseArgs(more.slice(1), { options: ["--port", "--request-path", "--check-interval", "--timeout", "--healthy-threshold", "--unhealthy-threshold", "--project"], flags: ["--global"] });
    if (parsed.unknown) return error(ctx, `${command}.http`, `unrecognized arguments: ${parsed.unknown}`);
    const name = parsed.positional[0];
    if (!name) return error(ctx, `${command}.http`, "argument NAME: Must be specified.");
    if (!NAME.test(name)) return error(ctx, `${command}.http`, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
    if (checks.has(name)) return error(ctx, `${command}.http`, `The resource 'projects/${ctx.state.gcp.project}/global/healthChecks/${name}' already exists`);
    const port = Number(parsed.options.get("--port") ?? 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return error(ctx, `${command}.http`, `argument --port: 1 到 65535，收到 '${parsed.options.get("--port")}'。`);
    const path = parsed.options.get("--request-path") ?? "/";
    checks.set(name, { port, path });
    ctx.out(`Created [${url(ctx.state, `global/healthChecks/${name}`)}].\n`);
    table(ctx, ["NAME", "PROTOCOL"], [[name, "HTTP"]]);
    return 0;
  }
  if (action === "delete") {
    const name = more[0];
    if (!name || !checks.has(name)) return notFound(ctx, command, `global/healthChecks/${name ?? ""}`);
    const user = [...ctx.state.gcp.backendServices].find(([, s]) => s.healthCheck === name);
    if (user) return error(ctx, command, `The health_check resource '${name}' is already being used by 'backendServices/${user[0]}'`);
    checks.delete(name);
    ctx.out(`Deleted [${url(ctx.state, `global/healthChecks/${name}`)}].\n`);
    return 0;
  }
  return error(ctx, "gcloud.compute.health-checks", `不支援的指令 '${action ?? ""}'。支援 create http、list、delete。`);
}

function backendServices(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.compute.backend-services.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--protocol", "--port-name", "--health-checks", "--load-balancing-scheme", "--instance-group", "--instance-group-zone", "--balancing-mode", "--max-utilization", "--project"],
    flags: ["--global", "--quiet", "-q"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const services = ctx.state.gcp.backendServices;
  if (action === "list") {
    table(ctx, ["NAME", "BACKENDS", "PROTOCOL"], [...services].map(([n, s]) => [n, [...s.backends].map((b) => `${ctx.state.gcp.migs.get(b)?.zone}/instanceGroups/${b}`).join(","), s.protocol]));
    return 0;
  }
  const actions = ["create", "add-backend", "get-health", "delete"];
  if (!actions.includes(action ?? "")) return error(ctx, "gcloud.compute.backend-services", `不支援的指令 '${action ?? ""}'。支援 list、${actions.join("、")}。`);
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument NAME: Must be specified.");
  if (!parsed.flags.has("--global")) return error(ctx, command, "這個模擬終端機只支援全域後端服務，請加上 --global。");
  if (action === "create") {
    if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
    if (services.has(name)) return error(ctx, command, `The resource 'projects/${ctx.state.gcp.project}/global/backendServices/${name}' already exists`);
    const hc = parsed.options.get("--health-checks");
    if (hc === undefined) return error(ctx, command, "這個模擬終端機需要用 --health-checks 指定健康檢查。");
    if (!ctx.state.gcp.healthChecks.has(hc)) return notFound(ctx, command, `global/healthChecks/${hc}`);
    const protocol = (parsed.options.get("--protocol") ?? "HTTP").toUpperCase();
    if (protocol !== "HTTP") return error(ctx, command, "這個模擬終端機的後端服務只支援 --protocol=HTTP。");
    const scheme = (parsed.options.get("--load-balancing-scheme") ?? "EXTERNAL").toUpperCase();
    if (scheme !== "EXTERNAL" && scheme !== "EXTERNAL_MANAGED") return error(ctx, command, "這個模擬終端機支援 --load-balancing-scheme=EXTERNAL_MANAGED（全域外部 Application Load Balancer）或 EXTERNAL（傳統版）。");
    // Without --port-name the backend service uses the named port "http".
    services.set(name, { protocol, portName: parsed.options.get("--port-name") ?? "http", healthCheck: hc, scheme, backends: new Set(), cdn: false, cacheMode: null, securityPolicy: null });
    ctx.out(`Created [${url(ctx.state, `global/backendServices/${name}`)}].\n`);
    table(ctx, ["NAME", "BACKENDS", "PROTOCOL"], [[name, "", protocol]]);
    return 0;
  }
  const service = services.get(name);
  if (!service) return notFound(ctx, command, `global/backendServices/${name}`);
  switch (action) {
    case "add-backend": {
      const groupName = parsed.options.get("--instance-group");
      if (groupName === undefined) return error(ctx, command, "argument --instance-group: Must be specified.");
      const zone = parsed.options.get("--instance-group-zone");
      if (zone === undefined) return error(ctx, command, "這個模擬終端機不會互動詢問可用區，請加上 --instance-group-zone。");
      const group = ctx.state.gcp.migs.get(groupName);
      if (!group || group.zone !== zone) return notFound(ctx, command, `zones/${zone}/instanceGroups/${groupName}`);
      if (service.backends.has(groupName)) return error(ctx, command, `Backend [${groupName}] in zone [${zone}] already exists in backend service [${name}].`);
      service.backends.add(groupName);
      ctx.out(`Updated [${url(ctx.state, `global/backendServices/${name}`)}].\n`);
      return 0;
    }
    case "get-health": {
      const healthy = new Set(healthyBackends(ctx.state, name));
      for (const groupName of service.backends) {
        const group = ctx.state.gcp.migs.get(groupName)!;
        ctx.out(`---\nbackend: ${url(ctx.state, `zones/${group.zone}/instanceGroups/${groupName}`)}\nstatus:\n  healthStatus:\n`);
        for (const i of group.instances) {
          const port = group.namedPorts.get(service.portName);
          ctx.out(`  - healthState: ${healthy.has(i) ? "HEALTHY" : "UNHEALTHY"}\n    instance: ${url(ctx.state, `zones/${group.zone}/instances/${i}`)}\n${port !== undefined ? `    port: ${port}\n` : ""}`);
        }
      }
      if (service.backends.size === 0) ctx.out("（這個後端服務還沒有後端，用 add-backend 加入執行個體群組）\n");
      return 0;
    }
    default: {
      const user = [...ctx.state.gcp.urlMaps].find(([, m]) => m.defaultService === name);
      if (user) return error(ctx, command, `The backend_service resource '${name}' is already being used by 'urlMaps/${user[0]}'`);
      services.delete(name);
      ctx.out(`Deleted [${url(ctx.state, `global/backendServices/${name}`)}].\n`);
      return 0;
    }
  }
}

/** url-maps and target-http-proxies: simple named links in the chain. */
function link(ctx: Ctx, kind: "url-maps" | "target-http-proxies", args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.compute.${kind}.${action}`;
  const parsed = parseArgs(rest, { options: ["--default-service", "--default-backend-bucket", "--url-map", "--project"], flags: ["--global", "--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;
  const isMap = kind === "url-maps";
  const store: Map<string, unknown> = isMap ? gcp.urlMaps : gcp.httpProxies;
  const path = isMap ? "urlMaps" : "targetHttpProxies";
  if (action === "list") {
    table(ctx, isMap ? ["NAME", "DEFAULT_SERVICE"] : ["NAME", "URL_MAP"], isMap ? [...gcp.urlMaps].map(([n, m]) => [n, m.defaultService ? `backendServices/${m.defaultService}` : `backendBuckets/${m.defaultBackendBucket}`]) : [...gcp.httpProxies].map(([n, p]) => [n, p.urlMap]));
    return 0;
  }
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument NAME: Must be specified.");
  if (action === "delete") {
    if (!store.has(name)) return notFound(ctx, command, `global/${path}/${name}`);
    const user = isMap ? [...gcp.httpProxies].find(([, p]) => p.urlMap === name)?.[0] : [...gcp.forwardingRules].find(([, r]) => r.target === name)?.[0];
    if (user) return error(ctx, command, `The ${isMap ? "url_map" : "target_http_proxy"} resource '${name}' is already being used by '${isMap ? "targetHttpProxies" : "forwardingRules"}/${user}'`);
    store.delete(name);
    ctx.out(`Deleted [${url(ctx.state, `global/${path}/${name}`)}].\n`);
    return 0;
  }
  if (action !== "create") return error(ctx, `gcloud.compute.${kind}`, `不支援的指令 '${action ?? ""}'。支援 create、list、delete。`);
  if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
  if (store.has(name)) return error(ctx, command, `The resource 'projects/${gcp.project}/global/${path}/${name}' already exists`);
  if (isMap) {
    const service = parsed.options.get("--default-service");
    const bucket = parsed.options.get("--default-backend-bucket");
    if ((service === undefined) === (bucket === undefined)) return error(ctx, command, "Exactly one of (--default-backend-bucket | --default-service) must be specified.");
    if (service !== undefined && !gcp.backendServices.has(service)) return notFound(ctx, command, `global/backendServices/${service}`);
    if (bucket !== undefined && !gcp.backendBuckets.has(bucket)) return notFound(ctx, command, `global/backendBuckets/${bucket}`);
    gcp.urlMaps.set(name, { defaultService: service ?? null, defaultBackendBucket: bucket ?? null, invalidations: [] });
  } else {
    const map = parsed.options.get("--url-map");
    if (map === undefined) return error(ctx, command, "argument --url-map: Must be specified.");
    if (!gcp.urlMaps.has(map)) return notFound(ctx, command, `global/urlMaps/${map}`);
    gcp.httpProxies.set(name, { urlMap: map });
  }
  ctx.out(`Created [${url(ctx.state, `global/${path}/${name}`)}].\n`);
  return 0;
}

function forwardingRules(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.compute.forwarding-rules.${action}`;
  const parsed = parseArgs(rest, { options: ["--target-http-proxy", "--ports", "--load-balancing-scheme", "--address", "--project"], flags: ["--global", "--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const gcp = ctx.state.gcp;
  const row = (n: string) => {
    const r = gcp.forwardingRules.get(n)!;
    return [n, "", r.ipAddress, "TCP", `targetHttpProxies/${r.target}`];
  };
  if (action === "list") {
    table(ctx, ["NAME", "REGION", "IP_ADDRESS", "IP_PROTOCOL", "TARGET"], [...gcp.forwardingRules.keys()].map(row));
    return 0;
  }
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument NAME: Must be specified.");
  if (!parsed.flags.has("--global")) return error(ctx, command, "這個模擬終端機只支援全域轉送規則，請加上 --global。");
  switch (action) {
    case "create": {
      if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
      if (gcp.forwardingRules.has(name)) return error(ctx, command, `The resource 'projects/${gcp.project}/global/forwardingRules/${name}' already exists`);
      const proxy = parsed.options.get("--target-http-proxy");
      if (proxy === undefined) return error(ctx, command, "這個模擬終端機需要用 --target-http-proxy 指定目標 proxy。");
      if (!gcp.httpProxies.has(proxy)) return notFound(ctx, command, `global/targetHttpProxies/${proxy}`);
      const port = Number(parsed.options.get("--ports") ?? NaN);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return error(ctx, command, "請用 --ports 指定一個連接埠，例如 --ports=80。");
      const n = gcp.forwardingRules.size + 1;
      const ipAddress = `34.120.${Math.floor(n / 250)}.${(n % 250) + 1}`;
      gcp.forwardingRules.set(name, { target: proxy, port, ipAddress });
      ctx.out(`Created [${url(ctx.state, `global/forwardingRules/${name}`)}].\n`);
      return 0;
    }
    case "describe": {
      const r = gcp.forwardingRules.get(name);
      if (!r) return notFound(ctx, command, `global/forwardingRules/${name}`);
      ctx.out(`IPAddress: ${r.ipAddress}\nIPProtocol: TCP\nname: ${name}\nportRange: ${r.port}-${r.port}\ntarget: ${url(ctx.state, `global/targetHttpProxies/${r.target}`)}\n`);
      return 0;
    }
    case "delete":
      if (!gcp.forwardingRules.delete(name)) return notFound(ctx, command, `global/forwardingRules/${name}`);
      ctx.out(`Deleted [${url(ctx.state, `global/forwardingRules/${name}`)}].\n`);
      return 0;
    default:
      return error(ctx, "gcloud.compute.forwarding-rules", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、delete。`);
  }
}

/** Routes the load-balancing related `gcloud compute` groups; returns null for others. */
export function loadBalancing(ctx: Ctx, args: string[]): number | null {
  switch (args[0]) {
    case "instance-templates":
      return instanceTemplates(ctx, args.slice(1));
    case "instance-groups":
      return instanceGroups(ctx, args.slice(1));
    case "health-checks":
      return healthChecks(ctx, args.slice(1));
    case "backend-services":
      return backendServices(ctx, args.slice(1));
    case "url-maps":
    case "target-http-proxies":
      return link(ctx, args[0], args.slice(1));
    case "forwarding-rules":
      return forwardingRules(ctx, args.slice(1));
    default:
      return null;
  }
}
