import { parseArgs, type Ctx } from "./context";
import { NAME, NAME_RULE, error, table } from "./gcloud-common";

const CACHE_MODES = ["CACHE_ALL_STATIC", "USE_ORIGIN_HEADERS", "FORCE_CACHE_ALL"];
const url = (ctx: Ctx, path: string) => `https://www.googleapis.com/compute/v1/projects/${ctx.state.gcp.project}/${path}`;

/** Reads --cache-mode; null after reporting an error. */
function cacheMode(ctx: Ctx, command: string, value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const mode = value.toUpperCase().replace(/-/g, "_");
  if (!CACHE_MODES.includes(mode)) {
    error(ctx, command, `argument --cache-mode: Invalid choice: '${value}'. 可用的值：${CACHE_MODES.join("、")}`);
    return null;
  }
  return mode;
}

function backendBuckets(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.compute.backend-buckets.${action}`;
  const parsed = parseArgs(rest, {
    options: ["--gcs-bucket-name", "--cache-mode", "--default-ttl", "--description", "--project"],
    flags: ["--enable-cdn", "--no-enable-cdn", "--global", "--quiet", "-q"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const buckets = ctx.state.gcp.backendBuckets;
  if (action === "list") {
    table(ctx, ["NAME", "GCS_BUCKET_NAME", "ENABLE_CDN"], [...buckets].map(([n, b]) => [n, b.gcsBucket, String(b.cdn)]));
    return 0;
  }
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument BACKEND_BUCKET_NAME: Must be specified.");
  switch (action) {
    case "create": {
      if (!NAME.test(name)) return error(ctx, command, `Invalid value for field 'resource.name': '${name}'. ${NAME_RULE}`);
      if (buckets.has(name)) return error(ctx, command, `The resource 'projects/${ctx.state.gcp.project}/global/backendBuckets/${name}' already exists`);
      const gcsBucket = parsed.options.get("--gcs-bucket-name");
      if (gcsBucket === undefined) return error(ctx, command, "argument --gcs-bucket-name: Must be specified.");
      if (!ctx.state.gcs.has(gcsBucket)) return error(ctx, command, `這個模擬終端機找不到 bucket gs://${gcsBucket}（backend bucket 要指向同一個專案裡已存在的 Cloud Storage bucket）。`);
      const mode = cacheMode(ctx, command, parsed.options.get("--cache-mode"));
      if (mode === null) return 1;
      const cdn = parsed.flags.has("--enable-cdn");
      // CACHE_ALL_STATIC is the default for CDN-enabled backends created with gcloud.
      buckets.set(name, { gcsBucket, cdn, cacheMode: cdn ? (mode ?? "CACHE_ALL_STATIC") : null });
      ctx.out(`Created [${url(ctx, `global/backendBuckets/${name}`)}].\n`);
      table(ctx, ["NAME", "GCS_BUCKET_NAME", "ENABLE_CDN"], [[name, gcsBucket, String(cdn)]]);
      return 0;
    }
    case "describe": {
      const b = buckets.get(name);
      if (!b) return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${ctx.state.gcp.project}/global/backendBuckets/${name}' was not found`);
      ctx.out(`bucketName: ${b.gcsBucket}\n${b.cdn ? `cdnPolicy:\n  cacheMode: ${b.cacheMode}\n` : ""}enableCdn: ${b.cdn}\nname: ${name}\n`);
      return 0;
    }
    case "delete": {
      if (!buckets.has(name)) return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${ctx.state.gcp.project}/global/backendBuckets/${name}' was not found`);
      const user = [...ctx.state.gcp.urlMaps].find(([, m]) => m.defaultBackendBucket === name)?.[0];
      if (user) return error(ctx, command, `The backend_bucket resource '${name}' is already being used by 'urlMaps/${user}'`);
      buckets.delete(name);
      ctx.out(`Deleted [${url(ctx, `global/backendBuckets/${name}`)}].\n`);
      return 0;
    }
    default:
      return error(ctx, "gcloud.compute.backend-buckets", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、delete。`);
  }
}

/** gcloud compute backend-services update: only the Cloud CDN settings. */
function updateBackendService(ctx: Ctx, args: string[]): number {
  const command = "gcloud.compute.backend-services.update";
  const parsed = parseArgs(args, { options: ["--cache-mode", "--security-policy", "--project"], flags: ["--enable-cdn", "--no-enable-cdn", "--global"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}（這個模擬終端機的 update 只支援 --enable-cdn、--no-enable-cdn、--cache-mode、--security-policy）`);
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument BACKEND_SERVICE_NAME: Must be specified.");
  if (!parsed.flags.has("--global")) return error(ctx, command, "這個模擬終端機只支援全域後端服務，請加上 --global。");
  const service = ctx.state.gcp.backendServices.get(name);
  if (!service) return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${ctx.state.gcp.project}/global/backendServices/${name}' was not found`);
  const mode = cacheMode(ctx, command, parsed.options.get("--cache-mode"));
  if (mode === null) return 1;
  if (parsed.flags.has("--enable-cdn")) service.cdn = true;
  if (parsed.flags.has("--no-enable-cdn")) service.cdn = false;
  const policy = parsed.options.get("--security-policy");
  if (!parsed.flags.has("--enable-cdn") && !parsed.flags.has("--no-enable-cdn") && mode === undefined && policy === undefined) {
    return error(ctx, command, "請指定要更新的設定，例如 --enable-cdn 或 --security-policy。");
  }
  if (policy !== undefined) {
    // An empty value detaches the policy.
    if (policy !== "" && !ctx.state.gcp.securityPolicies.has(policy)) {
      return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${ctx.state.gcp.project}/global/securityPolicies/${policy}' was not found`);
    }
    service.securityPolicy = policy === "" ? null : policy;
  }
  service.cacheMode = service.cdn ? (mode ?? service.cacheMode ?? "CACHE_ALL_STATIC") : null;
  ctx.out(`Updated [${url(ctx, `global/backendServices/${name}`)}].\n`);
  return 0;
}

function invalidate(ctx: Ctx, args: string[]): number {
  const command = "gcloud.compute.url-maps.invalidate-cdn-cache";
  const parsed = parseArgs(args, { options: ["--path", "--host", "--project"], flags: ["--global", "--async"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument URLMAP: Must be specified.");
  const map = ctx.state.gcp.urlMaps.get(name);
  if (!map) return error(ctx, command, `Could not fetch resource:\n - The resource 'projects/${ctx.state.gcp.project}/global/urlMaps/${name}' was not found`);
  const path = parsed.options.get("--path");
  if (path === undefined) return error(ctx, command, "這個模擬終端機需要用 --path 指定要清除的路徑，例如 --path=\"/images/*\"。");
  if (!path.startsWith("/") || path.slice(0, -1).includes("*")) {
    return error(ctx, command, "Invalid value for field 'resource.path': PATH 要以 / 開頭，而且 * 只能放在最後面。");
  }
  const cdnOn = map.defaultBackendBucket ? ctx.state.gcp.backendBuckets.get(map.defaultBackendBucket)?.cdn : ctx.state.gcp.backendServices.get(map.defaultService ?? "")?.cdn;
  map.invalidations.push(path);
  ctx.out(`Invalidation pending for [${url(ctx, `global/urlMaps/${name}`)}]\n${cdnOn ? "" : "（模擬終端機的提醒：這個 URL 對應的後端還沒開啟 Cloud CDN，沒有快取可以清除）\n"}`);
  return 0;
}

/** Cloud CDN related `gcloud compute` commands; returns null for everything else. */
export function cdn(ctx: Ctx, args: string[]): number | null {
  if (args[0] === "backend-buckets") return backendBuckets(ctx, args.slice(1));
  if (args[0] === "backend-services" && args[1] === "update") return updateBackendService(ctx, args.slice(2));
  if (args[0] === "url-maps" && args[1] === "invalidate-cdn-cache") return invalidate(ctx, args.slice(2));
  return null;
}
