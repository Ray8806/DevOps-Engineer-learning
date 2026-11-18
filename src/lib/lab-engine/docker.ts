import { parseArgs, type Command, type Ctx } from "./context";
import { basename, isWithin, resolvePath, type DockerImage, type LabState } from "./state";

export const ACCOUNT = "123456789012";
export const ECR_REGION = "us-east-1";
export const ECR_REGISTRY = `${ACCOUNT}.dkr.ecr.${ECR_REGION}.amazonaws.com`;
/** What `aws ecr get-login-password` prints; `docker login --password-stdin` checks for it. */
export const ECR_TOKEN = "eyJwYXlsb2FkIjoic2ltdWxhdGVkLWVjci10b2tlbiIsImV4cGlyYXRpb24iOjE3NjMzMjAwMDB9";

const SUPPORTED = "這個模擬終端機支援 docker build、images、tag、run、ps、stop、rm、rmi、login、push、pull。";
const INSTRUCTIONS = ["FROM", "RUN", "COPY", "ADD", "WORKDIR", "ENV", "EXPOSE", "CMD", "ENTRYPOINT", "ARG", "LABEL", "USER"];

function fail(ctx: Ctx, message: string, code = 1): number {
  ctx.err(message);
  return code;
}

/** "name[:tag]" -> [name, tag]; a colon inside the registry host is not a tag. */
export function splitRef(ref: string): [string, string] {
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? [ref.slice(0, colon), ref.slice(colon + 1)] : [ref, "latest"];
}

const normalise = (ref: string) => splitRef(ref).join(":");

function hash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ text.charCodeAt(i), 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
}

/** A registry push/pull target: which cloud registry, repository and tag. */
export type Target =
  | { kind: "ecr"; registry: string; repository: string; tag: string }
  | { kind: "ar"; registry: string; location: string; project: string; repository: string; image: string; tag: string }
  | { kind: "other"; registry: string };

export function parseTarget(ref: string): Target {
  const [name, tag] = splitRef(ref);
  const host = name.includes("/") && /[.:]/.test(name.split("/")[0]) ? name.split("/")[0] : "docker.io";
  const path = host === "docker.io" ? name : name.slice(host.length + 1);
  if (/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) return { kind: "ecr", registry: host, repository: path, tag };
  const ar = /^([a-z0-9-]+)-docker\.pkg\.dev$/.exec(host);
  if (ar) {
    const parts = path.split("/");
    if (parts.length >= 3) return { kind: "ar", registry: host, location: ar[1], project: parts[0], repository: parts[1], image: parts.slice(2).join("/"), tag };
  }
  return { kind: "other", registry: host };
}

/** The image id stored in a cloud registry for this reference, if any. */
/** The fully qualified name Docker prints: registry hosts stay, Docker Hub names get docker.io[/library]. */
function canonical(ref: string): string {
  const first = ref.split("/")[0];
  if (ref.includes("/") && /[.:]|^localhost$/.test(first)) return ref;
  return ref.includes("/") ? `docker.io/${ref}` : `docker.io/library/${ref}`;
}

export function remoteImage(state: LabState, ref: string): string | null {
  const t = parseTarget(ref);
  if (t.kind === "ecr") {
    if (t.registry !== ECR_REGISTRY) return null;
    return state.aws.ecr.repositories.get(t.repository)?.images.get(t.tag) ?? null;
  }
  if (t.kind === "ar") {
    if (t.project !== state.gcp.project) return null;
    return state.gcp.artifacts.repositories.get(`${t.location}/${t.repository}`)?.images.get(`${t.image}:${t.tag}`) ?? null;
  }
  return null;
}

/** Joins Dockerfile lines ending in a backslash and drops comments and blank lines. */
function instructions(dockerfile: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const raw of dockerfile.split("\n")) {
    const line = raw.trim();
    if (!current && (line === "" || line.startsWith("#"))) continue;
    if (line.endsWith("\\")) current += `${line.slice(0, -1).trim()} `;
    else {
      out.push(current + line);
      current = "";
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function build(ctx: Ctx, args: string[]): number {
  const parsed = parseArgs(args, { options: ["-t", "--tag", "-f", "--file", "--platform"], flags: ["-q", "--quiet", "--no-cache"] });
  if (parsed.unknown) return fail(ctx, `unknown flag: ${parsed.unknown}`);
  const contextArg = parsed.positional[0];
  if (contextArg === undefined) return fail(ctx, 'ERROR: "docker buildx build" requires exactly 1 argument.\n（最後要指定建置環境的目錄，通常是目前目錄 .）');
  const dir = resolvePath(ctx.state.cwd, contextArg);
  if (!ctx.state.dirs.has(dir)) return fail(ctx, `ERROR: unable to prepare context: path "${contextArg}" not found`);
  const dockerfilePath = resolvePath(dir, parsed.options.get("-f") ?? parsed.options.get("--file") ?? "Dockerfile");
  const dockerfile = ctx.state.files.get(dockerfilePath);
  if (dockerfile === undefined) return fail(ctx, `ERROR: failed to solve: failed to read dockerfile: open ${basename(dockerfilePath)}: no such file or directory`);
  const lines = instructions(dockerfile);
  if (!lines.length) return fail(ctx, "ERROR: failed to solve: the Dockerfile cannot be empty");

  let base = "";
  const exposed: number[] = [];
  let cmd = "";
  let index: string | null = null;
  const fingerprint: string[] = [];
  const steps: string[] = [];
  for (const [i, line] of lines.entries()) {
    const [word, ...restWords] = line.split(/\s+/);
    const op = word.toUpperCase();
    const rest = restWords.join(" ");
    if (!INSTRUCTIONS.includes(op)) return fail(ctx, `ERROR: failed to solve: dockerfile parse error on line ${i + 1}: unknown instruction: ${word}`);
    if (i === 0 && op !== "FROM" && op !== "ARG") return fail(ctx, "ERROR: failed to solve: no build stage in current context（Dockerfile 要以 FROM 開頭）");
    fingerprint.push(line);
    switch (op) {
      case "FROM":
        if (!rest) return fail(ctx, "ERROR: failed to solve: FROM requires either one or three arguments");
        base = restWords[0];
        break;
      case "COPY":
      case "ADD": {
        const parts = restWords.filter((w) => !w.startsWith("--"));
        if (parts.length < 2) return fail(ctx, `ERROR: failed to solve: ${op} requires at least two arguments`);
        for (const src of parts.slice(0, -1)) {
          const abs = resolvePath(dir, src);
          if (!isWithin(abs, dir)) return fail(ctx, `ERROR: failed to solve: failed to compute cache key: "${src}" is outside of the build context`);
          if (ctx.state.files.has(abs)) {
            fingerprint.push(ctx.state.files.get(abs)!);
            if (basename(abs) === "index.html") index = ctx.state.files.get(abs)!;
          } else if (ctx.state.dirs.has(abs)) {
            for (const [p, content] of ctx.state.files) {
              if (!isWithin(p, abs)) continue;
              fingerprint.push(p, content);
              if (p === `${abs}/index.html`) index = content;
            }
          } else {
            return fail(ctx, `ERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref: "/${src.replace(/^\.\//, "")}": not found`);
          }
        }
        break;
      }
      case "EXPOSE":
        for (const p of restWords) {
          const port = Number(p.split("/")[0]);
          if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(ctx, `ERROR: failed to solve: invalid containerPort: ${p}`);
          exposed.push(port);
        }
        break;
      case "CMD":
      case "ENTRYPOINT":
        cmd = rest;
        break;
    }
    // Only instructions that change the filesystem show up as numbered build steps.
    if (["RUN", "COPY", "ADD", "WORKDIR"].includes(op)) steps.push(line.length > 70 ? `${line.slice(0, 67)}...` : line);
  }

  const tagArg = parsed.options.get("-t") ?? parsed.options.get("--tag");
  const id = hash(fingerprint.join("\n"));
  const image: DockerImage = { id, base, exposed, cmd, sizeMb: 180 + (parseInt(id.slice(0, 2), 16) % 60), index };
  const total = steps.length + 1;
  ctx.out(
    `[+] Building 4.2s (${total + 3}/${total + 3}) FINISHED\n => [internal] load build definition from ${basename(dockerfilePath)}\n => [internal] load metadata for ${base}\n => [1/${total}] FROM ${base}\n${steps
      .map((s, i) => ` => [${i + 2}/${total}] ${s}\n`)
      .join("")} => exporting to image\n => => writing image sha256:${id}${hash(id)}\n${tagArg ? ` => => naming to ${canonical(normalise(tagArg))}\n` : ""}`,
  );
  if (tagArg) ctx.state.docker.images.set(normalise(tagArg), image);
  else ctx.state.docker.images.set(`<none>:${id}`, image);
  return 0;
}

/** Finds a local image by reference or image id. */
function local(state: LabState, ref: string): [string, DockerImage] | null {
  const byRef = state.docker.images.get(normalise(ref));
  if (byRef) return [normalise(ref), byRef];
  const byId = [...state.docker.images].find(([, i]) => i.id.startsWith(ref) && ref.length >= 4);
  return byId ?? null;
}

/** Pulls from ECR or Artifact Registry into the local image list; null after reporting. */
function pullRemote(ctx: Ctx, ref: string): DockerImage | null {
  const t = parseTarget(ref);
  if (t.kind === "other") {
    ctx.err(`這個模擬終端機只能從 Amazon ECR 或 Artifact Registry 拉取映像檔（${ref}）。`);
    return null;
  }
  if (!ctx.state.docker.logins.has(t.registry)) {
    ctx.err(t.kind === "ecr" ? `Error response from daemon: Head "https://${t.registry}/v2/${t.repository}/manifests/${t.tag}": no basic auth credentials` : `Error response from daemon: Head "https://${t.registry}/v2/...": denied: Unauthenticated request.（先執行 gcloud auth configure-docker ${t.registry}）`);
    return null;
  }
  const id = remoteImage(ctx.state, ref);
  if (!id) {
    ctx.err(`Error response from daemon: manifest for ${normalise(ref)} not found: manifest unknown`);
    return null;
  }
  // The image content is whatever local image has this id; otherwise a placeholder.
  const known = [...ctx.state.docker.images.values()].find((i) => i.id === id);
  const image: DockerImage = known ? { ...known } : { id, base: "", exposed: [], cmd: "", sizeMb: 200, index: null };
  ctx.state.docker.images.set(normalise(ref), image);
  return image;
}

function push(ctx: Ctx, ref: string): number {
  const found = local(ctx.state, ref);
  if (!found || found[0] !== normalise(ref)) return fail(ctx, `An image does not exist locally with the tag: ${splitRef(ref)[0]}（先用 docker tag 把映像檔標成這個名稱）`);
  const t = parseTarget(ref);
  if (t.kind === "other") return fail(ctx, `這個模擬終端機只能推送到 Amazon ECR（${ECR_REGISTRY}/儲存庫）或 Artifact Registry（區域-docker.pkg.dev/專案/儲存庫/映像檔）。\n（映像檔名稱的開頭要是 registry 的位址）`);
  const image = found[1];
  const layers = [hash(`${image.id}a`), hash(`${image.id}b`), hash(`${image.id}c`)];
  if (t.kind === "ecr") {
    if (!ctx.state.docker.logins.has(t.registry)) return fail(ctx, `no basic auth credentials\n（先用 aws ecr get-login-password 登入 ${t.registry}）`);
    if (t.registry !== ECR_REGISTRY) return fail(ctx, `denied: 這個模擬帳戶的 registry 是 ${ECR_REGISTRY}`);
    const repo = ctx.state.aws.ecr.repositories.get(t.repository);
    ctx.out(`The push refers to repository [${t.registry}/${t.repository}]\n`);
    if (!repo) return fail(ctx, `name unknown: The repository with name '${t.repository}' does not exist in the registry with id '${ACCOUNT}'`);
    if (repo.mutability === "IMMUTABLE" && repo.images.has(t.tag) && repo.images.get(t.tag) !== image.id) {
      return fail(ctx, `tag invalid: The image tag '${t.tag}' already exists in the '${t.repository}' repository and cannot be overwritten because the repository is immutable.`);
    }
    repo.images.set(t.tag, image.id);
  } else {
    if (!ctx.state.docker.logins.has(t.registry)) return fail(ctx, `denied: Unauthenticated request. Unauthenticated requests do not have permission "artifactregistry.repositories.uploadArtifacts"（先執行 gcloud auth configure-docker ${t.registry}）`);
    ctx.out(`The push refers to repository [${t.registry}/${t.project}/${t.repository}/${t.image}]\n`);
    if (t.project !== ctx.state.gcp.project) return fail(ctx, `denied: Permission "artifactregistry.repositories.uploadArtifacts" denied on resource "projects/${t.project}/locations/${t.location}/repositories/${t.repository}"`);
    const repo = ctx.state.gcp.artifacts.repositories.get(`${t.location}/${t.repository}`);
    if (!repo) return fail(ctx, `name unknown: Repository "${t.repository}" not found`);
    const existing = repo.images.get(`${t.image}:${t.tag}`);
    if (repo.immutableTags && existing !== undefined && existing !== image.id) {
      return fail(ctx, `denied: 標籤 ${t.tag} 已經存在，這個儲存庫開啟了不可變標籤（--immutable-tags），不能覆蓋。`);
    }
    repo.images.set(`${t.image}:${t.tag}`, image.id);
  }
  ctx.out(`${layers.map((l) => `${l}: Pushed\n`).join("")}${t.tag}: digest: sha256:${image.id}${hash(image.id)}${hash(t.tag)} size: 1574\n`);
  return 0;
}

export const docker: Command = (ctx, args) => {
  const [sub, ...rest] = args;
  const d = ctx.state.docker;
  switch (sub) {
    case "build":
      return build(ctx, rest);
    case "images": {
      const parsed = parseArgs(rest, { options: ["--filter"], flags: ["-a"] });
      const filter = parsed.options.get("--filter")?.replace(/^reference=/, "");
      const rows = [...d.images].filter(([ref]) => !filter || splitRef(ref)[0] === filter || ref === normalise(filter));
      ctx.out(`${"REPOSITORY".padEnd(60)} ${"TAG".padEnd(10)} ${"IMAGE ID".padEnd(14)} SIZE\n`);
      for (const [ref, i] of rows) {
        const [name, tag] = ref.startsWith("<none>:") ? ["<none>", "<none>"] : splitRef(ref);
        ctx.out(`${name.padEnd(60)} ${tag.padEnd(10)} ${i.id.padEnd(14)} ${i.sizeMb}MB\n`);
      }
      return 0;
    }
    case "tag": {
      if (rest.length !== 2) return fail(ctx, '"docker tag" requires exactly 2 arguments.\nUsage:  docker tag SOURCE_IMAGE[:TAG] TARGET_IMAGE[:TAG]');
      const found = local(ctx.state, rest[0]);
      if (!found) return fail(ctx, `Error response from daemon: No such image: ${normalise(rest[0])}`);
      if (!/^[a-z0-9][a-z0-9._\-/:]*$/.test(rest[1])) return fail(ctx, `Error parsing reference: "${rest[1]}" is not a valid repository/tag: invalid reference format（名稱要用小寫）`);
      d.images.set(normalise(rest[1]), { ...found[1] });
      return 0;
    }
    case "login": {
      const parsed = parseArgs(rest, { options: ["-u", "--username", "-p", "--password"], flags: ["--password-stdin"] });
      if (parsed.unknown) return fail(ctx, `unknown flag: ${parsed.unknown}`);
      const registry = parsed.positional[0];
      if (!registry) return fail(ctx, "這個模擬終端機需要指定 registry，例如 docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com");
      const t = parseTarget(`${registry}/x/x/x`);
      if (t.kind !== "ecr") {
        return fail(ctx, t.kind === "ar" ? `Artifact Registry 請用 gcloud auth configure-docker ${registry} 設定認證。` : "這個模擬終端機只支援登入 Amazon ECR 的 registry。");
      }
      const password = parsed.flags.has("--password-stdin") ? (ctx.stdin ?? "").trim() : (parsed.options.get("-p") ?? parsed.options.get("--password") ?? "");
      if (parsed.options.has("-p") || parsed.options.has("--password")) ctx.err("WARNING! Using --password via the CLI is insecure. Use --password-stdin.");
      const user = parsed.options.get("-u") ?? parsed.options.get("--username");
      if (user !== "AWS" || password !== ECR_TOKEN) {
        return fail(ctx, `Error response from daemon: Get "https://${registry}/v2/": no basic auth credentials\n（使用者名稱是 AWS，密碼用管線傳入：aws ecr get-login-password --region ${ECR_REGION} | docker login --username AWS --password-stdin ${registry}）`);
      }
      if (registry !== ECR_REGISTRY) return fail(ctx, `Error response from daemon: login attempt to https://${registry}/v2/ failed with status: 400 Bad Request（這個模擬帳戶的 registry 是 ${ECR_REGISTRY}）`);
      d.logins.add(registry);
      ctx.out("Login Succeeded\n");
      return 0;
    }
    case "push": {
      if (rest.length !== 1) return fail(ctx, '"docker push" requires exactly 1 argument.');
      return push(ctx, rest[0]);
    }
    case "pull": {
      if (rest.length !== 1) return fail(ctx, '"docker pull" requires exactly 1 argument.');
      const image = pullRemote(ctx, rest[0]);
      if (!image) return 1;
      ctx.out(`${splitRef(rest[0])[1]}: Pulling from ${splitRef(rest[0])[0].split("/").slice(1).join("/")}\nDigest: sha256:${image.id}${hash(image.id)}\nStatus: Downloaded newer image for ${normalise(rest[0])}\n`);
      return 0;
    }
    case "run": {
      const parsed = parseArgs(rest, { options: ["-p", "--publish", "--name"], flags: ["-d", "--detach", "-t", "-i", "-it", "--rm"], shortFlags: "dit" });
      if (parsed.unknown) return fail(ctx, `unknown flag: ${parsed.unknown}`);
      const ref = parsed.positional[0];
      if (!ref) return fail(ctx, '"docker run" requires at least 1 argument.');
      let image = local(ctx.state, ref)?.[1];
      if (!image) {
        if (parseTarget(ref).kind === "other") return fail(ctx, `Unable to find image '${normalise(ref)}' locally\n（這個模擬終端機只能執行本機建置的映像檔，或 Amazon ECR／Artifact Registry 上的映像檔）`);
        const pulled = pullRemote(ctx, ref);
        if (!pulled) return 125;
        image = pulled;
      }
      const ports: string[] = [];
      const publish = parsed.options.get("-p") ?? parsed.options.get("--publish");
      if (publish !== undefined) {
        const m = /^(\d+):(\d+)$/.exec(publish);
        if (!m) return fail(ctx, `invalid argument "${publish}" for "-p, --publish" flag（格式是 主機連接埠:容器連接埠，例如 8080:80）`);
        const used = [...d.containers].find(([, c]) => c.status === "running" && c.ports.some((p) => p.split("->")[0] === m[1]));
        if (used) return fail(ctx, `docker: Error response from daemon: Bind for 0.0.0.0:${m[1]} failed: port is already allocated（容器 ${used[0]} 正在使用）`, 125);
        ports.push(`${m[1]}->${m[2]}`);
      }
      const name = parsed.options.get("--name") ?? `container-${d.containers.size + 1}`;
      if (d.containers.has(name)) return fail(ctx, `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`, 125);
      d.containers.set(name, { image: normalise(ref), ports, status: "running" });
      const detached = parsed.flags.has("-d") || parsed.flags.has("--detach");
      ctx.out(detached ? `${hash(name + image.id)}${hash(image.id + name)}\n` : `（模擬終端機：容器 ${name} 已啟動；真實的終端機會停在這裡顯示容器的輸出，通常加 -d 在背景執行）\n`);
      return 0;
    }
    case "ps": {
      const parsed = parseArgs(rest, { flags: ["-a", "--all"] });
      const all = parsed.flags.has("-a") || parsed.flags.has("--all");
      ctx.out(`${"NAMES".padEnd(14)} ${"IMAGE".padEnd(40)} ${"STATUS".padEnd(10)} PORTS\n`);
      for (const [n, c] of d.containers) {
        if (!all && c.status !== "running") continue;
        ctx.out(`${n.padEnd(14)} ${c.image.padEnd(40)} ${(c.status === "running" ? "Up" : "Exited").padEnd(10)} ${c.ports.map((p) => `0.0.0.0:${p.replace("->", "->")}/tcp`).join(", ")}\n`);
      }
      return 0;
    }
    case "stop":
    case "rm": {
      const parsed = parseArgs(rest, { flags: ["-f", "--force"] });
      for (const n of parsed.positional) {
        const c = d.containers.get(n);
        if (!c) return fail(ctx, `Error response from daemon: No such container: ${n}`);
        if (sub === "stop") c.status = "exited";
        else if (c.status === "running" && !parsed.flags.has("-f") && !parsed.flags.has("--force")) {
          return fail(ctx, `Error response from daemon: cannot remove container "/${n}": container is running: stop the container before removing or force remove`);
        } else d.containers.delete(n);
        ctx.out(`${n}\n`);
      }
      return 0;
    }
    case "rmi": {
      for (const ref of rest) {
        const found = local(ctx.state, ref);
        if (!found) return fail(ctx, `Error response from daemon: No such image: ${normalise(ref)}`);
        const user = [...d.containers].find(([, c]) => c.image === found[0]);
        if (user) return fail(ctx, `Error response from daemon: conflict: unable to remove repository reference "${found[0]}" - container ${user[0]} is using its referenced image`);
        d.images.delete(found[0]);
        ctx.out(`Untagged: ${found[0]}\n`);
      }
      return 0;
    }
    default:
      return fail(ctx, sub ? `docker: '${sub}' is not a docker command.\n${SUPPORTED}` : `Usage:  docker [OPTIONS] COMMAND\n${SUPPORTED}`);
  }
};

/** curl http://localhost:PORT — answers from a running container that publishes the port. */
export const curl: Command = (ctx, args) => {
  const url = args.find((a) => !a.startsWith("-"));
  if (!url) return fail(ctx, "curl: try 'curl --help' for more information");
  const m = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::(\d+))?(\/.*)?$/.exec(url);
  if (!m) return fail(ctx, `curl: (6) Could not resolve host: ${url.replace(/^https?:\/\//, "").split("/")[0]}（這個模擬終端機的 curl 只能連到 localhost 上的容器）`, 6);
  const port = m[1] ?? "80";
  const running = [...ctx.state.docker.containers.values()].find((c) => c.status === "running" && c.ports.some((p) => p.split("->")[0] === port));
  if (!running) return fail(ctx, `curl: (7) Failed to connect to localhost port ${port}: Connection refused`, 7);
  const image = ctx.state.docker.images.get(running.image);
  const containerPort = Number(running.ports.find((p) => p.startsWith(`${port}->`))!.split("->")[1]);
  if (!image?.exposed.includes(containerPort) && image?.exposed.length) {
    return fail(ctx, `curl: (56) Recv failure: Connection reset by peer（容器裡的程式聽的是 ${image.exposed.join("、")} 連接埠，不是 ${containerPort}）`, 56);
  }
  ctx.out(image?.index ?? "<html><body>It works!</body></html>\n");
  return 0;
};
