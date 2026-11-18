import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content/loader";
import { advance } from "./check";
import { execute } from "./engine";
import { parseHcl } from "./hcl";
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
const view = (state: LabState): any => checkView(state);

const MAIN = `variable "region" {
  default = "asia-east1"
}

variable "storage_class" {
  default = "STANDARD"
}

resource "google_storage_bucket" "site" {
  name          = "tf-site"
  location      = var.region
  storage_class = var.storage_class
  force_destroy = true
}

output "bucket_url" {
  value = google_storage_bucket.site.url
}

output "summary" {
  value = "\${google_storage_bucket.site.name} in \${var.region}"
}
`;
const TF = { files: { "~/infra/main.tf": MAIN } };
const ready = () => sh(createLabState(TF), "cd infra", "terraform init").state;

describe("hcl", () => {
  it("parses blocks, attributes, references and templates", () => {
    const [v, r] = parseHcl('variable "x" {\n  default = [1, "a", true]\n}\nresource "t" "n" {\n  name = "p-${var.x}"\n  tags = { a = 1 }\n  nested {\n    k = v.w\n  }\n}\n');
    expect(v).toMatchObject({ type: "variable", labels: ["x"] });
    expect(v.attributes.get("default")).toEqual({ kind: "list", items: [{ kind: "literal", value: 1 }, { kind: "literal", value: "a" }, { kind: "literal", value: true }] });
    expect(r.attributes.get("name")).toEqual({ kind: "template", parts: ["p-", { kind: "ref", path: ["var", "x"] }] });
    expect(r.blocks[0].attributes.get("k")).toEqual({ kind: "ref", path: ["v", "w"] });
  });

  it("reports syntax errors with the line", () => {
    expect(() => parseHcl('resource "a" "b" {\n  name = "x\n}\n')).toThrow(/Unterminated/);
    expect(() => parseHcl('resource "a" "b" {\n  name = "x"\n')).toThrow(/Unclosed/);
  });
});

describe("terraform", () => {
  it("needs init before plan, and writes a lock file", () => {
    const s = createLabState(TF);
    expect(sh(s, "cd infra", "terraform plan").error).toContain("terraform init");
    const r = sh(s, "cd infra", "terraform init");
    expect(r.text).toContain("Installing hashicorp/google v6.12.0");
    expect(view(r.state).files["~/infra/.terraform.lock.hcl"]).toContain("hashicorp/google");
    expect(sh(createLabState(), "terraform init").error).toContain("No configuration files");
  });

  it("plans, applies with -auto-approve, writes state and outputs", () => {
    const s = ready();
    const p = sh(s, "terraform plan");
    expect(p.text).toContain("# google_storage_bucket.site will be created");
    expect(p.text).toContain('+ location      = "asia-east1"');
    expect(p.text).toContain("+ url           = (known after apply)");
    expect(p.text).toContain("Plan: 1 to add, 0 to change, 0 to destroy.");
    expect(sh(s, "terraform apply").error).toContain("-auto-approve");
    expect(view(sh(s, "terraform apply").state).cloud.gcs.buckets).toEqual({});
    const a = sh(s, "terraform apply -auto-approve");
    expect(a.text).toContain("Apply complete! Resources: 1 added, 0 changed, 0 destroyed.");
    expect(a.text).toContain('bucket_url = "gs://tf-site"');
    expect(a.text).toContain('summary = "tf-site in asia-east1"');
    expect(view(a.state).cloud.gcs.buckets["tf-site"]).toMatchObject({ location: "asia-east1", storageClass: "STANDARD" });
    expect(JSON.parse(view(a.state).files["~/infra/terraform.tfstate"]).resources[0].type).toBe("google_storage_bucket");
    expect(sh(a.state, "terraform plan").text).toContain("No changes.");
    expect(sh(a.state, "terraform output -raw bucket_url").text).toBe("gs://tf-site");
    expect(sh(a.state, "terraform state list").text).toBe("google_storage_bucket.site");
  });

  it("updates in place, replaces on forceNew attributes, and destroys", () => {
    const s = sh(ready(), "terraform apply -auto-approve").state;
    const update = sh(s, "terraform plan -var storage_class=NEARLINE");
    expect(update.text).toContain("will be updated in-place");
    expect(update.text).toContain('~ storage_class = "STANDARD" -> "NEARLINE"');
    const replace = sh(s, "terraform plan -var region=us-central1");
    expect(replace.text).toContain("must be replaced");
    expect(replace.text).toContain("# forces replacement");
    expect(replace.text).toContain("Plan: 1 to add, 0 to change, 1 to destroy.");
    expect(sh(s, "terraform plan -var colour=red").error).toContain("undeclared variable");
    const d = sh(s, "terraform destroy -auto-approve");
    expect(d.text).toContain("Destroy complete! Resources: 1 destroyed.");
    expect(view(d.state).cloud.gcs.buckets).toEqual({});
    expect(view(d.state).terraform["~/infra"].resources).toEqual({});
  });

  it("notices a resource deleted outside Terraform and recreates it", () => {
    const s = sh(ready(), "terraform apply -auto-approve", "gcloud storage buckets delete gs://tf-site").state;
    const p = sh(s, "terraform plan");
    expect(p.text).toContain("google_storage_bucket.site has been deleted");
    expect(p.text).toContain("Plan: 1 to add");
    const a = sh(s, "terraform apply -auto-approve");
    expect(view(a.state).terraform["~/infra"].driftRepairs).toBe(1);
  });

  it("refuses to create a bucket that already exists outside the state", () => {
    const s = sh(createLabState({ ...TF, cloud: { gcs: { buckets: { "tf-site": {} } } } }), "cd infra", "terraform init").state;
    expect(sh(s, "terraform apply -auto-approve").error).toContain("terraform import");
  });

  it("reports configuration errors", () => {
    const bad = (main: string) => sh(createLabState({ files: { "~/infra/main.tf": main } }), "cd infra", "terraform init", "terraform plan").error;
    expect(bad('resource "google_compute_thing" "x" {\n}\n')).toContain("Invalid resource type");
    expect(bad('resource "google_storage_bucket" "x" {\n  name = "a-b-c"\n}\n')).toContain('"location" is required');
    expect(bad('resource "google_storage_bucket" "x" {\n  name = var.nope\n  location = "US"\n}\n')).toContain("undeclared input variable");
  });
});

const TEMPLATE = (retention: number) => `AWSTemplateFormatVersion: "2010-09-09"
Parameters:
  EnvName:
    Type: String
    Default: dev
    AllowedValues: [dev, prod]
Resources:
  AppBucket:
    Type: AWS::S3::Bucket
    DeletionPolicy: Retain
    Properties:
      BucketName: !Sub lab-app-\${EnvName}-\${AWS::AccountId}
  AlertsTopic:
    Type: AWS::SNS::Topic
  AppLogs:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub /app/\${EnvName}
      RetentionInDays: ${retention}
Outputs:
  BucketName:
    Value: !Ref AppBucket
  BucketArn:
    Value: !GetAtt AppBucket.Arn
  TopicArn:
    Value: !Ref AlertsTopic
`;
const CFN = { files: { "~/app.yaml": TEMPLATE(30), "~/app-v2.yaml": TEMPLATE(90) } };
const stack = (s: LabState, name: string) => view(s).cloud.aws.cloudformation.stacks[name];

describe("cloudformation", () => {
  it("creates a stack with parameters, generated names and outputs", () => {
    const r = sh(createLabState(CFN), "aws cloudformation create-stack --stack-name lab-dev --template-body file://app.yaml");
    expect(stack(r.state, "lab-dev").status).toBe("CREATE_COMPLETE");
    expect(view(r.state).cloud.s3.buckets).toHaveProperty(["lab-app-dev-123456789012"]);
    expect(view(r.state).cloud.aws.logs.groups["/app/dev"].retentionInDays).toBe(30);
    const outputs = Object.fromEntries(JSON.parse(sh(r.state, "aws cloudformation describe-stacks --stack-name lab-dev").text).Stacks[0].Outputs.map((o: any) => [o.OutputKey, o.OutputValue]));
    expect(outputs.BucketName).toBe("lab-app-dev-123456789012");
    expect(outputs.BucketArn).toBe("arn:aws:s3:::lab-app-dev-123456789012");
    expect(outputs.TopicArn).toMatch(/^arn:aws:sns:us-east-1:123456789012:lab-dev-AlertsTopic-[A-Z0-9]{12}$/);
    expect(sh(r.state, "aws cloudformation create-stack --stack-name lab-dev --template-body file://app.yaml").error).toContain("AlreadyExistsException");
  });

  it("validates templates and parameters", () => {
    const s = createLabState({ files: { "~/bad.yaml": "Resources:\n  X:\n    Type: AWS::Fake::Thing\n", "~/ref.yaml": "Resources:\n  B:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: !Ref Missing\n" } });
    expect(sh(s, "aws cloudformation validate-template --template-body file://bad.yaml").error).toContain("Unrecognized resource types");
    expect(sh(s, "aws cloudformation validate-template --template-body file://ref.yaml").error).toContain("Unresolved resource dependencies [Missing]");
    expect(sh(createLabState(CFN), "aws cloudformation create-stack --stack-name x --template-body file://app.yaml --parameters ParameterKey=EnvName,ParameterValue=qa").error).toContain("AllowedValues");
    expect(JSON.parse(sh(createLabState(CFN), "aws cloudformation validate-template --template-body file://app.yaml").text).Parameters[0]).toMatchObject({ ParameterKey: "EnvName", DefaultValue: "dev" });
  });

  it("rolls back a failed create; the stack must be deleted before trying again", () => {
    const seed = { ...CFN, cloud: { s3: { buckets: { "lab-app-prod-123456789012": {} } } } };
    const r = sh(createLabState(seed), "aws cloudformation create-stack --stack-name lab-prod --template-body file://app.yaml --parameters ParameterKey=EnvName,ParameterValue=prod");
    expect(stack(r.state, "lab-prod").status).toBe("ROLLBACK_COMPLETE");
    expect(view(r.state).cloud.aws.sns.topics).toEqual({});
    expect(sh(r.state, "aws cloudformation describe-stack-events --stack-name lab-prod").text).toContain("already exists");
    expect(sh(r.state, "aws cloudformation create-change-set --stack-name lab-prod --change-set-name c --template-body file://app.yaml").error).toContain("ROLLBACK_COMPLETE");
    const d = sh(r.state, "aws cloudformation delete-stack --stack-name lab-prod");
    expect(stack(d.state, "lab-prod").status).toBe("DELETE_COMPLETE");
    expect(sh(d.state, "aws cloudformation describe-stacks --stack-name lab-prod").error).toContain("does not exist");
  });

  it("previews and executes a change set", () => {
    const s = sh(createLabState(CFN), "aws cloudformation create-stack --stack-name lab-dev --template-body file://app.yaml", "aws cloudformation create-change-set --stack-name lab-dev --change-set-name v2 --template-body file://app-v2.yaml").state;
    const cs = JSON.parse(sh(s, "aws cloudformation describe-change-set --stack-name lab-dev --change-set-name v2").text);
    expect(cs.Changes).toEqual([{ Type: "Resource", ResourceChange: { Action: "Modify", LogicalResourceId: "AppLogs", ResourceType: "AWS::Logs::LogGroup", Replacement: "False", Details: [{ Target: { Attribute: "Properties", Name: "RetentionInDays" } }] } }]);
    const e = sh(s, "aws cloudformation execute-change-set --stack-name lab-dev --change-set-name v2");
    expect(stack(e.state, "lab-dev").status).toBe("UPDATE_COMPLETE");
    expect(view(e.state).cloud.aws.logs.groups["/app/dev"].retentionInDays).toBe(90);
    const same = sh(e.state, "aws cloudformation create-change-set --stack-name lab-dev --change-set-name v3 --template-body file://app-v2.yaml", "aws cloudformation describe-change-set --stack-name lab-dev --change-set-name v3");
    expect(JSON.parse(same.text).Status).toBe("FAILED");
  });

  it("detects drift and retains resources on delete", () => {
    let s = sh(createLabState(CFN), "aws cloudformation create-stack --stack-name lab-dev --template-body file://app.yaml", "aws cloudformation detect-stack-drift --stack-name lab-dev").state;
    expect(stack(s, "lab-dev").drift).toBe("IN_SYNC");
    s = sh(s, "aws logs put-retention-policy --log-group-name /app/dev --retention-in-days 7", "aws cloudformation detect-stack-drift --stack-name lab-dev").state;
    expect(stack(s, "lab-dev").drift).toBe("DRIFTED");
    const drifts = JSON.parse(sh(s, "aws cloudformation describe-stack-resource-drifts --stack-name lab-dev").text).StackResourceDrifts;
    expect(drifts.find((d: any) => d.LogicalResourceId === "AppLogs")).toMatchObject({ StackResourceDriftStatus: "MODIFIED", PropertyDifferences: [{ PropertyPath: "/RetentionInDays", ExpectedValue: "30", ActualValue: "7" }] });
    const d = sh(s, "aws cloudformation delete-stack --stack-name lab-dev").state;
    expect(stack(d, "lab-dev").retained).toEqual({ AppBucket: true });
    expect(view(d).cloud.s3.buckets).toHaveProperty(["lab-app-dev-123456789012"]);
    expect(view(d).cloud.aws.logs.groups).toEqual({});
  });
});

describe("iac labs can be completed", () => {
  const labs = new Map([...loadContent().units.values()].flatMap((u) => u.labs).map((l) => [l.id, l]));
  function play(labId: string, groups: string[][]): number[] {
    const lab = labs.get(labId)!;
    let state = createLabState(lab.initialState);
    let done = advance(0, state, lab.steps);
    return groups.map((commands) => {
      for (const c of commands) {
        state = execute(state, c).state;
        done = advance(done, state, lab.steps);
      }
      return done;
    });
  }

  it("aws-cloudformation-stack", () => {
    expect(
      play("aws-cloudformation-stack", [
        ["cd cfn", "cat app.yaml", "aws cloudformation validate-template --template-body file://app.yaml", "aws cloudformation create-stack --stack-name lab-dev --template-body file://app.yaml", "aws cloudformation describe-stacks --stack-name lab-dev"],
        ["aws cloudformation create-stack --stack-name lab-prod --template-body file://app.yaml --parameters ParameterKey=EnvName,ParameterValue=prod", "aws cloudformation describe-stack-events --stack-name lab-prod", "aws cloudformation delete-stack --stack-name lab-prod"],
        ["aws cloudformation create-change-set --stack-name lab-dev --change-set-name v2 --template-body file://app-v2.yaml", "aws cloudformation describe-change-set --stack-name lab-dev --change-set-name v2", "aws cloudformation execute-change-set --stack-name lab-dev --change-set-name v2"],
        ["aws logs put-retention-policy --log-group-name /app/dev --retention-in-days 7", "aws cloudformation detect-stack-drift --stack-name lab-dev", "aws cloudformation describe-stack-resource-drifts --stack-name lab-dev"],
        ["aws cloudformation delete-stack --stack-name lab-dev", "aws s3 ls", "aws sns list-topics"],
      ]),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("gcp-terraform-basics", () => {
    expect(
      play("gcp-terraform-basics", [
        ["cd infra", "cat main.tf", "terraform plan", "terraform init"],
        ["terraform plan", "terraform apply", "terraform apply -auto-approve", "terraform output", "cat terraform.tfstate"],
        ["terraform plan -var storage_class=NEARLINE", "terraform apply -auto-approve -var storage_class=NEARLINE"],
        ["gcloud storage buckets delete gs://my-project-tf-site", "terraform plan -var storage_class=NEARLINE", "terraform apply -auto-approve -var storage_class=NEARLINE"],
        ["terraform state list", "terraform destroy -auto-approve"],
      ]),
    ).toEqual([1, 2, 3, 4, 5]);
  });
});
