import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content/loader";
import { advance, passes } from "./check";
import { complete, execute, prompt } from "./engine";
import { parseLine } from "./parse";
import { HOME, checkView, createLabState, resolvePath, type LabState } from "./state";

/** Runs lines in order; returns the final state and the output of the last line. */
function sh(state: LabState, ...lines: string[]) {
  let out: string[] = [];
  let errors: string[] = [];
  for (const line of lines) {
    const result = execute(state, line);
    state = result.state;
    out = result.lines.filter((l) => !l.error).map((l) => l.text);
    errors = result.lines.filter((l) => l.error).map((l) => l.text);
  }
  return { state, out, errors, text: out.join("\n") };
}

const fresh = (files: Record<string, string> = {}) => createLabState({ files });
const view = (state: LabState) => checkView(state) as { files: Record<string, string>; dirs: Record<string, true>; cwd: string };

describe("parseLine", () => {
  const argv = (line: string) => {
    const r = parseLine(line);
    if (!r.ok) throw new Error(r.error);
    return r.commands.map((c) => c.argv);
  };

  it("splits words and keeps quoted text together", () => {
    expect(argv(`echo "hello   world" 'a b' c\\ d`)).toEqual([["echo", "hello   world", "a b", "c d"]]);
    expect(argv(`echo a"b c"d`)).toEqual([["echo", "ab cd"]]);
    expect(argv(`echo ""`)).toEqual([["echo", ""]]);
  });

  it("parses redirection, chaining and comments", () => {
    const r = parseLine("echo hi >> out.txt && ls ; pwd # trailing");
    expect(r).toEqual({
      ok: true,
      commands: [
        { argv: ["echo", "hi"], redirect: { path: "out.txt", append: true }, joiner: "first" },
        { argv: ["ls"], joiner: "and" },
        { argv: ["pwd"], joiner: "then" },
      ],
    });
    expect(argv("echo a>b")).toEqual([["echo", "a"]]);
  });

  it("returns no commands for a blank or comment-only line", () => {
    expect(parseLine("   ")).toEqual({ ok: true, commands: [] });
    expect(parseLine("# just a comment")).toEqual({ ok: true, commands: [] });
  });

  it("reports unclosed quotes, dangling operators and unsupported syntax", () => {
    for (const line of [`echo "oops`, "echo 'oops", "echo >", "&& ls", "ls &&", "ls | cat", "cat < x", "sleep &"]) {
      expect(parseLine(line).ok, line).toBe(false);
    }
  });
});

describe("paths", () => {
  it("resolves ~, relative, absolute, . and ..", () => {
    expect(resolvePath(HOME, "~")).toBe(HOME);
    expect(resolvePath("/tmp", "~/a/../b")).toBe(`${HOME}/b`);
    expect(resolvePath(HOME, "x/./y//z/")).toBe(`${HOME}/x/y/z`);
    expect(resolvePath(HOME, "../../../..")).toBe("/");
    expect(resolvePath(HOME, "/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("linux commands", () => {
  it("pwd, cd and the prompt follow the current directory", () => {
    let s = fresh();
    expect(sh(s, "pwd").text).toBe(HOME);
    s = sh(s, "mkdir -p a/b", "cd a/b").state;
    expect(prompt(s)).toBe("learner@cloud:~/a/b$");
    expect(sh(s, "cd ..", "pwd").text).toBe(`${HOME}/a`);
    expect(sh(s, "cd", "pwd").text).toBe(HOME);
    expect(sh(s, "cd /", "pwd").text).toBe("/");
    expect(sh(s, "cd nope").errors[0]).toMatch(/No such file or directory/);
  });

  it("cd into a file is an error and leaves cwd alone", () => {
    const r = sh(fresh({ "~/f.txt": "x" }), "cd f.txt");
    expect(r.errors[0]).toMatch(/Not a directory/);
    expect(r.state.cwd).toBe(HOME);
  });

  it("ls lists entries, marks directories and hides dotfiles unless -a", () => {
    const s = sh(fresh({ "~/b.txt": "hello", "~/.hidden": "" }), "mkdir a").state;
    expect(sh(s, "ls").text).toBe("a/  b.txt");
    expect(sh(s, "ls -a").text).toBe(".hidden  a/  b.txt");
    expect(sh(s, "ls -l").out).toEqual(["drwxr-xr-x learner  4096 a/", "-rw-r--r-- learner     5 b.txt"]);
    expect(sh(s, "ls -la").out).toHaveLength(3);
    expect(sh(s, "ls a").out).toEqual([]);
    expect(sh(s, "ls b.txt").text).toBe("b.txt");
    expect(sh(s, "ls missing").errors[0]).toMatch(/cannot access 'missing'/);
    expect(sh(s, "ls -z").errors).toHaveLength(1);
  });

  it("mkdir needs the parent unless -p, and refuses existing names", () => {
    const s = fresh({ "~/f": "" });
    expect(sh(s, "mkdir x/y").errors[0]).toMatch(/No such file or directory/);
    expect(view(sh(s, "mkdir -p x/y").state).dirs["~/x/y"]).toBe(true);
    expect(sh(s, "mkdir f").errors[0]).toMatch(/File exists/);
    expect(sh(s, "mkdir d", "mkdir d").errors[0]).toMatch(/File exists/);
    expect(sh(s, "mkdir d", "mkdir -p d").errors).toEqual([]);
    expect(sh(s, "mkdir -p f/sub").errors[0]).toMatch(/Not a directory/);
  });

  it("touch creates empty files without clobbering existing ones", () => {
    const s = sh(fresh({ "~/keep.txt": "data" }), "touch new.txt keep.txt").state;
    expect(view(s).files).toEqual({ "~/keep.txt": "data", "~/new.txt": "" });
    expect(sh(s, "touch nodir/x").errors[0]).toMatch(/No such file or directory/);
  });

  it("echo with > overwrites and >> appends", () => {
    const s = sh(fresh(), "echo one > f.txt", "echo two >> f.txt").state;
    expect(view(s).files["~/f.txt"]).toBe("one\ntwo\n");
    expect(view(sh(s, "echo three > f.txt").state).files["~/f.txt"]).toBe("three\n");
    expect(view(sh(s, "echo -n raw > g.txt").state).files["~/g.txt"]).toBe("raw");
    expect(sh(s, "echo hi > f.txt").out).toEqual([]);
  });

  it("redirecting into a missing directory or onto a directory fails without running the write", () => {
    const s = sh(fresh(), "mkdir d").state;
    expect(sh(s, "echo x > nodir/f").errors[0]).toMatch(/No such file or directory/);
    expect(sh(s, "echo x > d").errors[0]).toMatch(/Is a directory/);
  });

  it("cat prints files and reports directories and missing files", () => {
    const s = sh(fresh({ "~/a": "A\n", "~/b": "B\n" }), "mkdir d").state;
    expect(sh(s, "cat a b").out).toEqual(["A", "B"]);
    expect(sh(s, "cat d").errors[0]).toMatch(/Is a directory/);
    expect(sh(s, "cat nope").errors[0]).toMatch(/No such file/);
    expect(view(sh(s, "cat a b > c").state).files["~/c"]).toBe("A\nB\n");
  });

  it("cp copies files to a name or into a directory, and directories only with -r", () => {
    let s = sh(fresh({ "~/a.txt": "A" }), "mkdir -p d/sub", "cp a.txt b.txt", "cp a.txt d", "cp a.txt d/").state;
    expect(view(s).files).toMatchObject({ "~/a.txt": "A", "~/b.txt": "A", "~/d/a.txt": "A" });
    expect(sh(s, "cp d e").errors[0]).toMatch(/-r not specified/);
    s = sh(s, "cp -r d e").state;
    expect(view(s).files["~/e/a.txt"]).toBe("A");
    expect(view(s).dirs["~/e/sub"]).toBe(true);
    expect(view(s).dirs["~/d/sub"]).toBe(true);
    expect(sh(s, "cp nope x").errors[0]).toMatch(/cannot stat/);
    expect(sh(s, "cp a.txt").errors[0]).toMatch(/missing destination/);
    expect(sh(s, "cp a.txt a.txt").errors[0]).toMatch(/same file/);
    expect(sh(s, "cp -r d d/inner").errors[0]).toMatch(/into itself/);
  });

  it("mv renames and moves files and directories", () => {
    let s = sh(fresh({ "~/a.txt": "A" }), "mkdir d", "mv a.txt b.txt").state;
    expect(view(s).files).toEqual({ "~/b.txt": "A" });
    s = sh(s, "mv b.txt d", "mv d e").state;
    expect(view(s).files).toEqual({ "~/e/b.txt": "A" });
    expect(view(s).dirs["~/d"]).toBeUndefined();
    expect(sh(s, "cd e", "mv ~/e ~/f").errors[0]).toMatch(/目前所在的目錄/);
  });

  it("rm removes files, needs -r for directories, and -f ignores missing files", () => {
    let s = sh(fresh({ "~/a": "", "~/d/x": "", "~/d/sub/y": "" })).state;
    expect(sh(s, "rm d").errors[0]).toMatch(/Is a directory/);
    expect(sh(s, "rm nope").errors[0]).toMatch(/No such file/);
    expect(sh(s, "rm -f nope").errors).toEqual([]);
    s = sh(s, "rm a", "rm -rf d").state;
    expect(view(s).files).toEqual({});
    expect(view(s).dirs["~/d/sub"]).toBeUndefined();
  });

  it("refuses to remove the home directory, its parents or the current directory", () => {
    const s = sh(fresh(), "mkdir -p a/b", "cd a/b").state;
    for (const cmd of ["rm -rf ~", "rm -rf /", "rm -rf /home", "rm -r ~/a", "rmdir ~/a/b"]) {
      const r = sh(s, cmd);
      expect(r.errors, cmd).toHaveLength(1);
      expect(r.state.dirs.has(`${HOME}/a/b`), cmd).toBe(true);
    }
  });

  it("rmdir removes only empty directories", () => {
    const s = sh(fresh({ "~/full/f": "" }), "mkdir empty").state;
    expect(sh(s, "rmdir full").errors[0]).toMatch(/not empty/);
    expect(view(sh(s, "rmdir empty").state).dirs["~/empty"]).toBeUndefined();
  });

  it("&& stops after a failure, ; keeps going", () => {
    expect(view(sh(fresh(), "cd nope && touch a").state).files).toEqual({});
    expect(view(sh(fresh(), "cd nope ; touch a").state).files).toEqual({ "~/a": "" });
    expect(sh(fresh(), "mkdir d && cd d && pwd").text).toBe(`${HOME}/d`);
  });

  it("reports unknown commands and never changes the input state", () => {
    const s = fresh({ "~/a": "1" });
    expect(sh(s, "kubectl get pods").errors[0]).toMatch(/kubectl: command not found/);
    expect(sh(s, "constructor").errors[0]).toMatch(/command not found/);
    execute(s, "rm a && mkdir d && cd d");
    expect(view(s)).toMatchObject({ cwd: "~", files: { "~/a": "1" } });
    expect(view(s).dirs["~/d"]).toBeUndefined();
  });

  it("clear drops earlier output and asks for a clear screen; help lists commands", () => {
    const r = execute(fresh(), "echo before; clear; echo after");
    expect(r.clear).toBe(true);
    expect(r.lines.map((l) => l.text)).toEqual(["after"]);
    expect(sh(fresh(), "help").text).toMatch(/gcloud storage/);
  });

  it("handles file names that collide with object prototype keys", () => {
    const s = sh(fresh(), "echo x > __proto__", "mkdir constructor").state;
    expect(sh(s, "cat __proto__").text).toBe("x");
    expect(sh(s, "ls").text).toBe("__proto__  constructor/");
    expect(passes(s, { type: "state", path: ["files", "~/__proto__"], exists: true })).toBe(true);
    expect(passes(fresh(), { type: "state", path: ["files", "__proto__"], exists: true })).toBe(false);
    expect(passes(fresh(), { type: "state", path: ["files", "constructor"], exists: true })).toBe(false);
  });
});

describe("tab completion", () => {
  const s = sh(fresh({ "~/report.txt": "", "~/readme.md": "", "~/.env": "" }), "mkdir projects", "touch projects/notes.txt").state;

  it("completes command names", () => {
    expect(complete(s, "mkd")).toBe("mkdir ");
    expect(complete(s, "gc")).toBe("gcloud ");
    expect(complete(s, "")).toBe("");
  });

  it("completes a unique path, adding / for directories and a space for files", () => {
    expect(complete(s, "cd pro")).toBe("cd projects/");
    expect(complete(s, "cat rep")).toBe("cat report.txt ");
    expect(complete(s, "cat projects/n")).toBe("cat projects/notes.txt ");
    expect(complete(s, "cat ~/projects/n")).toBe("cat ~/projects/notes.txt ");
  });

  it("extends to the common prefix when several match, and leaves no-match alone", () => {
    expect(complete(s, "cat r")).toBe("cat re");
    expect(complete(s, "cat re")).toBe("cat re");
    expect(complete(s, "cat zzz")).toBe("cat zzz");
    expect(complete(s, "cat nodir/x")).toBe("cat nodir/x");
  });

  it("only offers dotfiles when the word starts with a dot, and skips bucket URLs", () => {
    expect(complete(s, "cat .")).toBe("cat .env ");
    expect(complete(s, "aws s3 ls s3://b")).toBe("aws s3 ls s3://b");
  });
});

describe("aws s3", () => {
  const withFile = () => fresh({ "~/report.txt": "Q3 sales report\n" });
  const s3 = (state: LabState) => (checkView(state) as { cloud: { s3: { buckets: Record<string, { region: string; objects: Record<string, string> }> } } }).cloud.s3.buckets;

  it("mb creates a bucket in the default or given region", () => {
    const r = sh(withFile(), "aws s3 mb s3://my-data-bucket", "aws s3 mb s3://tokyo --region ap-northeast-1");
    expect(r.text).toBe("make_bucket: tokyo");
    expect(s3(r.state)["my-data-bucket"].region).toBe("us-east-1");
    expect(s3(r.state).tokyo.region).toBe("ap-northeast-1");
    expect(s3(sh(withFile(), "aws s3 mb s3://eqq --region=eu-west-1").state).eqq.region).toBe("eu-west-1");
  });

  it("mb rejects duplicates, bad names and a missing s3:// prefix", () => {
    const s = sh(withFile(), "aws s3 mb s3://taken").state;
    expect(sh(s, "aws s3 mb s3://taken").errors[0]).toMatch(/BucketAlreadyOwnedByYou/);
    expect(sh(s, "aws s3 mb s3://My_Bucket").errors[0]).toMatch(/InvalidBucketName/);
    expect(sh(s, "aws s3 mb s3://ab").errors[0]).toMatch(/InvalidBucketName/);
    expect(sh(s, "aws s3 mb my-bucket").errors[0]).toMatch(/usage/);
    expect(sh(s, "aws s3 mb").errors[0]).toMatch(/usage/);
    expect(Object.keys(s3(sh(s, "aws s3 mb my-bucket").state))).toEqual(["taken"]);
  });

  it("cp uploads to an explicit key, a bucket root or a folder", () => {
    const s = sh(withFile(), "aws s3 mb s3://bbb").state;
    const r = sh(s, "aws s3 cp report.txt s3://bbb/reports/report.txt");
    expect(r.text).toBe("upload: ./report.txt to s3://bbb/reports/report.txt");
    expect(s3(r.state).bbb.objects).toEqual({ "reports/report.txt": "Q3 sales report\n" });
    expect(Object.keys(s3(sh(s, "aws s3 cp report.txt s3://bbb").state).bbb.objects)).toEqual(["report.txt"]);
    expect(Object.keys(s3(sh(s, "aws s3 cp ~/report.txt s3://bbb/reports/").state).bbb.objects)).toEqual(["reports/report.txt"]);
    expect(Object.keys(s3(sh(s, "aws s3 cp report.txt s3://bbb/renamed.txt").state).bbb.objects)).toEqual(["renamed.txt"]);
  });

  it("cp reports a missing file, missing bucket, missing key and two local paths", () => {
    const s = sh(withFile(), "aws s3 mb s3://bbb").state;
    expect(sh(s, "aws s3 cp nope.txt s3://bbb/").errors[0]).toMatch(/does not exist/);
    expect(sh(s, "aws s3 cp report.txt s3://missing/").errors[0]).toMatch(/NoSuchBucket/);
    expect(sh(s, "aws s3 cp s3://bbb/nope.txt .").errors[0]).toMatch(/Key "nope.txt" does not exist/);
    expect(sh(s, "aws s3 cp report.txt copy.txt").errors[0]).toMatch(/usage/);
    expect(sh(s, "aws s3 cp report.txt").errors[0]).toMatch(/usage/);
  });

  it("cp downloads to a directory or a new name, and copies between buckets", () => {
    const s = sh(withFile(), "aws s3 mb s3://bbb", "aws s3 mb s3://ccc", "aws s3 cp report.txt s3://bbb/r/report.txt", "mkdir dl").state;
    expect(view(sh(s, "aws s3 cp s3://bbb/r/report.txt dl").state).files["~/dl/report.txt"]).toBe("Q3 sales report\n");
    expect(view(sh(s, "aws s3 cp s3://bbb/r/report.txt ./copy.txt").state).files["~/copy.txt"]).toBe("Q3 sales report\n");
    expect(sh(s, "aws s3 cp s3://bbb/r/report.txt nodir/x").errors).toHaveLength(1);
    const copied = sh(s, "aws s3 cp s3://bbb/r/report.txt s3://ccc/");
    expect(copied.text).toBe("copy: s3://bbb/r/report.txt to s3://ccc/report.txt");
    expect(s3(copied.state).ccc.objects).toEqual({ "report.txt": "Q3 sales report\n" });
  });

  it("cp --recursive uploads a directory; without it a directory is refused", () => {
    const s = sh(fresh({ "~/site/index.html": "<h1>", "~/site/css/a.css": "a" }), "aws s3 mb s3://bbb").state;
    expect(sh(s, "aws s3 cp site s3://bbb/").errors).toHaveLength(1);
    expect(s3(sh(s, "aws s3 cp site s3://bbb/www --recursive").state).bbb.objects).toEqual({
      "www/index.html": "<h1>",
      "www/css/a.css": "a",
    });
  });

  it("mv removes the source", () => {
    const r = sh(withFile(), "aws s3 mb s3://bbb", "aws s3 mv report.txt s3://bbb/");
    expect(r.text).toBe("move: ./report.txt to s3://bbb/report.txt");
    expect(view(r.state).files).toEqual({});
    const back = sh(r.state, "aws s3 mv s3://bbb/report.txt .");
    expect(s3(back.state).bbb.objects).toEqual({});
    expect(view(back.state).files["~/report.txt"]).toBe("Q3 sales report\n");
  });

  it("ls lists buckets, folders as PRE, and objects with sizes", () => {
    const s = sh(withFile(), "aws s3 mb s3://bbb", "aws s3 mb s3://aaa", "aws s3 cp report.txt s3://bbb/reports/report.txt", "aws s3 cp report.txt s3://bbb/top.txt").state;
    expect(sh(s, "aws s3 ls").out).toEqual(["2026-01-01 09:00:00 aaa", "2026-01-01 09:00:00 bbb"]);
    expect(sh(s, "aws s3 ls s3://bbb").out).toEqual([`${" ".repeat(27)}PRE reports/`, "2026-01-01 09:00:00         16 top.txt"]);
    expect(sh(s, "aws s3 ls s3://bbb/reports/").out).toEqual(["2026-01-01 09:00:00         16 report.txt"]);
    expect(sh(s, "aws s3 ls s3://bbb/rep").out).toEqual([`${" ".repeat(27)}PRE reports/`]);
    expect(sh(s, "aws s3 ls s3://bbb --recursive").out).toHaveLength(2);
    expect(sh(s, "aws s3 ls s3://aaa").out).toEqual([]);
    expect(sh(s, "aws s3 ls s3://missing").errors[0]).toMatch(/NoSuchBucket/);
  });

  it("rm deletes one object or everything under a prefix", () => {
    const s = sh(withFile(), "aws s3 mb s3://bbb", "aws s3 cp report.txt s3://bbb/x/1", "aws s3 cp report.txt s3://bbb/x/2", "aws s3 cp report.txt s3://bbb/y").state;
    expect(Object.keys(s3(sh(s, "aws s3 rm s3://bbb/y").state).bbb.objects)).toEqual(["x/1", "x/2"]);
    expect(Object.keys(s3(sh(s, "aws s3 rm s3://bbb/x/ --recursive").state).bbb.objects)).toEqual(["y"]);
    expect(sh(s, "aws s3 rm s3://bbb").errors).toHaveLength(1);
    expect(sh(s, "aws s3 rm s3://bbb/never-existed").text).toBe("delete: s3://bbb/never-existed");
  });

  it("rb refuses a non-empty bucket unless --force", () => {
    const s = sh(withFile(), "aws s3 mb s3://bbb", "aws s3 cp report.txt s3://bbb/").state;
    expect(sh(s, "aws s3 rb s3://bbb").errors[0]).toMatch(/BucketNotEmpty/);
    expect(s3(sh(s, "aws s3 rb s3://bbb --force").state)).toEqual({});
    expect(s3(sh(s, "aws s3 rm s3://bbb/report.txt", "aws s3 rb s3://bbb").state)).toEqual({});
    expect(sh(s, "aws s3 rb s3://missing").errors[0]).toMatch(/NoSuchBucket/);
  });

  it("explains unsupported services, subcommands and options", () => {
    expect(sh(fresh(), "aws ec2 describe-instances").errors[0]).toMatch(/不支援的服務 'ec2'/);
    expect(sh(fresh(), "aws s3 sync . s3://bbb").errors[0]).toMatch(/不支援的 s3 指令 'sync'/);
    expect(sh(fresh(), "aws s3 ls --profile x").errors[0]).toMatch(/Unknown options: --profile/);
    expect(sh(fresh(), "aws").errors[0]).toMatch(/usage/);
  });
});

describe("gcloud storage and gsutil", () => {
  const withFile = () => fresh({ "~/report.txt": "Q3 sales report\n" });
  const gcs = (state: LabState) =>
    (checkView(state) as { cloud: { gcs: { buckets: Record<string, { location: string; storageClass: string; objects: Record<string, string> }> } } }).cloud.gcs.buckets;

  it("buckets create accepts --location in both forms and defaults to us", () => {
    const r = sh(
      withFile(),
      "gcloud storage buckets create gs://aaa --location=asia-east1",
      "gcloud storage buckets create gs://bbb --location ASIA-EAST1 --default-storage-class=nearline",
      "gcloud storage buckets create gs://ccc",
      "gcloud storage buckets create --location=europe-west1 gs://ddd",
    );
    expect(r.text).toBe("Creating gs://ddd/...");
    expect(gcs(r.state).aaa).toEqual({ location: "asia-east1", storageClass: "STANDARD", objects: {} });
    expect(gcs(r.state).bbb).toMatchObject({ location: "asia-east1", storageClass: "NEARLINE" });
    expect(gcs(r.state).ccc.location).toBe("us");
    expect(gcs(r.state).ddd.location).toBe("europe-west1");
  });

  it("buckets create rejects duplicates, bad names, bad classes and unknown flags", () => {
    const s = sh(withFile(), "gcloud storage buckets create gs://taken").state;
    expect(sh(s, "gcloud storage buckets create gs://taken").errors[0]).toMatch(/409/);
    expect(sh(s, "gcloud storage buckets create gs://UPPER").errors[0]).toMatch(/400/);
    expect(sh(s, "gcloud storage buckets create gs://__proto__").errors[0]).toMatch(/400/);
    expect(sh(s, "gcloud storage buckets create gs://xx1 --default-storage-class=glacier").errors[0]).toMatch(/Invalid storage class/);
    expect(sh(s, "gcloud storage buckets create gs://xx1 --region=asia-east1").errors[0]).toMatch(/unrecognized arguments: --region=asia-east1/);
    expect(sh(s, "gcloud storage buckets create taken2").errors).toHaveLength(1);
    expect(Object.keys(gcs(sh(s, "gcloud storage buckets create gs://xx1 --region=asia-east1").state))).toEqual(["taken"]);
  });

  it("describe and list show the location in upper case", () => {
    const s = sh(withFile(), "gcloud storage buckets create gs://aaa --location=asia-east1").state;
    expect(sh(s, "gcloud storage buckets describe gs://aaa").out).toContain("location: ASIA-EAST1");
    expect(sh(s, "gcloud storage buckets list").text).toBe("gs://aaa/  ASIA-EAST1  STANDARD");
    expect(sh(s, "gcloud storage buckets describe gs://nope").errors[0]).toMatch(/not found: 404/);
  });

  it("cp uploads, downloads and copies between buckets", () => {
    const s = sh(withFile(), "gcloud storage buckets create gs://aaa", "gcloud storage buckets create gs://bbb").state;
    const up = sh(s, "gcloud storage cp report.txt gs://aaa/reports/report.txt");
    expect(up.text).toBe("Copying file://~/report.txt to gs://aaa/reports/report.txt");
    expect(gcs(up.state).aaa.objects).toEqual({ "reports/report.txt": "Q3 sales report\n" });
    expect(Object.keys(gcs(sh(s, "gcloud storage cp report.txt gs://aaa").state).aaa.objects)).toEqual(["report.txt"]);
    expect(Object.keys(gcs(sh(s, "gcloud storage cp report.txt gs://aaa/reports/").state).aaa.objects)).toEqual(["reports/report.txt"]);
    const s2 = sh(up.state, "mkdir dl", "gcloud storage cp gs://aaa/reports/report.txt dl/", "gcloud storage cp gs://aaa/reports/report.txt gs://bbb/").state;
    expect(view(s2).files["~/dl/report.txt"]).toBe("Q3 sales report\n");
    expect(gcs(s2).bbb.objects).toEqual({ "report.txt": "Q3 sales report\n" });
    expect(sh(s, "gcloud storage cp nope gs://aaa/").errors[0]).toMatch(/matched no objects/);
    expect(sh(s, "gcloud storage cp report.txt gs://missing/").errors[0]).toMatch(/not found: 404/);
    expect(sh(s, "gcloud storage cp report.txt other.txt").errors).toHaveLength(1);
  });

  it("ls, cat, rm and mv work on objects", () => {
    const s = sh(withFile(), "gcloud storage buckets create gs://aaa", "gcloud storage cp report.txt gs://aaa/r/report.txt", "gcloud storage cp report.txt gs://aaa/top.txt").state;
    expect(sh(s, "gcloud storage ls").out).toEqual(["gs://aaa/"]);
    expect(sh(s, "gcloud storage ls gs://aaa").out).toEqual(["gs://aaa/top.txt", "gs://aaa/r/"]);
    expect(sh(s, "gcloud storage ls gs://aaa/r").out).toEqual(["gs://aaa/r/report.txt"]);
    expect(sh(s, "gcloud storage ls gs://aaa/top.txt").out).toEqual(["gs://aaa/top.txt"]);
    expect(sh(s, "gcloud storage ls --long gs://aaa/r/").out).toEqual(["        16  gs://aaa/r/report.txt"]);
    expect(sh(s, "gcloud storage ls gs://aaa/nope").errors).toHaveLength(1);
    expect(sh(s, "gcloud storage cat gs://aaa/top.txt").text).toBe("Q3 sales report");
    expect(Object.keys(gcs(sh(s, "gcloud storage rm gs://aaa/top.txt").state).aaa.objects)).toEqual(["r/report.txt"]);
    expect(sh(s, "gcloud storage rm gs://aaa/nope").errors[0]).toMatch(/matched no objects/);
    expect(sh(s, "gcloud storage rm gs://aaa/r").errors[0]).toMatch(/matched no objects/);
    expect(Object.keys(gcs(sh(s, "gcloud storage rm --recursive gs://aaa/r").state).aaa.objects)).toEqual(["top.txt"]);
    expect(gcs(sh(s, "gcloud storage rm -r gs://aaa").state)).toEqual({});
    expect(Object.keys(gcs(sh(s, "gcloud storage mv gs://aaa/top.txt gs://aaa/moved.txt").state).aaa.objects).sort()).toEqual(["moved.txt", "r/report.txt"]);
  });

  it("buckets delete refuses a non-empty bucket", () => {
    const s = sh(withFile(), "gcloud storage buckets create gs://aaa", "gcloud storage cp report.txt gs://aaa/").state;
    expect(sh(s, "gcloud storage buckets delete gs://aaa").errors[0]).toMatch(/not empty/);
    expect(gcs(sh(s, "gcloud storage rm gs://aaa/report.txt", "gcloud storage buckets delete gs://aaa").state)).toEqual({});
  });

  it("gsutil does the same operations", () => {
    const r = sh(withFile(), "gsutil mb -l asia-east1 gs://aaa", "gsutil cp report.txt gs://aaa/reports/", "gsutil ls gs://aaa/reports/");
    expect(r.out).toEqual(["gs://aaa/reports/report.txt"]);
    expect(gcs(r.state).aaa).toMatchObject({ location: "asia-east1", objects: { "reports/report.txt": "Q3 sales report\n" } });
    expect(gcs(sh(r.state, "gsutil rm gs://aaa/reports/report.txt", "gsutil rb gs://aaa").state)).toEqual({});
    expect(sh(r.state, "gsutil rsync . gs://aaa").errors[0]).toMatch(/gsutil/);
  });

  it("explains unsupported gcloud groups", () => {
    expect(sh(fresh(), "gcloud compute instances list").errors[0]).toMatch(/不支援 'compute'/);
    expect(sh(fresh(), "gcloud storage rsync a b").errors[0]).toMatch(/不支援的指令 'rsync'/);
    expect(sh(fresh(), "gcloud storage buckets update gs://aaa").errors[0]).toMatch(/不支援的指令 'update'/);
  });

  it("keeps the two clouds separate", () => {
    const s = sh(withFile(), "aws s3 mb s3://shared-name", "gcloud storage buckets create gs://shared-name").state;
    const cloud = (checkView(s) as { cloud: { s3: { buckets: object }; gcs: { buckets: object } } }).cloud;
    expect(Object.keys(cloud.s3.buckets)).toEqual(["shared-name"]);
    expect(Object.keys(cloud.gcs.buckets)).toEqual(["shared-name"]);
    expect(sh(s, "aws s3 cp report.txt gs://shared-name/").errors).toHaveLength(1);
  });
});

describe("checks", () => {
  it("exists and equals against files, dirs, cwd and cloud state", () => {
    const s = sh(fresh(), "mkdir p", "echo hello > p/n.txt", "cd p", "aws s3 mb s3://bkt --region ap-northeast-1").state;
    const ok = (path: string[], rest: object) => passes(s, { type: "state", path, ...rest });
    expect(ok(["dirs", "~/p"], { exists: true })).toBe(true);
    expect(ok(["dirs", "~/q"], { exists: true })).toBe(false);
    expect(ok(["dirs", "~/q"], { exists: false })).toBe(true);
    expect(ok(["files", "~/p/n.txt"], { equals: "hello\n" })).toBe(true);
    expect(ok(["files", "~/p/n.txt"], { equals: "hello" })).toBe(false);
    expect(ok(["files", "~/missing"], { equals: "" })).toBe(false);
    expect(ok(["cwd"], { equals: "~/p" })).toBe(true);
    expect(ok(["cloud", "s3", "buckets", "bkt", "region"], { equals: "ap-northeast-1" })).toBe(true);
    expect(ok(["cloud", "s3", "buckets", "bkt", "objects"], { equals: {} })).toBe(true);
    expect(ok(["cloud", "s3", "buckets", "bkt", "region", "deeper"], { exists: true })).toBe(false);
  });

  it("advance completes steps in order and never un-completes them", () => {
    const steps = [
      { check: { type: "state" as const, path: ["files", "~/a"], exists: true } },
      { check: { type: "state" as const, path: ["files", "~/b"], exists: true } },
      { check: { type: "state" as const, path: ["files", "~/a"], exists: false } },
    ];
    let s = fresh();
    expect(advance(0, s, steps)).toBe(0);
    // Doing step 2 first does not count until step 1 is done.
    s = sh(s, "touch b").state;
    expect(advance(0, s, steps)).toBe(0);
    s = sh(s, "touch a").state;
    expect(advance(0, s, steps)).toBe(2);
    // Step 3 undoes step 1's condition; steps 1 and 2 stay done.
    s = sh(s, "rm a").state;
    expect(advance(2, s, steps)).toBe(3);
    expect(advance(3, s, steps)).toBe(3);
    expect(advance(99, s, steps)).toBe(3);
  });
});

describe("real labs can be completed", () => {
  const labs = new Map([...loadContent().units.values()].flatMap((u) => u.labs).map((l) => [l.id, l]));

  /** Runs each group of commands and returns completed-step counts after each group. */
  function play(labId: string, groups: string[][]): number[] {
    const lab = labs.get(labId)!;
    let state = createLabState(lab.initialState);
    let done = advance(0, state, lab.steps);
    return groups.map((commands) => {
      for (const c of commands) {
        const result = execute(state, c);
        state = result.state;
        done = advance(done, state, lab.steps);
      }
      return done;
    });
  }

  it("no lab starts with a step already complete", () => {
    for (const lab of labs.values()) {
      expect(advance(0, createLabState(lab.initialState), lab.steps), lab.id).toBe(0);
    }
  });

  it("linux-files, one step at a time", () => {
    expect(
      play("linux-files", [
        ["ls", "mkdir projects"],
        ["echo hello > projects/notes.txt"],
        ["cp todo.txt projects/"],
        ["mv projects/todo.txt projects/done.txt"],
        ["rm todo.txt"],
      ]),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("linux-files, a different valid route (cd in, absolute paths, quotes)", () => {
    expect(
      play("linux-files", [
        ["mkdir ~/projects && cd projects"],
        ['echo "hello" > notes.txt'],
        ["cp ../todo.txt ."],
        ["mv todo.txt done.txt"],
        ["rm /home/learner/todo.txt"],
      ]),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("linux-files does not accept the wrong file content", () => {
    expect(play("linux-files", [["mkdir projects"], ["echo goodbye > projects/notes.txt"]])).toEqual([1, 1]);
  });

  it("s3-create-bucket", () => {
    expect(
      play("s3-create-bucket", [["aws s3 mb s3://my-data-bucket"], ["aws s3 cp report.txt s3://my-data-bucket/reports/report.txt"]]),
    ).toEqual([1, 2]);
    expect(
      play("s3-create-bucket", [["aws s3 mb s3://my-data-bucket --region ap-northeast-1"], ["aws s3 cp ~/report.txt s3://my-data-bucket/reports/"]]),
    ).toEqual([1, 2]);
  });

  it("s3-create-bucket does not pass with the wrong bucket name or key", () => {
    expect(play("s3-create-bucket", [["aws s3 mb s3://other-bucket"]])).toEqual([0]);
    expect(play("s3-create-bucket", [["aws s3 mb s3://my-data-bucket"], ["aws s3 cp report.txt s3://my-data-bucket/"]])).toEqual([1, 1]);
  });

  it("gcs-create-bucket with gcloud and with gsutil", () => {
    expect(
      play("gcs-create-bucket", [
        ["gcloud storage buckets create gs://my-data-bucket --location=asia-east1"],
        ["gcloud storage cp report.txt gs://my-data-bucket/reports/report.txt"],
      ]),
    ).toEqual([2, 3]);
    expect(play("gcs-create-bucket", [["gsutil mb -l asia-east1 gs://my-data-bucket"], ["gsutil cp report.txt gs://my-data-bucket/reports/"]])).toEqual([2, 3]);
  });

  it("gcs-create-bucket: wrong location blocks step 2 until the bucket is recreated", () => {
    expect(
      play("gcs-create-bucket", [
        ["gcloud storage buckets create gs://my-data-bucket"],
        ["gcloud storage cp report.txt gs://my-data-bucket/reports/report.txt"],
        ["gcloud storage rm gs://my-data-bucket/reports/report.txt", "gcloud storage buckets delete gs://my-data-bucket"],
        ["gcloud storage buckets create gs://my-data-bucket --location=asia-east1"],
        ["gcloud storage cp report.txt gs://my-data-bucket/reports/report.txt"],
      ]),
    ).toEqual([1, 1, 1, 2, 3]);
  });
});
