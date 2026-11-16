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

const VPC = "vpc-0lab";
const SEED = {
  cloud: {
    aws: {
      vpcs: {
        [VPC]: {
          cidr: "10.0.0.0/16",
          internetGateway: true,
          subnets: {
            "subnet-0a": { cidr: "10.0.1.0/24", availabilityZone: "us-east-1a" },
            "subnet-0b": { cidr: "10.0.2.0/24", availabilityZone: "us-east-1b" },
            "subnet-0c": { cidr: "10.0.3.0/24", availabilityZone: "us-east-1a" },
          },
        },
      },
    },
  },
};
const TEMPLATE = `aws ec2 create-launch-template --launch-template-name web-template --launch-template-data '{"ImageId": "ami-0abcdef1234567890", "InstanceType": "t3.micro"}'`;
const TG = `aws elbv2 create-target-group --name web-tg --protocol HTTP --port 80 --vpc-id ${VPC} --health-check-path /health`;
const ALB = "aws elbv2 create-load-balancer --name web-alb --subnets subnet-0a subnet-0b";
const arnOf = (text: string, key: string) => new RegExp(`"${key}": "([^"]+)"`).exec(text)![1];

/** Template, target group, ALB and listener; returns the state and the ARNs. */
function frontEnd() {
  const t = sh(createLabState(SEED), TEMPLATE, TG);
  const tgArn = arnOf(t.text, "TargetGroupArn");
  const lb = sh(t.state, ALB);
  const lbArn = arnOf(lb.text, "LoadBalancerArn");
  const l = sh(lb.state, `aws elbv2 create-listener --load-balancer-arn ${lbArn} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tgArn}`);
  return { state: l.state, tgArn, lbArn, listener: l.text };
}
const ASG = (tgArn: string, extra = "") =>
  `aws autoscaling create-auto-scaling-group --auto-scaling-group-name web-asg --launch-template LaunchTemplateName=web-template --min-size 2 --max-size 4 --desired-capacity 2 --vpc-zone-identifier "subnet-0a,subnet-0b" --target-group-arns ${tgArn} --health-check-type ELB --health-check-grace-period 300${extra}`;
const asgInstances = (state: LabState) => JSON.parse(sh(state, "aws autoscaling describe-auto-scaling-groups").text).AutoScalingGroups[0].Instances.map((i: any) => i.InstanceId);

describe("aws launch templates, target groups and load balancers", () => {
  it("creates a launch template from JSON data", () => {
    const r = sh(createLabState(), TEMPLATE);
    expect(JSON.parse(r.text).LaunchTemplate).toMatchObject({ LaunchTemplateName: "web-template", DefaultVersionNumber: 1 });
    expect(cloud(r.state).aws.ec2.launchTemplates).toEqual({ "web-template": { imageId: "ami-0abcdef1234567890", instanceType: "t3.micro" } });
    expect(sh(r.state, TEMPLATE).error).toMatch(/AlreadyExistsException/);
    expect(sh(createLabState(), `aws ec2 create-launch-template --launch-template-name t1x --launch-template-data '{"InstanceType": "t3.micro"}'`).error).toMatch(/ImageId/);
    expect(sh(createLabState(), "aws ec2 create-launch-template --launch-template-name t1x --launch-template-data {bad").error).toMatch(/Invalid JSON/);
    expect(JSON.parse(sh(r.state, "aws ec2 describe-launch-templates").text).LaunchTemplates).toHaveLength(1);
  });

  it("creates a target group with ALB health check defaults", () => {
    const r = sh(createLabState(SEED), TG);
    const tg = JSON.parse(r.text).TargetGroups[0];
    expect(tg).toMatchObject({ TargetGroupName: "web-tg", Protocol: "HTTP", Port: 80, HealthCheckPath: "/health", HealthCheckIntervalSeconds: 30, HealthyThresholdCount: 5, UnhealthyThresholdCount: 2, Matcher: { HttpCode: "200" } });
    expect(tg.TargetGroupArn).toMatch(/^arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup\/web-tg\/[0-9a-f]{16}$/);
    expect(sh(r.state, TG).error).toMatch(/DuplicateTargetGroupName/);
    expect(sh(createLabState(SEED), TG.replace("--protocol HTTP", "--protocol TCP")).error).toMatch(/只支援 HTTP 和 HTTPS/);
    expect(sh(createLabState(SEED), TG.replace(VPC, "vpc-0nope")).error).toMatch(/is not found/);
    expect(sh(createLabState(SEED), TG.replace("/health", "health")).error).toMatch(/must begin with a '\/'/);
    expect(sh(createLabState(SEED), TG.replace("web-tg", "-bad-")).error).toMatch(/不符合規則/);
  });

  it("needs two availability zones for an ALB", () => {
    const r = sh(createLabState(SEED), ALB);
    const lb = JSON.parse(r.text).LoadBalancers[0];
    expect(lb).toMatchObject({ LoadBalancerName: "web-alb", Type: "application", Scheme: "internet-facing", State: { Code: "provisioning" } });
    expect(lb.DNSName).toMatch(/^web-alb-\d+\.us-east-1\.elb\.amazonaws\.com$/);
    expect(cloud(r.state).aws.elbv2.loadBalancers["web-alb"]).toEqual({ scheme: "internet-facing", availabilityZones: { "us-east-1a": true, "us-east-1b": true }, listeners: {} });
    expect(sh(createLabState(SEED), "aws elbv2 create-load-balancer --name one --subnets subnet-0a").error).toMatch(/two different Availability Zones/);
    expect(sh(createLabState(SEED), "aws elbv2 create-load-balancer --name same --subnets subnet-0a subnet-0c").error).toMatch(/two different Availability Zones/);
    expect(sh(createLabState(SEED), "aws elbv2 create-load-balancer --name x1 --subnets subnet-0a subnet-0zzz").error).toMatch(/SubnetNotFound/);
    expect(sh(createLabState(SEED), "aws elbv2 create-load-balancer --name nlb --type network --subnets subnet-0a subnet-0b").error).toMatch(/只支援 Application Load Balancer/);
    expect(JSON.parse(sh(r.state, "aws elbv2 describe-load-balancers").text).LoadBalancers[0].State.Code).toBe("active");
  });

  it("creates listeners that forward to a target group", () => {
    const { state, tgArn, lbArn, listener } = frontEnd();
    expect(JSON.parse(listener).Listeners[0]).toMatchObject({ Port: 80, Protocol: "HTTP", DefaultActions: [{ Type: "forward", TargetGroupArn: tgArn }] });
    expect(cloud(state).aws.elbv2.loadBalancers["web-alb"].listeners).toEqual({ "HTTP:80": "web-tg" });
    const again = `aws elbv2 create-listener --load-balancer-arn ${lbArn} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tgArn}`;
    expect(sh(state, again).error).toMatch(/DuplicateListener/);
    expect(sh(state, again.replace("HTTP --port 80", "HTTPS --port 443")).error).toMatch(/certificate must be specified/);
    expect(sh(state, again.replace("--port 80", "--port 8080").replace("Type=forward", "Type=redirect")).error).toMatch(/Type=forward/);
    expect(sh(state, again.replace(lbArn, "arn:nope")).error).toMatch(/LoadBalancerNotFound/);
    expect(sh(state, `aws elbv2 delete-target-group --target-group-arn ${tgArn}`).error).toMatch(/ResourceInUse/);
    expect(JSON.parse(sh(state, `aws elbv2 describe-listeners --load-balancer-arn ${lbArn}`).text).Listeners).toHaveLength(1);
  });

  it("reports target health: unused without a listener, healthy while running", () => {
    const base = sh(createLabState(SEED), "aws ec2 run-instances --image-id ami-0abcdef1234567890 --instance-type t3.micro", TG);
    const tgArn = arnOf(base.text, "TargetGroupArn");
    const instance = Object.keys(cloud(base.state).aws.ec2.instances)[0];
    let s = sh(base.state, `aws elbv2 register-targets --target-group-arn ${tgArn} --targets Id=${instance}`).state;
    expect(JSON.parse(sh(s, `aws elbv2 describe-target-health --target-group-arn ${tgArn}`).text).TargetHealthDescriptions[0].TargetHealth).toMatchObject({ State: "unused", Reason: "Target.NotInUse" });
    const lbArn = arnOf(sh(s, ALB).text, "LoadBalancerArn");
    s = sh(s, ALB, `aws elbv2 create-listener --load-balancer-arn ${lbArn} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tgArn}`).state;
    expect(cloud(s).aws.elbv2.targetGroups["web-tg"]).toMatchObject({ targets: { [instance]: "healthy" }, healthyTargets: 1 });
    s = sh(s, `aws ec2 stop-instances --instance-ids ${instance}`).state;
    expect(cloud(s).aws.elbv2.targetGroups["web-tg"].targets[instance]).toBe("unhealthy");
    expect(cloud(sh(s, `aws elbv2 deregister-targets --target-group-arn ${tgArn} --targets Id=${instance}`).state).aws.elbv2.targetGroups["web-tg"].targets).toEqual({});
    expect(sh(s, `aws elbv2 register-targets --target-group-arn ${tgArn} --targets Id=i-0nope`).error).toMatch(/InvalidTarget/);
  });
});

describe("aws autoscaling", () => {
  it("launches the desired capacity across zones and registers it with the target group", () => {
    const { state, tgArn } = frontEnd();
    const s = sh(state, ASG(tgArn)).state;
    const view = cloud(s).aws;
    expect(view.autoscaling.groups["web-asg"]).toMatchObject({ launchTemplate: "web-template", min: 2, max: 4, desired: 2, inService: 2, healthCheckType: "ELB", replacedInstances: 0 });
    expect(view.elbv2.targetGroups["web-tg"].healthyTargets).toBe(2);
    expect(view.ec2.counts.running).toBe(2);
    const group = JSON.parse(sh(s, "aws autoscaling describe-auto-scaling-groups").text).AutoScalingGroups[0];
    expect(group.Instances.map((i: any) => i.AvailabilityZone).sort()).toEqual(["us-east-1a", "us-east-1b"]);
    expect(group).toMatchObject({ HealthCheckGracePeriod: 300, VPCZoneIdentifier: "subnet-0a,subnet-0b" });
  });

  it("validates sizes, templates, subnets and target groups", () => {
    const { state, tgArn } = frontEnd();
    expect(sh(state, ASG(tgArn).replace("--desired-capacity 2", "--desired-capacity 9")).error).toMatch(/Desired capacity:9 must be between/);
    expect(sh(state, ASG(tgArn).replace("--min-size 2", "--min-size 5")).error).toMatch(/Max bound, 4, must be greater than or equal to min bound, 5/);
    expect(sh(state, ASG(tgArn).replace("web-template", "nope")).error).toMatch(/launch template does not exist/);
    expect(sh(state, ASG(tgArn).replace("subnet-0a,", "subnet-0z,")).error).toMatch(/subnet-0z/);
    expect(sh(state, ASG("arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/x/0")).error).toMatch(/Target Groups may not be valid/);
    expect(sh(state, ASG(tgArn), ASG(tgArn)).error).toMatch(/AlreadyExists/);
    // Without --desired-capacity the group starts at its minimum.
    expect(cloud(sh(state, ASG(tgArn).replace(" --desired-capacity 2", "")).state).aws.autoscaling.groups["web-asg"].desired).toBe(2);
  });

  it("replaces instances that are terminated or stopped outside the group", () => {
    const { state, tgArn } = frontEnd();
    let s = sh(state, ASG(tgArn)).state;
    const [first, second] = asgInstances(s);
    s = sh(s, `aws ec2 terminate-instances --instance-ids ${first}`).state;
    const after = asgInstances(s);
    expect(after).toHaveLength(2);
    expect(after).not.toContain(first);
    expect(cloud(s).aws.autoscaling.groups["web-asg"].replacedInstances).toBe(1);
    expect(cloud(s).aws.elbv2.targetGroups["web-tg"].healthyTargets).toBe(2);
    s = sh(s, `aws ec2 stop-instances --instance-ids ${second}`).state;
    expect(asgInstances(s)).not.toContain(second);
    expect(cloud(s).aws.autoscaling.groups["web-asg"].replacedInstances).toBe(2);
    expect(cloud(s).aws.ec2.counts).toMatchObject({ running: 2, stopped: 0, terminated: 2 });
  });

  it("changes capacity within the limits", () => {
    const { state, tgArn } = frontEnd();
    let s = sh(state, ASG(tgArn), "aws autoscaling set-desired-capacity --auto-scaling-group-name web-asg --desired-capacity 4").state;
    expect(cloud(s).aws.autoscaling.groups["web-asg"].inService).toBe(4);
    expect(sh(s, "aws autoscaling set-desired-capacity --auto-scaling-group-name web-asg --desired-capacity 5").error).toMatch(/must be between/);
    s = sh(s, "aws autoscaling update-auto-scaling-group --auto-scaling-group-name web-asg --max-size 3").state;
    expect(cloud(s).aws.autoscaling.groups["web-asg"]).toMatchObject({ max: 3, desired: 3, inService: 3 });
    expect(sh(s, "aws autoscaling update-auto-scaling-group --auto-scaling-group-name nope --max-size 3").error).toMatch(/not found/);
  });

  it("adds target tracking policies", () => {
    const { state, tgArn } = frontEnd();
    const s = sh(state, ASG(tgArn)).state;
    const put = (config: string, extra = "") => sh(s, `aws autoscaling put-scaling-policy --auto-scaling-group-name web-asg --policy-name cpu50 --policy-type TargetTrackingScaling --target-tracking-configuration '${config}'${extra}`);
    const r = put('{"PredefinedMetricSpecification": {"PredefinedMetricType": "ASGAverageCPUUtilization"}, "TargetValue": 50.0}');
    expect(JSON.parse(r.text).Alarms).toHaveLength(2);
    expect(cloud(r.state).aws.autoscaling.groups["web-asg"].policies).toEqual({ cpu50: { metric: "ASGAverageCPUUtilization", target: 50 } });
    expect(JSON.parse(sh(r.state, "aws autoscaling describe-policies").text).ScalingPolicies[0].PolicyType).toBe("TargetTrackingScaling");
    expect(put('{"PredefinedMetricSpecification": {"PredefinedMetricType": "MemoryUtilization"}, "TargetValue": 50}').error).toMatch(/預先定義指標/);
    expect(put('{"PredefinedMetricSpecification": {"PredefinedMetricType": "ASGAverageCPUUtilization"}, "TargetValue": 150}').error).toMatch(/0 到 100/);
    expect(sh(s, "aws autoscaling put-scaling-policy --auto-scaling-group-name web-asg --policy-name p --policy-type SimpleScaling").error).toMatch(/只支援目標追蹤/);
  });

  it("deletes a group only when empty or forced", () => {
    const { state, tgArn } = frontEnd();
    const s = sh(state, ASG(tgArn)).state;
    expect(sh(s, "aws autoscaling delete-auto-scaling-group --auto-scaling-group-name web-asg").error).toMatch(/ResourceInUse/);
    const gone = sh(s, "aws autoscaling delete-auto-scaling-group --auto-scaling-group-name web-asg --force-delete").state;
    expect(cloud(gone).aws.autoscaling.groups).toEqual({});
    expect(cloud(gone).aws.ec2.counts.running).toBe(0);
    expect(cloud(gone).aws.elbv2.targetGroups["web-tg"].targets).toEqual({});
  });
});

// ------------------------------------------------------------------- GCP

const MIG = ["gcloud compute instance-templates create web-template --machine-type=e2-small --tags=http-server", "gcloud compute instance-groups managed create web-mig --template=web-template --size=2 --zone=asia-east1-b"];
const BACKEND = [
  "gcloud compute health-checks create http web-hc --port=80",
  "gcloud compute backend-services create web-backend --protocol=HTTP --port-name=http --health-checks=web-hc --load-balancing-scheme=EXTERNAL_MANAGED --global",
  "gcloud compute backend-services add-backend web-backend --instance-group=web-mig --instance-group-zone=asia-east1-b --global",
];
const FIREWALL = "gcloud compute firewall-rules create allow-health-check --allow=tcp:80 --source-ranges=35.191.0.0/16 --target-tags=http-server";
const FRONT = [
  "gcloud compute url-maps create web-map --default-service=web-backend",
  "gcloud compute target-http-proxies create web-proxy --url-map=web-map",
  "gcloud compute forwarding-rules create web-rule --load-balancing-scheme=EXTERNAL_MANAGED --global --target-http-proxy=web-proxy --ports=80",
];
const migVms = (state: LabState) => Object.keys(cloud(state).gcp.instances).filter((n) => n.startsWith("web-mig-"));

describe("gcloud managed instance groups", () => {
  it("creates VMs from the template and keeps the target size", () => {
    const s = sh(createLabState(), ...MIG).state;
    const vms = migVms(s);
    expect(vms).toHaveLength(2);
    expect(cloud(s).gcp.instances[vms[0]]).toMatchObject({ zone: "asia-east1-b", machineType: "e2-small", status: "RUNNING", tags: { "http-server": true } });
    expect(cloud(s).gcp.migs["web-mig"]).toMatchObject({ template: "web-template", targetSize: 2, size: 2, autoscaler: null, recreated: 0 });
    expect(sh(s, "gcloud compute instance-groups managed list").out[1]).toMatch(/^web-mig\s+asia-east1-b\s+zone\s+web-template\s+2\s+2\s+no$/);
    expect(sh(s, "gcloud compute instance-groups managed list-instances web-mig --zone=asia-east1-b").out).toHaveLength(3);
    expect(migVms(sh(s, "gcloud compute instance-groups managed resize web-mig --size=3 --zone=asia-east1-b").state)).toHaveLength(3);
    expect(sh(createLabState(), "gcloud compute instance-groups managed create g --template=nope --size=1 --zone=asia-east1-b").error).toMatch(/instanceTemplates\/nope' was not found/);
    expect(sh(createLabState(), MIG[0], "gcloud compute instance-groups managed create g --template=web-template --size=1").error).toMatch(/請加上 --zone/);
  });

  it("recreates a deleted or stopped VM with the same name", () => {
    let s = sh(createLabState(), ...MIG).state;
    const [vm] = migVms(s);
    s = sh(s, `gcloud compute instances delete ${vm} --zone=asia-east1-b`).state;
    expect(migVms(s)).toContain(vm);
    expect(cloud(s).gcp.instances[vm].status).toBe("RUNNING");
    expect(cloud(s).gcp.migs["web-mig"].recreated).toBe(1);
    s = sh(s, `gcloud compute instances stop ${vm} --zone=asia-east1-b`).state;
    expect(cloud(s).gcp.instances[vm].status).toBe("RUNNING");
    expect(cloud(s).gcp.migs["web-mig"].recreated).toBe(2);
    // Instances outside a group are left alone.
    const plain = sh(createLabState(), "gcloud compute instances create solo --zone=asia-east1-b", "gcloud compute instances stop solo --zone=asia-east1-b").state;
    expect(cloud(plain).gcp.instances.solo.status).toBe("TERMINATED");
  });

  it("configures autoscaling and named ports", () => {
    let s = sh(createLabState(), ...MIG, "gcloud compute instance-groups managed set-autoscaling web-mig --zone=asia-east1-b --min-num-replicas=3 --max-num-replicas=5 --target-cpu-utilization=0.6").state;
    expect(cloud(s).gcp.migs["web-mig"]).toMatchObject({ autoscaler: { min: 3, max: 5, cpu: 0.6 }, targetSize: 3, size: 3 });
    expect(sh(s, "gcloud compute instance-groups managed resize web-mig --size=4 --zone=asia-east1-b").error).toMatch(/自動調度/);
    expect(sh(s, "gcloud compute instance-groups managed set-autoscaling web-mig --zone=asia-east1-b --max-num-replicas=5 --target-cpu-utilization=60").error).toMatch(/0\.0 到 1\.0/);
    expect(sh(s, "gcloud compute instance-groups managed set-autoscaling web-mig --zone=asia-east1-b").error).toMatch(/--max-num-replicas/);
    s = sh(s, "gcloud compute instance-groups set-named-ports web-mig --named-ports=http:80,admin:8080 --zone=asia-east1-b").state;
    expect(cloud(s).gcp.migs["web-mig"].namedPorts).toEqual({ http: 80, admin: 8080 });
    expect(sh(s, "gcloud compute instance-groups managed set-named-ports web-mig --named-ports=http --zone=asia-east1-b").error).toMatch(/名稱:連接埠/);
    expect(sh(s, "gcloud compute instance-groups managed describe web-mig --zone=asia-east1-b").text).toMatch(/maxNumReplicas: 5[\s\S]*namedPorts:\n- name: http\n {2}port: 80/);
  });
});

describe("gcloud load balancer chain", () => {
  it("marks backends unhealthy until a firewall rule lets the health check probes in", () => {
    let s = sh(createLabState(), ...MIG, ...BACKEND).state;
    expect(cloud(s).gcp.backendServices["web-backend"]).toMatchObject({ portName: "http", healthCheck: "web-hc", scheme: "EXTERNAL_MANAGED", backends: { "web-mig": true }, healthyInstances: 0 });
    expect(sh(s, "gcloud compute backend-services get-health web-backend --global").text).toMatch(/healthState: UNHEALTHY/);
    // A rule that does not cover the probe range, port or tags does not help.
    for (const rule of [
      "gcloud compute firewall-rules create r1 --allow=tcp:80 --source-ranges=203.0.113.0/24",
      "gcloud compute firewall-rules create r2 --allow=tcp:443 --source-ranges=35.191.0.0/16",
      "gcloud compute firewall-rules create r3 --allow=tcp:80 --source-ranges=35.191.0.0/16 --target-tags=db",
    ]) {
      expect(cloud(sh(s, rule).state).gcp.backendServices["web-backend"].healthyInstances).toBe(0);
    }
    expect(cloud(sh(s, "gcloud compute firewall-rules create wide --allow=tcp --source-ranges=0.0.0.0/0").state).gcp.backendServices["web-backend"].healthyInstances).toBe(2);
    s = sh(s, FIREWALL).state;
    expect(cloud(s).gcp.backendServices["web-backend"].healthyInstances).toBe(2);
    expect(sh(s, "gcloud compute backend-services get-health web-backend --global").text).not.toMatch(/UNHEALTHY/);
  });

  it("serves only when the chain is complete, a backend is healthy and the named port exists", () => {
    const noPort = sh(createLabState(), ...MIG, ...BACKEND, FIREWALL, ...FRONT);
    expect(cloud(noPort.state).gcp.forwardingRules["web-rule"]).toMatchObject({ backendService: "web-backend", serving: false, port: 80 });
    const s = sh(noPort.state, "gcloud compute instance-groups managed set-named-ports web-mig --named-ports=http:80 --zone=asia-east1-b").state;
    expect(cloud(s).gcp.forwardingRules["web-rule"].serving).toBe(true);
    expect(sh(s, "gcloud compute forwarding-rules describe web-rule --global").text).toMatch(/^IPAddress: 34\.120\.\d+\.\d+/);
    expect(sh(s, "gcloud compute forwarding-rules list").out[1]).toMatch(/^web-rule\s+34\.120/);
  });

  it("validates each piece and blocks deleting resources in use", () => {
    const s = sh(createLabState(), ...MIG, ...BACKEND, FIREWALL, ...FRONT).state;
    expect(sh(createLabState(), "gcloud compute health-checks create tcp x").error).toMatch(/只支援 gcloud compute health-checks create http/);
    expect(sh(createLabState(), "gcloud compute backend-services create b --health-checks=nope --global").error).toMatch(/healthChecks\/nope' was not found/);
    expect(sh(s, "gcloud compute backend-services create b2 --health-checks=web-hc").error).toMatch(/--global/);
    expect(sh(s, "gcloud compute backend-services add-backend web-backend --instance-group=web-mig --instance-group-zone=asia-east1-b --global").error).toMatch(/already exists/);
    expect(sh(s, "gcloud compute url-maps create m2 --default-service=nope").error).toMatch(/backendServices\/nope' was not found/);
    expect(sh(s, "gcloud compute forwarding-rules create r2 --global --target-http-proxy=web-proxy").error).toMatch(/--ports/);
    expect(sh(s, "gcloud compute backend-services delete web-backend --global").error).toMatch(/already being used by 'urlMaps\/web-map'/);
    expect(sh(s, "gcloud compute url-maps delete web-map").error).toMatch(/already being used by 'targetHttpProxies\/web-proxy'/);
    expect(sh(s, "gcloud compute target-http-proxies delete web-proxy").error).toMatch(/already being used by 'forwardingRules\/web-rule'/);
    expect(sh(s, "gcloud compute health-checks delete web-hc").error).toMatch(/already being used by 'backendServices\/web-backend'/);
    expect(sh(s, "gcloud compute instance-groups managed delete web-mig --zone=asia-east1-b").error).toMatch(/already being used by 'backendServices\/web-backend'/);
    expect(sh(s, "gcloud compute instance-templates delete web-template").error).toMatch(/already being used by 'web-mig'/);
    const torn = sh(s, "gcloud compute forwarding-rules delete web-rule --global", "gcloud compute target-http-proxies delete web-proxy", "gcloud compute url-maps delete web-map", "gcloud compute backend-services delete web-backend --global", "gcloud compute instance-groups managed delete web-mig --zone=asia-east1-b");
    expect(torn.error).toBe("");
    expect(migVms(torn.state)).toEqual([]);
  });
});

// ------------------------------------------------------------- the labs

describe("load balancing labs can be completed", () => {
  const labs = new Map([...loadContent().units.values()].flatMap((u) => u.labs).map((l) => [l.id, l]));

  function play(labId: string, groups: (string | ((outputs: string, state: LabState) => string))[][]): number[] {
    const lab = labs.get(labId)!;
    let state = createLabState(lab.initialState);
    let done = advance(0, state, lab.steps);
    let outputs = "";
    return groups.map((commands) => {
      for (const c of commands) {
        const result = execute(state, typeof c === "string" ? c : c(outputs, state));
        state = result.state;
        outputs += `${result.lines.map((l) => l.text).join("\n")}\n`;
        done = advance(done, state, lab.steps);
      }
      return done;
    });
  }
  const first = (o: string, key: string) => new RegExp(`"${key}": "([^"]+)"`).exec(o)![1];
  const A = "subnet-0a1b2c3d4e5f60718";
  const B = "subnet-0b2c3d4e5f6071829";

  it("aws-alb-auto-scaling", () => {
    expect(
      play("aws-alb-auto-scaling", [
        [TEMPLATE],
        ["aws ec2 describe-vpcs", (o) => `aws elbv2 create-target-group --name web-tg --protocol HTTP --port 80 --vpc-id ${first(o, "VpcId")} --health-check-path /health`],
        [`aws elbv2 create-load-balancer --name web-alb --subnets ${A}`, `aws elbv2 create-load-balancer --name web-alb --subnets ${A} ${B}`],
        [(o) => `aws elbv2 create-listener --load-balancer-arn ${first(o, "LoadBalancerArn")} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${first(o, "TargetGroupArn")}`],
        [
          (o) =>
            `aws autoscaling create-auto-scaling-group --auto-scaling-group-name web-asg --launch-template LaunchTemplateName=web-template --min-size 2 --max-size 4 --desired-capacity 2 --vpc-zone-identifier "${A},${B}" --target-group-arns ${first(o, "TargetGroupArn")} --health-check-type ELB --health-check-grace-period 300`,
          (o) => `aws elbv2 describe-target-health --target-group-arn ${first(o, "TargetGroupArn")}`,
        ],
        [`aws autoscaling put-scaling-policy --auto-scaling-group-name web-asg --policy-name cpu50 --policy-type TargetTrackingScaling --target-tracking-configuration '{"PredefinedMetricSpecification": {"PredefinedMetricType": "ASGAverageCPUUtilization"}, "TargetValue": 50.0}'`],
        ["aws autoscaling describe-auto-scaling-groups", (_o, s) => `aws ec2 terminate-instances --instance-ids ${asgInstances(s)[0]}`, "aws autoscaling describe-auto-scaling-groups"],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("aws-alb-auto-scaling: a group without the target group never gets healthy targets", () => {
    expect(
      play("aws-alb-auto-scaling", [
        [TEMPLATE, `aws elbv2 create-target-group --name web-tg --protocol HTTP --port 80 --vpc-id vpc-0f3c2a1b9d8e7c6b5 --health-check-path /health`, `aws elbv2 create-load-balancer --name web-alb --subnets ${A} ${B}`],
        [(o) => `aws elbv2 create-listener --load-balancer-arn ${first(o, "LoadBalancerArn")} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${first(o, "TargetGroupArn")}`],
        [`aws autoscaling create-auto-scaling-group --auto-scaling-group-name web-asg --launch-template LaunchTemplateName=web-template --min-size 2 --max-size 4 --vpc-zone-identifier "${A},${B}"`],
      ]),
    ).toEqual([3, 4, 4]);
  });

  it("gcp-load-balancer-mig", () => {
    expect(
      play("gcp-load-balancer-mig", [
        [MIG[0]],
        [MIG[1], "gcloud compute instances list", "gcloud compute instance-groups managed set-named-ports web-mig --named-ports=http:80 --zone=asia-east1-b"],
        ["gcloud compute instance-groups managed set-autoscaling web-mig --zone=asia-east1-b --min-num-replicas=2 --max-num-replicas=5 --target-cpu-utilization=0.6"],
        [...BACKEND, "gcloud compute backend-services get-health web-backend --global", FIREWALL],
        [...FRONT, "gcloud compute forwarding-rules describe web-rule --global"],
        [(_o, s) => `gcloud compute instances delete ${migVms(s)[0]} --zone=asia-east1-b`, "gcloud compute instance-groups managed list-instances web-mig --zone=asia-east1-b"],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gcp-load-balancer-mig: without the firewall rule the backends stay unhealthy", () => {
    expect(
      play("gcp-load-balancer-mig", [
        [MIG[0], MIG[1], "gcloud compute instance-groups managed set-named-ports web-mig --named-ports=http:80 --zone=asia-east1-b"],
        ["gcloud compute instance-groups managed set-autoscaling web-mig --zone=asia-east1-b --min-num-replicas=2 --max-num-replicas=5 --target-cpu-utilization=0.6"],
        [...BACKEND, ...FRONT],
        [FIREWALL],
      ]),
    ).toEqual([2, 3, 3, 5]);
  });
});
