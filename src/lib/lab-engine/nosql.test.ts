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

const CREATE =
  "aws dynamodb create-table --table-name Orders --attribute-definitions AttributeName=CustomerId,AttributeType=S AttributeName=OrderId,AttributeType=S --key-schema AttributeName=CustomerId,KeyType=HASH AttributeName=OrderId,KeyType=RANGE --billing-mode PAY_PER_REQUEST";
const put = (customer: string, order: string, extra = "") =>
  `aws dynamodb put-item --table-name Orders --item '{"CustomerId": {"S": "${customer}"}, "OrderId": {"S": "${order}"}${extra}}'`;
const withOrders = () => sh(createLabState(), CREATE, put("c001", "o002"), put("c001", "o001", ', "Total": {"N": "350"}'), put("c002", "o001"), put("c001", "x010")).state;
const query = (state: LabState, expression: string, values: string, extra = "") =>
  sh(state, `aws dynamodb query --table-name Orders --key-condition-expression "${expression}" --expression-attribute-values '${values}'${extra}`);

describe("aws dynamodb tables", () => {
  it("creates an on-demand table with a composite key", () => {
    const r = sh(createLabState(), CREATE);
    const desc = JSON.parse(r.text).TableDescription;
    expect(desc).toMatchObject({ TableName: "Orders", TableStatus: "CREATING", BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" }, ItemCount: 0 });
    expect(desc.KeySchema).toEqual([{ AttributeName: "CustomerId", KeyType: "HASH" }, { AttributeName: "OrderId", KeyType: "RANGE" }]);
    expect(cloud(r.state).aws.dynamodb.tables.Orders.definition).toEqual({ partitionKey: "CustomerId", sortKey: "OrderId", billingMode: "PAY_PER_REQUEST" });
    expect(JSON.parse(sh(r.state, "aws dynamodb describe-table --table-name Orders").text).Table.TableStatus).toBe("ACTIVE");
    expect(JSON.parse(sh(r.state, "aws dynamodb list-tables").text)).toEqual({ TableNames: ["Orders"] });
    expect(sh(r.state, CREATE).error).toMatch(/ResourceInUseException/);
  });

  it("supports provisioned capacity and simple keys", () => {
    const r = sh(createLabState(), "aws dynamodb create-table --table-name Users --attribute-definitions AttributeName=UserId,AttributeType=N --key-schema AttributeName=UserId,KeyType=HASH --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=2");
    expect(JSON.parse(r.text).TableDescription.ProvisionedThroughput).toMatchObject({ ReadCapacityUnits: 5, WriteCapacityUnits: 2 });
    expect(cloud(r.state).aws.dynamodb.tables.Users.definition).toEqual({ partitionKey: "UserId", sortKey: null, billingMode: "PROVISIONED" });
  });

  it("validates the table definition", () => {
    const s = createLabState();
    const base = "aws dynamodb create-table --table-name T01 --attribute-definitions AttributeName=Id,AttributeType=S --key-schema AttributeName=Id,KeyType=HASH";
    expect(sh(s, base).error).toMatch(/PAY_PER_REQUEST[\s\S]*--provisioned-throughput/);
    expect(sh(s, `${base} --billing-mode PAY_PER_REQUEST --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1`).error).toMatch(/can be specified when BillingMode is PAY_PER_REQUEST/);
    expect(sh(s, `${base} --billing-mode ON_DEMAND`).error).toMatch(/enum value set/);
    expect(sh(s, `${base.replace("T01", "T1")} --billing-mode PAY_PER_REQUEST`).error).toMatch(/between 3 and 255/);
    expect(sh(s, `${base.replace("AttributeName=Id,AttributeType=S", "AttributeName=Id,AttributeType=S AttributeName=Name,AttributeType=S")} --billing-mode PAY_PER_REQUEST`).error).toMatch(/does not exactly match/);
    expect(sh(s, `${base.replace("AttributeType=S", "AttributeType=BOOL")} --billing-mode PAY_PER_REQUEST`).error).toMatch(/S（字串）、N（數字）或 B/);
    expect(sh(s, `${base.replace("KeyType=HASH", "KeyType=RANGE")} --billing-mode PAY_PER_REQUEST`).error).toMatch(/KeyType=HASH/);
    expect(sh(s, `${base.replace("AttributeName=Id,AttributeType=S", "Id:S")} --billing-mode PAY_PER_REQUEST`).error).toMatch(/AttributeName=名稱,AttributeType=S/);
    expect(sh(s, "aws dynamodb create-table --table-name T01").error).toMatch(/required: --attribute-definitions, --key-schema/);
    expect(sh(s, "aws dynamodb describe-table --table-name Nope").error).toMatch(/ResourceNotFoundException.*Nope not found/);
  });

  it("deletes tables", () => {
    const r = sh(sh(createLabState(), CREATE).state, "aws dynamodb delete-table --table-name Orders");
    expect(JSON.parse(r.text).TableDescription.TableStatus).toBe("DELETING");
    expect(cloud(r.state).aws.dynamodb.tables).toEqual({});
  });
});

describe("aws dynamodb items", () => {
  it("puts, replaces, gets and deletes items by their full key", () => {
    let s = withOrders();
    expect(cloud(s).aws.dynamodb.tables.Orders.itemCount).toBe(4);
    s = sh(s, put("c001", "o001", ', "Total": {"N": "999"}')).state;
    expect(cloud(s).aws.dynamodb.tables.Orders.itemCount).toBe(4);
    const got = sh(s, `aws dynamodb get-item --table-name Orders --key '{"CustomerId": {"S": "c001"}, "OrderId": {"S": "o001"}}'`);
    expect(JSON.parse(got.text).Item.Total).toEqual({ N: "999" });
    expect(sh(s, `aws dynamodb get-item --table-name Orders --key '{"CustomerId": {"S": "c009"}, "OrderId": {"S": "o001"}}'`).text).toBe("");
    expect(sh(s, `aws dynamodb get-item --table-name Orders --key '{"CustomerId": {"S": "c001"}}'`).error).toMatch(/does not match the schema/);
    const deleted = sh(s, `aws dynamodb delete-item --table-name Orders --key '{"CustomerId": {"S": "c002"}, "OrderId": {"S": "o001"}}'`).state;
    expect(cloud(deleted).aws.dynamodb.tables.Orders.items["c002|o001"]).toBeUndefined();
    expect(JSON.parse(sh(deleted, "aws dynamodb scan --table-name Orders").text).Count).toBe(3);
  });

  it("rejects items without the key, with the wrong key type or untyped values", () => {
    const s = sh(createLabState(), CREATE).state;
    expect(sh(s, `aws dynamodb put-item --table-name Orders --item '{"CustomerId": {"S": "c001"}}'`).error).toMatch(/Missing the key OrderId/);
    expect(sh(s, `aws dynamodb put-item --table-name Orders --item '{"CustomerId": {"N": "1"}, "OrderId": {"S": "o1"}}'`).error).toMatch(/Type mismatch for key CustomerId expected: S actual: N/);
    expect(sh(s, `aws dynamodb put-item --table-name Orders --item '{"CustomerId": "c001", "OrderId": {"S": "o1"}}'`).error).toMatch(/帶型別的格式/);
    expect(sh(s, `aws dynamodb put-item --table-name Orders --item '{"CustomerId": {"S": "c1"}, "OrderId": {"S": "o1"}, "Total": {"N": "abc"}}'`).error).toMatch(/cannot be converted into a number/);
    expect(sh(s, `aws dynamodb put-item --table-name Orders --item {CustomerId}`).error).toMatch(/Invalid JSON[\s\S]*單引號/);
    expect(sh(s, "aws dynamodb put-item --table-name Orders --item file://item.json").error).toMatch(/Unable to load paramfile/);
    const fromFile = sh(createLabState({ files: { "~/item.json": '{"CustomerId": {"S": "c1"}, "OrderId": {"S": "o1"}}' } }), CREATE, "aws dynamodb put-item --table-name Orders --item file://item.json");
    expect(cloud(fromFile.state).aws.dynamodb.tables.Orders.items).toEqual({ "c1|o1": true });
  });
});

describe("aws dynamodb query", () => {
  const ids = (r: ReturnType<typeof sh>) => JSON.parse(r.text).Items.map((i: any) => i.OrderId.S);

  it("returns one partition sorted by the sort key and records the queried partition", () => {
    const r = query(withOrders(), "CustomerId = :c", '{":c": {"S": "c001"}}');
    expect(ids(r)).toEqual(["o001", "o002", "x010"]);
    expect(JSON.parse(r.text).Count).toBe(3);
    expect(cloud(r.state).aws.dynamodb.tables.Orders.queriedPartitions).toEqual({ c001: true });
    expect(ids(query(withOrders(), "CustomerId = :c", '{":c": {"S": "c001"}}', " --no-scan-index-forward"))).toEqual(["x010", "o002", "o001"]);
  });

  it("supports sort key conditions and attribute name placeholders", () => {
    const s = withOrders();
    expect(ids(query(s, "CustomerId = :c AND begins_with(OrderId, :p)", '{":c": {"S": "c001"}, ":p": {"S": "o"}}'))).toEqual(["o001", "o002"]);
    expect(ids(query(s, "CustomerId = :c and OrderId BETWEEN :a AND :b", '{":c": {"S": "c001"}, ":a": {"S": "o002"}, ":b": {"S": "x999"}}'))).toEqual(["o002", "x010"]);
    expect(ids(query(s, "CustomerId = :c AND OrderId > :a", '{":c": {"S": "c001"}, ":a": {"S": "o001"}}'))).toEqual(["o002", "x010"]);
    expect(ids(query(s, "OrderId = :o AND CustomerId = :c", '{":c": {"S": "c001"}, ":o": {"S": "o002"}}'))).toEqual(["o002"]);
    expect(ids(query(s, "#cid = :c", '{":c": {"S": "c002"}}', ` --expression-attribute-names '{"#cid": "CustomerId"}'`))).toEqual(["o001"]);
  });

  it("explains invalid queries", () => {
    const s = withOrders();
    expect(query(s, "OrderId = :o", '{":o": {"S": "o001"}}').error).toMatch(/missed key schema element: CustomerId/);
    expect(query(s, "CustomerId > :c", '{":c": {"S": "c001"}}').error).toMatch(/missed key schema element/);
    expect(query(s, "CustomerId = :c AND Total = :t", '{":c": {"S": "c001"}, ":t": {"N": "350"}}').error).toMatch(/Query key condition not supported/);
    expect(query(s, "CustomerId = :c", '{":x": {"S": "c001"}}').error).toMatch(/attribute value: :c/);
    expect(query(s, "CustomerId = :c", '{":c": {"N": "1"}}').error).toMatch(/type does not match schema type/);
    expect(query(s, "CustomerId == :c", '{":c": {"S": "c001"}}').error).toMatch(/Syntax error/);
    expect(query(s, "#x = :c", '{":c": {"S": "c001"}}').error).toMatch(/attribute name: #x/);
  });

  it("compares number sort keys numerically", () => {
    const s = sh(
      createLabState(),
      "aws dynamodb create-table --table-name Readings --attribute-definitions AttributeName=Sensor,AttributeType=S AttributeName=Time,AttributeType=N --key-schema AttributeName=Sensor,KeyType=HASH AttributeName=Time,KeyType=RANGE --billing-mode PAY_PER_REQUEST",
      `aws dynamodb put-item --table-name Readings --item '{"Sensor": {"S": "a"}, "Time": {"N": "100"}}'`,
      `aws dynamodb put-item --table-name Readings --item '{"Sensor": {"S": "a"}, "Time": {"N": "9"}}'`,
      `aws dynamodb put-item --table-name Readings --item '{"Sensor": {"S": "a"}, "Time": {"N": "20"}}'`,
    ).state;
    const r = sh(s, `aws dynamodb query --table-name Readings --key-condition-expression "Sensor = :s AND #t >= :t" --expression-attribute-names '{"#t": "Time"}' --expression-attribute-values '{":s": {"S": "a"}, ":t": {"N": "10"}}'`);
    expect(JSON.parse(r.text).Items.map((i: any) => i.Time.N)).toEqual(["20", "100"]);
  });
});

describe("aws dynamodb ttl", () => {
  it("enables and disables TTL on one attribute", () => {
    let s = sh(createLabState(), CREATE).state;
    expect(JSON.parse(sh(s, "aws dynamodb describe-time-to-live --table-name Orders").text).TimeToLiveDescription.TimeToLiveStatus).toBe("DISABLED");
    const r = sh(s, "aws dynamodb update-time-to-live --table-name Orders --time-to-live-specification Enabled=true,AttributeName=ExpiresAt");
    expect(JSON.parse(r.text)).toEqual({ TimeToLiveSpecification: { Enabled: true, AttributeName: "ExpiresAt" } });
    s = r.state;
    expect(cloud(s).aws.dynamodb.tables.Orders.ttlAttribute).toBe("ExpiresAt");
    expect(sh(s, "aws dynamodb update-time-to-live --table-name Orders --time-to-live-specification Enabled=true,AttributeName=Other").error).toMatch(/already enabled/);
    expect(cloud(sh(s, "aws dynamodb update-time-to-live --table-name Orders --time-to-live-specification Enabled=false,AttributeName=ExpiresAt").state).aws.dynamodb.tables.Orders.ttlAttribute).toBeNull();
    expect(sh(s, "aws dynamodb update-time-to-live --table-name Orders --time-to-live-specification ExpiresAt").error).toMatch(/Enabled=true,AttributeName=/);
  });
});

describe("gcloud firestore", () => {
  const created = () => sh(createLabState(), "gcloud firestore databases create --location=asia-east1");

  it("creates the default database with gcloud's defaults", () => {
    const r = created();
    expect(r.text).toMatch(/^Created database \[\(default\)\]\.\ndatabaseEdition: STANDARD[\s\S]*locationId: asia-east1[\s\S]*type: FIRESTORE_NATIVE$/);
    expect(cloud(r.state).gcp.firestore.databases["(default)"]).toEqual({
      location: "asia-east1",
      type: "firestore-native",
      edition: "standard",
      deleteProtection: false,
      indexes: {},
      ttlFields: {},
      exportCount: 0,
    });
    expect(sh(r.state, "gcloud firestore databases list").out[1]).toMatch(/^\(default\)\s+asia-east1\s+FIRESTORE_NATIVE$/);
  });

  it("validates locations, ids and options, and never changes a location", () => {
    expect(sh(createLabState(), "gcloud firestore databases create").error).toMatch(/--location: Must be specified/);
    expect(sh(createLabState(), "gcloud firestore databases create --location=taiwan").error).toMatch(/Invalid locationId/);
    expect(cloud(sh(createLabState(), "gcloud firestore databases create --location=nam5 --database=analytics --type=datastore-mode --edition=enterprise").state).gcp.firestore.databases.analytics).toMatchObject({ location: "nam5", type: "datastore-mode", edition: "enterprise" });
    expect(sh(createLabState(), "gcloud firestore databases create --location=nam5 --database=ab").error).toMatch(/4 到 63 個字元/);
    expect(sh(createLabState(), "gcloud firestore databases create --location=nam5 --type=mongo").error).toMatch(/Invalid choice/);
    const s = created().state;
    expect(sh(s, "gcloud firestore databases create --location=nam5").error).toMatch(/ALREADY_EXISTS[\s\S]*不能更改位置/);
    expect(sh(s, "gcloud firestore databases update --location=nam5").error).toMatch(/不能更改位置/);
    expect(sh(createLabState(), "gcloud firestore databases describe").error).toMatch(/NOT_FOUND: The database \(default\) does not exist/);
  });

  it("creates manual indexes with at least two fields", () => {
    const s = created().state;
    const base = "gcloud firestore indexes composite create --collection-group=orders";
    const r = sh(s, `${base} --field-config=field-path=customerId,order=ascending --field-config field-path=createdAt,order=descending`);
    expect(r.text).toMatch(/Created index \[orders\(customerId ASCENDING, createdAt DESCENDING\)\]/);
    expect(cloud(r.state).gcp.firestore.databases["(default)"].indexes).toEqual({ "orders(customerId ASCENDING, createdAt DESCENDING)": true });
    expect(sh(r.state, "gcloud firestore indexes composite list").out[1]).toBe("orders(customerId ASCENDING, createdAt DESCENDING)");
    expect(sh(s, `${base} --field-config=field-path=customerId,order=ascending`).error).toMatch(/not necessary[\s\S]*至少要兩個欄位/);
    expect(sh(s, `${base} --field-config=field-path=tags,array-config=contains --field-config=field-path=createdAt,order=descending`).error).toBe("");
    expect(sh(s, `${base} --field-config=field-path=a,order=up --field-config=field-path=b,order=ascending`).error).toMatch(/ascending 或 descending/);
    expect(sh(s, `${base} --field-config=field-path=a --field-config=field-path=b,order=ascending`).error).toMatch(/Exactly one of/);
    expect(sh(s, "gcloud firestore indexes composite create --field-config=field-path=a,order=ascending").error).toMatch(/--collection-group: Must be specified/);
    expect(sh(r.state, `${base} --field-config=field-path=customerId,order=ascending --field-config=field-path=createdAt,order=descending`).error).toMatch(/ALREADY_EXISTS/);
    expect(sh(createLabState(), `${base} --field-config=field-path=a,order=ascending --field-config=field-path=b,order=ascending`).error).toMatch(/does not exist/);
  });

  it("enables and disables TTL on a field", () => {
    const s = sh(created().state, "gcloud firestore fields ttls update expiresAt --collection-group=sessions --enable-ttl").state;
    expect(cloud(s).gcp.firestore.databases["(default)"].ttlFields).toEqual({ "sessions.expiresAt": true });
    expect(sh(s, "gcloud firestore fields ttls list").out[1]).toMatch(/^sessions\s+expiresAt\s+ACTIVE$/);
    expect(cloud(sh(s, "gcloud firestore fields ttls update expiresAt --collection-group=sessions --disable-ttl").state).gcp.firestore.databases["(default)"].ttlFields).toEqual({});
    expect(sh(s, "gcloud firestore fields ttls update expiresAt --collection-group=sessions").error).toMatch(/Exactly one of/);
    expect(sh(s, "gcloud firestore fields ttls update expiresAt --enable-ttl").error).toMatch(/--collection-group: Must be specified/);
  });

  it("exports to an existing Cloud Storage bucket", () => {
    const s = created().state;
    expect(sh(s, "gcloud firestore export gs://missing").error).toMatch(/Bucket missing does not exist/);
    expect(sh(s, "gcloud firestore export ./backup").error).toMatch(/gs:\/\//);
    const r = sh(s, "gcloud storage buckets create gs://fs-backup --location=asia-east1", "gcloud firestore export gs://fs-backup");
    expect(r.text).toMatch(/outputUriPrefix: gs:\/\/fs-backup\/2026-11-16T00:00:00_00001/);
    expect(cloud(r.state).gcp.firestore.databases["(default)"].exportCount).toBe(1);
    expect(Object.keys(cloud(r.state).gcs.buckets["fs-backup"].objects)).toEqual(["2026-11-16T00:00:00_00001/2026-11-16T00:00:00_00001.overall_export_metadata"]);
    const nested = sh(r.state, "gcloud firestore export gs://fs-backup/daily/");
    expect(Object.keys(cloud(nested.state).gcs.buckets["fs-backup"].objects)[1]).toBe("daily/2026-11-16T00:00:00_00002/2026-11-16T00:00:00_00002.overall_export_metadata");
  });

  it("honours delete protection", () => {
    let s = sh(created().state, "gcloud firestore databases update --database='(default)' --delete-protection").state;
    expect(cloud(s).gcp.firestore.databases["(default)"].deleteProtection).toBe(true);
    expect(sh(s, "gcloud firestore databases delete --database='(default)'").error).toMatch(/Delete protection is enabled/);
    s = sh(s, "gcloud firestore databases update --no-delete-protection", "gcloud firestore databases delete --database='(default)'").state;
    expect(cloud(s).gcp.firestore.databases).toEqual({});
    expect(sh(created().state, "gcloud firestore databases delete").error).toMatch(/--database: Must be specified/);
    expect(sh(createLabState(), "gcloud firestore import gs://x").error).toMatch(/不支援 'import'/);
  });
});

// ------------------------------------------------------------- the labs

describe("nosql labs can be completed", () => {
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

  it("aws-dynamodb-table", () => {
    expect(
      play("aws-dynamodb-table", [
        [CREATE],
        [put("c001", "o001", ', "Total": {"N": "350"}')],
        [put("c001", "o002", ', "Total": {"N": "120"}'), put("c002", "o001")],
        [`aws dynamodb query --table-name Orders --key-condition-expression "CustomerId = :c" --expression-attribute-values '{":c": {"S": "c001"}}'`],
        ["aws dynamodb update-time-to-live --table-name Orders --time-to-live-specification Enabled=true,AttributeName=ExpiresAt"],
        [`aws dynamodb delete-item --table-name Orders --key '{"CustomerId": {"S": "c002"}, "OrderId": {"S": "o001"}}'`],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("aws-dynamodb-table: a provisioned table or a query on Total does not pass", () => {
    expect(
      play("aws-dynamodb-table", [
        [CREATE.replace("--billing-mode PAY_PER_REQUEST", "--provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5")],
        ["aws dynamodb delete-table --table-name Orders", CREATE, put("c001", "o001"), put("c001", "o002"), put("c002", "o001")],
        [`aws dynamodb query --table-name Orders --key-condition-expression "Total = :t" --expression-attribute-values '{":t": {"N": "350"}}'`],
        [`aws dynamodb query --table-name Orders --key-condition-expression "CustomerId = :c" --expression-attribute-values '{":c": {"S": "c001"}}'`],
      ]),
    ).toEqual([0, 3, 3, 4]);
  });

  it("gcp-firestore-database", () => {
    expect(
      play("gcp-firestore-database", [
        ["gcloud firestore databases create --location=asia-east1"],
        ["gcloud firestore indexes composite create --collection-group=orders --field-config=field-path=customerId,order=ascending --field-config=field-path=createdAt,order=descending"],
        ["gcloud firestore fields ttls update expiresAt --collection-group=sessions --enable-ttl"],
        ["gcloud storage buckets create gs://lab-firestore-backup --location=asia-east1", "gcloud firestore export gs://lab-firestore-backup"],
        ["gcloud firestore databases update --database='(default)' --delete-protection"],
      ]),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("gcp-firestore-database: the index fields must be in the query's order", () => {
    expect(
      play("gcp-firestore-database", [
        ["gcloud firestore databases create --location=asia-east1"],
        ["gcloud firestore indexes composite create --collection-group=orders --field-config=field-path=createdAt,order=descending --field-config=field-path=customerId,order=ascending"],
        ["gcloud firestore export gs://lab-firestore-backup"],
      ]),
    ).toEqual([1, 1, 1]);
  });
});
