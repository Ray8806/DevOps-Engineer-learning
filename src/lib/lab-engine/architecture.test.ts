import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content/loader";
import { advance } from "./check";
import { execute, startLab } from "./engine";
import { checkView, createLabState, type LabState } from "./state";

/* eslint-disable @typescript-eslint/no-explicit-any -- the check view is walked loosely in tests */
const view = (state: LabState): any => checkView(state);

const labs = new Map([...loadContent().units.values()].flatMap((u) => u.labs).map((l) => [l.id, l]));

describe("lab setup", () => {
  it("runs every lab's setup commands without errors and starts in the home directory", () => {
    for (const lab of labs.values()) {
      const state = startLab(lab.initialState);
      expect(state.cwd, lab.id).toBe(createLabState({}).cwd);
      // A lab must not be finished before the learner does anything.
      expect(advance(0, state, lab.steps), lab.id).toBe(0);
    }
  });

  it("reports the failing setup command", () => {
    expect(() => startLab({ setup: ["aws sqs get-queue-url --queue-name nope"] })).toThrow(/Lab setup failed at "aws sqs get-queue-url/);
  });
});

describe("update-auto-scaling-group --vpc-zone-identifier", () => {
  it("spreads new instances to the added zones", () => {
    const lab = labs.get("aws-ha-review")!;
    let s = startLab(lab.initialState);
    expect(view(s).cloud.aws.autoscaling.groups["shop-asg"]).toMatchObject({ inService: 1, availabilityZones: { "us-east-1a": true }, instanceZones: { "us-east-1a": true } });
    const r = execute(s, "aws autoscaling update-auto-scaling-group --auto-scaling-group-name shop-asg --vpc-zone-identifier subnet-nope");
    expect(r.lines.map((l) => l.text).join("")).toMatch(/subnet-nope' does not exist/);
    s = execute(s, 'aws autoscaling update-auto-scaling-group --auto-scaling-group-name shop-asg --vpc-zone-identifier "subnet-0a1b2c3d4e5f60718,subnet-0b2c3d4e5f6071829" --min-size 2 --max-size 6 --desired-capacity 2').state;
    expect(view(s).cloud.aws.autoscaling.groups["shop-asg"]).toMatchObject({
      inService: 2,
      availabilityZones: { "us-east-1a": true, "us-east-1b": true },
      instanceZones: { "us-east-1a": true, "us-east-1b": true },
    });
    expect(view(s).cloud.aws.elbv2.targetGroups["shop-tg"].healthyTargets).toBe(2);
  });
});

describe("architecture labs can be completed", () => {
  function play(labId: string, groups: (string | ((s: LabState) => string))[][]): number[] {
    const lab = labs.get(labId)!;
    let state = startLab(lab.initialState);
    let done = advance(0, state, lab.steps);
    return groups.map((commands) => {
      for (const c of commands) {
        state = execute(state, typeof c === "string" ? c : c(state)).state;
        done = advance(done, state, lab.steps);
      }
      return done;
    });
  }
  const TG = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/shop-tg/ffd11ff0aa762598";

  it("aws-ha-review", () => {
    expect(
      play("aws-ha-review", [
        ["aws autoscaling describe-auto-scaling-groups", `aws elbv2 describe-target-health --target-group-arn ${TG}`, 'aws autoscaling update-auto-scaling-group --auto-scaling-group-name shop-asg --vpc-zone-identifier "subnet-0a1b2c3d4e5f60718,subnet-0b2c3d4e5f6071829" --min-size 2 --max-size 6 --desired-capacity 2'],
        ['aws autoscaling put-scaling-policy --auto-scaling-group-name shop-asg --policy-name cpu50 --policy-type TargetTrackingScaling --target-tracking-configuration \'{"PredefinedMetricSpecification": {"PredefinedMetricType": "ASGAverageCPUUtilization"}, "TargetValue": 50}\''],
        ["aws rds describe-db-instances --db-instance-identifier shop-db", "aws rds modify-db-instance --db-instance-identifier shop-db --multi-az --apply-immediately"],
        [(s) => `aws ec2 terminate-instances --instance-ids ${s.aws.autoscaling.groups.get("shop-asg")!.instances[0]}`, "aws autoscaling describe-auto-scaling-groups", `aws elbv2 describe-target-health --target-group-arn ${TG}`],
      ]),
    ).toEqual([1, 2, 3, 4]);
  });

  it("gcp-ha-review", () => {
    expect(
      play("gcp-ha-review", [
        [
          "gcloud compute backend-services get-health shop-backend --global",
          "gcloud compute instance-groups managed create shop-mig-c --template=shop-template --size=1 --zone=asia-east1-c",
          "gcloud compute instance-groups managed set-named-ports shop-mig-c --named-ports=http:80 --zone=asia-east1-c",
          "gcloud compute backend-services add-backend shop-backend --instance-group=shop-mig-c --instance-group-zone=asia-east1-c --global",
        ],
        [
          "gcloud compute instance-groups managed set-autoscaling shop-mig-b --zone=asia-east1-b --min-num-replicas=1 --max-num-replicas=5 --target-cpu-utilization=0.6",
          "gcloud compute instance-groups managed set-autoscaling shop-mig-c --zone=asia-east1-c --min-num-replicas=1 --max-num-replicas=5 --target-cpu-utilization=0.6",
        ],
        ["gcloud sql instances describe shop-db", "gcloud sql instances patch shop-db --availability-type=REGIONAL"],
        ["gcloud compute instance-groups managed list-instances shop-mig-b --zone=asia-east1-b", (s) => `gcloud compute instances delete ${[...s.gcp.instances.keys()].find((n) => n.startsWith("shop-mig-b"))} --zone=asia-east1-b`, "gcloud compute backend-services get-health shop-backend --global"],
      ]),
    ).toEqual([1, 2, 3, 4]);
  });
});
