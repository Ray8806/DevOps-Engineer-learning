import { cidrContains, cidrOverlaps, cidrSize, formatCidr, parseCidr } from "./cidr";
import { parseArgs, type Ctx } from "./context";

export const VPC_COMMANDS = [
  "create-vpc", "describe-vpcs", "delete-vpc",
  "create-subnet", "describe-subnets", "delete-subnet", "modify-subnet-attribute",
  "create-internet-gateway", "attach-internet-gateway", "detach-internet-gateway", "describe-internet-gateways",
  "create-route-table", "describe-route-tables", "create-route", "delete-route", "associate-route-table", "disassociate-route-table",
];

const OWNER = "123456789012";
const AZ = /^[a-z]{2}-[a-z]+-\d[a-z]$/;
const DEFAULT_AZ = "us-east-1a";

const json = (ctx: Ctx, value: unknown) => ctx.out(`${JSON.stringify(value, null, 4)}\n`);

function fail(ctx: Ctx, code: string, operation: string, message: string): number {
  ctx.err(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}`);
  return 254;
}

/** Deterministic 17-hex-digit resource id, e.g. vpc-0a3f…; `n` is a running counter. */
export function newId(prefix: string, n: number): string {
  let hash = 0x811c9dc5;
  let hex = "";
  for (let round = 0; round < 2; round++) {
    for (const ch of `${prefix}${n}:${round}`) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hex += hash.toString(16).padStart(8, "0");
  }
  return `${prefix}-0${hex}`;
}

/** Reads `--filters Name=vpc-id,Values=vpc-…` (the one filter these commands support). */
function vpcFilter(ctx: Ctx, filter: string | undefined): { ok: boolean; vpcId?: string } {
  if (filter === undefined) return { ok: true };
  const m = /^Name=vpc-id,Values=([\w-]+)$/.exec(filter);
  if (!m) {
    ctx.err(`\n這個模擬終端機的 --filters 只支援 Name=vpc-id,Values=vpc-…，收到 '${filter}'`);
    return { ok: false };
  }
  return { ok: true, vpcId: m[1] };
}

export function vpc(ctx: Ctx, sub: string, rest: string[]): number {
  const parsed = parseArgs(rest, {
    options: [
      "--cidr-block", "--vpc-id", "--vpc-ids", "--subnet-id", "--subnet-ids", "--availability-zone", "--internet-gateway-id",
      "--internet-gateway-ids", "--route-table-id", "--route-table-ids", "--destination-cidr-block", "--gateway-id",
      "--association-id", "--filters", "--tag-specifications", "--region", "--output",
    ],
    flags: ["--map-public-ip-on-launch", "--no-map-public-ip-on-launch"],
  });
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const state = ctx.state.aws;
  const { vpcs, subnets, internetGateways, routeTables } = state.vpc;
  const operation = sub.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  const opt = (name: string) => parsed.options.get(`--${name}`);
  /** A list option's values: the one after the flag plus any following bare words. */
  const list = (name: string) => (parsed.options.has(`--${name}`) ? [opt(name)!, ...parsed.positional] : []);
  function required(...names: string[]): boolean {
    const missing = names.filter((n) => !parsed.options.has(`--${n}`));
    if (missing.length) ctx.err(`\naws: error: the following arguments are required: ${missing.map((n) => `--${n}`).join(", ")}`);
    return missing.length === 0;
  }
  const nextId = (prefix: string) => newId(prefix, ++state.ec2.created);
  const noVpc = (id: string) => fail(ctx, "InvalidVpcID.NotFound", operation, `The vpc ID '${id}' does not exist`);
  const noSubnet = (id: string) => fail(ctx, "InvalidSubnetID.NotFound", operation, `The subnet ID '${id}' does not exist`);
  const noTable = (id: string) => fail(ctx, "InvalidRouteTableID.NotFound", operation, `The routeTable ID '${id}' does not exist`);
  const noGateway = (id: string) => fail(ctx, "InvalidInternetGatewayID.NotFound", operation, `The internetGateway ID '${id}' does not exist`);

  const subnetJson = (id: string) => {
    const s = subnets.get(id)!;
    return {
      AvailabilityZone: s.availabilityZone,
      // AWS keeps five addresses of every subnet: the first four and the last one.
      AvailableIpAddressCount: cidrSize(parseCidr(s.cidr)!) - 5,
      CidrBlock: s.cidr,
      MapPublicIpOnLaunch: s.mapPublicIpOnLaunch,
      State: "available",
      SubnetId: id,
      VpcId: s.vpcId,
    };
  };
  const tableJson = (id: string) => {
    const t = routeTables.get(id)!;
    return {
      Associations: [
        ...(t.main ? [{ Main: true, RouteTableAssociationId: `rtbassoc-main${id.slice(4)}`, RouteTableId: id }] : []),
        ...[...t.associations].map(([assoc, subnetId]) => ({ Main: false, RouteTableAssociationId: assoc, RouteTableId: id, SubnetId: subnetId })),
      ],
      RouteTableId: id,
      Routes: [...t.routes].map(([dest, target]) => ({
        DestinationCidrBlock: dest,
        GatewayId: target,
        // A route to a detached gateway goes nowhere.
        State: target === "local" || internetGateways.get(target)?.vpcId === t.vpcId ? "active" : "blackhole",
      })),
      VpcId: t.vpcId,
    };
  };
  const gatewayJson = (id: string) => {
    const g = internetGateways.get(id)!;
    return { Attachments: g.vpcId ? [{ State: "available", VpcId: g.vpcId }] : [], InternetGatewayId: id, OwnerId: OWNER };
  };

  switch (sub) {
    // ------------------------------------------------------------------ VPCs
    case "create-vpc": {
      if (!required("cidr-block")) return 252;
      const cidr = parseCidr(opt("cidr-block")!);
      if (!cidr || cidr.prefix < 16 || cidr.prefix > 28) {
        return fail(ctx, "InvalidVpc.Range", operation, `The CIDR '${opt("cidr-block")}' is invalid. VPC 的 IPv4 範圍必須介於 /16（65,536 個位址）和 /28（16 個位址）之間。`);
      }
      const id = nextId("vpc");
      const block = formatCidr(cidr);
      vpcs.set(id, { cidr: block });
      // Every VPC comes with a main route table holding the local route.
      routeTables.set(nextId("rtb"), { vpcId: id, main: true, routes: new Map([[block, "local"]]), associations: new Map() });
      json(ctx, { Vpc: { CidrBlock: block, State: "pending", VpcId: id, OwnerId: OWNER, InstanceTenancy: "default", IsDefault: false } });
      return 0;
    }
    case "describe-vpcs": {
      const ids = list("vpc-ids");
      const unknown = ids.find((id) => !vpcs.has(id));
      if (unknown) return noVpc(unknown);
      json(ctx, {
        Vpcs: [...vpcs].filter(([id]) => ids.length === 0 || ids.includes(id)).map(([id, v]) => ({ CidrBlock: v.cidr, State: "available", VpcId: id, OwnerId: OWNER, IsDefault: false })),
      });
      return 0;
    }
    case "delete-vpc": {
      if (!required("vpc-id")) return 252;
      const id = opt("vpc-id")!;
      if (!vpcs.has(id)) return noVpc(id);
      const dependent =
        [...subnets].find(([, s]) => s.vpcId === id)?.[0] ??
        [...internetGateways].find(([, g]) => g.vpcId === id)?.[0] ??
        [...routeTables].find(([, t]) => t.vpcId === id && !t.main)?.[0];
      if (dependent) return fail(ctx, "DependencyViolation", operation, `The vpc '${id}' has dependencies and cannot be deleted. (${dependent})`);
      vpcs.delete(id);
      for (const [tableId, t] of routeTables) if (t.vpcId === id) routeTables.delete(tableId);
      return 0;
    }

    // --------------------------------------------------------------- subnets
    case "create-subnet": {
      if (!required("vpc-id", "cidr-block")) return 252;
      const vpcId = opt("vpc-id")!;
      const owner = vpcs.get(vpcId);
      if (!owner) return noVpc(vpcId);
      const cidr = parseCidr(opt("cidr-block")!);
      const vpcCidr = parseCidr(owner.cidr)!;
      if (!cidr || cidr.prefix < 16 || cidr.prefix > 28 || !cidrContains(vpcCidr, cidr)) {
        return fail(ctx, "InvalidSubnet.Range", operation, `The CIDR '${opt("cidr-block")}' is invalid. 子網路的範圍必須在 VPC 的 ${owner.cidr} 之內，大小介於 /16 和 /28 之間。`);
      }
      const block = formatCidr(cidr);
      const conflict = [...subnets.values()].find((s) => s.vpcId === vpcId && cidrOverlaps(parseCidr(s.cidr)!, cidr));
      if (conflict) return fail(ctx, "InvalidSubnet.Conflict", operation, `The CIDR '${block}' conflicts with another subnet (${conflict.cidr})`);
      const az = opt("availability-zone") ?? DEFAULT_AZ;
      if (!AZ.test(az)) return fail(ctx, "InvalidParameterValue", operation, `Value (${az}) for parameter availabilityZone is invalid. 可用區的格式像 us-east-1a。`);
      const id = nextId("subnet");
      subnets.set(id, { vpcId, cidr: block, availabilityZone: az, mapPublicIpOnLaunch: false });
      json(ctx, { Subnet: subnetJson(id) });
      return 0;
    }
    case "describe-subnets": {
      const filter = vpcFilter(ctx, opt("filters"));
      if (!filter.ok) return 252;
      const ids = list("subnet-ids");
      const unknown = ids.find((id) => !subnets.has(id));
      if (unknown) return noSubnet(unknown);
      json(ctx, {
        Subnets: [...subnets]
          .filter(([id, s]) => (ids.length === 0 || ids.includes(id)) && (filter.vpcId === undefined || s.vpcId === filter.vpcId))
          .map(([id]) => subnetJson(id)),
      });
      return 0;
    }
    case "delete-subnet": {
      if (!required("subnet-id")) return 252;
      const id = opt("subnet-id")!;
      if (!subnets.has(id)) return noSubnet(id);
      const group = [...state.rds.subnetGroups].find(([, g]) => g.subnetIds.includes(id));
      if (group) return fail(ctx, "DependencyViolation", operation, `The subnet '${id}' has dependencies and cannot be deleted. (DB subnet group ${group[0]})`);
      subnets.delete(id);
      for (const t of routeTables.values()) for (const [assoc, s] of t.associations) if (s === id) t.associations.delete(assoc);
      return 0;
    }
    case "modify-subnet-attribute": {
      if (!required("subnet-id")) return 252;
      const id = opt("subnet-id")!;
      const subnet = subnets.get(id);
      if (!subnet) return noSubnet(id);
      if (parsed.flags.has("--map-public-ip-on-launch")) subnet.mapPublicIpOnLaunch = true;
      else if (parsed.flags.has("--no-map-public-ip-on-launch")) subnet.mapPublicIpOnLaunch = false;
      else {
        ctx.err("\n這個模擬終端機的 modify-subnet-attribute 支援 --map-public-ip-on-launch 與 --no-map-public-ip-on-launch");
        return 252;
      }
      return 0;
    }

    // ------------------------------------------------------ internet gateways
    case "create-internet-gateway": {
      const id = nextId("igw");
      internetGateways.set(id, { vpcId: null });
      json(ctx, { InternetGateway: { Attachments: [], InternetGatewayId: id, OwnerId: OWNER, Tags: [] } });
      return 0;
    }
    case "attach-internet-gateway": {
      if (!required("internet-gateway-id", "vpc-id")) return 252;
      const id = opt("internet-gateway-id")!;
      const vpcId = opt("vpc-id")!;
      const gateway = internetGateways.get(id);
      if (!gateway) return noGateway(id);
      if (!vpcs.has(vpcId)) return noVpc(vpcId);
      if (gateway.vpcId) return fail(ctx, "Resource.AlreadyAssociated", operation, `resource ${id} is already attached to network ${gateway.vpcId}`);
      const other = [...internetGateways].find(([, g]) => g.vpcId === vpcId);
      if (other) return fail(ctx, "Resource.AlreadyAssociated", operation, `Network ${vpcId} already has an internet gateway attached (${other[0]}). 一個 VPC 只能連接一個網際網路閘道。`);
      gateway.vpcId = vpcId;
      return 0;
    }
    case "detach-internet-gateway": {
      if (!required("internet-gateway-id", "vpc-id")) return 252;
      const id = opt("internet-gateway-id")!;
      const gateway = internetGateways.get(id);
      if (!gateway) return noGateway(id);
      if (gateway.vpcId !== opt("vpc-id")) return fail(ctx, "Gateway.NotAttached", operation, `resource ${id} is not attached to network ${opt("vpc-id")}`);
      gateway.vpcId = null;
      return 0;
    }
    case "describe-internet-gateways": {
      const ids = list("internet-gateway-ids");
      const unknown = ids.find((id) => !internetGateways.has(id));
      if (unknown) return noGateway(unknown);
      json(ctx, { InternetGateways: [...internetGateways.keys()].filter((id) => ids.length === 0 || ids.includes(id)).map(gatewayJson) });
      return 0;
    }

    // ---------------------------------------------------------- route tables
    case "create-route-table": {
      if (!required("vpc-id")) return 252;
      const vpcId = opt("vpc-id")!;
      const owner = vpcs.get(vpcId);
      if (!owner) return noVpc(vpcId);
      const id = nextId("rtb");
      routeTables.set(id, { vpcId, main: false, routes: new Map([[owner.cidr, "local"]]), associations: new Map() });
      json(ctx, { RouteTable: tableJson(id) });
      return 0;
    }
    case "describe-route-tables": {
      const filter = vpcFilter(ctx, opt("filters"));
      if (!filter.ok) return 252;
      const ids = list("route-table-ids");
      const unknown = ids.find((id) => !routeTables.has(id));
      if (unknown) return noTable(unknown);
      json(ctx, {
        RouteTables: [...routeTables]
          .filter(([id, t]) => (ids.length === 0 || ids.includes(id)) && (filter.vpcId === undefined || t.vpcId === filter.vpcId))
          .map(([id]) => tableJson(id)),
      });
      return 0;
    }
    case "create-route": {
      if (!required("route-table-id", "destination-cidr-block")) return 252;
      const tableId = opt("route-table-id")!;
      const table = routeTables.get(tableId);
      if (!table) return noTable(tableId);
      const gatewayId = opt("gateway-id");
      if (gatewayId === undefined) {
        ctx.err("\n這個模擬終端機的 create-route 只支援 --gateway-id（網際網路閘道）作為目標");
        return 252;
      }
      const dest = parseCidr(opt("destination-cidr-block")!);
      if (!dest) return fail(ctx, "InvalidParameterValue", operation, `Value (${opt("destination-cidr-block")}) for parameter destinationCidrBlock is invalid.`);
      const gateway = internetGateways.get(gatewayId);
      if (!gateway) return fail(ctx, "InvalidGatewayID.NotFound", operation, `The gateway ID '${gatewayId}' does not exist`);
      if (gateway.vpcId !== table.vpcId) {
        return fail(ctx, "InvalidParameterValue", operation, `route table ${tableId} and network gateway ${gatewayId} belong to different networks. 閘道必須先連接到這個路由表所在的 VPC。`);
      }
      const block = formatCidr(dest);
      if (table.routes.has(block)) return fail(ctx, "RouteAlreadyExists", operation, `The route identified by ${block} already exists.`);
      table.routes.set(block, gatewayId);
      json(ctx, { Return: true });
      return 0;
    }
    case "delete-route": {
      if (!required("route-table-id", "destination-cidr-block")) return 252;
      const tableId = opt("route-table-id")!;
      const table = routeTables.get(tableId);
      if (!table) return noTable(tableId);
      const dest = parseCidr(opt("destination-cidr-block")!);
      const block = dest ? formatCidr(dest) : opt("destination-cidr-block")!;
      const target = table.routes.get(block);
      if (target === undefined) return fail(ctx, "InvalidRoute.NotFound", operation, `no route with destination-cidr-block ${block} in route table ${tableId}`);
      if (target === "local") return fail(ctx, "InvalidParameterValue", operation, `cannot remove local route ${block} in route table ${tableId}`);
      table.routes.delete(block);
      return 0;
    }
    case "associate-route-table": {
      if (!required("route-table-id", "subnet-id")) return 252;
      const tableId = opt("route-table-id")!;
      const subnetId = opt("subnet-id")!;
      const table = routeTables.get(tableId);
      if (!table) return noTable(tableId);
      const subnet = subnets.get(subnetId);
      if (!subnet) return noSubnet(subnetId);
      if (subnet.vpcId !== table.vpcId) return fail(ctx, "InvalidParameterValue", operation, `Route table ${tableId} and subnet ${subnetId} belong to different networks`);
      const current = [...routeTables].find(([, t]) => [...t.associations.values()].includes(subnetId));
      if (current) {
        return fail(ctx, "Resource.AlreadyAssociated", operation, `the specified association for route table ${tableId} conflicts with an existing association (${current[0]}). 一個子網路只能明確關聯一個路由表，請先用 disassociate-route-table 解除。`);
      }
      const assoc = nextId("rtbassoc");
      table.associations.set(assoc, subnetId);
      json(ctx, { AssociationId: assoc, AssociationState: { State: "associated" } });
      return 0;
    }
    case "disassociate-route-table": {
      if (!required("association-id")) return 252;
      const assoc = opt("association-id")!;
      const table = [...routeTables.values()].find((t) => t.associations.has(assoc));
      if (!table) return fail(ctx, "InvalidAssociationID.NotFound", operation, `The association ID '${assoc}' does not exist`);
      table.associations.delete(assoc);
      return 0;
    }
    default:
      return 252;
  }
}
