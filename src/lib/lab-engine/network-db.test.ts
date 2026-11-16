import { describe, expect, it } from "vitest";
import { loadContent } from "@/lib/content/loader";
import { advance } from "./check";
import { cidrContains, cidrOverlaps, formatCidr, parseCidr } from "./cidr";
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
const field = (output: string, name: string) => new RegExp(`"${name}": "([^"]+)"`).exec(output)![1];

describe("cidr", () => {
  it("parses, normalises and compares ranges", () => {
    expect(formatCidr(parseCidr("10.0.1.5/24")!)).toBe("10.0.1.0/24");
    expect(parseCidr("10.0.1.5/24")!.canonical).toBe(false);
    expect(parseCidr("10.0.1.0/24")!.canonical).toBe(true);
    expect(parseCidr("10.0.300.0/24")).toBeNull();
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0.0")).toBeNull();
    expect(cidrContains(parseCidr("10.0.0.0/16")!, parseCidr("10.0.255.0/24")!)).toBe(true);
    expect(cidrContains(parseCidr("10.0.0.0/16")!, parseCidr("10.1.0.0/24")!)).toBe(false);
    expect(cidrOverlaps(parseCidr("10.0.0.0/23")!, parseCidr("10.0.1.0/24")!)).toBe(true);
    expect(cidrOverlaps(parseCidr("10.0.0.0/24")!, parseCidr("10.0.1.0/24")!)).toBe(false);
    expect(formatCidr(parseCidr("200.100.50.25/32")!)).toBe("200.100.50.25/32");
  });
});

// ------------------------------------------------------------------ AWS VPC

/** A VPC with one subnet; returns the ids it printed. */
function vpcWithSubnet(az = "us-east-1a") {
  const v = sh(createLabState(), "aws ec2 create-vpc --cidr-block 10.0.0.0/16");
  const vpcId = field(v.text, "VpcId");
  const s = sh(v.state, `aws ec2 create-subnet --vpc-id ${vpcId} --cidr-block 10.0.1.0/24 --availability-zone ${az}`);
  return { state: s.state, vpcId, subnetId: field(s.text, "SubnetId"), subnetOutput: s.text };
}

describe("aws ec2 vpc", () => {
  it("creates a VPC with a main route table holding the local route", () => {
    const r = sh(createLabState(), "aws ec2 create-vpc --cidr-block 10.0.0.0/16");
    expect(JSON.parse(r.text).Vpc).toMatchObject({ CidrBlock: "10.0.0.0/16", State: "pending", IsDefault: false });
    const vpcId = field(r.text, "VpcId");
    expect(vpcId).toMatch(/^vpc-0[0-9a-f]{16}$/);
    const tables = JSON.parse(sh(r.state, "aws ec2 describe-route-tables").text).RouteTables;
    expect(tables).toHaveLength(1);
    expect(tables[0].Associations[0].Main).toBe(true);
    expect(tables[0].Routes).toEqual([{ DestinationCidrBlock: "10.0.0.0/16", GatewayId: "local", State: "active" }]);
    expect(cloud(r.state).aws.vpcs["10.0.0.0/16"]).toEqual({ id: vpcId, internetGateway: false, internetRoute: false, publicSubnets: {}, subnets: {} });
  });

  it("only accepts VPC sizes from /16 to /28 and normalises the block", () => {
    expect(sh(createLabState(), "aws ec2 create-vpc --cidr-block 10.0.0.0/8").error).toMatch(/InvalidVpc\.Range/);
    expect(sh(createLabState(), "aws ec2 create-vpc --cidr-block 10.0.0.0/29").error).toMatch(/InvalidVpc\.Range/);
    expect(sh(createLabState(), "aws ec2 create-vpc --cidr-block banana").error).toMatch(/InvalidVpc\.Range/);
    expect(sh(createLabState(), "aws ec2 create-vpc").error).toMatch(/required: --cidr-block/);
    expect(JSON.parse(sh(createLabState(), "aws ec2 create-vpc --cidr-block 10.1.2.3/16").text).Vpc.CidrBlock).toBe("10.1.0.0/16");
  });

  it("creates subnets inside the VPC range, counting five reserved addresses", () => {
    const { state, subnetOutput, vpcId } = vpcWithSubnet();
    expect(JSON.parse(subnetOutput).Subnet).toMatchObject({ CidrBlock: "10.0.1.0/24", AvailabilityZone: "us-east-1a", AvailableIpAddressCount: 251, MapPublicIpOnLaunch: false });
    const sub = (cidr: string, extra = "") => sh(state, `aws ec2 create-subnet --vpc-id ${vpcId} --cidr-block ${cidr}${extra}`);
    expect(sub("10.1.0.0/24").error).toMatch(/InvalidSubnet\.Range/);
    expect(sub("10.0.1.128/25").error).toMatch(/InvalidSubnet\.Conflict/);
    expect(sub("10.0.0.0/30").error).toMatch(/InvalidSubnet\.Range/);
    expect(sub("10.0.2.0/24", " --availability-zone tokyo").error).toMatch(/availabilityZone is invalid/);
    expect(JSON.parse(sub("10.0.2.0/28").text).Subnet.AvailableIpAddressCount).toBe(11);
    expect(sh(state, "aws ec2 create-subnet --vpc-id vpc-0000000000000000 --cidr-block 10.0.2.0/24").error).toMatch(/InvalidVpcID\.NotFound/);
    expect(JSON.parse(sh(state, `aws ec2 describe-subnets --filters Name=vpc-id,Values=${vpcId}`).text).Subnets).toHaveLength(1);
    expect(JSON.parse(sh(state, "aws ec2 describe-subnets --filters Name=vpc-id,Values=vpc-0other").text).Subnets).toHaveLength(0);
    expect(sh(state, "aws ec2 describe-subnets --filters Name=tag:Name,Values=x").error).toMatch(/只支援 Name=vpc-id/);
  });

  it("makes a subnet public only through a route to an attached internet gateway", () => {
    const { state, vpcId, subnetId } = vpcWithSubnet();
    const igw = sh(state, "aws ec2 create-internet-gateway");
    const igwId = field(igw.text, "InternetGatewayId");
    const rt = sh(igw.state, `aws ec2 create-route-table --vpc-id ${vpcId}`);
    const rtbId = field(rt.text, "RouteTableId");

    // A route to a gateway that is not attached to this VPC is refused.
    expect(sh(rt.state, `aws ec2 create-route --route-table-id ${rtbId} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igwId}`).error).toMatch(/belong to different networks/);
    let s = sh(rt.state, `aws ec2 attach-internet-gateway --internet-gateway-id ${igwId} --vpc-id ${vpcId}`).state;
    expect(cloud(s).aws.vpcs["10.0.0.0/16"].internetGateway).toBe(true);
    s = sh(s, `aws ec2 create-route --route-table-id ${rtbId} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igwId}`).state;
    expect(cloud(s).aws.vpcs["10.0.0.0/16"].internetRoute).toBe(true);
    // Not associated yet: the subnet still uses the main table.
    expect(cloud(s).aws.vpcs["10.0.0.0/16"].subnets["10.0.1.0/24"].public).toBe(false);
    const assoc = sh(s, `aws ec2 associate-route-table --route-table-id ${rtbId} --subnet-id ${subnetId}`);
    expect(JSON.parse(assoc.text).AssociationState.State).toBe("associated");
    s = assoc.state;
    expect(cloud(s).aws.vpcs["10.0.0.0/16"].publicSubnets).toEqual({ "10.0.1.0/24": true });

    // Detaching the gateway leaves a blackhole route and the subnet private again.
    const detached = sh(s, `aws ec2 detach-internet-gateway --internet-gateway-id ${igwId} --vpc-id ${vpcId}`).state;
    expect(cloud(detached).aws.vpcs["10.0.0.0/16"].publicSubnets).toEqual({});
    expect(JSON.parse(sh(detached, `aws ec2 describe-route-tables --route-table-ids ${rtbId}`).text).RouteTables[0].Routes[1].State).toBe("blackhole");

    // Disassociating falls back to the main table.
    const back = sh(s, `aws ec2 disassociate-route-table --association-id ${field(assoc.text, "AssociationId")}`).state;
    expect(cloud(back).aws.vpcs["10.0.0.0/16"].subnets["10.0.1.0/24"].public).toBe(false);
  });

  it("validates gateways, routes and associations", () => {
    const { state, vpcId, subnetId } = vpcWithSubnet();
    const igw = sh(state, "aws ec2 create-internet-gateway", "aws ec2 create-internet-gateway");
    const igws = JSON.parse(sh(igw.state, "aws ec2 describe-internet-gateways").text).InternetGateways.map((g: any) => g.InternetGatewayId);
    let s = sh(igw.state, `aws ec2 attach-internet-gateway --internet-gateway-id ${igws[0]} --vpc-id ${vpcId}`).state;
    expect(sh(s, `aws ec2 attach-internet-gateway --internet-gateway-id ${igws[1]} --vpc-id ${vpcId}`).error).toMatch(/already has an internet gateway/);
    expect(sh(s, `aws ec2 attach-internet-gateway --internet-gateway-id ${igws[0]} --vpc-id ${vpcId}`).error).toMatch(/already attached/);
    expect(sh(s, `aws ec2 attach-internet-gateway --internet-gateway-id igw-0nope --vpc-id ${vpcId}`).error).toMatch(/InvalidInternetGatewayID\.NotFound/);

    const mainId = JSON.parse(sh(s, "aws ec2 describe-route-tables").text).RouteTables[0].RouteTableId;
    expect(sh(s, `aws ec2 delete-route --route-table-id ${mainId} --destination-cidr-block 10.0.0.0/16`).error).toMatch(/cannot remove local route/);
    expect(sh(s, `aws ec2 delete-route --route-table-id ${mainId} --destination-cidr-block 0.0.0.0/0`).error).toMatch(/InvalidRoute\.NotFound/);
    s = sh(s, `aws ec2 create-route --route-table-id ${mainId} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igws[0]}`).state;
    expect(sh(s, `aws ec2 create-route --route-table-id ${mainId} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igws[0]}`).error).toMatch(/RouteAlreadyExists/);
    // A route on the main table makes every unassociated subnet public.
    expect(cloud(s).aws.vpcs["10.0.0.0/16"].subnets["10.0.1.0/24"].public).toBe(true);
    expect(cloud(sh(s, `aws ec2 delete-route --route-table-id ${mainId} --destination-cidr-block 0.0.0.0/0`).state).aws.vpcs["10.0.0.0/16"].publicSubnets).toEqual({});

    const rt = sh(s, `aws ec2 create-route-table --vpc-id ${vpcId}`, `aws ec2 create-route-table --vpc-id ${vpcId}`).state;
    const custom = JSON.parse(sh(rt, "aws ec2 describe-route-tables").text).RouteTables.filter((t: any) => !t.Associations.length).map((t: any) => t.RouteTableId);
    const one = sh(rt, `aws ec2 associate-route-table --route-table-id ${custom[0]} --subnet-id ${subnetId}`).state;
    expect(sh(one, `aws ec2 associate-route-table --route-table-id ${custom[1]} --subnet-id ${subnetId}`).error).toMatch(/Resource\.AlreadyAssociated/);
    expect(sh(one, "aws ec2 create-route --route-table-id rtb-0nope --destination-cidr-block 0.0.0.0/0 --gateway-id x").error).toMatch(/InvalidRouteTableID\.NotFound/);
    expect(sh(one, `aws ec2 modify-subnet-attribute --subnet-id ${subnetId}`).error).toMatch(/map-public-ip-on-launch/);
    expect(cloud(sh(one, `aws ec2 modify-subnet-attribute --subnet-id ${subnetId} --map-public-ip-on-launch`).state).aws.vpcs["10.0.0.0/16"].subnets["10.0.1.0/24"].mapPublicIpOnLaunch).toBe(true);
  });

  it("refuses to delete a VPC that still has resources", () => {
    const { state, vpcId, subnetId } = vpcWithSubnet();
    expect(sh(state, `aws ec2 delete-vpc --vpc-id ${vpcId}`).error).toMatch(/DependencyViolation/);
    const empty = sh(state, `aws ec2 delete-subnet --subnet-id ${subnetId}`, `aws ec2 delete-vpc --vpc-id ${vpcId}`);
    expect(empty.error).toBe("");
    expect(cloud(empty.state).aws.vpcs).toEqual({});
    expect(JSON.parse(sh(empty.state, "aws ec2 describe-route-tables").text).RouteTables).toEqual([]);
  });

  it("keys the check view by CIDR, keeping the oldest VPC when two share a block", () => {
    const s = sh(createLabState(), "aws ec2 create-vpc --cidr-block 10.0.0.0/16", "aws ec2 create-vpc --cidr-block 10.0.0.0/16").state;
    const ids = JSON.parse(sh(s, "aws ec2 describe-vpcs").text).Vpcs.map((v: any) => v.VpcId);
    expect(ids).toHaveLength(2);
    expect(cloud(s).aws.vpcs["10.0.0.0/16"].id).toBe(ids[0]);
  });

  it("seeds VPCs and subnets from the lab's initial state", () => {
    const s = createLabState({
      cloud: { aws: { vpcs: { "vpc-0seed": { cidr: "10.9.0.0/16", subnets: { "subnet-0a": { cidr: "10.9.1.0/24", availabilityZone: "us-east-1b" } } } } } },
    });
    expect(cloud(s).aws.vpcs["10.9.0.0/16"].subnets["10.9.1.0/24"]).toEqual({ id: "subnet-0a", availabilityZone: "us-east-1b", public: false, mapPublicIpOnLaunch: false });
    expect(JSON.parse(sh(s, "aws ec2 describe-route-tables").text).RouteTables[0].VpcId).toBe("vpc-0seed");
  });
});

// ---------------------------------------------------------------- AWS RDS

const RDS_SEED = {
  cloud: {
    aws: {
      vpcs: {
        "vpc-0lab": {
          cidr: "10.0.0.0/16",
          subnets: { "subnet-0a": { cidr: "10.0.1.0/24", availabilityZone: "us-east-1a" }, "subnet-0b": { cidr: "10.0.2.0/24", availabilityZone: "us-east-1b" } },
        },
      },
    },
  },
};
const GROUP = 'aws rds create-db-subnet-group --db-subnet-group-name app-subnets --db-subnet-group-description "App" --subnet-ids subnet-0a subnet-0b';
const CREATE_DB =
  "aws rds create-db-instance --db-instance-identifier app-db --engine mysql --db-instance-class db.t3.micro --allocated-storage 20 --master-username admin --manage-master-user-password --db-subnet-group-name app-subnets";
const withDb = () => sh(createLabState(RDS_SEED), GROUP, CREATE_DB);

describe("aws rds", () => {
  it("creates a subnet group only when it covers two availability zones", () => {
    const s = createLabState(RDS_SEED);
    const ok = sh(s, GROUP);
    expect(JSON.parse(ok.text).DBSubnetGroup).toMatchObject({ DBSubnetGroupName: "app-subnets", VpcId: "vpc-0lab" });
    expect(cloud(ok.state).aws.rds.subnetGroups["app-subnets"].availabilityZones).toEqual({ "us-east-1a": true, "us-east-1b": true });
    expect(sh(s, 'aws rds create-db-subnet-group --db-subnet-group-name one --db-subnet-group-description "x" --subnet-ids subnet-0a').error).toMatch(/DBSubnetGroupDoesNotCoverEnoughAZs/);
    expect(sh(s, 'aws rds create-db-subnet-group --db-subnet-group-name two --db-subnet-group-description "x" --subnet-ids subnet-0a subnet-0zzz').error).toMatch(/InvalidSubnet/);
    expect(sh(s, 'aws rds create-db-subnet-group --db-subnet-group-name default --db-subnet-group-description "x" --subnet-ids subnet-0a subnet-0b').error).toMatch(/不能是 default/);
    expect(sh(ok.state, GROUP).error).toMatch(/DBSubnetGroupAlreadyExists/);
    expect(sh(s, "aws rds create-db-subnet-group --db-subnet-group-name x").error).toMatch(/required: --db-subnet-group-description, --subnet-ids/);
  });

  it("creates a private instance in the subnet group and shows it as available", () => {
    const r = withDb();
    const created = JSON.parse(r.text).DBInstance;
    expect(created).toMatchObject({ DBInstanceIdentifier: "app-db", DBInstanceStatus: "creating", Engine: "mysql", BackupRetentionPeriod: 1, MultiAZ: false, PubliclyAccessible: false });
    expect(created.MasterUserSecret.SecretStatus).toBe("creating");
    const described = JSON.parse(sh(r.state, "aws rds describe-db-instances --db-instance-identifier app-db").text).DBInstances[0];
    expect(described.DBInstanceStatus).toBe("available");
    expect(described.Endpoint.Port).toBe(3306);
    expect(cloud(r.state).aws.rds.instances["app-db"]).toMatchObject({ subnetGroup: "app-subnets", publiclyAccessible: false, readReplicaSource: null });
  });

  it("defaults to publicly accessible without a subnet group, and needs an internet gateway to be public in one", () => {
    const noGroup = sh(createLabState(), "aws rds create-db-instance --db-instance-identifier pub --engine postgres --db-instance-class db.t3.micro --allocated-storage 20 --master-username dbadmin --master-user-password Secret123");
    expect(cloud(noGroup.state).aws.rds.instances.pub).toMatchObject({ publiclyAccessible: true, subnetGroup: "default" });
    expect(sh(createLabState(RDS_SEED), GROUP, `${CREATE_DB} --publicly-accessible`).error).toMatch(/has no internet gateway attached/);
  });

  it("validates create-db-instance arguments", () => {
    const s = sh(createLabState(RDS_SEED), GROUP).state;
    const base = "aws rds create-db-instance --db-instance-class db.t3.micro --allocated-storage 20 --master-username admin";
    expect(sh(s, `${base} --db-instance-identifier 1db --engine mysql --manage-master-user-password`).error).toMatch(/識別碼必須以字母開頭/);
    expect(sh(s, `${base} --db-instance-identifier a--b --engine mysql --manage-master-user-password`).error).toMatch(/識別碼/);
    expect(sh(s, `${base} --db-instance-identifier db --engine aurora-mysql --manage-master-user-password`).error).toMatch(/create-db-cluster/);
    expect(sh(s, `${base} --db-instance-identifier db --engine oracle-ee --manage-master-user-password`).error).toMatch(/支援的引擎/);
    expect(sh(s, `${base} --db-instance-identifier db --engine mysql`).error).toMatch(/--manage-master-user-password/);
    expect(sh(s, `${base} --db-instance-identifier db --engine mysql --master-user-password short`).error).toMatch(/not a valid password/);
    expect(sh(s, `${base} --db-instance-identifier db --engine mysql --master-user-password "has@sign1"`).error).toMatch(/not a valid password/);
    expect(sh(s, `${base} --db-instance-identifier db --engine mysql --master-user-password LongEnough1 --manage-master-user-password`).error).toMatch(/InvalidParameterCombination/);
    expect(sh(s, "aws rds create-db-instance --db-instance-identifier db --engine mysql --db-instance-class db.t3.micro --allocated-storage 10 --master-username admin --manage-master-user-password").error).toMatch(/20 到 65536/);
    expect(sh(s, `${base} --db-instance-identifier db --engine mysql --manage-master-user-password --db-subnet-group-name nope`).error).toMatch(/DBSubnetGroupNotFoundFault/);
    expect(sh(s, `${base} --db-instance-identifier db --engine mysql --manage-master-user-password --backup-retention-period 36`).error).toMatch(/0 到 35/);
    expect(sh(s, "aws rds create-db-instance --db-instance-identifier db --engine mysql").error).toMatch(/required: --db-instance-class/);
    expect(sh(withDb().state, CREATE_DB).error).toMatch(/DBInstanceAlreadyExists/);
  });

  it("applies Multi-AZ immediately only with --apply-immediately", () => {
    const s = withDb().state;
    const pending = sh(s, "aws rds modify-db-instance --db-instance-identifier app-db --multi-az");
    expect(JSON.parse(pending.text).DBInstance.PendingModifiedValues).toEqual({ MultiAZ: true });
    expect(cloud(pending.state).aws.rds.instances["app-db"].multiAZ).toBe(false);
    const now = sh(s, "aws rds modify-db-instance --db-instance-identifier app-db --multi-az --apply-immediately");
    expect(JSON.parse(now.text).DBInstance.DBInstanceStatus).toBe("modifying");
    expect(cloud(now.state).aws.rds.instances["app-db"].multiAZ).toBe(true);
  });

  it("needs automated backups for read replicas, and promotes replicas when the source is deleted", () => {
    const noBackups = sh(createLabState(RDS_SEED), GROUP, `${CREATE_DB} --backup-retention-period 0`).state;
    expect(sh(noBackups, "aws rds create-db-instance-read-replica --db-instance-identifier r1 --source-db-instance-identifier app-db").error).toMatch(/Automated backups are not enabled/);

    const s = sh(withDb().state, "aws rds create-db-instance-read-replica --db-instance-identifier r1 --source-db-instance-identifier app-db").state;
    expect(cloud(s).aws.rds.instances.r1).toMatchObject({ readReplicaSource: "app-db", backupRetentionPeriod: 0 });
    expect(JSON.parse(sh(s, "aws rds describe-db-instances --db-instance-identifier app-db").text).DBInstances[0].ReadReplicaDBInstanceIdentifiers).toEqual(["r1"]);
    expect(sh(s, "aws rds modify-db-instance --db-instance-identifier app-db --backup-retention-period 0").error).toMatch(/source for read replicas/);
    expect(sh(s, "aws rds create-db-instance-read-replica --db-instance-identifier r2 --source-db-instance-identifier nope").error).toMatch(/DBInstanceNotFound/);

    const deleted = sh(s, "aws rds delete-db-instance --db-instance-identifier app-db --skip-final-snapshot").state;
    expect(cloud(deleted).aws.rds.instances.r1.readReplicaSource).toBeNull();
  });

  it("requires a final snapshot decision, keeps snapshots after deletion and honours deletion protection", () => {
    const s = withDb().state;
    expect(sh(s, "aws rds delete-db-instance --db-instance-identifier app-db").error).toMatch(/FinalDBSnapshotIdentifier is required/);
    expect(sh(s, "aws rds delete-db-instance --db-instance-identifier app-db --skip-final-snapshot --final-db-snapshot-identifier x").error).toMatch(/Cannot specify both/);
    const withFinal = sh(s, "aws rds create-db-snapshot --db-instance-identifier app-db --db-snapshot-identifier manual-1", "aws rds delete-db-instance --db-instance-identifier app-db --final-db-snapshot-identifier final-1");
    expect(JSON.parse(withFinal.text).DBInstance.DBInstanceStatus).toBe("deleting");
    expect(Object.keys(cloud(withFinal.state).aws.rds.snapshots)).toEqual(["manual-1", "final-1"]);
    expect(JSON.parse(sh(withFinal.state, "aws rds describe-db-snapshots").text).DBSnapshots).toHaveLength(2);
    expect(sh(s, "aws rds create-db-snapshot --db-instance-identifier app-db --db-snapshot-identifier m", "aws rds create-db-snapshot --db-instance-identifier app-db --db-snapshot-identifier m").error).toMatch(/DBSnapshotAlreadyExists/);

    const replica = sh(s, "aws rds create-db-instance-read-replica --db-instance-identifier r1 --source-db-instance-identifier app-db").state;
    expect(sh(replica, "aws rds delete-db-instance --db-instance-identifier r1 --final-db-snapshot-identifier r1-final").error).toMatch(/--skip-final-snapshot/);

    const protectedDb = sh(s, "aws rds modify-db-instance --db-instance-identifier app-db --deletion-protection").state;
    expect(sh(protectedDb, "aws rds delete-db-instance --db-instance-identifier app-db --skip-final-snapshot").error).toMatch(/Cannot delete protected DB Instance/);
  });

  it("will not delete a subnet group or subnet that a database uses", () => {
    const s = withDb().state;
    expect(sh(s, "aws rds delete-db-subnet-group --db-subnet-group-name app-subnets").error).toMatch(/still using it/);
    expect(sh(s, "aws ec2 delete-subnet --subnet-id subnet-0a").error).toMatch(/DependencyViolation/);
    expect(sh(s, "aws rds describe-db-instances --db-instance-identifier nope").error).toMatch(/DBInstanceNotFound/);
    expect(sh(s, "aws rds start-db-instance").error).toMatch(/不支援的 rds 指令/);
  });
});

// ------------------------------------------------------------ GCP networks

describe("gcloud compute networks", () => {
  const custom = () => sh(createLabState(), "gcloud compute networks create lab-net --subnet-mode=custom", "gcloud compute networks subnets create web --network=lab-net --region=asia-east1 --range=10.10.1.0/24");

  it("starts with the auto mode default network and creates custom ones", () => {
    const listed = sh(createLabState(), "gcloud compute networks list").out;
    expect(listed[1]).toMatch(/^default\s+AUTO\s+REGIONAL$/);
    const r = sh(createLabState(), "gcloud compute networks create lab-net --subnet-mode=custom");
    expect(r.out[0]).toMatch(/^Created \[.*\/global\/networks\/lab-net\]\.$/);
    expect(r.text).toMatch(/firewall-rules create <FIREWALL_NAME> --network lab-net/);
    expect(cloud(r.state).gcp.networks["lab-net"]).toEqual({ mode: "custom", subnets: {}, natRegions: {} });
    expect(cloud(sh(createLabState(), "gcloud compute networks create other").state).gcp.networks.other.mode).toBe("auto");
    expect(sh(r.state, "gcloud compute networks create lab-net").error).toMatch(/already exists/);
    expect(sh(createLabState(), "gcloud compute networks create x --subnet-mode=legacy").error).toMatch(/Invalid choice/);
  });

  it("creates regional subnets and rejects bad or overlapping ranges", () => {
    const r = custom();
    expect(r.out[1]).toMatch(/^NAME\s+REGION\s+NETWORK\s+RANGE$/);
    expect(cloud(r.state).gcp.networks["lab-net"].subnets.web).toEqual({ region: "asia-east1", range: "10.10.1.0/24" });
    const sub = (args: string) => sh(r.state, `gcloud compute networks subnets create ${args}`);
    expect(sub("db --network=lab-net --region=us-central1 --range=10.10.1.128/25").error).toMatch(/conflicts with existing subnetwork 'web'/);
    expect(sub("db --network=lab-net --region=us-central1 --range=10.20.1.0/30").error).toMatch(/\/8 到 \/29/);
    expect(sub("db --network=lab-net --region=us-central1 --range=10.20.1.5/24").error).toMatch(/10\.20\.1\.0\/24/);
    expect(sub("db --network=lab-net --region=us-central1-a --range=10.20.1.0/24").error).toMatch(/區域的格式/);
    expect(sub("db --network=lab-net --range=10.20.1.0/24").error).toMatch(/請加上 --region/);
    expect(sub("db --network=nope --region=us-central1 --range=10.20.1.0/24").error).toMatch(/networks\/nope' was not found/);
    expect(sub("web --network=lab-net --region=asia-east1 --range=10.30.0.0/24").error).toMatch(/already exists/);
    // Names are unique per region, so the same name works in another region.
    expect(sub("web --network=lab-net --region=us-central1 --range=10.30.0.0/24").error).toBe("");
    expect(sh(createLabState(), "gcloud compute networks subnets create x --network=default --region=asia-east1 --range=10.140.0.0/24").error).toMatch(/auto mode range/);
    expect(sh(r.state, "gcloud compute networks subnets list --network=lab-net").out[1]).toMatch(/^web\s+asia-east1\s+lab-net\s+10\.10\.1\.0\/24$/);
    expect(sh(r.state, "gcloud compute networks subnets list").text).toMatch(/auto 模式網路 default/);
  });

  it("places instances by subnet, which must be in the instance's region", () => {
    const s = custom().state;
    const ok = sh(s, "gcloud compute instances create app-1 --zone=asia-east1-b --subnet=web --no-address");
    expect(cloud(ok.state).gcp.instances["app-1"].networkInterface).toEqual({ network: "lab-net", subnet: "web", externalIp: false });
    expect(sh(ok.state, "gcloud compute instances describe app-1").text).toMatch(/networkInterfaces:\n- network: .*\/networks\/lab-net\n {2}subnetwork: .*\/regions\/asia-east1\/subnetworks\/web/);
    expect(sh(s, "gcloud compute instances create app-2 --zone=us-central1-a --subnet=web").error).toMatch(/子網路是區域資源：web 在 asia-east1/);
    expect(sh(s, "gcloud compute instances create app-2 --zone=us-central1-a --network=lab-net").error).toMatch(/在區域 us-central1 沒有子網路/);
    expect(cloud(sh(s, "gcloud compute instances create app-2 --zone=asia-east1-a --network=lab-net").state).gcp.instances["app-2"].networkInterface.subnet).toBe("web");
    expect(sh(s, "gcloud compute instances create app-2 --zone=asia-east1-a --network=default --subnet=web").error).toMatch(/屬於網路 lab-net/);
    expect(sh(s, "gcloud compute instances create app-2 --zone=asia-east1-a --network=ghost").error).toMatch(/networks\/ghost' was not found/);
  });

  it("puts firewall rules on the named network", () => {
    const s = custom().state;
    const r = sh(s, "gcloud compute firewall-rules create ssh --network=lab-net --allow=tcp:22 --source-ranges=203.0.113.0/24");
    expect(cloud(r.state).gcp.firewallRules.ssh.network).toBe("lab-net");
    expect(sh(r.state, "gcloud compute firewall-rules list").out[1]).toMatch(/^ssh\s+lab-net\s+INGRESS\s+tcp:22\s+203\.0\.113\.0\/24$/);
    expect(sh(s, "gcloud compute firewall-rules create x --network=ghost --allow=tcp:22").error).toMatch(/was not found/);
  });

  it("refuses to delete networks and subnets that are in use", () => {
    const s = sh(custom().state, "gcloud compute instances create app-1 --zone=asia-east1-b --subnet=web").state;
    expect(sh(s, "gcloud compute networks subnets delete web --region=asia-east1").error).toMatch(/already being used by 'instances\/app-1'/);
    expect(sh(s, "gcloud compute networks delete lab-net").error).toMatch(/already being used by 'subnetworks\/web'/);
    const empty = sh(s, "gcloud compute instances delete app-1 --zone=asia-east1-b", "gcloud compute networks subnets delete web --region=asia-east1", "gcloud compute networks delete lab-net");
    expect(empty.error).toBe("");
    expect(Object.keys(cloud(empty.state).gcp.networks)).toEqual(["default"]);
  });

  it("creates Cloud NAT on a Cloud Router in the subnet's region", () => {
    const s = sh(custom().state, "gcloud compute routers create nat-router --network=lab-net --region=asia-east1").state;
    expect(sh(s, "gcloud compute routers list").out[1]).toMatch(/^nat-router\s+asia-east1\s+lab-net$/);
    const base = "gcloud compute routers nats create nat-config --router=nat-router --region=asia-east1";
    expect(sh(s, `${base} --nat-all-subnet-ip-ranges`).error).toMatch(/--auto-allocate-nat-external-ips/);
    expect(sh(s, `${base} --auto-allocate-nat-external-ips`).error).toMatch(/--nat-all-subnet-ip-ranges/);
    expect(sh(s, `${base} --auto-allocate-nat-external-ips --nat-custom-subnet-ip-ranges=other`).error).toMatch(/只能服務同一個區域/);
    expect(sh(s, "gcloud compute routers nats create n --router=nat-router --region=us-central1 --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges").error).toMatch(/routers\/nat-router' was not found/);
    const ok = sh(s, `${base} --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges`);
    expect(ok.text).toBe("Creating NAT [nat-config] in router [nat-router]...done.");
    expect(cloud(ok.state).gcp.networks["lab-net"].natRegions).toEqual({ "asia-east1": true });
    expect(cloud(ok.state).gcp.routers["nat-router"].nats).toEqual({ "nat-config": "ALL" });
    expect(sh(ok.state, `${base} --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges`).error).toMatch(/already exists/);
    expect(cloud(sh(ok.state, "gcloud compute routers nats delete nat-config --router=nat-router --region=asia-east1").state).gcp.networks["lab-net"].natRegions).toEqual({});
    const customNat = sh(s, `${base} --auto-allocate-nat-external-ips --nat-custom-subnet-ip-ranges=web`).state;
    expect(cloud(customNat).gcp.routers["nat-router"].nats["nat-config"]).toEqual(["web"]);
  });
});

// --------------------------------------------------------------- Cloud SQL

const SQL_CREATE = "gcloud sql instances create app-db --database-version=POSTGRES_16 --edition=enterprise --cpu=2 --memory=8GiB --region=asia-east1";
const withSql = () => sh(createLabState(), SQL_CREATE);

describe("gcloud sql", () => {
  it("creates an instance with default databases and users", () => {
    const r = withSql();
    expect(r.out[1]).toMatch(/^Created \[https:\/\/sqladmin\.googleapis\.com\/.*\/instances\/app-db\]\.$/);
    expect(r.out[3]).toMatch(/^app-db\s+POSTGRES_16\s+asia-east1\s+db-custom-2-8192\s+RUNNABLE$/);
    expect(cloud(r.state).gcp.sql.instances["app-db"]).toMatchObject({
      edition: "ENTERPRISE",
      tier: "db-custom-2-8192",
      availabilityType: "ZONAL",
      backupsEnabled: true,
      databases: { postgres: true },
      users: { postgres: true },
      backupCount: 0,
    });
    expect(sh(r.state, "gcloud sql instances describe app-db").text).toMatch(/availabilityType: ZONAL[\s\S]*edition: ENTERPRISE/);
    expect(sh(r.state, SQL_CREATE).error).toMatch(/already exists/);
  });

  it("chooses the default edition from the database version and checks machine flags against it", () => {
    expect(sh(createLabState(), "gcloud sql instances create a --database-version=POSTGRES_16 --cpu=2 --memory=8GiB").error).toMatch(/not compatible with the Enterprise Plus edition/);
    expect(sh(createLabState(), "gcloud sql instances create a --database-version=POSTGRES_16").error).toMatch(/Enterprise Plus 版本需要用 --tier/);
    const plus = sh(createLabState(), "gcloud sql instances create a --database-version=POSTGRES_17 --tier=db-perf-optimized-N-2 --region=asia-east1").state;
    expect(cloud(plus).gcp.sql.instances.a.edition).toBe("ENTERPRISE_PLUS");
    // Without --database-version gcloud uses MySQL 8.0, which defaults to Enterprise.
    const mysql = sh(createLabState(), "gcloud sql instances create b --tier=db-f1-micro").state;
    expect(cloud(mysql).gcp.sql.instances.b).toMatchObject({ databaseVersion: "MYSQL_8_0", edition: "ENTERPRISE", region: "us-central", users: { root: true } });
    expect(sh(createLabState(), "gcloud sql instances create b --database-version=MYSQL_8_0").error).toMatch(/需要指定規格/);
    expect(sh(createLabState(), "gcloud sql instances create b --database-version=MYSQL_8_0 --cpu=2").error).toMatch(/Both --cpu and --memory/);
    expect(sh(createLabState(), "gcloud sql instances create b --database-version=MYSQL_8_0 --cpu=1 --memory=16GiB").error).toMatch(/0\.9 GB 到 6\.5 GB/);
    expect(sh(createLabState(), "gcloud sql instances create b --database-version=MYSQL_8_0 --tier=db-perf-optimized-N-2").error).toMatch(/Invalid Tier/);
    expect(sh(createLabState(), "gcloud sql instances create b --database-version=ORACLE_19 --tier=db-f1-micro").error).toMatch(/Invalid choice/);
    expect(sh(createLabState(), "gcloud sql instances create Bad_Name --tier=db-f1-micro").error).toMatch(/Invalid instance name/);
    expect(cloud(sh(createLabState(), "gcloud sql instances create c --database-version=MYSQL_8_0 --cpu=1 --memory=3840MiB").state).gcp.sql.instances.c.tier).toBe("db-custom-1-3840");
  });

  it("needs backups for high availability", () => {
    expect(sh(createLabState(), `${SQL_CREATE} --availability-type=regional --no-backup`).error).toMatch(/必須啟用自動備份/);
    const noBackup = sh(createLabState(), `${SQL_CREATE} --no-backup`).state;
    expect(sh(noBackup, "gcloud sql instances patch app-db --availability-type=REGIONAL").error).toMatch(/需要先啟用自動備份/);
    const ha = sh(noBackup, "gcloud sql instances patch app-db --availability-type=REGIONAL --backup-start-time=03:00");
    expect(ha.text).toMatch(/^Patching Cloud SQL instance\.\.\.done\./);
    expect(cloud(ha.state).gcp.sql.instances["app-db"]).toMatchObject({ availabilityType: "REGIONAL", backupsEnabled: true });
    expect(sh(ha.state, "gcloud sql instances patch app-db --no-backup").error).toMatch(/不能停用/);
    expect(sh(withSql().state, "gcloud sql instances patch app-db --availability-type=everywhere").error).toMatch(/Invalid choice/);
  });

  it("creates databases and users, and copies them to replicas", () => {
    let s = sh(withSql().state, "gcloud sql databases create appdb --instance=app-db", "gcloud sql users create app_user --instance=app-db --password=x").state;
    expect(cloud(s).gcp.sql.instances["app-db"]).toMatchObject({ databases: { postgres: true, appdb: true }, users: { postgres: true, app_user: true } });
    expect(sh(s, "gcloud sql databases create appdb --instance=app-db").error).toMatch(/already exists/);
    expect(sh(s, "gcloud sql databases create x").error).toMatch(/--instance\/-i: Must be specified/);
    expect(sh(s, "gcloud sql databases create x --instance=nope").error).toMatch(/does not exist/);
    expect(sh(s, "gcloud sql databases list --instance=app-db").out.map((l) => l.split(/\s+/)[0])).toEqual(["NAME", "appdb", "postgres"]);
    s = sh(s, "gcloud sql instances create app-db-replica --master-instance-name=app-db").state;
    expect(cloud(s).gcp.sql.instances["app-db-replica"]).toMatchObject({ masterInstanceName: "app-db", region: "asia-east1", tier: "db-custom-2-8192", backupsEnabled: false, databases: { appdb: true } });
    s = sh(s, "gcloud sql databases create later --instance=app-db").state;
    expect(cloud(s).gcp.sql.instances["app-db-replica"].databases.later).toBe(true);
    expect(sh(s, "gcloud sql databases create direct --instance=app-db-replica").error).toMatch(/唯讀備用資源/);
    expect(sh(s, "gcloud sql backups create --instance=app-db-replica").error).toMatch(/Backups cannot be enabled on replica instances/);
    expect(sh(s, "gcloud sql instances create r2 --master-instance-name=nope").error).toMatch(/does not exist/);
    expect(cloud(sh(s, "gcloud sql users delete app_user --instance=app-db").state).gcp.sql.instances["app-db-replica"].users.app_user).toBeUndefined();
  });

  it("takes on-demand backups", () => {
    const r = sh(withSql().state, "gcloud sql backups create --instance=app-db", "gcloud sql backups create --instance=app-db");
    expect(r.text).toMatch(/^Backing up Cloud SQL instance\.\.\.done\./);
    expect(cloud(r.state).gcp.sql.instances["app-db"].backupCount).toBe(2);
    expect(sh(r.state, "gcloud sql backups list --instance=app-db").out).toHaveLength(3);
  });

  it("will not delete a primary with replicas or a protected instance", () => {
    const s = sh(withSql().state, "gcloud sql instances create app-db-replica --master-instance-name=app-db").state;
    expect(sh(s, "gcloud sql instances delete app-db").error).toMatch(/has read replicas: app-db-replica/);
    const gone = sh(s, "gcloud sql instances delete app-db-replica", "gcloud sql instances delete app-db");
    expect(gone.text).toMatch(/^Deleting Cloud SQL instance\.\.\.done\./);
    expect(cloud(gone.state).gcp.sql.instances).toEqual({});
    const protectedDb = sh(withSql().state, "gcloud sql instances patch app-db --deletion-protection").state;
    expect(sh(protectedDb, "gcloud sql instances delete app-db").error).toMatch(/protected from deletion/);
    expect(cloud(sh(protectedDb, "gcloud sql instances patch app-db --no-deletion-protection", "gcloud sql instances delete app-db").state).gcp.sql.instances).toEqual({});
  });

  it("explains unsupported sql commands", () => {
    expect(sh(createLabState(), "gcloud sql instances restart x").error).toMatch(/不支援的指令 'restart'/);
    expect(sh(createLabState(), "gcloud sql operations list").error).toMatch(/不支援 'operations'/);
  });
});

// ------------------------------------------------------------- the labs

describe("network and database labs can be completed", () => {
  const labs = new Map([...loadContent().units.values()].flatMap((u) => u.labs).map((l) => [l.id, l]));

  /**
   * Runs groups of commands; a function gets every output so far, so it can
   * pick generated ids out of earlier commands the way a learner would.
   */
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
  const last = (outputs: string, name: string) => [...outputs.matchAll(new RegExp(`"${name}": "([^"]+)"`, "g"))].at(-1)![1];
  /** Subnet id for a CIDR, from create-subnet output ("CidrBlock" comes just before "MapPublicIpOnLaunch" … "SubnetId"). */
  const subnetFor = (outputs: string, cidr: string) => new RegExp(`"CidrBlock": "${cidr.replace(/[./]/g, "\\$&")}",[\\s\\S]*?"SubnetId": "([^"]+)"`).exec(outputs)![1];

  it("aws-vpc-public-subnet", () => {
    expect(
      play("aws-vpc-public-subnet", [
        ["aws ec2 create-vpc --cidr-block 10.0.0.0/16"],
        [(o) => `aws ec2 create-subnet --vpc-id ${last(o, "VpcId")} --cidr-block 10.0.1.0/24 --availability-zone us-east-1a`],
        [(o) => `aws ec2 create-subnet --vpc-id ${last(o, "VpcId")} --cidr-block 10.0.2.0/24 --availability-zone us-east-1b`],
        ["aws ec2 create-internet-gateway", (o) => `aws ec2 attach-internet-gateway --internet-gateway-id ${last(o, "InternetGatewayId")} --vpc-id ${last(o, "VpcId")}`],
        [
          (o) => `aws ec2 create-route-table --vpc-id ${last(o, "VpcId")}`,
          (o) => `aws ec2 create-route --route-table-id ${last(o, "RouteTableId")} --destination-cidr-block 0.0.0.0/0 --gateway-id ${last(o, "InternetGatewayId")}`,
        ],
        ["aws ec2 describe-subnets", (o) => `aws ec2 associate-route-table --route-table-id ${last(o, "RouteTableId")} --subnet-id ${subnetFor(o, "10.0.1.0/24")}`],
        [(o) => `aws ec2 modify-subnet-attribute --subnet-id ${subnetFor(o, "10.0.1.0/24")} --map-public-ip-on-launch`],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("aws-vpc-public-subnet: a route on the main table blocks the association step until it is removed", () => {
    expect(
      play("aws-vpc-public-subnet", [
        ["aws ec2 create-vpc --cidr-block 10.0.0.0/16"],
        [
          (o) => `aws ec2 create-subnet --vpc-id ${last(o, "VpcId")} --cidr-block 10.0.1.0/24 --availability-zone us-east-1a`,
          (o) => `aws ec2 create-subnet --vpc-id ${last(o, "VpcId")} --cidr-block 10.0.2.0/24 --availability-zone us-east-1b`,
          "aws ec2 create-internet-gateway",
          (o) => `aws ec2 attach-internet-gateway --internet-gateway-id ${last(o, "InternetGatewayId")} --vpc-id ${last(o, "VpcId")}`,
        ],
        // The main route table is the only one so far.
        ["aws ec2 describe-route-tables", (o) => `aws ec2 create-route --route-table-id ${last(o, "RouteTableId")} --destination-cidr-block 0.0.0.0/0 --gateway-id ${last(o, "InternetGatewayId")}`],
        [(o) => `aws ec2 create-route-table --vpc-id ${last(o, "VpcId")}`],
        [(o) => `aws ec2 create-route --route-table-id ${last(o, "RouteTableId")} --destination-cidr-block 0.0.0.0/0 --gateway-id ${last(o, "InternetGatewayId")}`],
        [(o) => `aws ec2 associate-route-table --route-table-id ${last(o, "RouteTableId")} --subnet-id ${subnetFor(o, "10.0.1.0/24")}`],
        // The first route table id printed (by describe-route-tables) is the main one.
        [(o) => `aws ec2 delete-route --route-table-id ${/"RouteTableId": "([^"]+)"/.exec(o)![1]} --destination-cidr-block 0.0.0.0/0`],
      ]),
    ).toEqual([1, 4, 5, 5, 5, 5, 6]);
  });

  it("aws-vpc-public-subnet: the wrong subnet cannot be the public one", () => {
    expect(
      play("aws-vpc-public-subnet", [
        [
          "aws ec2 create-vpc --cidr-block 10.0.0.0/16",
          (o) => `aws ec2 create-subnet --vpc-id ${last(o, "VpcId")} --cidr-block 10.0.1.0/24 --availability-zone us-east-1a`,
          (o) => `aws ec2 create-subnet --vpc-id ${last(o, "VpcId")} --cidr-block 10.0.2.0/24 --availability-zone us-east-1b`,
          "aws ec2 create-internet-gateway",
          (o) => `aws ec2 attach-internet-gateway --internet-gateway-id ${last(o, "InternetGatewayId")} --vpc-id ${last(o, "VpcId")}`,
          (o) => `aws ec2 create-route-table --vpc-id ${last(o, "VpcId")}`,
          (o) => `aws ec2 create-route --route-table-id ${last(o, "RouteTableId")} --destination-cidr-block 0.0.0.0/0 --gateway-id ${last(o, "InternetGatewayId")}`,
        ],
        [(o) => `aws ec2 associate-route-table --route-table-id ${last(o, "RouteTableId")} --subnet-id ${subnetFor(o, "10.0.2.0/24")}`],
      ]),
    ).toEqual([5, 5]);
  });

  it("gcp-vpc-custom-network", () => {
    expect(
      play("gcp-vpc-custom-network", [
        ["gcloud compute networks list", "gcloud compute networks create lab-net --subnet-mode=custom"],
        ["gcloud compute networks subnets create web-subnet --network=lab-net --region=asia-east1 --range=10.10.1.0/24"],
        ["gcloud compute networks subnets create db-subnet --network=lab-net --region=us-central1 --range=10.20.1.0/24"],
        ["gcloud compute firewall-rules create lab-net-allow-ssh --network=lab-net --allow=tcp:22 --source-ranges=203.0.113.0/24"],
        ["gcloud compute instances create app-1 --zone=asia-east1-b --subnet=web-subnet --no-address"],
        [
          "gcloud compute routers create nat-router --network=lab-net --region=asia-east1",
          "gcloud compute routers nats create nat-config --router=nat-router --region=asia-east1 --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges",
        ],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gcp-vpc-custom-network: mistakes on the default network or a NAT in the wrong region do not count", () => {
    expect(
      play("gcp-vpc-custom-network", [
        [
          "gcloud compute networks create lab-net --subnet-mode=custom",
          "gcloud compute networks subnets create web-subnet --network=lab-net --region=asia-east1 --range=10.10.1.0/24",
          "gcloud compute networks subnets create db-subnet --network=lab-net --region=us-central1 --range=10.20.1.0/24",
        ],
        ["gcloud compute firewall-rules create lab-net-allow-ssh --allow=tcp:22 --source-ranges=203.0.113.0/24"],
        ["gcloud compute firewall-rules delete lab-net-allow-ssh", "gcloud compute firewall-rules create lab-net-allow-ssh --network=lab-net --allow=tcp:22 --source-ranges=203.0.113.0/24"],
        ["gcloud compute instances create app-1 --zone=asia-east1-b --subnet=web-subnet"],
        ["gcloud compute instances delete app-1 --zone=asia-east1-b", "gcloud compute instances create app-1 --zone=asia-east1-b --subnet=web-subnet --no-address"],
        [
          "gcloud compute routers create nat-router --network=lab-net --region=us-central1",
          "gcloud compute routers nats create nat-config --router=nat-router --region=us-central1 --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges",
        ],
        [
          "gcloud compute routers create nat-router --network=lab-net --region=asia-east1",
          "gcloud compute routers nats create nat-config --router=nat-router --region=asia-east1 --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges",
        ],
      ]),
    ).toEqual([3, 3, 4, 4, 5, 5, 6]);
  });

  it("aws-rds-instance", () => {
    expect(
      play("aws-rds-instance", [
        ["aws ec2 describe-subnets", 'aws rds create-db-subnet-group --db-subnet-group-name lab-db-subnets --db-subnet-group-description "Lab database" --subnet-ids subnet-0a1b2c3d4e5f60718 subnet-0b2c3d4e5f6071829'],
        ["aws rds create-db-instance --db-instance-identifier lab-db --engine mysql --db-instance-class db.t3.micro --allocated-storage 20 --master-username admin --manage-master-user-password --db-subnet-group-name lab-db-subnets --no-publicly-accessible"],
        ["aws rds modify-db-instance --db-instance-identifier lab-db --multi-az --apply-immediately", "aws rds describe-db-instances"],
        ["aws rds create-db-instance-read-replica --db-instance-identifier lab-db-replica --source-db-instance-identifier lab-db"],
        ["aws rds create-db-snapshot --db-instance-identifier lab-db --db-snapshot-identifier lab-db-before-change"],
        ["aws rds delete-db-instance --db-instance-identifier lab-db-replica --skip-final-snapshot"],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("aws-rds-instance: a subnet group in one zone, a missing --apply-immediately or a missing --skip-final-snapshot all hold the lab back", () => {
    expect(
      play("aws-rds-instance", [
        ['aws rds create-db-subnet-group --db-subnet-group-name lab-db-subnets --db-subnet-group-description "x" --subnet-ids subnet-0a1b2c3d4e5f60718'],
        ['aws rds create-db-subnet-group --db-subnet-group-name lab-db-subnets --db-subnet-group-description "x" --subnet-ids subnet-0a1b2c3d4e5f60718 subnet-0b2c3d4e5f6071829'],
        ["aws rds create-db-instance --db-instance-identifier lab-db --engine mysql --db-instance-class db.t3.micro --allocated-storage 20 --master-username admin --master-user-password Lab-Passw0rd --db-subnet-group-name lab-db-subnets"],
        ["aws rds modify-db-instance --db-instance-identifier lab-db --multi-az"],
        ["aws rds modify-db-instance --db-instance-identifier lab-db --multi-az --apply-immediately"],
        ["aws rds create-db-instance-read-replica --db-instance-identifier lab-db-replica --source-db-instance-identifier lab-db", "aws rds create-db-snapshot --db-instance-identifier lab-db --db-snapshot-identifier lab-db-before-change"],
        ["aws rds delete-db-instance --db-instance-identifier lab-db-replica"],
        ["aws rds delete-db-instance --db-instance-identifier lab-db-replica --skip-final-snapshot"],
      ]),
    ).toEqual([0, 1, 2, 2, 3, 5, 5, 6]);
  });

  it("gcp-cloud-sql-instance", () => {
    expect(
      play("gcp-cloud-sql-instance", [
        ["gcloud sql instances create lab-db --database-version=POSTGRES_16 --edition=enterprise --cpu=2 --memory=8GiB --region=asia-east1"],
        ["gcloud sql databases create appdb --instance=lab-db"],
        ["gcloud sql users create app_user --instance=lab-db --password=Chang3-Me-Now"],
        ["gcloud sql instances patch lab-db --availability-type=REGIONAL"],
        ["gcloud sql instances create lab-db-replica --master-instance-name=lab-db", "gcloud sql databases list --instance=lab-db-replica"],
        ["gcloud sql backups create --instance=lab-db"],
        ["gcloud sql instances delete lab-db", "gcloud sql instances delete lab-db-replica"],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("gcp-cloud-sql-instance: forgetting --edition fails, and deleting the primary first is refused", () => {
    expect(
      play("gcp-cloud-sql-instance", [
        ["gcloud sql instances create lab-db --database-version=POSTGRES_16 --cpu=2 --memory=8GiB --region=asia-east1"],
        ["gcloud sql instances create lab-db --database-version=POSTGRES_16 --edition=enterprise --cpu=2 --memory=8GiB --region=asia-east1"],
        [
          "gcloud sql databases create appdb --instance=lab-db",
          "gcloud sql users create app_user --instance=lab-db --password=pw",
          "gcloud sql instances patch lab-db --availability-type=REGIONAL",
          "gcloud sql instances create lab-db-replica --master-instance-name=lab-db",
          "gcloud sql backups create --instance=lab-db",
        ],
        ["gcloud sql instances delete lab-db"],
      ]),
    ).toEqual([0, 1, 6, 6]);
  });
});
