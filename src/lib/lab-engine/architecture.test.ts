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

describe("bucket event notifications", () => {
  const Q = "https://sqs.us-east-1.amazonaws.com/123456789012";
  const B = "lab-sales-raw-123456789012";
  const run = (state: LabState, ...lines: string[]) => {
    let text = "";
    let error = "";
    for (const line of lines) {
      const r = execute(state, line);
      state = r.state;
      text = r.lines.filter((l) => !l.error).map((l) => l.text).join("\n");
      error = r.lines.filter((l) => l.error).map((l) => l.text).join("\n");
    }
    return { state, text, error };
  };
  const bodies = (text: string) => (JSON.parse(text.slice(0, text.lastIndexOf("}") + 1)).Messages as { Body: string; ReceiptHandle: string }[]).map((m) => JSON.parse(m.Body));

  it("S3 validates the queue policy, sends a test event, then object events filtered by prefix", () => {
    const lab = labs.get("aws-s3-events")!;
    let r = run(startLab(lab.initialState), `aws s3 mb s3://${B}`, "aws sqs create-queue --queue-name new-files", `aws s3api put-bucket-notification-configuration --bucket ${B} --notification-configuration file://notification.json`);
    expect(r.error).toMatch(/InvalidArgument[\s\S]*Unable to validate the following destination configurations/);
    r = run(r.state, `aws sqs set-queue-attributes --queue-url ${Q}/new-files --attributes file://queue-policy.json`, `aws s3api put-bucket-notification-configuration --bucket ${B} --notification-configuration file://notification.json`);
    expect(r.error).toBe("");
    expect(JSON.parse(run(r.state, `aws s3api get-bucket-notification-configuration --bucket ${B}`).text).QueueConfigurations[0]).toMatchObject({ Id: "new-sales-files", Events: ["s3:ObjectCreated:*"] });
    r = run(r.state, `aws sqs receive-message --queue-url ${Q}/new-files`);
    expect(bodies(r.text)[0]).toMatchObject({ Service: "Amazon S3", Event: "s3:TestEvent", Bucket: B });
    // Outside the prefix: no event. Inside: an ObjectCreated:Put record with a URL-encoded key.
    r = run(r.state, "echo hi > 'my file.csv'", `aws s3 cp 'my file.csv' s3://${B}/reports/x.csv`, `aws s3 cp 'my file.csv' s3://${B}/incoming/`, "sleep 30", `aws sqs receive-message --queue-url ${Q}/new-files --max-number-of-messages 10`);
    const events = bodies(r.text).filter((b) => b.Records);
    expect(events).toHaveLength(1);
    expect(events[0].Records[0]).toMatchObject({ eventSource: "aws:s3", eventName: "ObjectCreated:Put", s3: { bucket: { name: B }, object: { key: "incoming/my+file.csv", size: 3 } } });
    expect(view(r.state).cloud.aws.sqs.queues["new-files"].receivedS3Event).toBe(true);
    r = run(r.state, `aws s3 rm s3://${B}/incoming/my\\ file.csv`);
  });

  it("gcloud creates the topic, grants the service agent and publishes object events", () => {
    let r = run(createLabState({ files: { "~/a.csv": "x" } }), "gcloud storage buckets create gs://raw-bucket", "gcloud storage buckets notifications create gs://raw-bucket --topic=new-files --event-types=OBJECT_FINALIZE --object-prefix=incoming/");
    expect(r.text).toMatch(/Created Pub\/Sub topic/);
    expect(view(r.state).cloud.gcp.pubsub.topics["new-files"].iam["roles/pubsub.publisher"]).toEqual({ "serviceAccount:service-498765432109@gs-project-accounts.iam.gserviceaccount.com": true });
    // Published before the subscription exists: not delivered to it.
    r = run(r.state, "gcloud storage cp a.csv gs://raw-bucket/incoming/", "gcloud pubsub subscriptions create sub --topic=new-files", "gcloud pubsub subscriptions pull sub");
    expect(r.text).toBe("Listed 0 items.");
    r = run(r.state, "gcloud storage cp a.csv gs://raw-bucket/other/", "gcloud storage cp a.csv gs://raw-bucket/incoming/b.csv", "gcloud pubsub subscriptions pull sub --auto-ack --limit=5");
    expect(r.text).toMatch(/eventType=OBJECT_FINALIZE/);
    expect(r.text).toMatch(/objectId=incoming\/b\.csv/);
    expect(r.text).not.toMatch(/other\//);
    expect(run(r.state, "gcloud storage buckets notifications list gs://raw-bucket").text).toMatch(/topic: \/\/pubsub.googleapis.com\/projects\/my-project\/topics\/new-files/);
    // --skip-topic-setup without the grant: nothing is delivered.
    r = run(r.state, "gcloud pubsub topics create quiet", "gcloud pubsub subscriptions create quiet-sub --topic=quiet", "gcloud storage buckets notifications create gs://raw-bucket --topic=quiet --skip-topic-setup", "gcloud storage cp a.csv gs://raw-bucket/c.csv", "gcloud pubsub subscriptions pull quiet-sub");
    expect(r.text).toBe("Listed 0 items.");
  });
});

describe("data pipeline labs can be completed", () => {
  function play(labId: string, groups: string[][]): number[] {
    const lab = labs.get(labId)!;
    let state = startLab(lab.initialState);
    let done = advance(0, state, lab.steps);
    return groups.map((commands) => {
      for (const c of commands) {
        state = execute(state, c).state;
        done = advance(done, state, lab.steps);
      }
      return done;
    });
  }
  const Q = "https://sqs.us-east-1.amazonaws.com/123456789012";
  const B = "lab-sales-raw-123456789012";
  const G = "my-project-sales-raw";

  it("aws-s3-events", () => {
    expect(
      play("aws-s3-events", [
        [`aws s3 mb s3://${B}`, "aws sqs create-queue --queue-name new-files", "cat notification.json", `aws s3api put-bucket-notification-configuration --bucket ${B} --notification-configuration file://notification.json`],
        ["cat queue-policy.json", `aws sqs set-queue-attributes --queue-url ${Q}/new-files --attributes file://queue-policy.json`, `aws s3api put-bucket-notification-configuration --bucket ${B} --notification-configuration file://notification.json`, `aws sqs receive-message --queue-url ${Q}/new-files`],
        [`aws s3 cp sales-2026-11-16.csv s3://${B}/incoming/sales-2026-11-16.csv`, `aws sqs receive-message --queue-url ${Q}/new-files`],
        [`aws s3 cp s3://${B}/incoming/sales-2026-11-16.csv s3://${B}/sales/year=2026/month=11/day=16/sales.csv`, `aws s3 ls s3://${B} --recursive`, `aws sqs receive-message --queue-url ${Q}/new-files`],
      ]),
    ).toEqual([1, 2, 3, 4]);
  });

  it("gcp-storage-events", () => {
    expect(
      play("gcp-storage-events", [
        [`gcloud storage buckets create gs://${G} --location=asia-east1`, `gcloud storage buckets notifications create gs://${G} --topic=new-files --event-types=OBJECT_FINALIZE --object-prefix=incoming/`, `gcloud storage buckets notifications list gs://${G}`],
        [`gcloud storage cp sales-2026-11-16.csv gs://${G}/incoming/`, "gcloud pubsub subscriptions create new-files-sub --topic=new-files", "gcloud pubsub subscriptions pull new-files-sub", `gcloud storage cp sales-2026-11-17.csv gs://${G}/incoming/`, "gcloud pubsub subscriptions pull new-files-sub --auto-ack"],
        [`gcloud storage cp gs://${G}/incoming/sales-2026-11-17.csv gs://${G}/sales/dt=2026-11-17/sales.csv`, `gcloud storage ls --recursive gs://${G}`, "gcloud pubsub subscriptions pull new-files-sub"],
      ]),
    ).toEqual([1, 2, 3]);
  });
});
