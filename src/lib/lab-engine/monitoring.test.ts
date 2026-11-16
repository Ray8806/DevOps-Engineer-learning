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

const TOPIC = "arn:aws:sns:us-east-1:123456789012:ops-alerts";
const ALARM = `aws cloudwatch put-metric-alarm --alarm-name high-cpu --namespace AWS/EC2 --metric-name CPUUtilization --statistic Average --period 300 --evaluation-periods 2 --threshold 80 --comparison-operator GreaterThanThreshold --dimensions Name=InstanceId,Value=i-0123456789abcdef0 --alarm-actions ${TOPIC}`;
const LOGS = {
  cloud: {
    aws: {
      logs: { "/app/web": [{ stream: "web-1", message: "ERROR boom" }, { stream: "web-2", message: "error lower" }, { stream: "web-1", message: "INFO ok" }] },
      cloudtrail: [
        { eventName: "DeleteBucket", username: "mallory", eventSource: "s3.amazonaws.com", resourceName: "b1", eventTime: "2025-11-15T09:00:00Z" },
        { eventName: "CreateBucket", username: "alice", eventSource: "s3.amazonaws.com", resourceName: "b1", eventTime: "2025-11-14T09:00:00Z" },
      ],
    },
    gcp: {
      logs: [
        { severity: "INFO", resourceType: "gce_instance", logName: "syslog", text: "started", timestamp: "2025-11-15T08:00:00Z" },
        { severity: "ERROR", resourceType: "cloud_run_revision", logName: "stderr", text: "payment timeout", timestamp: "2025-11-15T08:10:00Z" },
        { severity: "CRITICAL", resourceType: "gce_instance", logName: "syslog", text: "disk full", timestamp: "2025-11-15T08:20:00Z" },
      ],
    },
  },
};

describe("aws sns and cloudwatch alarms", () => {
  it("email subscriptions wait for confirmation", () => {
    const r = sh(createLabState(), "aws sns create-topic --name ops-alerts", `aws sns subscribe --topic-arn ${TOPIC} --protocol email --notification-endpoint ops@example.com`);
    expect(r.text).toContain("pending confirmation");
    expect(cloud(r.state).aws.sns.topics["ops-alerts"].subscriptions["email:ops@example.com"]).toBe("PendingConfirmation");
  });

  it("creates an alarm that starts without data and notifies the topic", () => {
    const r = sh(createLabState(), "aws sns create-topic --name ops-alerts", ALARM);
    expect(r.errors).toEqual([]);
    expect(cloud(r.state).aws.cloudwatch.alarms["high-cpu"]).toEqual({
      namespace: "AWS/EC2",
      metricName: "CPUUtilization",
      statistic: "Average",
      condition: "CPUUtilization > 80 for 2 x 300s",
      dimensions: { InstanceId: "i-0123456789abcdef0" },
      notifies: { "ops-alerts": true },
      state: "INSUFFICIENT_DATA",
    });
    expect(sh(r.state, "aws cloudwatch describe-alarms").text).toContain('"StateValue": "INSUFFICIENT_DATA"');
  });

  it("rejects alarm actions for missing topics and bad periods", () => {
    expect(sh(createLabState(), ALARM).error).toContain("Invalid alarm action");
    const r = sh(createLabState(), "aws sns create-topic --name ops-alerts", ALARM.replace("--period 300", "--period 90"));
    expect(r.error).toContain("Period");
  });

  it("set-alarm-state changes the state", () => {
    const r = sh(createLabState(), "aws sns create-topic --name ops-alerts", ALARM, 'aws cloudwatch set-alarm-state --alarm-name high-cpu --state-value ALARM --state-reason "test"');
    expect(cloud(r.state).aws.cloudwatch.alarms["high-cpu"].state).toBe("ALARM");
  });
});

describe("aws cloudwatch logs and cloudtrail", () => {
  it("filter patterns are case-sensitive", () => {
    const r = sh(createLabState(LOGS), "aws logs filter-log-events --log-group-name /app/web --filter-pattern ERROR");
    expect(r.text).toContain("ERROR boom");
    expect(r.text).not.toContain("error lower");
    expect(cloud(r.state).aws.logs.groups["/app/web"].searches).toEqual({ ERROR: true });
  });

  it("log groups keep events forever until a retention policy is set", () => {
    const s = createLabState(LOGS);
    expect(cloud(s).aws.logs.groups["/app/web"].retentionInDays).toBeNull();
    expect(sh(s, "aws logs put-retention-policy --log-group-name /app/web --retention-in-days 45").error).toContain("retention");
    const r = sh(s, "aws logs put-retention-policy --log-group-name /app/web --retention-in-days 30");
    expect(cloud(r.state).aws.logs.groups["/app/web"].retentionInDays).toBe(30);
  });

  it("metric filters turn matching events into metrics", () => {
    const r = sh(createLabState(LOGS), 'aws logs put-metric-filter --log-group-name /app/web --filter-name errors --filter-pattern ERROR --metric-transformations metricName=ErrorCount,metricNamespace=App,metricValue=1');
    expect(r.errors).toEqual([]);
    expect(sh(r.state, "aws logs describe-metric-filters --log-group-name /app/web").text).toContain("ErrorCount");
  });

  it("looks up events by name, newest first", () => {
    const r = sh(createLabState(LOGS), "aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteBucket");
    const events = JSON.parse(r.text).Events;
    expect(events).toHaveLength(1);
    expect(events[0].Username).toBe("mallory");
    const all = JSON.parse(sh(createLabState(LOGS), "aws cloudtrail lookup-events").text).Events;
    expect(all.map((e: any) => e.EventName)).toEqual(["DeleteBucket", "CreateBucket"]);
  });
});

describe("gcloud logging", () => {
  it("reads entries at or above a severity", () => {
    const r = sh(createLabState(LOGS), "gcloud logging read 'severity >= ERROR'");
    expect(r.text).toContain("payment timeout");
    expect(r.text).toContain("disk full");
    expect(r.text).not.toContain("started");
    expect(cloud(r.state).gcp.logging.queries).toEqual({ "severity>=ERROR": true });
  });

  it("combines clauses with AND", () => {
    const r = sh(createLabState(LOGS), 'gcloud logging read \'severity>=ERROR AND resource.type="gce_instance"\'');
    expect(r.text).toContain("disk full");
    expect(r.text).not.toContain("payment timeout");
  });

  it("the _Required bucket cannot be changed; _Default can", () => {
    const s = createLabState();
    expect(sh(s, "gcloud logging buckets update _Required --location=global --retention-days=60").error).toContain("400");
    expect(sh(s, "gcloud logging buckets update _Default --location=global --retention-days=5000").error).toContain("3650");
    const r = sh(s, "gcloud logging buckets update _Default --location=global --retention-days=60");
    expect(cloud(r.state).gcp.logging.buckets).toEqual({ _Required: { retentionDays: 400 }, _Default: { retentionDays: 60 } });
  });

  it("sinks need an existing bucket and remind about the writer identity", () => {
    const sink = "gcloud logging sinks create archive-sink storage.googleapis.com/lab-log-archive --log-filter='severity>=WARNING'";
    expect(sh(createLabState(), sink).error).toContain("gs://lab-log-archive");
    const r = sh(createLabState(), "gcloud storage buckets create gs://lab-log-archive", sink);
    expect(r.text).toContain("grant");
    expect(cloud(r.state).gcp.logging.sinks["archive-sink"]).toEqual({ destination: "storage.googleapis.com/lab-log-archive", filter: "severity>=WARNING" });
  });

  it("creates log-based metrics", () => {
    const r = sh(createLabState(), "gcloud logging metrics create error_count --log-filter='severity>=ERROR'");
    expect(cloud(r.state).gcp.logging.metrics.error_count.filter).toBe("severity>=ERROR");
    expect(sh(r.state, "gcloud logging metrics create error_count --log-filter='severity>=ERROR'").error).toContain("ALREADY_EXISTS");
  });
});

describe("gcloud monitoring", () => {
  it("creates uptime checks and alerting policies", () => {
    const r = sh(
      createLabState(),
      "gcloud monitoring uptime create web-uptime --resource-type=uptime-url --resource-labels=host=example.com",
      `gcloud monitoring policies create --display-name="Too many errors" --condition-display-name="error_count > 5" --condition-filter='metric.type = "logging.googleapis.com/user/error_count"' --if='> 5' --duration=60s`,
    );
    expect(r.errors).toEqual([]);
    expect(cloud(r.state).gcp.monitoring).toEqual({
      uptimeChecks: { "web-uptime": { host: "example.com", path: "/", period: 1 } },
      policies: { "Too many errors": { conditionFilter: 'metric.type="logging.googleapis.com/user/error_count"', condition: "> 5 for 60s" } },
    });
  });

  it("validates --if", () => {
    expect(sh(createLabState(), `gcloud monitoring policies create --display-name=x --condition-filter='metric.type="a"' --if='>= 5'`).error).toContain("--if");
  });
});

describe("monitoring labs can be completed", () => {
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

  it("aws-cloudwatch-alarm", () => {
    expect(
      play("aws-cloudwatch-alarm", [
        ["aws sns create-topic --name ops-alerts"],
        [`aws sns subscribe --topic-arn ${TOPIC} --protocol email --notification-endpoint ops@example.com`, `aws sns list-subscriptions-by-topic --topic-arn ${TOPIC}`],
        [ALARM, "aws cloudwatch describe-alarms"],
        ["aws logs filter-log-events --log-group-name /app/web --filter-pattern ERROR"],
        ["aws logs describe-log-groups", "aws logs put-retention-policy --log-group-name /app/web --retention-in-days 30"],
        ["aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteBucket", "echo intern-kevin > ~/answer.txt"],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gcp-logging-monitoring", () => {
    expect(
      play("gcp-logging-monitoring", [
        ["gcloud logging read 'severity>=ERROR'"],
        [`gcloud logging metrics create error_count --description="Number of error logs" --log-filter='severity>=ERROR'`],
        ["gcloud logging buckets list", "gcloud logging buckets update _Required --location=global --retention-days=60", "gcloud logging buckets update _Default --location=global --retention-days=60"],
        ["gcloud storage buckets create gs://lab-log-archive", "gcloud logging sinks create archive-sink storage.googleapis.com/lab-log-archive --log-filter='severity>=WARNING'"],
        ["gcloud monitoring uptime create web-uptime --resource-type=uptime-url --resource-labels=host=example.com"],
        [
          `gcloud monitoring policies create --display-name="Too many errors" --condition-display-name="error_count > 5" --condition-filter='metric.type="logging.googleapis.com/user/error_count"' --if='> 5' --duration=60s`,
        ],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
