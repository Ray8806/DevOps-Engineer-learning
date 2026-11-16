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
const field = (text: string, key: string) => new RegExp(`"${key}": "([^"]+)"`).exec(text)![1];

const SITE = { cloud: { s3: { buckets: { "lab-static-site": { objects: { "index.html": "hi" } } } }, gcs: { buckets: { "lab-static-site": { objects: { "index.html": "hi" } } } } } };
const DIST = "aws cloudfront create-distribution --origin-domain-name lab-static-site.s3.amazonaws.com --default-root-object index.html";
const ZONE = "aws route53 create-hosted-zone --name example.com --caller-reference lab-1";
const batch = (...changes: object[]) => `'${JSON.stringify({ Changes: changes })}'`;
const create = (set: object) => ({ Action: "CREATE", ResourceRecordSet: set });
const change = (zoneId: string, ...changes: object[]) => `aws route53 change-resource-record-sets --hosted-zone-id ${zoneId} --change-batch ${batch(...changes)}`;

/** A distribution and a hosted zone; returns the state, zone id and distribution domain. */
function setup() {
  const d = sh(createLabState(SITE), DIST);
  const z = sh(d.state, ZONE);
  return { state: z.state, zoneId: field(z.text, "Id").replace("/hostedzone/", ""), domain: field(d.text, "DomainName"), distId: field(d.text, "Id") };
}

describe("aws cloudfront", () => {
  it("creates a distribution for an existing S3 bucket", () => {
    const r = sh(createLabState(SITE), DIST);
    expect(r.text).toMatch(/"DomainName": "d[a-z0-9]{13}\.cloudfront\.net"/);
    expect(cloud(r.state).aws.cloudfront.distributions["lab-static-site.s3.amazonaws.com"]).toEqual({ defaultRootObject: "index.html", invalidations: {} });
    expect(sh(createLabState(), DIST).error).toContain("valid S3 bucket");
  });

  it("invalidations need paths starting with / and * only at the end", () => {
    const { state, distId } = setup();
    expect(sh(state, `aws cloudfront create-invalidation --distribution-id ${distId} --paths "images/*"`).error).toContain("invalid invalidation paths");
    expect(sh(state, `aws cloudfront create-invalidation --distribution-id ${distId} --paths "/*/logo.png"`).error).toContain("invalid invalidation paths");
    const r = sh(state, `aws cloudfront create-invalidation --distribution-id ${distId} --paths "/images/*" /index.html`);
    expect(cloud(r.state).aws.cloudfront.distributions["lab-static-site.s3.amazonaws.com"].invalidations).toEqual({ "/images/*": true, "/index.html": true });
  });
});

describe("aws route53", () => {
  it("creates a public hosted zone with NS and SOA records", () => {
    const { state, zoneId } = setup();
    const sets = JSON.parse(sh(state, `aws route53 list-resource-record-sets --hosted-zone-id ${zoneId}`).text).ResourceRecordSets;
    expect(sets.map((s: any) => s.Type)).toEqual(["NS", "SOA"]);
    expect(sets[0].ResourceRecords).toHaveLength(4);
    expect(sh(state, "aws route53 create-hosted-zone --name example.com --caller-reference lab-1").error).toContain("HostedZoneAlreadyExists");
    expect(sh(state, "aws route53 create-hosted-zone --name com --caller-reference x").error).toContain("InvalidDomainName");
  });

  it("does not allow a CNAME at the zone apex, but allows an alias", () => {
    const { state, zoneId, domain } = setup();
    const cname = sh(state, change(zoneId, create({ Name: "example.com", Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: "www.example.com" }] })));
    expect(cname.error).toContain("not permitted at apex");
    const alias = sh(state, change(zoneId, create({ Name: "example.com", Type: "A", AliasTarget: { HostedZoneId: "Z2FDTNDATAQYW2", DNSName: domain, EvaluateTargetHealth: false } })));
    expect(alias.errors).toEqual([]);
    expect(cloud(alias.state).aws.route53.zones["example.com."].records["example.com./A"].aliasTo).toBe("cloudfront:lab-static-site.s3.amazonaws.com");
  });

  it("checks alias targets", () => {
    const { state, zoneId, domain } = setup();
    const aliasTo = (HostedZoneId: string, DNSName: string, Name = "www.example.com") =>
      sh(state, change(zoneId, create({ Name, Type: "A", AliasTarget: { HostedZoneId, DNSName, EvaluateTargetHealth: false } }))).error;
    expect(aliasTo("Z123", domain)).toContain("Z2FDTNDATAQYW2");
    expect(aliasTo("Z2FDTNDATAQYW2", "dnotreal12345.cloudfront.net")).toContain("找不到");
    expect(aliasTo(zoneId, "missing.example.com")).toContain("not found");
    expect(sh(state, change(zoneId, create({ Name: "www.example.com", Type: "A", TTL: 60, AliasTarget: { HostedZoneId: "Z2FDTNDATAQYW2", DNSName: domain } }))).error).toContain("TTL");
  });

  it("keeps CNAMEs from sharing a name with other records and rejects bad batches as a whole", () => {
    const { state, zoneId } = setup();
    const a = sh(state, change(zoneId, create({ Name: "www.example.com", Type: "A", TTL: 300, ResourceRecords: [{ Value: "192.0.2.1" }] })));
    expect(sh(a.state, change(zoneId, create({ Name: "www.example.com", Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: "x.example.org" }] }))).error).toContain("conflicting");
    expect(sh(a.state, change(zoneId, create({ Name: "www.example.com", Type: "A", TTL: 300, ResourceRecords: [{ Value: "192.0.2.2" }] }))).error).toContain("already exists");
    const mixed = sh(
      a.state,
      change(zoneId, create({ Name: "ok.example.com", Type: "A", TTL: 300, ResourceRecords: [{ Value: "192.0.2.3" }] }), create({ Name: "bad.example.org", Type: "A", TTL: 300, ResourceRecords: [{ Value: "192.0.2.4" }] })),
    );
    expect(mixed.error).toContain("not permitted in zone");
    expect(cloud(mixed.state).aws.route53.zones["example.com."].records["ok.example.com./A"]).toBeUndefined();
    const upsert = sh(a.state, change(zoneId, { Action: "UPSERT", ResourceRecordSet: { Name: "www.example.com", Type: "A", TTL: 60, ResourceRecords: [{ Value: "192.0.2.9" }] } }));
    expect(cloud(upsert.state).aws.route53.zones["example.com."].records["www.example.com./A"]).toEqual({ ttl: 60, values: ["192.0.2.9"], aliasTo: null });
  });

  it("weighted records answer in proportion", () => {
    const { state, zoneId } = setup();
    const w = (id: string, weight: number, ip: string) => create({ Name: "api.example.com", Type: "A", SetIdentifier: id, Weight: weight, TTL: 60, ResourceRecords: [{ Value: ip }] });
    let s = sh(state, change(zoneId, w("blue", 90, "192.0.2.10"), w("green", 10, "192.0.2.20"))).state;
    expect(cloud(s).aws.route53.zones["example.com."].weighted).toEqual({ "api.example.com./A": { blue: 90, green: 10 } });
    const answers: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = sh(s, `aws route53 test-dns-answer --hosted-zone-id ${zoneId} --record-name api.example.com --record-type A`);
      s = r.state;
      answers.push(JSON.parse(r.text).RecordData[0]);
    }
    const green = answers.filter((a) => a === "192.0.2.20").length;
    expect(green).toBeGreaterThan(0);
    expect(green).toBeLessThan(6);
  });

  it("delete-hosted-zone refuses zones with records", () => {
    const { state, zoneId } = setup();
    const a = sh(state, change(zoneId, create({ Name: "www.example.com", Type: "A", TTL: 300, ResourceRecords: [{ Value: "192.0.2.1" }] })));
    expect(sh(a.state, `aws route53 delete-hosted-zone --id ${zoneId}`).error).toContain("HostedZoneNotEmpty");
    expect(sh(state, `aws route53 delete-hosted-zone --id /hostedzone/${zoneId}`).errors).toEqual([]);
  });
});

describe("gcloud cloud cdn", () => {
  const LB = [
    "gcloud compute backend-buckets create static-backend --gcs-bucket-name=lab-static-site --enable-cdn",
    "gcloud compute url-maps create static-map --default-backend-bucket=static-backend",
    "gcloud compute target-http-proxies create static-proxy --url-map=static-map",
    "gcloud compute forwarding-rules create static-rule --global --target-http-proxy=static-proxy --ports=80",
  ];

  it("serves a backend bucket with Cloud CDN through the load balancer", () => {
    const r = sh(createLabState(SITE), ...LB);
    expect(r.errors).toEqual([]);
    const c = cloud(r.state).gcp;
    expect(c.backendBuckets["static-backend"]).toEqual({ gcsBucket: "lab-static-site", cdn: true, cacheMode: "CACHE_ALL_STATIC" });
    expect(c.forwardingRules["static-rule"].serving).toBe(true);
    expect(sh(createLabState(), LB[0]).error).toContain("gs://lab-static-site");
  });

  it("url maps need exactly one default backend", () => {
    const s = sh(createLabState(SITE), LB[0]).state;
    expect(sh(s, "gcloud compute url-maps create m").error).toContain("Exactly one");
    expect(sh(s, "gcloud compute url-maps create m --default-backend-bucket=nope").error).toContain("was not found");
  });

  it("invalidates cached paths", () => {
    const s = sh(createLabState(SITE), ...LB).state;
    expect(sh(s, 'gcloud compute url-maps invalidate-cdn-cache static-map --path="images/*"').error).toContain("/");
    const r = sh(s, 'gcloud compute url-maps invalidate-cdn-cache static-map --path="/images/*"');
    expect(cloud(r.state).gcp.urlMaps["static-map"].invalidations).toEqual({ "/images/*": true });
  });

  it("enables Cloud CDN on a backend service", () => {
    const s = sh(
      createLabState(),
      "gcloud compute health-checks create http web-hc --port=80",
      "gcloud compute backend-services create web-backend --protocol=HTTP --health-checks=web-hc --global",
    ).state;
    expect(cloud(s).gcp.backendServices["web-backend"].cdn).toBe(false);
    const r = sh(s, "gcloud compute backend-services update web-backend --enable-cdn --cache-mode=USE_ORIGIN_HEADERS --global");
    expect(cloud(r.state).gcp.backendServices["web-backend"]).toMatchObject({ cdn: true, cacheMode: "USE_ORIGIN_HEADERS" });
    expect(sh(s, "gcloud compute backend-services update web-backend --enable-cdn --cache-mode=ALL --global").error).toContain("cache-mode");
  });
});

describe("gcloud dns", () => {
  const ZONE_G = 'gcloud dns managed-zones create lab-zone --dns-name=example.com --description="Lab zone"';

  it("creates a zone with NS and SOA records and a trailing-dot name", () => {
    const r = sh(createLabState(), ZONE_G);
    expect(cloud(r.state).gcp.dns.zones["lab-zone"].dnsName).toBe("example.com.");
    const listed = sh(r.state, "gcloud dns record-sets list --zone=lab-zone").text;
    expect(listed).toContain("NS");
    expect(listed).toContain("SOA");
    expect(sh(r.state, ZONE_G).error).toContain("already exists");
  });

  it("enforces CNAME rules and zone membership", () => {
    const s = sh(createLabState(), ZONE_G).state;
    expect(sh(s, "gcloud dns record-sets create example.com. --zone=lab-zone --type=CNAME --ttl=300 --rrdatas=www.example.com.").error).toContain("zone apex");
    expect(sh(s, "gcloud dns record-sets create www.example.org. --zone=lab-zone --type=A --ttl=300 --rrdatas=192.0.2.1").error).toContain("not within the zone");
    const a = sh(s, "gcloud dns record-sets create www.example.com --zone=lab-zone --type=A --ttl=300 --rrdatas=192.0.2.1");
    expect(sh(a.state, "gcloud dns record-sets create www.example.com. --zone=lab-zone --type=CNAME --ttl=300 --rrdatas=x.example.org.").error).toContain("CNAME");
    expect(sh(a.state, "gcloud dns record-sets create www.example.com. --zone=lab-zone --type=A --ttl=300 --rrdatas=192.0.2.2").error).toContain("already exists");
    const u = sh(a.state, "gcloud dns record-sets update www.example.com. --zone=lab-zone --type=A --ttl=60 --rrdatas=192.0.2.9");
    expect(cloud(u.state).gcp.dns.zones["lab-zone"].records["www.example.com./A"]).toEqual({ ttl: 60, rrdatas: ["192.0.2.9"], forwardingRule: null });
    expect(sh(a.state, "gcloud dns managed-zones delete lab-zone").error).toContain("not empty");
  });
});

describe("dns and cdn labs can be completed", () => {
  const labs = new Map([...loadContent().units.values()].flatMap((u) => u.labs).map((l) => [l.id, l]));

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
  const zone = (o: string) => /"Id": "\/hostedzone\/([A-Z0-9]+)"/.exec(o)![1];

  it("aws-route53-cloudfront", () => {
    expect(
      play("aws-route53-cloudfront", [
        [DIST],
        ["aws cloudfront list-distributions", (o) => `aws cloudfront create-invalidation --distribution-id ${field(o, "Id")} --paths "/images/*"`],
        [ZONE, (o) => `aws route53 list-resource-record-sets --hosted-zone-id ${zone(o)}`],
        [(o) => change(zone(o), create({ Name: "www.example.com", Type: "A", AliasTarget: { HostedZoneId: "Z2FDTNDATAQYW2", DNSName: field(o, "DomainName"), EvaluateTargetHealth: false } }))],
        [
          (o) => change(zone(o), create({ Name: "example.com", Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: "www.example.com" }] })),
          (o) => change(zone(o), create({ Name: "example.com", Type: "A", AliasTarget: { HostedZoneId: zone(o), DNSName: "www.example.com", EvaluateTargetHealth: false } })),
        ],
        [
          (o) =>
            change(
              zone(o),
              create({ Name: "api.example.com", Type: "A", SetIdentifier: "blue", Weight: 90, TTL: 60, ResourceRecords: [{ Value: "192.0.2.10" }] }),
              create({ Name: "api.example.com", Type: "A", SetIdentifier: "green", Weight: 10, TTL: 60, ResourceRecords: [{ Value: "192.0.2.20" }] }),
            ),
          (o) => `aws route53 test-dns-answer --hosted-zone-id ${zone(o)} --record-name api.example.com --record-type A`,
        ],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gcp-dns-cdn", () => {
    const ip = (o: string) => /IPAddress: (\S+)/.exec(o)![1];
    expect(
      play("gcp-dns-cdn", [
        ["gcloud compute backend-buckets create static-backend --gcs-bucket-name=lab-static-site --enable-cdn", "gcloud compute backend-buckets describe static-backend"],
        [
          "gcloud compute url-maps create static-map --default-backend-bucket=static-backend",
          "gcloud compute target-http-proxies create static-proxy --url-map=static-map",
          "gcloud compute forwarding-rules create static-rule --global --target-http-proxy=static-proxy --ports=80",
        ],
        ['gcloud compute url-maps invalidate-cdn-cache static-map --path="/images/*"'],
        ['gcloud dns managed-zones create lab-zone --dns-name=example.com. --description="Lab zone"', "gcloud dns record-sets list --zone=lab-zone"],
        ["gcloud compute forwarding-rules describe static-rule --global", (o) => `gcloud dns record-sets create www.example.com. --zone=lab-zone --type=A --ttl=300 --rrdatas=${ip(o)}`],
        [
          "gcloud dns record-sets create example.com. --zone=lab-zone --type=CNAME --ttl=300 --rrdatas=www.example.com.",
          (o) => `gcloud dns record-sets create example.com. --zone=lab-zone --type=A --ttl=300 --rrdatas=${ip(o)}`,
        ],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
