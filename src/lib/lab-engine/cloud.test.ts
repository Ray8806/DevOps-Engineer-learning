import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content/loader";
import { advance } from "./check";
import { execute } from "./engine";
import { checkView, createLabState, type LabState } from "./state";

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
const S3_READ = "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess";

describe("aws iam", () => {
  it("creates users and groups and prints their ARNs", () => {
    const r = sh(createLabState(), "aws iam create-group --group-name developers", "aws iam create-user --user-name alice");
    expect(JSON.parse(r.text)).toEqual({ User: { Path: "/", UserName: "alice", Arn: "arn:aws:iam::123456789012:user/alice" } });
    expect(cloud(r.state).aws.iam).toEqual({ users: { alice: { groups: {}, policies: {} } }, groups: { developers: { policies: {} } } });
    expect(JSON.parse(sh(r.state, "aws iam list-users").text).Users).toHaveLength(1);
    expect(JSON.parse(sh(r.state, "aws iam list-groups").text).Groups[0].GroupName).toBe("developers");
  });

  it("rejects duplicates, bad names and missing arguments", () => {
    const s = sh(createLabState(), "aws iam create-user --user-name alice", "aws iam create-group --group-name devs").state;
    expect(sh(s, "aws iam create-user --user-name alice").error).toMatch(/EntityAlreadyExists.*CreateUser/);
    expect(sh(s, "aws iam create-group --group-name devs").error).toMatch(/EntityAlreadyExists.*CreateGroup/);
    expect(sh(s, 'aws iam create-user --user-name "bad name"').error).toMatch(/ValidationError/);
    expect(sh(s, "aws iam create-user").error).toMatch(/required: --user-name/);
    expect(sh(s, "aws iam add-user-to-group --user-name alice").error).toMatch(/required: --group-name/);
    expect(sh(s, "aws iam create-user alice").error).toMatch(/Unknown options: alice/);
    expect(sh(s, "aws iam create-user --name alice").error).toMatch(/Unknown options: --name/);
  });

  it("adds and removes group members", () => {
    const s = sh(createLabState(), "aws iam create-user --user-name alice", "aws iam create-group --group-name devs", "aws iam add-user-to-group --group-name devs --user-name alice").state;
    expect(cloud(s).aws.iam.users.alice.groups).toEqual({ devs: true });
    expect(JSON.parse(sh(s, "aws iam list-groups-for-user --user-name alice").text).Groups[0].GroupName).toBe("devs");
    expect(cloud(sh(s, "aws iam remove-user-from-group --user-name alice --group-name devs").state).aws.iam.users.alice.groups).toEqual({});
    expect(sh(s, "aws iam add-user-to-group --group-name devs --user-name bob").error).toMatch(/user with name bob cannot be found/);
    expect(sh(s, "aws iam add-user-to-group --group-name ops --user-name alice").error).toMatch(/group with name ops cannot be found/);
  });

  it("attaches and detaches managed policies on groups and users", () => {
    let s = sh(createLabState(), "aws iam create-user --user-name alice", "aws iam create-group --group-name devs").state;
    s = sh(s, `aws iam attach-group-policy --group-name devs --policy-arn ${S3_READ}`, `aws iam attach-user-policy --user-name alice --policy-arn=arn:aws:iam::aws:policy/ReadOnlyAccess`).state;
    expect(cloud(s).aws.iam.groups.devs.policies).toEqual({ [S3_READ]: true });
    expect(JSON.parse(sh(s, "aws iam list-attached-group-policies --group-name devs").text)).toEqual({
      AttachedPolicies: [{ PolicyName: "AmazonS3ReadOnlyAccess", PolicyArn: S3_READ }],
    });
    expect(JSON.parse(sh(s, "aws iam list-attached-user-policies --user-name alice").text).AttachedPolicies[0].PolicyName).toBe("ReadOnlyAccess");
    expect(cloud(sh(s, `aws iam detach-group-policy --group-name devs --policy-arn ${S3_READ}`).state).aws.iam.groups.devs.policies).toEqual({});
    expect(sh(s, "aws iam detach-group-policy --group-name devs --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess").error).toMatch(/was not found/);
  });

  it("explains an unknown policy or a bare policy name", () => {
    const s = sh(createLabState(), "aws iam create-group --group-name devs").state;
    expect(sh(s, "aws iam attach-group-policy --group-name devs --policy-arn AmazonS3ReadOnlyAccess").error).toMatch(/does not exist or is not attachable[\s\S]*arn:aws:iam::aws:policy\//);
    expect(sh(s, "aws iam attach-group-policy --group-name devs --policy-arn arn:aws:iam::aws:policy/MadeUp").error).toMatch(/NoSuchEntity/);
    expect(cloud(sh(s, "aws iam attach-group-policy --group-name devs --policy-arn AmazonS3ReadOnlyAccess").state).aws.iam.groups.devs.policies).toEqual({});
  });

  it("refuses to delete users and groups that are still in use", () => {
    const s = sh(createLabState(), "aws iam create-user --user-name alice", "aws iam create-group --group-name devs", "aws iam add-user-to-group --group-name devs --user-name alice").state;
    expect(sh(s, "aws iam delete-user --user-name alice").error).toMatch(/DeleteConflict/);
    expect(sh(s, "aws iam delete-group --group-name devs").error).toMatch(/DeleteConflict/);
    const cleared = sh(s, "aws iam remove-user-from-group --group-name devs --user-name alice", "aws iam delete-user --user-name alice", "aws iam delete-group --group-name devs").state;
    expect(cloud(cleared).aws.iam).toEqual({ users: {}, groups: {} });
  });

  it("handles names that collide with object prototype keys", () => {
    const s = sh(createLabState(), "aws iam create-user --user-name __proto__", "aws iam create-group --group-name constructor").state;
    expect(JSON.parse(sh(s, "aws iam list-users").text).Users[0].UserName).toBe("__proto__");
    expect(Object.keys(cloud(s).aws.iam.groups)).toEqual(["constructor"]);
  });

  it("lists what is supported for unknown subcommands", () => {
    expect(sh(createLabState(), "aws iam create-role --role-name x").error).toMatch(/不支援的 iam 指令 'create-role'/);
    expect(sh(createLabState(), "aws iam").error).toMatch(/usage: aws iam/);
  });
});

describe("aws ec2", () => {
  const AMI = "ami-0abcdef1234567890";
  const withGroup = () => sh(createLabState(), 'aws ec2 create-security-group --group-name web-sg --description "Web server"');
  const launch = (state: LabState, extra = "") => {
    const r = sh(state, `aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro ${extra}`);
    return { ...r, id: JSON.parse(r.text).Instances[0].InstanceId as string };
  };

  it("creates security groups with generated ids", () => {
    const r = withGroup();
    const id = JSON.parse(r.text).GroupId;
    expect(id).toMatch(/^sg-0[0-9a-f]{16}$/);
    expect(cloud(r.state).aws.ec2.securityGroups["web-sg"]).toEqual({ id, ingress: {}, runningInstances: 0 });
    expect(sh(r.state, 'aws ec2 create-security-group --group-name web-sg --description "again"').error).toMatch(/InvalidGroup\.Duplicate/);
    expect(sh(createLabState(), "aws ec2 create-security-group --group-name web-sg").error).toMatch(/required: --description/);
  });

  it("adds ingress rules by group name or id and validates them", () => {
    const g = withGroup();
    const id = JSON.parse(g.text).GroupId;
    const s = sh(g.state, "aws ec2 authorize-security-group-ingress --group-name web-sg --protocol tcp --port 443 --cidr 0.0.0.0/0", `aws ec2 authorize-security-group-ingress --group-id ${id} --protocol TCP --port 22 --cidr 203.0.113.0/24`).state;
    expect(cloud(s).aws.ec2.securityGroups["web-sg"].ingress).toEqual({ "tcp:443:0.0.0.0/0": true, "tcp:22:203.0.113.0/24": true });
    const rule = "aws ec2 authorize-security-group-ingress --group-name web-sg --protocol tcp";
    expect(sh(s, `${rule} --port 443 --cidr 0.0.0.0/0`).error).toMatch(/InvalidPermission\.Duplicate/);
    expect(sh(s, `${rule} --port 443 --cidr 0.0.0.0`).error).toMatch(/malformed/);
    expect(sh(s, `${rule} --port 443 --cidr 300.0.0.0/8`).error).toMatch(/malformed/);
    expect(sh(s, `${rule} --port 99999 --cidr 0.0.0.0/0`).error).toMatch(/Invalid value '99999'/);
    expect(sh(s, `${rule} --port 443`).error).toMatch(/required: --cidr/);
    expect(sh(s, "aws ec2 authorize-security-group-ingress --group-name nope --protocol tcp --port 1 --cidr 0.0.0.0/0").error).toMatch(/InvalidGroup\.NotFound/);
    expect(sh(s, "aws ec2 authorize-security-group-ingress --protocol tcp --port 1 --cidr 0.0.0.0/0").error).toMatch(/--group-id 或 --group-name/);
    const described = JSON.parse(sh(s, "aws ec2 describe-security-groups").text).SecurityGroups[0];
    expect(described.IpPermissions).toHaveLength(2);
  });

  it("launches an instance with a security group given by name or id", () => {
    const g = withGroup();
    const byName = launch(g.state, "--security-groups web-sg");
    expect(byName.id).toMatch(/^i-0[0-9a-f]{16}$/);
    expect(cloud(byName.state).aws.ec2.counts).toEqual({ running: 1, stopped: 0, terminated: 0 });
    expect(cloud(byName.state).aws.ec2.securityGroups["web-sg"].runningInstances).toBe(1);
    const byId = launch(g.state, `--security-group-ids ${JSON.parse(g.text).GroupId}`);
    expect(cloud(byId.state).aws.ec2.securityGroups["web-sg"].runningInstances).toBe(1);
    expect(cloud(launch(g.state).state).aws.ec2.securityGroups["web-sg"].runningInstances).toBe(0);
  });

  it("validates run-instances arguments", () => {
    const s = withGroup().state;
    expect(sh(s, "aws ec2 run-instances --instance-type t3.micro").error).toMatch(/required: --image-id/);
    expect(sh(s, "aws ec2 run-instances --image-id ubuntu --instance-type t3.micro").error).toMatch(/InvalidAMIID\.Malformed/);
    expect(sh(s, `aws ec2 run-instances --image-id ${AMI} --instance-type big`).error).toMatch(/Invalid value 'big' for InstanceType/);
    expect(sh(s, `aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --security-groups nope`).error).toMatch(/InvalidGroup\.NotFound/);
    expect(sh(s, `aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --count 3`).error).toMatch(/一次只能啟動 1 台/);
    expect(cloud(sh(s, `aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --security-groups nope`).state).aws.ec2.counts.running).toBe(0);
  });

  it("stops, starts and terminates; a terminated instance cannot come back", () => {
    const { state, id } = launch(withGroup().state, "--security-groups web-sg");
    const stopped = sh(state, `aws ec2 stop-instances --instance-ids ${id}`);
    expect(JSON.parse(stopped.text).StoppingInstances[0]).toEqual({ InstanceId: id, CurrentState: { Name: "stopped" }, PreviousState: { Name: "running" } });
    expect(cloud(stopped.state).aws.ec2.counts).toEqual({ running: 0, stopped: 1, terminated: 0 });
    expect(cloud(stopped.state).aws.ec2.securityGroups["web-sg"].runningInstances).toBe(0);
    expect(cloud(sh(stopped.state, `aws ec2 start-instances --instance-ids ${id}`).state).aws.ec2.counts.running).toBe(1);
    const gone = sh(stopped.state, `aws ec2 terminate-instances --instance-ids ${id}`).state;
    expect(cloud(gone).aws.ec2.counts).toEqual({ running: 0, stopped: 0, terminated: 1 });
    expect(sh(gone, `aws ec2 start-instances --instance-ids ${id}`).error).toMatch(/IncorrectInstanceState/);
    expect(sh(gone, `aws ec2 stop-instances --instance-ids ${id}`).error).toMatch(/IncorrectInstanceState/);
    expect(JSON.parse(sh(gone, "aws ec2 describe-instances").text).Reservations[0].Instances[0].State.Name).toBe("terminated");
  });

  it("acts on several instance ids at once and rejects unknown ids", () => {
    const a = launch(createLabState());
    const b = launch(a.state);
    expect(a.id).not.toBe(b.id);
    expect(cloud(sh(b.state, `aws ec2 stop-instances --instance-ids ${a.id} ${b.id}`).state).aws.ec2.counts.stopped).toBe(2);
    expect(sh(b.state, "aws ec2 stop-instances --instance-ids i-00000000000000000").error).toMatch(/InvalidInstanceID\.NotFound/);
    expect(sh(b.state, "aws ec2 stop-instances").error).toMatch(/required: --instance-ids/);
    expect(JSON.parse(sh(b.state, `aws ec2 describe-instances --instance-ids ${b.id}`).text).Reservations[0].Instances).toHaveLength(1);
    expect(JSON.parse(sh(createLabState(), "aws ec2 describe-instances").text)).toEqual({ Reservations: [] });
  });

  it("will not delete a security group that an instance still uses", () => {
    const { state, id } = launch(withGroup().state, "--security-groups web-sg");
    expect(sh(state, "aws ec2 delete-security-group --group-name web-sg").error).toMatch(/DependencyViolation/);
    const after = sh(state, `aws ec2 terminate-instances --instance-ids ${id}`, "aws ec2 delete-security-group --group-name web-sg").state;
    expect(cloud(after).aws.ec2.securityGroups).toEqual({});
  });
});

describe("gcloud iam and projects", () => {
  const SA = "app-reader@my-project.iam.gserviceaccount.com";
  const withSa = () => sh(createLabState(), 'gcloud iam service-accounts create app-reader --display-name="App reader"');

  it("creates, lists and deletes service accounts", () => {
    const r = withSa();
    expect(r.text).toBe("Created service account [app-reader].");
    expect(cloud(r.state).gcp.serviceAccounts).toEqual({ [SA]: { displayName: "App reader" } });
    expect(sh(r.state, "gcloud iam service-accounts list").out[1]).toMatch(new RegExp(`^App reader\\s+${SA}$`));
    expect(sh(createLabState(), "gcloud iam service-accounts list").text).toBe("Listed 0 items.");
    expect(cloud(sh(r.state, `gcloud iam service-accounts delete ${SA}`).state).gcp.serviceAccounts).toEqual({});
    expect(sh(r.state, "gcloud iam service-accounts delete app-reader").error).toMatch(/NOT_FOUND/);
  });

  it("rejects bad or duplicate service account ids", () => {
    expect(sh(createLabState(), "gcloud iam service-accounts create App").error).toMatch(/6 到 30 個字元/);
    expect(sh(createLabState(), "gcloud iam service-accounts create short").error).toMatch(/INVALID_ARGUMENT/);
    expect(sh(createLabState(), "gcloud iam service-accounts create").error).toMatch(/NAME: Must be specified/);
    expect(sh(withSa().state, "gcloud iam service-accounts create app-reader").error).toMatch(/already exists/);
    expect(sh(createLabState(), "gcloud iam roles list").error).toMatch(/支援 gcloud iam service-accounts/);
  });

  it("grants and revokes project roles and prints the policy", () => {
    const bind = `gcloud projects add-iam-policy-binding my-project --member="serviceAccount:${SA}" --role="roles/storage.objectViewer"`;
    const r = sh(withSa().state, bind);
    expect(r.out[0]).toBe("Updated IAM policy for project [my-project].");
    expect(cloud(r.state).gcp.bindings).toEqual({ "roles/storage.objectViewer": { [`serviceAccount:${SA}`]: true } });
    expect(sh(r.state, "gcloud projects get-iam-policy my-project").text).toBe(
      `bindings:\n- members:\n  - serviceAccount:${SA}\n  role: roles/storage.objectViewer\nversion: 1`,
    );
    const revoked = sh(r.state, `gcloud projects remove-iam-policy-binding my-project --member serviceAccount:${SA} --role roles/storage.objectViewer`).state;
    expect(cloud(revoked).gcp.bindings).toEqual({});
    expect(sh(revoked, "gcloud projects get-iam-policy my-project").text).toBe("version: 1");
  });

  it("validates the project, member and role", () => {
    const s = withSa().state;
    const base = "gcloud projects add-iam-policy-binding";
    expect(sh(s, `${base} other-project --member=user:a@example.com --role=roles/viewer`).error).toMatch(/專案 ID 是 my-project/);
    expect(sh(s, `${base} my-project --member=${SA} --role=roles/viewer`).error).toMatch(/成員 .* 的格式不正確/);
    expect(sh(s, `${base} my-project --member=user:a@example.com --role=storage.objectViewer`).error).toMatch(/角色的格式是 roles\//);
    expect(sh(s, `${base} my-project --member=user:a@example.com`).error).toMatch(/--role: Must be specified/);
    expect(sh(s, `${base} --member=user:a@example.com --role=roles/viewer`).error).toMatch(/PROJECT_ID: Must be specified/);
    expect(sh(s, `${base} my-project --member=serviceAccount:ghost1@my-project.iam.gserviceaccount.com --role=roles/viewer`).error).toMatch(/does not exist/);
    expect(sh(s, "gcloud projects remove-iam-policy-binding my-project --member=user:a@example.com --role=roles/viewer").error).toMatch(/not found/);
    expect(cloud(sh(s, `${base} my-project --member=group:devs@example.com --role=roles/viewer`).state).gcp.bindings["roles/viewer"]).toEqual({ "group:devs@example.com": true });
  });

  it("starts from seeded bindings and a custom project id", () => {
    const s = createLabState({ cloud: { gcp: { project: "acme-prod", bindings: { "roles/editor": ["user:intern@example.com"] } } } });
    expect(sh(s, "gcloud config get-value project").text).toBe("acme-prod");
    expect(sh(s, "gcloud projects get-iam-policy acme-prod").text).toMatch(/user:intern@example\.com\n {2}role: roles\/editor/);
    expect(sh(s, "gcloud projects list").out[1]).toMatch(/^acme-prod/);
    expect(sh(s, "gcloud iam service-accounts create builder").state.gcp.serviceAccounts.has("builder@acme-prod.iam.gserviceaccount.com")).toBe(true);
  });
});

describe("gcloud compute", () => {
  const create = "gcloud compute instances create web-1 --zone=asia-east1-b --machine-type=e2-micro --tags=web";
  const withVm = () => sh(createLabState(), create);

  it("creates an instance and lists it", () => {
    const r = withVm();
    expect(r.out[0]).toMatch(/^Created \[.*\/zones\/asia-east1-b\/instances\/web-1\]\.$/);
    expect(cloud(r.state).gcp.instances["web-1"]).toEqual({ zone: "asia-east1-b", machineType: "e2-micro", status: "RUNNING", tags: { web: true } });
    const listed = sh(r.state, "gcloud compute instances list").out;
    expect(listed[0]).toMatch(/^NAME\s+ZONE\s+MACHINE_TYPE\s+STATUS$/);
    expect(listed[1]).toMatch(/^web-1\s+asia-east1-b\s+e2-micro\s+RUNNING$/);
    expect(sh(createLabState(), "gcloud compute instances list").text).toBe("Listed 0 items.");
  });

  it("requires a valid zone and name, and refuses duplicates", () => {
    expect(sh(createLabState(), "gcloud compute instances create web-1").error).toMatch(/請加上 --zone/);
    expect(sh(createLabState(), "gcloud compute instances create web-1 --zone=asia-east1").error).toMatch(/可用區的格式/);
    expect(sh(createLabState(), "gcloud compute instances create Web_1 --zone=asia-east1-b").error).toMatch(/名稱必須以小寫字母開頭/);
    expect(sh(createLabState(), "gcloud compute instances create --zone=asia-east1-b").error).toMatch(/INSTANCE_NAMES: Must be specified/);
    expect(sh(withVm().state, create).error).toMatch(/already exists/);
    expect(sh(createLabState(), "gcloud compute instances create web-1 --zone=asia-east1-b --size=big").error).toMatch(/unrecognized arguments: --size=big/);
  });

  it("stop shows TERMINATED, start brings it back, delete removes it", () => {
    const stopped = sh(withVm().state, "gcloud compute instances stop web-1 --zone=asia-east1-b").state;
    expect(cloud(stopped).gcp.instances["web-1"].status).toBe("TERMINATED");
    expect(sh(stopped, "gcloud compute instances list").out[1]).toMatch(/TERMINATED$/);
    expect(cloud(sh(stopped, "gcloud compute instances start web-1").state).gcp.instances["web-1"].status).toBe("RUNNING");
    const deleted = sh(stopped, "gcloud compute instances delete web-1 --zone=asia-east1-b --quiet");
    expect(deleted.text).toMatch(/^Deleted \[/);
    expect(cloud(deleted.state).gcp.instances).toEqual({});
  });

  it("reports unknown instances and a wrong zone", () => {
    const s = withVm().state;
    expect(sh(s, "gcloud compute instances stop web-9 --zone=asia-east1-b").error).toMatch(/instances\/web-9' was not found/);
    expect(sh(s, "gcloud compute instances stop web-1 --zone=us-central1-a").error).toMatch(/zones\/us-central1-a\/instances\/web-1' was not found/);
    expect(cloud(sh(s, "gcloud compute instances stop web-1 --zone=us-central1-a").state).gcp.instances["web-1"].status).toBe("RUNNING");
  });

  it("adds tags later and describes an instance", () => {
    const s = sh(createLabState(), "gcloud compute instances create db-1 --zone=asia-east1-a", "gcloud compute instances add-tags db-1 --tags=db,internal").state;
    expect(cloud(s).gcp.instances["db-1"].tags).toEqual({ db: true, internal: true });
    expect(sh(s, "gcloud compute instances describe db-1").text).toMatch(/name: db-1\nstatus: RUNNING\ntags:\n {2}items:\n {2}- db\n {2}- internal\nzone: asia-east1-a/);
    expect(sh(s, "gcloud compute instances add-tags db-1").error).toMatch(/--tags: Must be specified/);
  });

  it("creates, lists and deletes firewall rules", () => {
    const r = sh(createLabState(), "gcloud compute firewall-rules create allow-http --allow=tcp:80 --source-ranges=0.0.0.0/0 --target-tags=web");
    expect(r.out[1]).toMatch(/^Created \[.*\/global\/firewalls\/allow-http\]\.$/);
    expect(cloud(r.state).gcp.firewallRules["allow-http"]).toEqual({ allow: { "tcp:80": true }, sourceRanges: { "0.0.0.0/0": true }, targetTags: { web: true } });
    expect(sh(r.state, "gcloud compute firewall-rules list").out[1]).toMatch(/^allow-http\s+default\s+INGRESS\s+tcp:80\s+0\.0\.0\.0\/0\s+web$/);
    expect(cloud(sh(r.state, "gcloud compute firewall-rules delete allow-http").state).gcp.firewallRules).toEqual({});
    expect(sh(r.state, "gcloud compute firewall-rules delete nope").error).toMatch(/was not found/);
  });

  it("defaults the source to everywhere and accepts several protocols", () => {
    const s = sh(createLabState(), "gcloud compute firewall-rules create web --allow tcp:80,tcp:443,icmp").state;
    expect(cloud(s).gcp.firewallRules.web).toEqual({ allow: { "tcp:80": true, "tcp:443": true, icmp: true }, sourceRanges: { "0.0.0.0/0": true }, targetTags: {} });
  });

  it("validates firewall rule arguments", () => {
    const base = "gcloud compute firewall-rules create";
    expect(sh(createLabState(), `${base} r1`).error).toMatch(/請用 --allow/);
    expect(sh(createLabState(), `${base} r1 --allow=http`).error).toMatch(/無法解讀 'http'/);
    expect(sh(createLabState(), `${base} --allow=tcp:80`).error).toMatch(/NAME: Must be specified/);
    expect(sh(createLabState(), `${base} r1 --allow=tcp:80 --direction=EGRESS`).error).toMatch(/只支援輸入/);
    expect(sh(createLabState(), `${base} r1 --allow=tcp:80`, `${base} r1 --allow=tcp:80`).error).toMatch(/already exists/);
    expect(sh(createLabState(), "gcloud compute disks list").error).toMatch(/不支援 'disks'/);
  });
});

describe("cloud state", () => {
  it("is never modified by running commands", () => {
    const before = sh(createLabState(), "aws iam create-user --user-name a", "gcloud compute instances create vm-1 --zone=asia-east1-b").state;
    const snapshot = JSON.stringify(checkView(before));
    sh(before, "aws iam create-group --group-name g", "aws iam add-user-to-group --group-name g --user-name a", "gcloud compute instances stop vm-1", "gcloud compute instances add-tags vm-1 --tags=x", "gcloud iam service-accounts create builder");
    expect(JSON.stringify(checkView(before))).toBe(snapshot);
  });

  it("keeps AWS and Google Cloud resources separate from each other and from storage", () => {
    const s = sh(createLabState(), "aws s3 mb s3://shared-name", "gcloud compute instances create shared-name --zone=asia-east1-b").state;
    expect(Object.keys(cloud(s).s3.buckets)).toEqual(["shared-name"]);
    expect(Object.keys(cloud(s).gcp.instances)).toEqual(["shared-name"]);
    expect(cloud(s).aws.ec2.counts.running).toBe(0);
  });
});

describe("iam and vm labs can be completed", () => {
  const labs = new Map([...loadContent().units.values()].flatMap((u) => u.labs).map((l) => [l.id, l]));

  /** Runs groups of commands; a function gets the output so far (to pick up generated ids). */
  function play(labId: string, groups: (string | ((lastOutput: string) => string))[][]): number[] {
    const lab = labs.get(labId)!;
    let state = createLabState(lab.initialState);
    let done = advance(0, state, lab.steps);
    let lastOutput = "";
    return groups.map((commands) => {
      for (const c of commands) {
        const result = execute(state, typeof c === "string" ? c : c(lastOutput));
        state = result.state;
        const text = result.lines.map((l) => l.text).join("\n");
        if (text.includes("InstanceId")) lastOutput = text;
        done = advance(done, state, lab.steps);
      }
      return done;
    });
  }
  const instanceId = (output: string) => /"InstanceId": "(i-[0-9a-f]+)"/.exec(output)![1];

  it("no lab starts with a step already complete", () => {
    for (const id of ["aws-iam-group", "gcp-iam-service-account", "aws-ec2-instance", "gcp-compute-instance"]) {
      const lab = labs.get(id)!;
      expect(advance(0, createLabState(lab.initialState), lab.steps), id).toBe(0);
    }
  });

  it("aws-iam-group", () => {
    expect(
      play("aws-iam-group", [
        ["aws iam create-group --group-name developers"],
        [`aws iam attach-group-policy --group-name developers --policy-arn ${S3_READ}`],
        ["aws iam create-user --user-name alice"],
        ["aws iam add-user-to-group --group-name developers --user-name alice", "aws iam list-groups-for-user --user-name alice"],
      ]),
    ).toEqual([1, 2, 3, 4]);
  });

  it("aws-iam-group does not accept the wrong policy or attaching it to the user instead", () => {
    expect(
      play("aws-iam-group", [
        ["aws iam create-group --group-name developers"],
        ["aws iam attach-group-policy --group-name developers --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess"],
        ["aws iam create-user --user-name alice", `aws iam attach-user-policy --user-name alice --policy-arn ${S3_READ}`],
      ]),
    ).toEqual([1, 1, 1]);
  });

  it("gcp-iam-service-account", () => {
    expect(
      play("gcp-iam-service-account", [
        ["gcloud projects get-iam-policy my-project", 'gcloud iam service-accounts create app-reader --display-name="App reader"'],
        ['gcloud projects add-iam-policy-binding my-project --member="serviceAccount:app-reader@my-project.iam.gserviceaccount.com" --role="roles/storage.objectViewer"'],
        ['gcloud projects remove-iam-policy-binding my-project --member="user:intern@example.com" --role="roles/editor"'],
      ]),
    ).toEqual([1, 2, 3]);
  });

  it("gcp-iam-service-account: removing the intern first does not skip ahead", () => {
    expect(play("gcp-iam-service-account", [["gcloud projects remove-iam-policy-binding my-project --member=user:intern@example.com --role=roles/editor"]])).toEqual([0]);
  });

  it("aws-ec2-instance, picking the instance id out of the launch output", () => {
    expect(
      play("aws-ec2-instance", [
        ['aws ec2 create-security-group --group-name web-sg --description "Web server"'],
        ["aws ec2 authorize-security-group-ingress --group-name web-sg --protocol tcp --port 443 --cidr 0.0.0.0/0"],
        ["aws ec2 run-instances --image-id ami-0abcdef1234567890 --instance-type t3.micro --security-groups web-sg"],
        [(out) => `aws ec2 stop-instances --instance-ids ${instanceId(out)}`],
        [(out) => `aws ec2 terminate-instances --instance-ids ${instanceId(out)}`],
      ]),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("aws-ec2-instance: an instance without the security group does not count", () => {
    expect(
      play("aws-ec2-instance", [
        ['aws ec2 create-security-group --group-name web-sg --description "x"', "aws ec2 authorize-security-group-ingress --group-name web-sg --protocol tcp --port 443 --cidr 0.0.0.0/0"],
        ["aws ec2 run-instances --image-id ami-0abcdef1234567890 --instance-type t3.micro"],
      ]),
    ).toEqual([2, 2]);
  });

  it("gcp-compute-instance", () => {
    expect(
      play("gcp-compute-instance", [
        ["gcloud compute instances create web-1 --zone=asia-east1-b --machine-type=e2-micro --tags=web"],
        ["gcloud compute firewall-rules create allow-http --allow=tcp:80 --source-ranges=0.0.0.0/0 --target-tags=web"],
        ["gcloud compute instances stop web-1 --zone=asia-east1-b", "gcloud compute instances list"],
        ["gcloud compute instances delete web-1 --zone=asia-east1-b"],
      ]),
    ).toEqual([1, 3, 4, 5]);
  });

  it("gcp-compute-instance: forgotten tags can be fixed afterwards", () => {
    expect(
      play("gcp-compute-instance", [
        ["gcloud compute instances create web-1 --zone=asia-east1-b --machine-type=e2-micro"],
        ["gcloud compute instances add-tags web-1 --tags=web --zone=asia-east1-b"],
        ["gcloud compute firewall-rules create allow-http --allow=tcp:80"],
        ["gcloud compute firewall-rules delete allow-http", "gcloud compute firewall-rules create allow-http --allow=tcp:80 --target-tags=web"],
      ]),
    ).toEqual([0, 1, 2, 3]);
  });
});
