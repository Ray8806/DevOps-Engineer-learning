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
const files = (state: LabState): any => (checkView(state) as any).files;
const field = (text: string, key: string) => new RegExp(`"${key}": "([^"]+)"`).exec(text)![1];

const SECRET = "db-password=S3cr3t!\n";
const SEED = { files: { "~/secret.txt": SECRET }, cloud: { aws: { kms: { "alias/legacy-app": { description: "old" } } } } };

/** A key with alias/app-data; returns the state and key id. */
function appKey(seed: object = SEED) {
  const created = sh(createLabState(seed), 'aws kms create-key --description "app data"');
  const keyId = field(created.text, "KeyId");
  return { state: sh(created.state, `aws kms create-alias --alias-name alias/app-data --target-key-id ${keyId}`).state, keyId };
}

describe("base64", () => {
  it("encodes and decodes files", () => {
    const r = sh(createLabState({ files: { "~/a.txt": "héllo\n" } }), "base64 a.txt > a.b64", "base64 -d a.b64 > b.txt");
    expect(files(r.state)["~/a.b64"]).toBe("aMOpbGxvCg==\n");
    expect(files(r.state)["~/b.txt"]).toBe("héllo\n");
    expect(sh(createLabState({ files: { "~/x": "not base64!" } }), "base64 --decode x").error).toContain("invalid input");
  });
});

describe("aws kms", () => {
  it("creates keys and aliases", () => {
    const { state, keyId } = appKey();
    expect(cloud(state).aws.kms.aliases["alias/app-data"]).toEqual({ description: "app data", state: "Enabled", rotationPeriodInDays: null, pendingWindowInDays: null });
    expect(sh(state, `aws kms create-alias --alias-name alias/app-data --target-key-id ${keyId}`).error).toContain("AlreadyExistsException");
    expect(sh(state, `aws kms create-alias --alias-name alias/aws/x --target-key-id ${keyId}`).error).toContain("alias/aws/");
    expect(sh(state, `aws kms create-alias --alias-name app --target-key-id ${keyId}`).error).toContain("alias/");
  });

  it("rotation needs a key id, not an alias, and checks the period", () => {
    const { state, keyId } = appKey();
    expect(sh(state, "aws kms enable-key-rotation --key-id alias/app-data").error).toContain("不能用別名");
    expect(sh(state, `aws kms enable-key-rotation --key-id ${keyId} --rotation-period-in-days 30`).error).toContain("between 90 and 2560");
    const r = sh(state, `aws kms enable-key-rotation --key-id arn:aws:kms:us-east-1:123456789012:key/${keyId}`);
    expect(cloud(r.state).aws.kms.aliases["alias/app-data"].rotationPeriodInDays).toBe(365);
    expect(JSON.parse(sh(r.state, `aws kms get-key-rotation-status --key-id ${keyId}`).text).KeyRotationEnabled).toBe(true);
  });

  it("encrypts and decrypts round trip, following the documented base64 steps", () => {
    const { state } = appKey();
    const r = sh(
      state,
      "aws kms encrypt --key-id alias/app-data --plaintext fileb://secret.txt --output text --query CiphertextBlob > secret.b64",
      "base64 -d secret.b64 > secret.enc",
      "aws kms decrypt --ciphertext-blob fileb://secret.enc --key-id alias/app-data --output text --query Plaintext > plain.b64",
      "base64 -d plain.b64 > secret.out",
    );
    expect(r.errors).toEqual([]);
    expect(files(r.state)["~/secret.enc"]).not.toContain("S3cr3t");
    expect(files(r.state)["~/secret.out"]).toBe(SECRET);
  });

  it("explains a ciphertext that is still base64 text, and rejects the wrong key", () => {
    const { state } = appKey();
    const enc = sh(state, "aws kms encrypt --key-id alias/app-data --plaintext fileb://secret.txt --output text --query CiphertextBlob > secret.b64").state;
    expect(sh(enc, "aws kms decrypt --ciphertext-blob fileb://secret.b64").error).toContain("base64 -d");
    const binary = sh(enc, "base64 -d secret.b64 > secret.enc").state;
    expect(sh(binary, "aws kms decrypt --ciphertext-blob fileb://secret.enc --key-id alias/legacy-app").error).toContain("IncorrectKeyException");
  });

  it("disabled and pending-deletion keys cannot encrypt; deletion has a 7-30 day window", () => {
    const { state, keyId } = appKey();
    expect(sh(state, `aws kms disable-key --key-id ${keyId}`, "aws kms encrypt --key-id alias/app-data --plaintext fileb://secret.txt").error).toContain("DisabledException");
    expect(sh(state, `aws kms schedule-key-deletion --key-id ${keyId} --pending-window-in-days 3`).error).toContain("between 7 and 30");
    const pending = sh(state, `aws kms schedule-key-deletion --key-id ${keyId}`);
    expect(JSON.parse(pending.text).PendingWindowInDays).toBe(30);
    expect(sh(pending.state, "aws kms encrypt --key-id alias/app-data --plaintext fileb://secret.txt").error).toContain("pending deletion");
    const cancelled = sh(pending.state, `aws kms cancel-key-deletion --key-id ${keyId}`);
    expect(cloud(cancelled.state).aws.kms.aliases["alias/app-data"].state).toBe("Disabled");
  });

  it("limits plaintext to 4,096 bytes", () => {
    const { state } = appKey({ files: { "~/big.txt": "x".repeat(5000) } });
    expect(sh(state, "aws kms encrypt --key-id alias/app-data --plaintext fileb://big.txt").error).toContain("4,096");
  });
});

describe("aws wafv2", () => {
  const RULES = JSON.stringify([
    { Name: "common-rules", Priority: 0, Statement: { ManagedRuleGroupStatement: { VendorName: "AWS", Name: "AWSManagedRulesCommonRuleSet" } }, OverrideAction: { None: {} }, VisibilityConfig: {} },
  ]);
  const ACL = (rules: string) =>
    `aws wafv2 create-web-acl --name web-acl --scope REGIONAL --default-action Allow={} --visibility-config SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=web-acl --rules '${rules}'`;

  it("creates web ACLs with managed rule groups and IP sets", () => {
    const ip = sh(createLabState(), "aws wafv2 create-ip-set --name blocked --scope REGIONAL --ip-address-version IPV4 --addresses 203.0.113.0/24 198.51.100.7/32");
    const arn = field(ip.text, "ARN");
    const rules = JSON.stringify([
      JSON.parse(RULES)[0],
      { Name: "block-ips", Priority: 1, Statement: { IPSetReferenceStatement: { ARN: arn } }, Action: { Block: {} }, VisibilityConfig: {} },
    ]);
    const r = sh(ip.state, ACL(rules));
    expect(r.errors).toEqual([]);
    expect(cloud(r.state).aws.wafv2.webAcls["web-acl"]).toEqual({
      scope: "REGIONAL",
      defaultAction: "Allow",
      rules: { "common-rules": "managed:AWS/AWSManagedRulesCommonRuleSet", "block-ips": "ipset:blocked:Block" },
      associatedLoadBalancers: {},
    });
  });

  it("validates rules and IP addresses", () => {
    const managedWithAction = JSON.stringify([{ ...JSON.parse(RULES)[0], OverrideAction: undefined, Action: { Block: {} } }]);
    expect(sh(createLabState(), ACL(managedWithAction)).error).toContain("OverrideAction");
    expect(sh(createLabState(), "aws wafv2 create-ip-set --name b --scope REGIONAL --ip-address-version IPV4 --addresses 203.0.113.5").error).toContain("CIDR");
    expect(sh(createLabState(), "aws wafv2 create-ip-set --name b --scope GLOBAL --ip-address-version IPV4 --addresses 203.0.113.5/32").error).toContain("REGIONAL");
  });
});

describe("gcloud kms", () => {
  const LOC = "--keyring=app-ring --location=asia-east1";
  const KEY = [
    "gcloud kms keyrings create app-ring --location=asia-east1",
    `gcloud kms keys create app-key ${LOC} --purpose=encryption --rotation-period=90d --next-rotation-time=2027-01-01T00:00:00Z`,
  ];

  it("creates rotating keys and encrypts files", () => {
    const r = sh(
      createLabState(SEED),
      ...KEY,
      `gcloud kms encrypt --key=app-key ${LOC} --plaintext-file=secret.txt --ciphertext-file=secret.enc`,
      `gcloud kms decrypt --key=app-key ${LOC} --ciphertext-file=secret.enc --plaintext-file=secret.out`,
    );
    expect(r.errors).toEqual([]);
    expect(cloud(r.state).gcp.kms.keyRings["asia-east1/app-ring"].keys["app-key"]).toMatchObject({ rotationPeriod: "7776000s", primary: 1, versions: { "1": "ENABLED" } });
    expect(files(r.state)["~/secret.enc"]).not.toContain("S3cr3t");
    expect(files(r.state)["~/secret.out"]).toBe(SECRET);
  });

  it("old versions keep decrypting old data until they are destroyed; restore brings them back disabled", () => {
    let s = sh(createLabState(SEED), ...KEY, `gcloud kms encrypt --key=app-key ${LOC} --plaintext-file=secret.txt --ciphertext-file=secret.enc`).state;
    s = sh(s, `gcloud kms keys versions create --key=app-key ${LOC} --primary`).state;
    expect(sh(s, `gcloud kms decrypt --key=app-key ${LOC} --ciphertext-file=secret.enc --plaintext-file=a.out`).errors).toEqual([]);
    s = sh(s, `gcloud kms keys versions destroy 1 --key=app-key ${LOC}`).state;
    expect(sh(s, `gcloud kms decrypt --key=app-key ${LOC} --ciphertext-file=secret.enc --plaintext-file=a.out`).error).toContain("DESTROY_SCHEDULED");
    s = sh(s, `gcloud kms keys versions restore 1 --key=app-key ${LOC}`).state;
    expect(sh(s, `gcloud kms decrypt --key=app-key ${LOC} --ciphertext-file=secret.enc --plaintext-file=a.out`).error).toContain("DISABLED");
    s = sh(s, `gcloud kms keys versions enable 1 --key=app-key ${LOC}`).state;
    expect(cloud(s).gcp.kms.keyRings["asia-east1/app-ring"].keys["app-key"].recovered).toEqual({ "1": true });
    expect(files(sh(s, `gcloud kms decrypt --key=app-key ${LOC} --ciphertext-file=secret.enc --plaintext-file=a.out`).state)["~/a.out"]).toBe(SECRET);
  });

  it("validates names and options", () => {
    expect(sh(createLabState(), "gcloud kms keyrings create r").error).toContain("--location");
    expect(sh(createLabState(), "gcloud kms keys create k --keyring=r --location=global --purpose=encryption").error).toContain("NOT_FOUND");
    const s = sh(createLabState(), "gcloud kms keyrings create r --location=global").state;
    expect(sh(s, "gcloud kms keyrings create r --location=global").error).toContain("ALREADY_EXISTS");
    expect(sh(s, "gcloud kms keys create k --keyring=r --location=global --purpose=encryption --rotation-period=3months").error).toContain("rotation-period");
  });
});

describe("gcloud cloud armor", () => {
  const POLICY = ["gcloud compute security-policies create block-bad", "gcloud compute security-policies rules create 1000 --security-policy=block-bad --src-ip-ranges=203.0.113.0/24 --action=deny-403"];

  it("has an undeletable default rule and ordered rules", () => {
    const s = sh(createLabState(), ...POLICY).state;
    expect(cloud(s).gcp.securityPolicies["block-bad"].rules).toEqual({
      "1000": { action: "deny-403", srcIpRanges: ["203.0.113.0/24"], preview: false },
      "2147483647": { action: "allow", srcIpRanges: ["*"], preview: false },
    });
    expect(sh(s, "gcloud compute security-policies rules delete 2147483647 --security-policy=block-bad").error).toContain("不能刪除");
    expect(sh(s, POLICY[1]).error).toContain("same priorities");
    const u = sh(s, "gcloud compute security-policies rules update 2147483647 --security-policy=block-bad --action=deny-404");
    expect(cloud(u.state).gcp.securityPolicies["block-bad"].rules["2147483647"].action).toBe("deny-404");
  });

  it("attaches to backend services and cannot be deleted while in use", () => {
    const s = sh(
      createLabState(),
      ...POLICY,
      "gcloud compute health-checks create http web-hc --port=80",
      "gcloud compute backend-services create web-backend --protocol=HTTP --health-checks=web-hc --global",
      "gcloud compute backend-services update web-backend --security-policy=block-bad --global",
    ).state;
    expect(cloud(s).gcp.backendServices["web-backend"].securityPolicy).toBe("block-bad");
    expect(sh(s, "gcloud compute security-policies delete block-bad").error).toContain("already being used");
    expect(sh(s, "gcloud compute backend-services update web-backend --security-policy=nope --global").error).toContain("was not found");
  });
});

describe("security labs can be completed", () => {
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

  it("aws-kms-waf", () => {
    const keyId = (o: string) => field(o, "KeyId");
    expect(
      play("aws-kms-waf", [
        ['aws kms create-key --description "app data"', (o) => `aws kms create-alias --alias-name alias/app-data --target-key-id ${keyId(o)}`],
        ["aws kms enable-key-rotation --key-id alias/app-data", (o) => `aws kms enable-key-rotation --key-id ${keyId(o)}`, (o) => `aws kms get-key-rotation-status --key-id ${keyId(o)}`],
        ["aws kms encrypt --key-id alias/app-data --plaintext fileb://secret.txt --output text --query CiphertextBlob > secret.b64", "base64 -d secret.b64 > secret.enc", "cat secret.enc"],
        ["aws kms decrypt --ciphertext-blob fileb://secret.enc --key-id alias/app-data --output text --query Plaintext > plain.b64", "base64 -d plain.b64 > secret.out"],
        [
          "aws kms list-aliases",
          (o) => `aws kms schedule-key-deletion --key-id ${/"AliasName": "alias\/legacy-app"[^}]*"TargetKeyId": "([^"]+)"/.exec(o)![1]} --pending-window-in-days 7`,
        ],
        [
          "cat waf-rules.json",
          "aws wafv2 create-web-acl --name web-acl --scope REGIONAL --default-action Allow={} --visibility-config SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=web-acl --rules file://waf-rules.json",
        ],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gcp-kms-armor", () => {
    const LOC = "--key=app-key --keyring=app-ring --location=asia-east1";
    expect(
      play("gcp-kms-armor", [
        [
          "gcloud kms keyrings create app-ring --location=asia-east1",
          "gcloud kms keys create app-key --keyring=app-ring --location=asia-east1 --purpose=encryption --rotation-period=90d --next-rotation-time=2027-01-01T00:00:00Z",
        ],
        [`gcloud kms encrypt ${LOC} --plaintext-file=secret.txt --ciphertext-file=secret.enc`, `gcloud kms decrypt ${LOC} --ciphertext-file=secret.enc --plaintext-file=secret.out`],
        [
          `gcloud kms keys versions create ${LOC} --primary`,
          `gcloud kms keys versions destroy 1 ${LOC}`,
          `gcloud kms decrypt ${LOC} --ciphertext-file=secret.enc --plaintext-file=again.out`,
          `gcloud kms keys versions restore 1 ${LOC}`,
          `gcloud kms keys versions enable 1 ${LOC}`,
        ],
        ['gcloud compute security-policies create block-bad --description="block bad IPs"', "gcloud compute security-policies rules create 1000 --security-policy=block-bad --src-ip-ranges=203.0.113.0/24 --action=deny-403"],
        [
          "gcloud compute health-checks create http web-hc --port=80",
          "gcloud compute backend-services create web-backend --protocol=HTTP --health-checks=web-hc --global",
          "gcloud compute backend-services update web-backend --security-policy=block-bad --global",
        ],
      ]),
    ).toEqual([1, 2, 3, 4, 5]);
  });
});
