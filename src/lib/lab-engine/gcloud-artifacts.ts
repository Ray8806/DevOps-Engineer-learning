import { parseArgs, type Ctx } from "./context";
import { parseTarget } from "./docker";
import { error, list, table } from "./gcloud-common";

const FORMATS = ["docker", "maven", "npm", "python", "apt", "yum", "go"];
const REPO_NAME = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** gcloud artifacts repositories … | docker images list. */
export function artifacts(ctx: Ctx, args: string[]): number {
  const [group, ...rest] = args;
  const repos = ctx.state.gcp.artifacts.repositories;
  const project = ctx.state.gcp.project;

  if (group === "docker") {
    const command = "gcloud.artifacts.docker.images.list";
    if (rest[0] !== "images" || rest[1] !== "list") return error(ctx, "gcloud.artifacts.docker", "這個模擬終端機支援 gcloud artifacts docker images list 儲存庫路徑。");
    const parsed = parseArgs(rest.slice(2), { options: ["--format", "--limit"], flags: ["--include-tags"] });
    if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
    const path = parsed.positional[0];
    if (!path) return error(ctx, command, "這個模擬終端機需要指定儲存庫路徑，例如 asia-east1-docker.pkg.dev/my-project/my-repo。");
    const t = parseTarget(`${path.replace(/\/$/, "")}/x`);
    if (t.kind !== "ar" || t.project !== project) return error(ctx, command, `INVALID_ARGUMENT: '${path}' 不是這個專案的 Artifact Registry 儲存庫路徑（格式：區域-docker.pkg.dev/${project}/儲存庫）。`);
    const repo = repos.get(`${t.location}/${t.repository}`);
    if (!repo) return error(ctx, command, `NOT_FOUND: Requested entity was not found.（找不到儲存庫 ${t.repository}）`);
    const byImage = new Map<string, string[]>();
    for (const key of repo.images.keys()) {
      const [image, tag] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1)];
      byImage.set(image, [...(byImage.get(image) ?? []), tag]);
    }
    table(
      ctx,
      ["IMAGE", "DIGEST", "TAGS"],
      [...repo.images].map(([key, id]) => [`${path.replace(/\/$/, "")}/${key.slice(0, key.lastIndexOf(":"))}`, `sha256:${id}${"0".repeat(52)}`, key.slice(key.lastIndexOf(":") + 1)]),
    );
    if (!repo.images.size) ctx.out("Listed 0 items.\n");
    return 0;
  }

  if (group !== "repositories") return error(ctx, "gcloud.artifacts", `不支援 '${group ?? ""}'。這個模擬終端機支援 gcloud artifacts repositories 和 gcloud artifacts docker images list。`);
  const [action, ...more] = rest;
  const command = `gcloud.artifacts.repositories.${action}`;
  const parsed = parseArgs(more, { options: ["--repository-format", "--location", "--description", "--project", "--format"], flags: ["--quiet", "-q", "--immutable-tags"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const location = parsed.options.get("--location");
  if (action === "list") {
    table(
      ctx,
      ["REPOSITORY", "FORMAT", "LOCATION", "DESCRIPTION"],
      [...repos].filter(([k]) => !location || k.startsWith(`${location}/`)).map(([k, r]) => [k.split("/")[1], r.format.toUpperCase(), k.split("/")[0], r.description]),
    );
    return 0;
  }
  const name = parsed.positional[0];
  if (!name) return error(ctx, command, "argument REPOSITORY: Must be specified.");
  if (location === undefined) return error(ctx, command, "這個模擬終端機需要用 --location 指定位置，例如 --location=asia-east1。");
  const key = `${location}/${name}`;
  switch (action) {
    case "create": {
      if (!REPO_NAME.test(name)) return error(ctx, command, "INVALID_ARGUMENT: 儲存庫名稱要以小寫字母開頭，只能用小寫字母、數字和連字號。");
      if (repos.has(key)) return error(ctx, command, `ALREADY_EXISTS: the repository already exists`);
      const format = (parsed.options.get("--repository-format") ?? "").toLowerCase();
      if (!format) return error(ctx, command, "argument --repository-format: Must be specified.");
      if (!FORMATS.includes(format)) return error(ctx, command, `argument --repository-format: Invalid choice: '${format}'.`);
      if (!/^[a-z]+-[a-z]+\d$|^(us|europe|asia)$/.test(location)) return error(ctx, command, `INVALID_ARGUMENT: '${location}' 不是有效的位置，例如 asia-east1 或 us。`);
      repos.set(key, { format, description: parsed.options.get("--description") ?? "", immutableTags: parsed.flags.has("--immutable-tags"), images: new Map() });
      ctx.out(`Create request issued for: [${name}]\nCreated repository [${name}].\n`);
      return 0;
    }
    case "describe": {
      const r = repos.get(key);
      if (!r) return error(ctx, command, `NOT_FOUND: Repository ${name} not found.`);
      ctx.out(`description: ${r.description}\nformat: ${r.format.toUpperCase()}\nname: projects/${project}/locations/${location}/repositories/${name}\n${r.format === "docker" ? `Registry URL: ${location}-docker.pkg.dev/${project}/${name}\n` : ""}`);
      return 0;
    }
    case "delete":
      if (!repos.delete(key)) return error(ctx, command, `NOT_FOUND: Repository ${name} not found.`);
      ctx.out(`Deleted repository [${name}].\n`);
      return 0;
    default:
      return error(ctx, "gcloud.artifacts.repositories", `不支援的指令 '${action ?? ""}'。支援 create、list、describe、delete。`);
  }
}

/** gcloud auth configure-docker HOSTS: registers gcloud as the credential helper for those registries. */
export function configureDocker(ctx: Ctx, args: string[]): number {
  const parsed = parseArgs(args, { flags: ["--quiet", "-q"] });
  const hosts = list(parsed.positional[0]);
  if (!hosts.length) return error(ctx, "gcloud.auth.configure-docker", "這個模擬終端機需要指定 registry，例如 gcloud auth configure-docker asia-east1-docker.pkg.dev。");
  const bad = hosts.find((h) => !/^[a-z0-9-]+-docker\.pkg\.dev$/.test(h) && h !== "gcr.io");
  if (bad) return error(ctx, "gcloud.auth.configure-docker", `'${bad}' 不是 Artifact Registry 的 Docker registry，格式像 asia-east1-docker.pkg.dev。`);
  for (const h of hosts) ctx.state.docker.logins.add(h);
  ctx.out(`Adding credentials for: ${hosts.join(",")}\nAfter update, the following will be written to your Docker config file located at [~/.docker/config.json]:\n {\n  "credHelpers": {\n${hosts.map((h) => `    "${h}": "gcloud"`).join(",\n")}\n  }\n}\n\nDocker configuration file updated.\n`);
  return 0;
}
