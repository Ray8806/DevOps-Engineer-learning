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

const COSTS = {
  cloud: {
    aws: {
      costs: [
        { month: "2026-10", service: "Amazon Elastic Compute Cloud - Compute", amount: 300, tags: { Project: "data" } },
        { month: "2026-10", service: "Amazon Elastic Compute Cloud - Compute", amount: 100, tags: { Project: "web" } },
        { month: "2026-10", service: "Amazon Simple Storage Service", amount: 10, tags: {} },
        { month: "2026-11", service: "Amazon Simple Storage Service", amount: 5, tags: {} },
      ],
    },
  },
};
const OCT = "--time-period Start=2026-10-01,End=2026-11-01 --granularity MONTHLY --metrics UnblendedCost";
const usage = (s: LabState, extra = "") => JSON.parse(sh(s, `aws ce get-cost-and-usage ${OCT} ${extra}`).text);

describe("aws cost explorer", () => {
  it("totals and groups by service", () => {
    const s = createLabState(COSTS);
    expect(usage(s).ResultsByTime[0].Total.UnblendedCost).toEqual({ Amount: "410", Unit: "USD" });
    const groups = usage(s, "--group-by Type=DIMENSION,Key=SERVICE").ResultsByTime[0].Groups;
    expect(groups.map((g: any) => [g.Keys[0], g.Metrics.UnblendedCost.Amount])).toEqual([
      ["Amazon Elastic Compute Cloud - Compute", "400"],
      ["Amazon Simple Storage Service", "10"],
    ]);
  });

  it("puts everything in Key$ until the tag is activated", () => {
    const s = createLabState(COSTS);
    const before = usage(s, "--group-by Type=TAG,Key=Project").ResultsByTime[0].Groups;
    expect(before.map((g: any) => g.Keys[0])).toEqual(["Project$"]);
    expect(JSON.parse(sh(s, "aws ce list-cost-allocation-tags").text).CostAllocationTags[0]).toMatchObject({ TagKey: "Project", Status: "Inactive" });
    const active = sh(s, "aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=Project,Status=Active").state;
    const after = usage(active, "--group-by Type=TAG,Key=Project").ResultsByTime[0].Groups;
    expect(after.map((g: any) => [g.Keys[0], g.Metrics.UnblendedCost.Amount])).toEqual([
      ["Project$data", "300"],
      ["Project$web", "100"],
      ["Project$", "10"],
    ]);
    expect(cloud(active).aws.ce.costAllocationTags).toEqual({ Project: "Active" });
    expect(JSON.parse(sh(s, "aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=Team,Status=Active").text).Errors).toHaveLength(1);
  });

  it("splits a range into months and marks the current month as estimated", () => {
    const r = JSON.parse(sh(createLabState(COSTS), "aws ce get-cost-and-usage --time-period Start=2026-10-01,End=2026-12-01 --granularity MONTHLY --metrics UnblendedCost").text);
    expect(r.ResultsByTime.map((x: any) => [x.TimePeriod.Start, x.Total.UnblendedCost.Amount, x.Estimated])).toEqual([
      ["2026-10-01", "410", false],
      ["2026-11-01", "5", true],
    ]);
  });

  it("validates time periods, granularity and grouping", () => {
    const s = createLabState(COSTS);
    expect(sh(s, "aws ce get-cost-and-usage --time-period Start=2026-11-01,End=2026-10-01 --granularity MONTHLY --metrics UnblendedCost").error).toContain("before End");
    expect(sh(s, "aws ce get-cost-and-usage --time-period Start=2026-10-01,End=2026-11-01 --granularity DAILY --metrics UnblendedCost").error).toContain("MONTHLY");
    expect(sh(s, `aws ce get-cost-and-usage ${OCT} --group-by Type=DIMENSION,Key=REGION`).error).toContain("SERVICE");
  });

  it("forecasts from last month's daily average, from today on", () => {
    const s = createLabState(COSTS);
    expect(sh(s, "aws ce get-cost-forecast --time-period Start=2026-11-01,End=2026-12-01 --metric UNBLENDED_COST --granularity MONTHLY").error).toContain("current date");
    const r = sh(s, "aws ce get-cost-forecast --time-period Start=2026-11-16,End=2026-12-01 --metric UNBLENDED_COST --granularity MONTHLY");
    expect(Number(JSON.parse(r.text).Total.Amount)).toBeCloseTo((410 / 31) * 15, 4);
    expect(cloud(r.state).aws.ce.queries).toEqual({ FORECAST: true });
  });
});

describe("aws budgets", () => {
  const BUDGET = `'${JSON.stringify({ BudgetName: "monthly", BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: "500", Unit: "USD" } })}'`;
  const NOTES = `'${JSON.stringify([
    { Notification: { NotificationType: "ACTUAL", ComparisonOperator: "GREATER_THAN", Threshold: 80, ThresholdType: "PERCENTAGE" }, Subscribers: [{ SubscriptionType: "EMAIL", Address: "a@example.com" }] },
  ])}'`;

  it("creates budgets with notifications", () => {
    const r = sh(createLabState(), `aws budgets create-budget --account-id 123456789012 --budget ${BUDGET} --notifications-with-subscribers ${NOTES}`);
    expect(r.errors).toEqual([]);
    expect(cloud(r.state).aws.budgets.monthly).toEqual({ limit: "500 USD", timeUnit: "MONTHLY", notifications: { "ACTUAL > 80%": { "email:a@example.com": true } } });
    expect(sh(r.state, `aws budgets create-budget --account-id 123456789012 --budget ${BUDGET}`).error).toContain("DuplicateRecordException");
    expect(JSON.parse(sh(r.state, "aws budgets describe-budgets --account-id 123456789012").text).Budgets[0].BudgetName).toBe("monthly");
  });

  it("checks the account, amounts and notification fields", () => {
    expect(sh(createLabState(), `aws budgets create-budget --account-id 111111111111 --budget ${BUDGET}`).error).toContain("123456789012");
    const numeric = `'${JSON.stringify({ BudgetName: "b", BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: 500, Unit: "USD" } })}'`;
    expect(sh(createLabState(), `aws budgets create-budget --account-id 123456789012 --budget ${numeric}`).error).toContain("Amount 是字串");
    const bad = `'${JSON.stringify([{ Notification: { NotificationType: "LATER", ComparisonOperator: "GREATER_THAN", Threshold: 80 }, Subscribers: [] }])}'`;
    expect(sh(createLabState(), `aws budgets create-budget --account-id 123456789012 --budget ${BUDGET} --notifications-with-subscribers ${bad}`).error).toContain("FORECASTED");
  });
});

describe("gcloud billing and labels", () => {
  const SEED = { cloud: { gcp: { billingAccount: { id: "01A2B3-C4D5E6-F7G8H9" }, instances: { "web-1": { zone: "asia-east1-b" } } } } };

  it("lists the billing account and creates budgets with repeated threshold rules", () => {
    const s = createLabState(SEED);
    expect(sh(s, "gcloud billing accounts list").text).toContain("01A2B3-C4D5E6-F7G8H9");
    expect(sh(s, "gcloud billing projects describe my-project").text).toContain("billingEnabled: true");
    const r = sh(
      s,
      "gcloud billing budgets create --billing-account=01A2B3-C4D5E6-F7G8H9 --display-name=monthly --budget-amount=300USD --threshold-rule=percent=0.5 --threshold-rule percent=0.9 --threshold-rule=percent=1.0,basis=forecasted-spend",
    );
    expect(r.text).toContain("不會自動停止花費");
    expect(cloud(r.state).gcp.billing.budgets.monthly).toEqual({
      amount: "300 USD",
      thresholds: { "50%": "current-spend", "90%": "current-spend", "100%": "forecasted-spend" },
      filterLabels: {},
      filterProjects: {},
    });
  });

  it("validates budget arguments", () => {
    const s = createLabState(SEED);
    expect(sh(s, "gcloud billing budgets create --billing-account=0X0X0X-0X0X0X-0X0X0X --display-name=b --budget-amount=10").error).toContain("NOT_FOUND");
    expect(sh(s, "gcloud billing budgets create --billing-account=01A2B3-C4D5E6-F7G8H9 --display-name=b --budget-amount=10EUR").error).toContain("USD");
    expect(sh(s, "gcloud billing budgets create --billing-account=01A2B3-C4D5E6-F7G8H9 --display-name=b --budget-amount=10 --threshold-rule=percent=90").error).toContain("0.9");
  });

  it("adds and removes instance labels", () => {
    const s = createLabState(SEED);
    expect(sh(s, "gcloud compute instances add-labels web-1 --zone=asia-east1-b --labels=Team=web").error).toContain("小寫");
    const r = sh(s, "gcloud compute instances add-labels web-1 --zone=asia-east1-b --labels=team=web,env=prod");
    expect(cloud(r.state).gcp.instances["web-1"].labels).toEqual({ team: "web", env: "prod" });
    expect(sh(r.state, "gcloud compute instances describe web-1 --zone=asia-east1-b").text).toContain("labels:\n  env: prod\n  team: web");
    const removed = sh(r.state, "gcloud compute instances remove-labels web-1 --zone=asia-east1-b --labels=env");
    expect(cloud(removed.state).gcp.instances["web-1"].labels).toEqual({ team: "web" });
  });
});

describe("cost labs can be completed", () => {
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

  it("aws-cost-budgets", () => {
    expect(
      play("aws-cost-budgets", [
        [`aws ce get-cost-and-usage ${OCT} --group-by Type=DIMENSION,Key=SERVICE`],
        [`aws ce get-cost-and-usage ${OCT} --group-by Type=TAG,Key=Project`, "aws ce list-cost-allocation-tags", "aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=Project,Status=Active"],
        [`aws ce get-cost-and-usage ${OCT} --group-by Type=TAG,Key=Project`, (o) => `echo ${/"Project\$([a-z-]+)"/.exec(o)![1]} > ~/top-project.txt`],
        ["aws ce get-cost-forecast --time-period Start=2026-11-16,End=2026-12-01 --metric UNBLENDED_COST --granularity MONTHLY"],
        ["cat budget.json", "cat notifications.json", "aws budgets create-budget --account-id 123456789012 --budget file://budget.json --notifications-with-subscribers file://notifications.json"],
        ["aws ec2 describe-volumes", "aws ec2 delete-volume --volume-id vol-0a1b2c3d4e5f60718", "aws ec2 delete-volume --volume-id vol-0f9e8d7c6b5a49382"],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gcp-billing-budgets", () => {
    const account = (o: string) => /^([0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6})\s/m.exec(o)![1];
    expect(
      play("gcp-billing-budgets", [
        [
          "gcloud billing accounts list",
          "gcloud billing projects describe my-project",
          (o) =>
            `gcloud billing budgets create --billing-account=${account(o)} --display-name=monthly-budget --budget-amount=300USD --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0,basis=forecasted-spend`,
        ],
        ["gcloud compute instances add-labels web-1 --zone=asia-east1-b --labels=team=web,env=prod", "gcloud compute instances describe web-1 --zone=asia-east1-b"],
        [(o) => `gcloud billing budgets create --billing-account=${account(o)} --display-name=data-team --budget-amount=100USD --filter-labels=team=data --threshold-rule=percent=0.9`],
        ["gcloud compute disks list", "gcloud compute disks describe old-export --zone=asia-east1-b", "gcloud compute disks delete old-export --zone=asia-east1-b"],
        ["gcloud compute disks delete batch-old-data --zone=asia-east1-b", "gcloud compute instances delete batch-old --zone=asia-east1-b", "gcloud compute disks delete batch-old-data --zone=asia-east1-b"],
      ]),
    ).toEqual([1, 2, 3, 4, 5]);
  });
});
