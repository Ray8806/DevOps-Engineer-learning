import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content/loader";
import { decodeArchive } from "./archive";
import { advance } from "./check";
import { execute } from "./engine";
import { HOME, checkView, createLabState, type LabState } from "./state";

function sh(state: LabState, ...lines: string[]) {
  let out: string[] = [];
  let errors: string[] = [];
  for (const line of lines) {
    const result = execute(state, line);
    state = result.state;
    out = result.lines.filter((l) => !l.error).map((l) => l.text);
    errors = result.lines.filter((l) => l.error).map((l) => l.text);
  }
  return { state, out, errors, text: out.join("\n"), error: errors.join("\n") };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the check view is walked loosely in tests */
const cloud = (state: LabState): any => (checkView(state) as any).cloud;
const field = (output: string, name: string) => new RegExp(`"${name}": "([^"]+)"`).exec(output)![1];

const HANDLER = 'import json\n\n\ndef lambda_handler(event, context):\n    return {"statusCode": 200, "body": json.dumps(event)}\n';
const TRUST = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
const BASIC = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
const ROLE = "arn:aws:iam::123456789012:role/lambda-role";

describe("zip", () => {
  it("packs files into a simulated archive that cat can show", () => {
    const r = sh(createLabState({ files: { "~/app/main.py": "print(1)", "~/app/lib/util.py": "x = 1", "~/readme.txt": "hi" } }), "zip -r bundle app readme.txt");
    expect(r.out).toEqual(["  adding: app/main.py (deflated 0%)", "  adding: app/lib/util.py (deflated 0%)", "  adding: readme.txt (deflated 0%)"]);
    expect(decodeArchive(r.state.files.get(`${HOME}/bundle.zip`)!)).toEqual({ "app/main.py": "print(1)", "app/lib/util.py": "x = 1", "readme.txt": "hi" });
    expect(sh(r.state, "cat bundle.zip").text).toMatch(/^PK（模擬的 zip 封存檔/);
  });

  it("needs -r for directories and reports missing files", () => {
    const s = createLabState({ files: { "~/app/main.py": "x" } });
    expect(sh(s, "zip out.zip app").error).toMatch(/加上 -r/);
    expect(sh(s, "zip out.zip nope.py").error).toMatch(/name not matched: nope\.py/);
    expect(sh(s, "zip out.zip").error).toMatch(/Nothing to do/);
    expect(sh(s, "zip -q out.zip app/main.py").text).toBe("");
    expect(decodeArchive("just text")).toBeNull();
  });
});

describe("aws iam roles", () => {
  const withTrust = () => createLabState({ files: { "~/trust.json": TRUST } });

  it("creates a role from a trust policy file or inline JSON", () => {
    const r = sh(withTrust(), "aws iam create-role --role-name lambda-role --assume-role-policy-document file://trust.json");
    expect(JSON.parse(r.text).Role.Arn).toBe(ROLE);
    expect(cloud(r.state).aws.iam.roles["lambda-role"]).toEqual({ trustedServices: { "lambda.amazonaws.com": true }, policies: {} });
    const inline = sh(createLabState(), `aws iam create-role --role-name r2 --assume-role-policy-document '${TRUST.replace("lambda", "ec2")}'`);
    expect(cloud(inline.state).aws.iam.roles.r2.trustedServices).toEqual({ "ec2.amazonaws.com": true });
    expect(JSON.parse(sh(r.state, "aws iam get-role --role-name lambda-role").text).Role.AssumeRolePolicyDocument.Statement[0].Principal.Service).toBe("lambda.amazonaws.com");
    expect(JSON.parse(sh(r.state, "aws iam list-roles").text).Roles).toHaveLength(1);
  });

  it("rejects missing files, bad JSON, trust policies without a service and duplicates", () => {
    expect(sh(createLabState(), "aws iam create-role --role-name r --assume-role-policy-document file://none.json").error).toMatch(/Unable to load paramfile/);
    expect(sh(createLabState(), "aws iam create-role --role-name r --assume-role-policy-document '{not json'").error).toMatch(/MalformedPolicyDocument.*invalid Json/);
    expect(sh(createLabState(), `aws iam create-role --role-name r --assume-role-policy-document '{"Statement": []}'`).error).toMatch(/MalformedPolicyDocument/);
    const s = sh(withTrust(), "aws iam create-role --role-name r --assume-role-policy-document file://trust.json").state;
    expect(sh(s, "aws iam create-role --role-name r --assume-role-policy-document file://trust.json").error).toMatch(/EntityAlreadyExists/);
    expect(sh(s, "aws iam get-role --role-name nope").error).toMatch(/role with name nope cannot be found/);
  });

  it("attaches the Lambda basic execution policy and blocks deleting a role that still has policies", () => {
    let s = sh(withTrust(), "aws iam create-role --role-name r --assume-role-policy-document file://trust.json", `aws iam attach-role-policy --role-name r --policy-arn ${BASIC}`).state;
    expect(JSON.parse(sh(s, "aws iam list-attached-role-policies --role-name r").text).AttachedPolicies).toEqual([{ PolicyName: "AWSLambdaBasicExecutionRole", PolicyArn: BASIC }]);
    expect(sh(s, "aws iam delete-role --role-name r").error).toMatch(/DeleteConflict/);
    s = sh(s, `aws iam detach-role-policy --role-name r --policy-arn ${BASIC}`, "aws iam delete-role --role-name r").state;
    expect(cloud(s).aws.iam.roles).toEqual({});
    expect(sh(withTrust(), "aws iam create-role --role-name r --assume-role-policy-document file://trust.json", "aws iam attach-role-policy --role-name r --policy-arn arn:aws:iam::aws:policy/AWSLambdaBasicExecutionRole").error).toMatch(/does not exist or is not attachable/);
  });
});

describe("aws lambda", () => {
  const ready = () =>
    sh(
      createLabState({ files: { "~/lambda_function.py": HANDLER, "~/trust.json": TRUST } }),
      "aws iam create-role --role-name lambda-role --assume-role-policy-document file://trust.json",
      "zip function.zip lambda_function.py",
    ).state;
  const create = (extra = "") =>
    `aws lambda create-function --function-name hello --runtime python3.14 --handler lambda_function.lambda_handler --role ${ROLE} --zip-file fileb://function.zip${extra}`;

  it("creates a function with Lambda's defaults", () => {
    const r = sh(ready(), create());
    expect(JSON.parse(r.text)).toMatchObject({ FunctionName: "hello", Timeout: 3, MemorySize: 128, State: "Pending", Version: "$LATEST", Handler: "lambda_function.lambda_handler" });
    expect(cloud(r.state).aws.lambda.functions.hello).toMatchObject({ runtime: "python3.14", timeout: 3, memorySize: 128, invoked: false });
    expect(JSON.parse(sh(r.state, "aws lambda get-function --function-name hello").text).Configuration.State).toBe("Active");
    expect(JSON.parse(sh(r.state, "aws lambda list-functions").text).Functions).toHaveLength(1);
    expect(sh(r.state, create()).error).toMatch(/ResourceConflictException/);
  });

  it("checks the role, runtime, package and limits", () => {
    const s = ready();
    expect(sh(s, create().replace(ROLE, "arn:aws:iam::123456789012:role/missing")).error).toMatch(/cannot be assumed by Lambda/);
    const ec2Role = sh(s, `aws iam create-role --role-name ec2-role --assume-role-policy-document '${TRUST.replace("lambda", "ec2")}'`).state;
    expect(sh(ec2Role, create().replace(ROLE, "arn:aws:iam::123456789012:role/ec2-role")).error).toMatch(/cannot be assumed by Lambda/);
    expect(sh(s, create().replace(ROLE, "lambda-role")).error).toMatch(/failed to satisfy constraint/);
    expect(sh(s, create().replace("python3.14", "python2.7")).error).toMatch(/at 'runtime' failed/);
    expect(sh(s, create().replace("fileb://function.zip", "fileb://lambda_function.py")).error).toMatch(/Could not unzip/);
    expect(sh(s, create().replace("fileb://", "file://")).error).toMatch(/fileb:\/\//);
    expect(sh(s, create().replace("function.zip", "none.zip")).error).toMatch(/Unable to load paramfile/);
    expect(sh(s, create(" --timeout 901")).error).toMatch(/between 1 and 900/);
    expect(sh(s, create(" --memory-size 64")).error).toMatch(/between 128 and 10240/);
    expect(sh(s, "aws lambda create-function --function-name x --role r").error).toMatch(/--zip-file/);
  });

  it("invokes synchronously, writing the response to the outfile", () => {
    const s = sh(ready(), create()).state;
    const r = sh(s, `aws lambda invoke --function-name hello --cli-binary-format raw-in-base64-out --payload '{"name": "Ray"}' response.json`);
    expect(JSON.parse(r.text)).toEqual({ StatusCode: 200, ExecutedVersion: "$LATEST" });
    expect(JSON.parse(r.state.files.get(`${HOME}/response.json`)!)).toEqual({ statusCode: 200, body: '{"name":"Ray"}' });
    expect(cloud(r.state).aws.lambda.functions.hello.invoked).toBe(true);
    // AWS CLI v2 treats --payload as base64 unless told otherwise.
    expect(sh(s, `aws lambda invoke --function-name hello --payload '{"name": "Ray"}' out.json`).error).toMatch(/Invalid base64[\s\S]*raw-in-base64-out/);
    expect(JSON.parse(sh(s, `aws lambda invoke --function-name hello --payload ${btoa('{"a":1}')} out.json`, "cat out.json").text).body).toBe('{"a":1}');
    expect(sh(s, "aws lambda invoke --function-name hello").error).toMatch(/outfile/);
    expect(sh(s, "aws lambda invoke --function-name nope out.json").error).toMatch(/Function not found/);
    expect(sh(s, "aws lambda invoke --function-name hello --cli-binary-format raw-in-base64-out --payload notjson out.json").error).toMatch(/Could not parse/);
  });

  it("reports a wrong handler at invocation time, like the Python runtime", () => {
    const s = sh(ready(), create().replace("lambda_function.lambda_handler", "main.handler"), "aws lambda invoke --function-name hello out.json");
    expect(JSON.parse(s.text).FunctionError).toBe("Unhandled");
    expect(JSON.parse(s.state.files.get(`${HOME}/out.json`)!).errorType).toBe("Runtime.ImportModuleError");
    expect(cloud(s.state).aws.lambda.functions.hello.invoked).toBe(false);
    const missing = sh(ready(), create().replace("lambda_handler", "handler"), "aws lambda invoke --function-name hello out.json");
    expect(JSON.parse(missing.state.files.get(`${HOME}/out.json`)!).errorMessage).toBe("Handler 'handler' missing on module 'lambda_function'");
    const fixed = sh(missing.state, "aws lambda update-function-configuration --function-name hello --handler lambda_function.lambda_handler", "aws lambda invoke --function-name hello out.json");
    expect(cloud(fixed.state).aws.lambda.functions.hello.invoked).toBe(true);
  });

  it("updates configuration and code, and deletes functions", () => {
    let s = sh(ready(), create()).state;
    const r = sh(s, "aws lambda update-function-configuration --function-name hello --timeout 30 --memory-size 256 --environment Variables={STAGE=dev,DEBUG=1}");
    expect(JSON.parse(r.text)).toMatchObject({ Timeout: 30, MemorySize: 256, Environment: { Variables: { STAGE: "dev", DEBUG: "1" } } });
    s = r.state;
    expect(sh(s, "aws lambda update-function-configuration --function-name hello --environment STAGE=dev").error).toMatch(/Variables=/);
    expect(sh(s, "aws lambda update-function-code --function-name hello --zip-file fileb://function.zip").error).toBe("");
    expect(cloud(sh(s, "aws lambda delete-function --function-name hello").state).aws.lambda.functions).toEqual({});
    expect(sh(s, "aws lambda publish-version --function-name hello").error).toMatch(/不支援的 lambda 指令/);
  });
});

describe("aws ec2 volumes", () => {
  const launch = (az = "us-east-1a") => sh(createLabState(), `aws ec2 run-instances --image-id ami-0abcdef1234567890 --instance-type t3.micro --placement AvailabilityZone=${az}`);

  it("defaults to gp2 and checks sizes per type", () => {
    const r = sh(createLabState(), "aws ec2 create-volume --availability-zone us-east-1a --size 80");
    expect(JSON.parse(r.text)).toMatchObject({ VolumeType: "gp2", Size: 80, State: "creating", AvailabilityZone: "us-east-1a" });
    expect(cloud(r.state).aws.ec2.volumeSpecs).toEqual({ "us-east-1a/gp2/80": { count: 1, attached: 0, fromSnapshot: 0 } });
    expect(sh(createLabState(), "aws ec2 create-volume --availability-zone us-east-1a --size 100 --volume-type st1").error).toMatch(/125 到 16384/);
    expect(sh(createLabState(), "aws ec2 create-volume --availability-zone us-east-1a --size 70000 --volume-type gp3").error).toMatch(/1 到 65536/);
    expect(sh(createLabState(), "aws ec2 create-volume --availability-zone us-east-1a --volume-type gp3").error).toMatch(/MissingParameter/);
    expect(sh(createLabState(), "aws ec2 create-volume --availability-zone us-east-1a --size 10 --volume-type ssd").error).toMatch(/volumeType is invalid/);
    expect(sh(createLabState(), "aws ec2 create-volume --availability-zone tokyo --size 10").error).toMatch(/Invalid availability zone/);
    expect(sh(createLabState(), "aws ec2 create-volume --size 10").error).toMatch(/required: --availability-zone/);
  });

  it("attaches only within the same availability zone", () => {
    const i = launch();
    const instanceId = field(i.text, "InstanceId");
    expect(JSON.parse(i.text).Instances[0].Placement.AvailabilityZone).toBe("us-east-1a");
    const v = sh(i.state, "aws ec2 create-volume --availability-zone us-east-1b --size 20 --volume-type gp3");
    expect(sh(v.state, `aws ec2 attach-volume --volume-id ${field(v.text, "VolumeId")} --instance-id ${instanceId} --device /dev/sdf`).error).toMatch(/InvalidVolume\.ZoneMismatch/);
    const ok = sh(i.state, "aws ec2 create-volume --availability-zone us-east-1a --size 20 --volume-type gp3");
    const volumeId = field(ok.text, "VolumeId");
    const attached = sh(ok.state, `aws ec2 attach-volume --volume-id ${volumeId} --instance-id ${instanceId} --device /dev/sdf`);
    expect(JSON.parse(attached.text).State).toBe("attaching");
    expect(cloud(attached.state).aws.ec2.volumeSpecs["us-east-1a/gp3/20"].attached).toBe(1);
    expect(sh(attached.state, `aws ec2 attach-volume --volume-id ${volumeId} --instance-id ${instanceId} --device /dev/sdg`).error).toMatch(/VolumeInUse/);
    expect(sh(attached.state, `aws ec2 delete-volume --volume-id ${volumeId}`).error).toMatch(/VolumeInUse/);
    expect(sh(ok.state, `aws ec2 attach-volume --volume-id ${volumeId} --instance-id ${instanceId} --device sdf`).error).toMatch(/parameter device is invalid/);
    expect(sh(launch().state, "aws ec2 run-instances --image-id ami-0abcdef1234567890 --instance-type t3.micro --placement us-east-1a").error).toMatch(/AvailabilityZone=/);

    // Terminating the instance keeps a data volume attached after launch, detached.
    const terminated = sh(attached.state, `aws ec2 terminate-instances --instance-ids ${instanceId}`).state;
    expect(cloud(terminated).aws.ec2.volumeSpecs["us-east-1a/gp3/20"]).toEqual({ count: 1, attached: 0, fromSnapshot: 0 });
    const detached = sh(attached.state, `aws ec2 detach-volume --volume-id ${volumeId}`, `aws ec2 delete-volume --volume-id ${volumeId}`);
    expect(detached.error).toBe("");
    expect(cloud(detached.state).aws.ec2.volumeSpecs).toEqual({});
  });

  it("snapshots a volume and restores it in another zone, never smaller", () => {
    const v = sh(createLabState(), "aws ec2 create-volume --availability-zone us-east-1a --size 20 --volume-type gp3");
    const snap = sh(v.state, `aws ec2 create-snapshot --volume-id ${field(v.text, "VolumeId")} --description backup`);
    const snapshotId = field(snap.text, "SnapshotId");
    expect(snapshotId).toMatch(/^snap-0[0-9a-f]{16}$/);
    expect(cloud(snap.state).aws.ec2.snapshotCount).toBe(1);
    const restored = sh(snap.state, `aws ec2 create-volume --snapshot-id ${snapshotId} --availability-zone us-east-1b --volume-type gp3`);
    expect(JSON.parse(restored.text)).toMatchObject({ Size: 20, SnapshotId: snapshotId });
    expect(cloud(restored.state).aws.ec2.volumeSpecs["us-east-1b/gp3/20"].fromSnapshot).toBe(1);
    expect(sh(snap.state, `aws ec2 create-volume --snapshot-id ${snapshotId} --availability-zone us-east-1b --size 10`).error).toMatch(/smaller than snapshot/);
    expect(sh(snap.state, "aws ec2 create-volume --snapshot-id snap-0nope --availability-zone us-east-1b").error).toMatch(/InvalidSnapshot\.NotFound/);
    expect(JSON.parse(sh(snap.state, "aws ec2 describe-snapshots").text).Snapshots[0].State).toBe("completed");
    expect(sh(snap.state, `aws ec2 delete-snapshot --snapshot-id ${snapshotId}`).error).toBe("");
  });

  it("only grows volumes", () => {
    const v = sh(createLabState(), "aws ec2 create-volume --availability-zone us-east-1a --size 20 --volume-type gp3");
    const id = field(v.text, "VolumeId");
    expect(sh(v.state, `aws ec2 modify-volume --volume-id ${id} --size 10`).error).toMatch(/cannot be smaller/);
    const grown = sh(v.state, `aws ec2 modify-volume --volume-id ${id} --size 50`);
    expect(JSON.parse(grown.text).VolumeModification).toMatchObject({ OriginalSize: 20, TargetSize: 50 });
    expect(Object.keys(cloud(grown.state).aws.ec2.volumeSpecs)).toEqual(["us-east-1a/gp3/50"]);
    expect(JSON.parse(sh(grown.state, "aws ec2 describe-volumes").text).Volumes[0]).toMatchObject({ Size: 50, State: "available" });
  });
});

describe("gcloud compute disks and snapshots", () => {
  const vm = () => sh(createLabState(), "gcloud compute instances create web-1 --zone=asia-east1-b").state;

  it("creates disks with gcloud's defaults", () => {
    const r = sh(createLabState(), "gcloud compute disks create logs --zone=asia-east1-b");
    expect(r.out[0]).toMatch(/^Created \[.*\/zones\/asia-east1-b\/disks\/logs\]\.$/);
    expect(cloud(r.state).gcp.disks.logs).toEqual({ zone: "asia-east1-b", sizeGb: 500, type: "pd-standard", sourceSnapshot: null, users: {} });
    expect(cloud(sh(createLabState(), "gcloud compute disks create d --type=pd-balanced --zone=asia-east1-b").state).gcp.disks.d.sizeGb).toBe(100);
    expect(cloud(sh(createLabState(), "gcloud compute disks create d --size=2TB --type=pd-ssd --zone=asia-east1-b").state).gcp.disks.d.sizeGb).toBe(2048);
    expect(sh(createLabState(), "gcloud compute disks create d --zone=asia-east1-b --type=hdd").error).toMatch(/resource\.type/);
    expect(sh(createLabState(), "gcloud compute disks create d --size=5GB --zone=asia-east1-b").error).toMatch(/10 GB 到 64 TB/);
    expect(sh(createLabState(), "gcloud compute disks create d").error).toMatch(/請加上 --zone/);
    expect(sh(r.state, "gcloud compute disks create logs --zone=asia-east1-b").error).toMatch(/already exists/);
    expect(sh(r.state, "gcloud compute disks list").out[1]).toMatch(/^logs\s+asia-east1-b\s+zone\s+500\s+pd-standard\s+READY$/);
  });

  it("attaches within a zone and shares only read-only", () => {
    let s = sh(vm(), "gcloud compute disks create data --type=pd-balanced --zone=asia-east1-b", "gcloud compute instances create web-2 --zone=asia-east1-b", "gcloud compute instances create far --zone=asia-east1-a").state;
    expect(sh(s, "gcloud compute instances attach-disk far --disk=data --zone=asia-east1-a").error).toMatch(/磁碟是可用區資源：data 在 asia-east1-b/);
    s = sh(s, "gcloud compute instances attach-disk web-1 --disk=data --zone=asia-east1-b").state;
    expect(cloud(s).gcp.disks.data.users).toEqual({ "web-1": "rw" });
    expect(sh(s, "gcloud compute instances attach-disk web-2 --disk=data --zone=asia-east1-b --mode=ro").error).toMatch(/read-write mode/);
    expect(sh(s, "gcloud compute disks delete data --zone=asia-east1-b").error).toMatch(/already being used by 'web-1'/);
    expect(sh(s, "gcloud compute disks describe data --zone=asia-east1-b").text).toMatch(/users:\n- .*\/instances\/web-1/);
    const shared = sh(s, "gcloud compute instances detach-disk web-1 --disk=data --zone=asia-east1-b", "gcloud compute instances attach-disk web-1 --disk=data --zone=asia-east1-b --mode=ro", "gcloud compute instances attach-disk web-2 --disk=data --zone=asia-east1-b --mode=ro").state;
    expect(cloud(shared).gcp.disks.data.users).toEqual({ "web-1": "ro", "web-2": "ro" });
    // Deleting a VM leaves its data disks, detached.
    const gone = sh(s, "gcloud compute instances delete web-1 --zone=asia-east1-b").state;
    expect(cloud(gone).gcp.disks.data.users).toEqual({});
    expect(sh(s, "gcloud compute instances detach-disk web-2 --disk=data --zone=asia-east1-b").error).toMatch(/is not attached/);
  });

  it("only grows disks", () => {
    const s = sh(createLabState(), "gcloud compute disks create data --size=50GB --type=pd-balanced --zone=asia-east1-b").state;
    expect(sh(s, "gcloud compute disks resize data --size=40GB --zone=asia-east1-b").error).toMatch(/只能加大/);
    expect(sh(s, "gcloud compute disks resize data --size=50GB --zone=asia-east1-b").error).toMatch(/must be larger/);
    expect(cloud(sh(s, "gcloud compute disks resize data --size=100 --zone=asia-east1-b").state).gcp.disks.data.sizeGb).toBe(100);
    expect(sh(s, "gcloud compute disks resize data --size=100GB --zone=asia-east1-a").error).toMatch(/was not found/);
  });

  it("snapshots a disk and restores it in another zone", () => {
    const s = sh(createLabState(), "gcloud compute disks create data --size=50GB --type=pd-balanced --zone=asia-east1-b").state;
    const snap = sh(s, "gcloud compute snapshots create snap1 --source-disk=data --source-disk-zone=asia-east1-b");
    expect(snap.text).toBe("Creating snapshot(s) snap1...done.");
    expect(cloud(snap.state).gcp.snapshots).toEqual({ snap1: { sourceDisk: "data", sizeGb: 50 } });
    const viaDisk = sh(s, "gcloud compute disks snapshot data --snapshot-names=snap2 --zone=asia-east1-b").state;
    expect(cloud(viaDisk).gcp.snapshots.snap2.sourceDisk).toBe("data");
    expect(sh(s, "gcloud compute disks snapshot data --zone=asia-east1-b").error).toMatch(/--snapshot-names/);
    const copy = sh(snap.state, "gcloud compute disks create copy --source-snapshot=snap1 --type=pd-balanced --zone=asia-east1-a").state;
    expect(cloud(copy).gcp.disks.copy).toMatchObject({ zone: "asia-east1-a", sizeGb: 50, sourceSnapshot: "snap1" });
    expect(sh(snap.state, "gcloud compute disks create c --source-snapshot=snap1 --size=20GB --zone=asia-east1-a").error).toMatch(/smaller than the snapshot/);
    expect(sh(snap.state, "gcloud compute disks create c --source-snapshot=nope --zone=asia-east1-a").error).toMatch(/snapshots\/nope' was not found/);
    expect(sh(snap.state, "gcloud compute snapshots create snap1 --source-disk=data --source-disk-zone=asia-east1-b").error).toMatch(/already exists/);
    expect(sh(snap.state, "gcloud compute snapshots list").out[1]).toMatch(/^snap1\s+50\s+data\s+READY$/);
    expect(cloud(sh(snap.state, "gcloud compute snapshots delete snap1").state).gcp.snapshots).toEqual({});
  });
});

describe("gcloud run", () => {
  const DEPLOY = "gcloud run deploy hello --image=us-docker.pkg.dev/cloudrun/container/hello --region=asia-east1";
  const deployed = () => sh(createLabState(), DEPLOY);

  it("deploys a private service with Cloud Run's defaults and prints its URL", () => {
    const r = deployed();
    expect(r.text).toMatch(/Service \[hello\] revision \[hello-00001-[a-z]{3}\] has been deployed/);
    expect(r.text).toMatch(/Service URL: https:\/\/hello-\d+\.asia-east1\.run\.app/);
    expect(r.text).toMatch(/不公開/);
    expect(cloud(r.state).gcp.run.services.hello).toEqual({
      region: "asia-east1",
      image: "us-docker.pkg.dev/cloudrun/container/hello",
      public: false,
      concurrency: 80,
      memory: "512Mi",
      timeout: 300,
      minInstances: 0,
      maxInstances: 100,
      env: {},
      revisionCount: 1,
    });
  });

  it("makes a service public in either supported way", () => {
    expect(cloud(sh(createLabState(), `${DEPLOY} --allow-unauthenticated`).state).gcp.run.services.hello.public).toBe(true);
    const s = deployed().state;
    const bound = sh(s, "gcloud run services add-iam-policy-binding hello --region=asia-east1 --member=allUsers --role=roles/run.invoker");
    expect(bound.text).toMatch(/- allUsers\n {2}role: roles\/run\.invoker/);
    expect(cloud(bound.state).gcp.run.services.hello.public).toBe(true);
    expect(cloud(sh(bound.state, "gcloud run services remove-iam-policy-binding hello --region=asia-east1 --member=allUsers --role=roles/run.invoker").state).gcp.run.services.hello.public).toBe(false);
    const noCheck = sh(s, "gcloud run services update hello --region=asia-east1 --no-invoker-iam-check");
    expect(noCheck.text).toBe("Service [hello] has been updated.");
    expect(cloud(noCheck.state).gcp.run.services.hello).toMatchObject({ public: true, revisionCount: 1 });
    expect(sh(s, "gcloud run services add-iam-policy-binding hello --region=asia-east1 --member=allUsers --role=roles/run.admin").error).toMatch(/roles\/run\.invoker/);
    expect(sh(s, "gcloud run services add-iam-policy-binding hello --region=asia-east1 --member=bob --role=roles/run.invoker").error).toMatch(/Invalid member/);
  });

  it("creates a new revision for configuration changes", () => {
    let s = sh(deployed().state, "gcloud run services update hello --region=asia-east1 --update-env-vars=GREETING=hello,MODE=dev").state;
    expect(cloud(s).gcp.run.services.hello).toMatchObject({ env: { GREETING: "hello", MODE: "dev" }, revisionCount: 2 });
    s = sh(s, "gcloud run services update hello --region=asia-east1 --remove-env-vars=MODE --max-instances=5 --memory=1Gi --concurrency=40 --timeout=10m").state;
    expect(cloud(s).gcp.run.services.hello).toMatchObject({ env: { GREETING: "hello" }, maxInstances: 5, memory: "1Gi", concurrency: 40, timeout: 600, revisionCount: 3 });
    const listed = sh(s, "gcloud run revisions list --region=asia-east1").out;
    expect(listed).toHaveLength(4);
    expect(listed[1]).toMatch(/✔\s+hello-00003-[a-z]{3}\s+yes\s+hello/);
    expect(cloud(sh(s, `${DEPLOY}`).state).gcp.run.services.hello.revisionCount).toBe(4);
    expect(sh(s, "gcloud run services describe hello --region=asia-east1").text).toMatch(/Scaling: Auto \(Min: 0, Max: 5\)[\s\S]*GREETING {2}hello/);
  });

  it("validates settings", () => {
    const s = deployed().state;
    const update = (flags: string) => sh(s, `gcloud run services update hello --region=asia-east1 ${flags}`).error;
    expect(update("--concurrency=2000")).toMatch(/1 到 1000/);
    expect(update("--timeout=2h")).toMatch(/60 分鐘/);
    expect(update("--memory=64Gi")).toMatch(/最多 32Gi/);
    expect(update("--min-instances=10 --max-instances=5")).toMatch(/不能大於/);
    expect(update("--update-env-vars=NOEQUALS")).toMatch(/KEY1=VALUE1/);
    expect(update("--image=nginx")).toMatch(/gcloud run deploy/);
    expect(sh(createLabState(), "gcloud run deploy hello --image=nginx --region=asia-east1").error).toMatch(/不是容器映像檔的位址/);
    expect(sh(createLabState(), "gcloud run deploy hello --source=. --region=asia-east1").error).toMatch(/不能從原始碼建置/);
    expect(sh(createLabState(), "gcloud run deploy hello --image=us-docker.pkg.dev/cloudrun/container/hello").error).toMatch(/請加上 --region/);
    expect(sh(createLabState(), "gcloud run deploy hello --region=asia-east1").error).toMatch(/--image/);
    expect(sh(s, "gcloud run deploy hello --image=us-docker.pkg.dev/cloudrun/container/hello --region=us-central1").error).toMatch(/已經有一個名為 hello 的服務在 asia-east1/);
    expect(sh(s, "gcloud run services describe hello --region=us-central1").error).toMatch(/Cannot find service \[hello\] in region \[us-central1\]/);
    expect(sh(s, "gcloud run jobs list").error).toMatch(/不支援 'jobs'/);
  });

  it("lists and deletes services", () => {
    const s = deployed().state;
    expect(sh(s, "gcloud run services list").out[1]).toMatch(/^hello\s+asia-east1\s+https:\/\/hello-/);
    const gone = sh(s, "gcloud run services delete hello --region=asia-east1");
    expect(gone.text).toBe("Deleted service [hello].");
    expect(cloud(gone.state).gcp.run.services).toEqual({});
  });
});

// ------------------------------------------------------------- the labs

describe("serverless and block storage labs can be completed", () => {
  const labs = new Map([...loadContent().units.values()].flatMap((u) => u.labs).map((l) => [l.id, l]));

  /** Runs groups of commands; a function gets every output so far, to pick up generated ids. */
  function play(labId: string, groups: (string | ((outputs: string) => string))[][]): number[] {
    const lab = labs.get(labId)!;
    let state = createLabState(lab.initialState);
    let done = advance(0, state, lab.steps);
    let outputs = "";
    return groups.map((commands) => {
      for (const c of commands) {
        const result = execute(state, typeof c === "string" ? c : c(outputs));
        state = result.state;
        outputs += `${result.lines.map((l) => l.text).join("\n")}\n`;
        done = advance(done, state, lab.steps);
      }
      return done;
    });
  }
  const all = (outputs: string, name: string) => [...outputs.matchAll(new RegExp(`"${name}": "([^"]+)"`, "g"))].map((m) => m[1]);
  const first = (outputs: string, name: string) => all(outputs, name)[0];
  const last = (outputs: string, name: string) => all(outputs, name).at(-1)!;

  it("aws-lambda-function", () => {
    expect(
      play("aws-lambda-function", [
        ["cat trust-policy.json", "aws iam create-role --role-name lambda-basic-role --assume-role-policy-document file://trust-policy.json"],
        [`aws iam attach-role-policy --role-name lambda-basic-role --policy-arn ${BASIC}`],
        ["zip function.zip lambda_function.py"],
        [(o) => `aws lambda create-function --function-name hello --runtime python3.14 --handler lambda_function.lambda_handler --role ${first(o, "Arn")} --zip-file fileb://function.zip`],
        [`aws lambda invoke --function-name hello --cli-binary-format raw-in-base64-out --payload '{"name": "Ray"}' response.json`, "cat response.json"],
        ["aws lambda update-function-configuration --function-name hello --timeout 30 --memory-size 256"],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("aws-lambda-function: forgetting --cli-binary-format or a wrong handler does not count as an invocation", () => {
    expect(
      play("aws-lambda-function", [
        [
          "aws iam create-role --role-name lambda-basic-role --assume-role-policy-document file://trust-policy.json",
          `aws iam attach-role-policy --role-name lambda-basic-role --policy-arn ${BASIC}`,
          "zip function.zip lambda_function.py",
          "aws lambda create-function --function-name hello --runtime python3.14 --handler main.handler --role arn:aws:iam::123456789012:role/lambda-basic-role --zip-file fileb://function.zip",
        ],
        [`aws lambda invoke --function-name hello --payload '{"name": "Ray"}' response.json`],
        [`aws lambda invoke --function-name hello --cli-binary-format raw-in-base64-out --payload '{"name": "Ray"}' response.json`],
        ["aws lambda update-function-configuration --function-name hello --handler lambda_function.lambda_handler", `aws lambda invoke --function-name hello --cli-binary-format raw-in-base64-out --payload '{"name": "Ray"}' response.json`],
      ]),
    ).toEqual([4, 4, 4, 5]);
  });

  it("gcp-cloud-run-service", () => {
    expect(
      play("gcp-cloud-run-service", [
        ["gcloud run deploy hello --image=us-docker.pkg.dev/cloudrun/container/hello --region=asia-east1"],
        ["gcloud run services add-iam-policy-binding hello --region=asia-east1 --member=allUsers --role=roles/run.invoker"],
        ["gcloud run services update hello --region=asia-east1 --update-env-vars=GREETING=hello", "gcloud run revisions list --region=asia-east1"],
        ["gcloud run services update hello --region=asia-east1 --max-instances=5"],
        ["gcloud run services delete hello --region=asia-east1"],
      ]),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("gcp-cloud-run-service: the recommended --no-invoker-iam-check also makes it public", () => {
    expect(
      play("gcp-cloud-run-service", [
        ["gcloud run deploy hello --image=us-docker.pkg.dev/cloudrun/container/hello --region=asia-east1"],
        ["gcloud run services update hello --region=asia-east1 --no-invoker-iam-check"],
      ]),
    ).toEqual([1, 2]);
  });

  it("aws-ebs-volume", () => {
    expect(
      play("aws-ebs-volume", [
        ["aws ec2 run-instances --image-id ami-0abcdef1234567890 --instance-type t3.micro --placement AvailabilityZone=us-east-1a"],
        ["aws ec2 create-volume --availability-zone us-east-1a --size 20 --volume-type gp3"],
        [(o) => `aws ec2 attach-volume --volume-id ${first(o, "VolumeId")} --instance-id ${first(o, "InstanceId")} --device /dev/sdf`],
        [(o) => `aws ec2 create-snapshot --volume-id ${first(o, "VolumeId")} --description "lab backup"`],
        [(o) => `aws ec2 create-volume --snapshot-id ${last(o, "SnapshotId")} --availability-zone us-east-1b --volume-type gp3`],
        [(o) => `aws ec2 modify-volume --volume-id ${first(o, "VolumeId")} --size 10`, (o) => `aws ec2 modify-volume --volume-id ${first(o, "VolumeId")} --size 50`],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("aws-ebs-volume: a gp2 volume (the CLI default) does not pass the gp3 step", () => {
    expect(
      play("aws-ebs-volume", [
        ["aws ec2 run-instances --image-id ami-0abcdef1234567890 --instance-type t3.micro"],
        ["aws ec2 create-volume --availability-zone us-east-1a --size 20"],
        ["aws ec2 create-volume --availability-zone us-east-1a --size 20 --volume-type gp3"],
      ]),
    ).toEqual([1, 1, 2]);
  });

  it("gcp-persistent-disk", () => {
    expect(
      play("gcp-persistent-disk", [
        ["gcloud compute instances create web-1 --zone=asia-east1-b --machine-type=e2-micro"],
        ["gcloud compute disks create data-disk --size=50GB --type=pd-balanced --zone=asia-east1-b"],
        ["gcloud compute instances attach-disk web-1 --disk=data-disk --zone=asia-east1-b"],
        ["gcloud compute disks resize data-disk --size=40GB --zone=asia-east1-b", "gcloud compute disks resize data-disk --size=100GB --zone=asia-east1-b"],
        ["gcloud compute snapshots create data-snap --source-disk=data-disk --source-disk-zone=asia-east1-b"],
        ["gcloud compute disks create data-copy --source-snapshot=data-snap --type=pd-balanced --zone=asia-east1-a"],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gcp-persistent-disk: a pd-standard disk has to be replaced", () => {
    expect(
      play("gcp-persistent-disk", [
        ["gcloud compute instances create web-1 --zone=asia-east1-b"],
        ["gcloud compute disks create data-disk --size=50GB --zone=asia-east1-b"],
        ["gcloud compute disks delete data-disk --zone=asia-east1-b", "gcloud compute disks create data-disk --size=50GB --type=pd-balanced --zone=asia-east1-b"],
      ]),
    ).toEqual([1, 1, 2]);
  });
});
