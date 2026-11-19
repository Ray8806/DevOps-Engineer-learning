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
const view = (state: LabState): any => checkView(state);

const Q = "https://sqs.us-east-1.amazonaws.com/123456789012";
const receive = (text: string) => JSON.parse(text.slice(0, text.lastIndexOf("}") + 1)).Messages as { Body: string; ReceiptHandle: string; Attributes?: Record<string, string>; MD5OfBody: string }[];

describe("sleep", () => {
  it("moves the simulated clock", () => {
    expect(sh(createLabState({}), "sleep 30", "sleep 2m").state.clock).toBe(150);
    expect(sh(createLabState({}), "sleep").error).toMatch(/missing operand/);
    expect(sh(createLabState({}), "sleep soon").error).toMatch(/invalid time interval/);
  });
});

describe("aws sqs", () => {
  const queue = () => sh(createLabState({}), "aws sqs create-queue --queue-name orders").state;

  it("sends, receives and deletes messages", () => {
    let r = sh(queue(), `aws sqs send-message --queue-url ${Q}/orders --message-body hello`);
    expect(JSON.parse(r.text).MD5OfMessageBody).toBe("5d41402abc4b2a76b9719d911017c592");
    r = sh(r.state, `aws sqs receive-message --queue-url ${Q}/orders`);
    const [m] = receive(r.text);
    expect(m.Body).toBe("hello");
    expect(m.Attributes).toBeUndefined();
    expect(sh(r.state, `aws sqs delete-message --queue-url ${Q}/orders --receipt-handle wrong`).error).toMatch(/ReceiptHandleIsInvalid/);
    r = sh(r.state, `aws sqs delete-message --queue-url ${Q}/orders --receipt-handle ${m.ReceiptHandle}`);
    expect(view(r.state).cloud.aws.sqs.queues.orders).toMatchObject({ messages: 0, deletedAny: true, sent: 1 });
    expect(sh(r.state, "aws sqs list-queues").text).toContain(`${Q}/orders`);
    expect(sh(r.state, "aws sqs get-queue-url --queue-name nope").error).toMatch(/NonExistentQueue/);
  });

  it("hides received messages until the visibility timeout passes", () => {
    let r = sh(queue(), `aws sqs send-message --queue-url ${Q}/orders --message-body job`, `aws sqs receive-message --queue-url ${Q}/orders`);
    const first = receive(r.text)[0];
    r = sh(r.state, `aws sqs receive-message --queue-url ${Q}/orders`);
    expect(r.text).toMatch(/沒有可接收的訊息/);
    r = sh(r.state, "sleep 29", `aws sqs receive-message --queue-url ${Q}/orders`);
    expect(r.text).toMatch(/沒有可接收的訊息/);
    r = sh(r.state, "sleep 1", `aws sqs receive-message --queue-url ${Q}/orders --attribute-names All`);
    const again = receive(r.text)[0];
    expect(again.Attributes!.ApproximateReceiveCount).toBe("2");
    expect(again.ReceiptHandle).not.toBe(first.ReceiptHandle);
    // The old receipt handle no longer works.
    expect(sh(r.state, `aws sqs delete-message --queue-url ${Q}/orders --receipt-handle ${first.ReceiptHandle}`).error).toMatch(/ReceiptHandleIsInvalid/);
    expect(view(r.state).cloud.aws.sqs.queues.orders.redelivered).toBe(true);
    const attrs = JSON.parse(sh(r.state, `aws sqs get-queue-attributes --queue-url ${Q}/orders --attribute-names All`).text).Attributes;
    expect(attrs).toMatchObject({ VisibilityTimeout: "30", MessageRetentionPeriod: "345600", ApproximateNumberOfMessagesNotVisible: "1", QueueArn: "arn:aws:sqs:us-east-1:123456789012:orders" });
  });

  it("moves messages to the dead-letter queue after maxReceiveCount receives and redrives them back", () => {
    let s = sh(queue(), "aws sqs create-queue --queue-name orders-dlq").state;
    const policy = '{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"arn:aws:sqs:us-east-1:123456789012:orders-dlq\\",\\"maxReceiveCount\\":\\"2\\"}"}';
    s = sh(s, `aws sqs set-queue-attributes --queue-url ${Q}/orders --attributes '${policy}'`, `aws sqs send-message --queue-url ${Q}/orders --message-body bad`).state;
    expect(view(s).cloud.aws.sqs.queues.orders).toMatchObject({ deadLetterQueue: "orders-dlq", maxReceiveCount: 2 });
    s = sh(s, `aws sqs receive-message --queue-url ${Q}/orders`, "sleep 30", `aws sqs receive-message --queue-url ${Q}/orders`, "sleep 30").state;
    let r = sh(s, `aws sqs receive-message --queue-url ${Q}/orders`);
    expect(r.text).toMatch(/沒有可接收的訊息/);
    expect(view(r.state).cloud.aws.sqs.queues.orders).toMatchObject({ messages: 0, movedToDeadLetter: true });
    expect(receive(sh(r.state, `aws sqs receive-message --queue-url ${Q}/orders-dlq`).text)[0].Body).toBe("bad");
    r = sh(r.state, "aws sqs start-message-move-task --source-arn arn:aws:sqs:us-east-1:123456789012:orders-dlq");
    expect(view(r.state).cloud.aws.sqs.queues).toMatchObject({ orders: { messages: 1 }, "orders-dlq": { messages: 0 } });
  });

  it("validates attributes", () => {
    const s = queue();
    expect(sh(s, `aws sqs set-queue-attributes --queue-url ${Q}/orders --attributes VisibilityTimeout=50000`).error).toMatch(/0 到 43200/);
    expect(sh(s, `aws sqs set-queue-attributes --queue-url ${Q}/orders --attributes '{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"arn:aws:sqs:us-east-1:123456789012:nope\\",\\"maxReceiveCount\\":3}"}'`).error).toMatch(/Dead-letter target does not exist/);
    expect(sh(s, "aws sqs create-queue --queue-name jobs.fifo").error).toMatch(/標準佇列/);
    expect(sh(s, "aws sqs create-queue --queue-name 'bad name'").error).toMatch(/alphanumeric/);
    const short = sh(s, `aws sqs set-queue-attributes --queue-url ${Q}/orders --attributes VisibilityTimeout=10`).state;
    expect(view(short).cloud.aws.sqs.queues.orders.visibilityTimeout).toBe(10);
    expect(sh(s, `aws sqs send-message --queue-url ${Q}/nope --message-body x`).error).toMatch(/NonExistentQueue/);
  });

  it("delivers SNS messages only when the queue policy allows the topic", () => {
    let s = sh(
      queue(),
      "aws sns create-topic --name events",
      "aws sns subscribe --topic-arn arn:aws:sns:us-east-1:123456789012:events --protocol sqs --notification-endpoint arn:aws:sqs:us-east-1:123456789012:orders",
      "aws sns publish --topic-arn arn:aws:sns:us-east-1:123456789012:events --message first",
    ).state;
    expect(view(s).cloud.aws.sqs.queues.orders.messages).toBe(0);
    const statement = (source: string) =>
      JSON.stringify({ Policy: JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: "arn:aws:sqs:us-east-1:123456789012:orders", Condition: { ArnEquals: { "aws:SourceArn": source } } }] }) });
    s.files.set("/home/learner/wrong.json", statement("arn:aws:sns:us-east-1:123456789012:other"));
    s.files.set("/home/learner/right.json", statement("arn:aws:sns:us-east-1:123456789012:events"));
    s = sh(s, `aws sqs set-queue-attributes --queue-url ${Q}/orders --attributes file://wrong.json`, "aws sns publish --topic-arn arn:aws:sns:us-east-1:123456789012:events --message second").state;
    expect(view(s).cloud.aws.sqs.queues.orders.messages).toBe(0);
    s = sh(s, `aws sqs set-queue-attributes --queue-url ${Q}/orders --attributes file://right.json`, "aws sns publish --topic-arn arn:aws:sns:us-east-1:123456789012:events --message third --subject New").state;
    const r = sh(s, `aws sqs receive-message --queue-url ${Q}/orders`);
    const body = JSON.parse(receive(r.text)[0].Body);
    expect(body).toMatchObject({ Type: "Notification", TopicArn: "arn:aws:sns:us-east-1:123456789012:events", Subject: "New", Message: "third" });
    expect(view(r.state).cloud.aws.sqs.queues.orders.receivedFromSns).toBe(true);
  });
});

const SA = "serviceAccount:service-498765432109@gcp-sa-pubsub.iam.gserviceaccount.com";
const rows = (text: string) => text.split("\n").filter((l) => l && !l.startsWith("DATA") && !l.startsWith("（"));

describe("gcloud pubsub", () => {
  const ready = () => sh(createLabState({}), "gcloud pubsub topics create orders", "gcloud pubsub subscriptions create sub-a --topic=orders", "gcloud pubsub subscriptions create sub-b --topic=orders").state;

  it("gives every subscription its own copy", () => {
    let r = sh(ready(), "gcloud pubsub topics publish orders --message=hello --attribute=kind=order");
    expect(r.text).toMatch(/messageIds:\n- '\d+'/);
    r = sh(r.state, "gcloud pubsub subscriptions pull sub-a --auto-ack");
    expect(r.text).toMatch(/^DATA\s+MESSAGE_ID\s+ORDERING_KEY\s+ATTRIBUTES\s+DELIVERY_ATTEMPT$/m);
    expect(r.text).toMatch(/hello .*kind=order/);
    r = sh(r.state, "gcloud pubsub subscriptions pull sub-b --auto-ack");
    expect(r.text).toMatch(/hello/);
    expect(sh(r.state, "gcloud pubsub subscriptions pull sub-a").text).toBe("Listed 0 items.");
    // A subscription only gets messages published after it was created.
    r = sh(r.state, "gcloud pubsub subscriptions create late --topic=orders", "gcloud pubsub subscriptions pull late");
    expect(r.text).toBe("Listed 0 items.");
    expect(view(r.state).cloud.gcp.pubsub.subscriptions).toMatchObject({ "sub-a": { ackedAny: true, backlog: 0 }, "sub-b": { ackedAny: true } });
  });

  it("redelivers after the ack deadline and acks by ack id", () => {
    let r = sh(ready(), "gcloud pubsub topics publish orders --message=job", "gcloud pubsub subscriptions pull sub-a");
    const firstAck = rows(r.text)[0].trim().split(/\s+/).at(-1)!;
    expect(sh(r.state, "gcloud pubsub subscriptions pull sub-a").text).toBe("Listed 0 items.");
    r = sh(r.state, "sleep 10", "gcloud pubsub subscriptions pull sub-a");
    const ackId = rows(r.text)[0].trim().split(/\s+/).at(-1)!;
    expect(ackId).not.toBe(firstAck);
    expect(sh(r.state, `gcloud pubsub subscriptions ack sub-a --ack-ids=${firstAck}`).error).toMatch(/invalid ack ID/);
    r = sh(r.state, `gcloud pubsub subscriptions ack sub-a --ack-ids=${ackId}`);
    expect(view(r.state).cloud.gcp.pubsub.subscriptions["sub-a"]).toMatchObject({ backlog: 0, redelivered: true, ackedAfterRedelivery: true });
    // A nack (deadline 0) makes the message available right away.
    r = sh(r.state, "gcloud pubsub topics publish orders --message=again", "gcloud pubsub subscriptions pull sub-a");
    const id = rows(r.text)[0].trim().split(/\s+/).at(-1)!;
    r = sh(r.state, `gcloud pubsub subscriptions modify-message-ack-deadline sub-a --ack-ids=${id} --ack-deadline=0`, "gcloud pubsub subscriptions pull sub-a --auto-ack");
    expect(r.text).toMatch(/again/);
  });

  it("forwards to the dead-letter topic only with the service agent's roles", () => {
    let s = sh(
      ready(),
      "gcloud pubsub topics create dead",
      "gcloud pubsub subscriptions create dead-sub --topic=dead",
      "gcloud pubsub subscriptions update sub-a --dead-letter-topic=dead --max-delivery-attempts=5",
      "gcloud pubsub topics publish orders --message=bad",
    ).state;
    expect(view(s).cloud.gcp.pubsub.subscriptions["sub-a"]).toMatchObject({ deadLetterTopic: "dead", maxDeliveryAttempts: 5 });
    for (let i = 0; i < 6; i++) s = sh(s, "gcloud pubsub subscriptions pull sub-a", "sleep 10").state;
    let r = sh(s, "gcloud pubsub subscriptions pull sub-a");
    expect(r.text).toMatch(/沒有轉到 dead-letter topic/);
    expect(view(r.state).cloud.gcp.pubsub.subscriptions["sub-a"].forwardedToDeadLetter).toBe(false);

    s = sh(r.state, `gcloud pubsub topics add-iam-policy-binding dead --member=${SA} --role=roles/pubsub.publisher`, `gcloud pubsub subscriptions add-iam-policy-binding sub-a --member=${SA} --role=roles/pubsub.subscriber`, "sleep 10").state;
    const attempts: string[] = [];
    for (let i = 0; i < 6; i++) {
      r = sh(s, "gcloud pubsub subscriptions pull sub-a");
      s = sh(r.state, "sleep 10").state;
      attempts.push(rows(r.text)[0]?.trim().split(/\s+/).at(-2) ?? "-");
    }
    expect(attempts.slice(0, 5)).toEqual(["1", "2", "3", "4", "5"]);
    expect(r.text).toBe("Listed 0 items.");
    expect(view(s).cloud.gcp.pubsub.subscriptions["sub-a"].forwardedToDeadLetter).toBe(true);
    r = sh(s, "gcloud pubsub subscriptions pull dead-sub --auto-ack");
    expect(r.text).toMatch(/bad .*CloudPubSubDeadLetterSourceDeliveryCount=5.*CloudPubSubDeadLetterSourceSubscription=sub-a/);
  });

  it("validates names and settings", () => {
    const s = ready();
    expect(sh(s, "gcloud pubsub topics create go").error).toMatch(/Invalid \[topics\] name/);
    expect(sh(s, "gcloud pubsub topics create orders").error).toMatch(/already exists/);
    expect(sh(s, "gcloud pubsub subscriptions create sub-c --topic=nope").error).toMatch(/Resource not found/);
    expect(sh(s, "gcloud pubsub subscriptions create sub-c --topic=orders --ack-deadline=5").error).toMatch(/between 10 and 600/);
    expect(sh(s, "gcloud pubsub topics create dead", "gcloud pubsub subscriptions update sub-a --dead-letter-topic=dead --max-delivery-attempts=3").error).toMatch(/between 5 and 100/);
    expect(sh(s, "gcloud pubsub subscriptions update sub-a --dead-letter-topic=orders").error).toMatch(/不同/);
    expect(sh(s, "gcloud projects describe my-project").text).toMatch(/projectNumber: '498765432109'/);
  });
});

describe("message queue labs can be completed", () => {
  const labs = new Map([...loadContent().units.values()].flatMap((u) => u.labs).map((l) => [l.id, l]));
  function play(labId: string, groups: (string | ((last: string) => string))[][]): number[] {
    const lab = labs.get(labId)!;
    let state = createLabState(lab.initialState);
    let done = advance(0, state, lab.steps);
    let last = "";
    return groups.map((commands) => {
      for (const c of commands) {
        const result = execute(state, typeof c === "string" ? c : c(last));
        state = result.state;
        last = result.lines.map((l) => l.text).join("\n");
        done = advance(done, state, lab.steps);
      }
      return done;
    });
  }
  const handle = (text: string) => receive(text)[0].ReceiptHandle;
  const ackOf = (text: string) => rows(text)[0].trim().split(/\s+/).at(-1)!;

  it("aws-sqs-sns", () => {
    expect(
      play("aws-sqs-sns", [
        ["aws sqs create-queue --queue-name orders", `aws sqs send-message --queue-url ${Q}/orders --message-body order-1001`, `aws sqs receive-message --queue-url ${Q}/orders`, (t) => `aws sqs delete-message --queue-url ${Q}/orders --receipt-handle ${handle(t)}`],
        [`aws sqs send-message --queue-url ${Q}/orders --message-body order-1002`, `aws sqs receive-message --queue-url ${Q}/orders`, `aws sqs receive-message --queue-url ${Q}/orders`, "sleep 30", `aws sqs receive-message --queue-url ${Q}/orders --attribute-names All`],
        ["aws sqs create-queue --queue-name orders-dlq", "cat redrive.json", `aws sqs set-queue-attributes --queue-url ${Q}/orders --attributes file://redrive.json`, "sleep 30", `aws sqs receive-message --queue-url ${Q}/orders`, "sleep 30", `aws sqs receive-message --queue-url ${Q}/orders`, `aws sqs receive-message --queue-url ${Q}/orders-dlq`],
        [
          "aws sns create-topic --name order-events",
          "aws sns subscribe --topic-arn arn:aws:sns:us-east-1:123456789012:order-events --protocol sqs --notification-endpoint arn:aws:sqs:us-east-1:123456789012:orders",
          "aws sns publish --topic-arn arn:aws:sns:us-east-1:123456789012:order-events --message order-1003",
          `aws sqs receive-message --queue-url ${Q}/orders`,
          "cat queue-policy.json",
          `aws sqs set-queue-attributes --queue-url ${Q}/orders --attributes file://queue-policy.json`,
          "aws sns publish --topic-arn arn:aws:sns:us-east-1:123456789012:order-events --message order-1003",
          `aws sqs receive-message --queue-url ${Q}/orders`,
        ],
      ]),
    ).toEqual([1, 2, 3, 4]);
  });

  it("gcp-pubsub", () => {
    const pullAndWait = Array.from({ length: 6 }, () => "gcloud pubsub subscriptions pull billing && sleep 10");
    expect(
      play("gcp-pubsub", [
        ["gcloud pubsub topics create orders", "gcloud pubsub subscriptions create billing --topic=orders", "gcloud pubsub subscriptions create shipping --topic=orders", "gcloud pubsub topics publish orders --message=order-1001", "gcloud pubsub subscriptions pull billing --auto-ack", "gcloud pubsub subscriptions pull shipping --auto-ack"],
        ["gcloud pubsub topics publish orders --message=order-1002", "gcloud pubsub subscriptions pull billing", "gcloud pubsub subscriptions pull billing", "sleep 10", "gcloud pubsub subscriptions pull billing", (t) => `gcloud pubsub subscriptions ack billing --ack-ids=${ackOf(t)}`],
        [
          "gcloud pubsub topics create orders-dead",
          "gcloud pubsub subscriptions create orders-dead-sub --topic=orders-dead",
          "gcloud pubsub subscriptions update billing --dead-letter-topic=orders-dead --max-delivery-attempts=5",
          "gcloud projects describe my-project",
          `gcloud pubsub topics add-iam-policy-binding orders-dead --member=${SA} --role=roles/pubsub.publisher`,
          `gcloud pubsub subscriptions add-iam-policy-binding billing --member=${SA} --role=roles/pubsub.subscriber`,
        ],
        ["gcloud pubsub topics publish orders --message=bad-order", ...pullAndWait, "gcloud pubsub subscriptions pull orders-dead-sub --auto-ack"],
      ]),
    ).toEqual([1, 2, 3, 4]);
  });
});
