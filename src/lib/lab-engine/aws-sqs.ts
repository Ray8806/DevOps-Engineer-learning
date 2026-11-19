import { fail, json, operationName, parse, requiredCheck, shorthand, unsupported } from "./aws-observability";
import type { Ctx } from "./context";
import { md5 } from "./encoding";
import { resolvePath, type LabState, type SqsMessage, type SqsQueue } from "./state";

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
/** Wall-clock time of the simulated clock's zero, for timestamps. */
const EPOCH_MS = Date.UTC(2026, 10, 16, 8, 0, 0);

export const SQS_COMMANDS = [
  "create-queue", "list-queues", "get-queue-url", "get-queue-attributes", "set-queue-attributes", "send-message",
  "receive-message", "delete-message", "change-message-visibility", "purge-queue", "delete-queue", "start-message-move-task",
];

export const queueUrl = (name: string) => `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${name}`;
export const queueArn = (name: string) => `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}`;
const nameFromArn = (arn: string) => (arn.startsWith(`arn:aws:sqs:${REGION}:${ACCOUNT}:`) ? arn.split(":").at(-1)! : null);
const nameFromUrl = (url: string) => {
  const m = url.match(/^https:\/\/(?:sqs\.[a-z0-9-]+|queue)\.amazonaws\.com\/(\d{12})\/([^/]+)$/);
  return m && m[1] === ACCOUNT ? m[2] : null;
};

const DEFAULTS: Record<string, string> = {
  VisibilityTimeout: "30",
  MessageRetentionPeriod: "345600",
  DelaySeconds: "0",
  ReceiveMessageWaitTimeSeconds: "0",
};
const SETTABLE = ["VisibilityTimeout", "MessageRetentionPeriod", "DelaySeconds", "ReceiveMessageWaitTimeSeconds", "RedrivePolicy", "Policy"];
const RANGES: Record<string, [number, number]> = {
  VisibilityTimeout: [0, 43200],
  MessageRetentionPeriod: [60, 1209600],
  DelaySeconds: [0, 900],
  ReceiveMessageWaitTimeSeconds: [0, 20],
};

/** A short, deterministic id that looks like the real ones. */
function makeId(state: LabState, prefix: string): string {
  const n = ++state.aws.sqs.counter;
  const hex = ((n * 2654435761) >>> 0).toString(16).padStart(8, "0");
  return prefix === "msg" ? `${hex}-5b6c-4d7e-8f90-${String(n).padStart(12, "0")}` : `AQEB${hex}${md5(`${prefix}${n}`).slice(0, 24)}==`;
}

/** --attributes as shorthand (Key=Value,…) or JSON (inline or file://). */
function readAttributes(ctx: Ctx, raw: string): Record<string, string> | string {
  let text = raw;
  if (raw.startsWith("file://")) {
    const content = ctx.state.files.get(resolvePath(ctx.state.cwd, raw.slice(7)));
    if (content === undefined) return `Unable to load paramfile ${raw}`;
    text = content;
  }
  if (text.trim().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Invalid JSON";
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
    } catch {
      return "Invalid JSON：檢查引號和逗號（RedrivePolicy、Policy 的值本身是一段 JSON 字串）";
    }
  }
  return shorthand(text) ?? "格式應為 Key=Value,Key=Value 或 JSON";
}

/** Validates attribute values; returns an error message or null. */
function checkAttributes(state: LabState, name: string, attrs: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "FifoQueue" || key === "ContentBasedDeduplication") return "這個模擬終端機只支援標準佇列（standard queue）。";
    if (!SETTABLE.includes(key)) return `Unknown Attribute ${key}.（這個模擬終端機支援 ${SETTABLE.join("、")}）`;
    const range = RANGES[key];
    if (range && (!/^\d+$/.test(value) || Number(value) < range[0] || Number(value) > range[1])) {
      return `Invalid value for the parameter ${key}.（範圍是 ${range[0]} 到 ${range[1]} 秒）`;
    }
    if (key === "RedrivePolicy") {
      let policy: { deadLetterTargetArn?: unknown; maxReceiveCount?: unknown };
      try {
        policy = JSON.parse(value);
      } catch {
        return "Value for parameter RedrivePolicy is invalid. Reason: Redrive policy is not a valid JSON map.";
      }
      const target = typeof policy.deadLetterTargetArn === "string" ? nameFromArn(policy.deadLetterTargetArn) : null;
      if (!target || !state.aws.sqs.queues.has(target)) return "Value for parameter RedrivePolicy is invalid. Reason: Dead-letter target does not exist.（deadLetterTargetArn 要是已存在的佇列 ARN，用 get-queue-attributes 查 QueueArn）";
      if (target === name) return "Value for parameter RedrivePolicy is invalid. Reason: Dead-letter target cannot be the queue itself.";
      const max = Number(policy.maxReceiveCount);
      if (!Number.isInteger(max) || max < 1 || max > 1000) return "Value for parameter RedrivePolicy is invalid. Reason: maxReceiveCount must be an integer between 1 and 1000.";
    }
    if (key === "Policy") {
      try {
        JSON.parse(value);
      } catch {
        return "Invalid value for the parameter Policy.（Policy 要是一段 JSON 字串）";
      }
    }
  }
  return null;
}

/** True when the queue policy lets the topic's SNS service principal send to the queue. */
function allowsSns(queue: SqsQueue, name: string, topic: string): boolean {
  if (!queue.attributes.Policy) return false;
  let policy: { Statement?: unknown };
  try {
    policy = JSON.parse(queue.attributes.Policy);
  } catch {
    return false;
  }
  const statements = Array.isArray(policy.Statement) ? policy.Statement : policy.Statement ? [policy.Statement] : [];
  const list = (v: unknown) => (Array.isArray(v) ? v : [v]).map(String);
  const wildcard = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value);
  return statements.some((raw) => {
    const st = raw as Record<string, unknown>;
    if (st.Effect !== "Allow") return false;
    const principal = st.Principal as unknown;
    const principals = principal === "*" ? ["*"] : principal && typeof principal === "object" ? list((principal as Record<string, unknown>).Service ?? (principal as Record<string, unknown>).AWS) : [];
    if (!principals.some((p) => p === "*" || p === "sns.amazonaws.com")) return false;
    if (!list(st.Action).some((a) => ["sqs:SendMessage", "sqs:*", "*"].includes(a))) return false;
    if (!list(st.Resource ?? "*").some((r) => wildcard(r, queueArn(name)))) return false;
    const condition = st.Condition as Record<string, Record<string, unknown>> | undefined;
    if (!condition) return true;
    return Object.entries(condition).every(([op, keys]) =>
      Object.entries(keys).every(([key, value]) => {
        if (key !== "aws:SourceArn") return key === "aws:SourceAccount" ? list(value).includes(ACCOUNT) : true;
        return list(value).some((v) => (op === "ArnLike" || op === "StringLike" ? wildcard(v, topic) : v === topic));
      }),
    );
  });
}

/**
 * Delivers an SNS notification to a subscribed queue, if the queue's access
 * policy allows the topic to send to it. Returns whether it was delivered.
 */
export function deliverFromSns(state: LabState, queueArnValue: string, topic: string, subject: string | undefined, message: string, messageId: string): boolean {
  const name = nameFromArn(queueArnValue);
  const queue = name ? state.aws.sqs.queues.get(name) : undefined;
  if (!queue || !allowsSns(queue, name!, topic)) return false;
  const body = JSON.stringify(
    {
      Type: "Notification",
      MessageId: messageId,
      TopicArn: topic,
      ...(subject ? { Subject: subject } : {}),
      Message: message,
      Timestamp: new Date(EPOCH_MS + state.clock * 1000).toISOString(),
      SignatureVersion: "1",
      Signature: "EXAMPLEpH+...",
      SigningCertURL: `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-EXAMPLE.pem`,
      UnsubscribeURL: `https://sns.${REGION}.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${topic}:EXAMPLE`,
    },
    null,
    2,
  );
  queue.messages.push({ id: makeId(state, "msg"), body, sentAt: state.clock, receiveCount: 0, invisibleUntil: state.clock + Number(queue.attributes.DelaySeconds), receipt: null, fromSns: true });
  queue.stats.sent++;
  return true;
}

export function sqs(ctx: Ctx, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !SQS_COMMANDS.includes(sub)) return unsupported(ctx, "sqs", sub, SQS_COMMANDS);
  const parsed = parse(
    rest,
    [
      "--queue-name", "--queue-url", "--attributes", "--attribute-names", "--message-system-attribute-names", "--message-body",
      "--delay-seconds", "--max-number-of-messages", "--visibility-timeout", "--wait-time-seconds", "--receipt-handle",
      "--queue-name-prefix", "--source-arn", "--destination-arn", "--message-attribute-names", "--region", "--output",
    ],
    ["--attribute-names", "--message-system-attribute-names", "--message-attribute-names"],
  );
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const state = ctx.state;
  const queues = state.aws.sqs.queues;
  const operation = operationName(sub);
  const opt = (n: string) => parsed.options.get(`--${n}`)?.[0];
  const notExist = () => fail(ctx, "AWS.SimpleQueueService.NonExistentQueue", operation, "The specified queue does not exist.");
  /** The queue named by --queue-url. */
  const target = (): [string, SqsQueue] | null => {
    const name = nameFromUrl(opt("queue-url") ?? "");
    const queue = name ? queues.get(name) : undefined;
    return queue ? [name!, queue] : null;
  };
  const int = (n: string, min: number, max: number): number | null | undefined => {
    const v = opt(n);
    if (v === undefined) return undefined;
    return /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? Number(v) : null;
  };

  switch (sub) {
    case "create-queue": {
      if (!requiredCheck(ctx, parsed, ["queue-name"])) return 252;
      const name = opt("queue-name")!;
      if (name.endsWith(".fifo")) return fail(ctx, "InvalidParameterValue", operation, "這個模擬終端機只支援標準佇列（standard queue）；FIFO 佇列的名稱要以 .fifo 結尾，並設定 FifoQueue=true。");
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) return fail(ctx, "InvalidParameterValue", operation, "Can only include alphanumeric characters, hyphens, or underscores. 1 to 80 in length");
      const raw = opt("attributes");
      const attrs = raw === undefined ? {} : readAttributes(ctx, raw);
      if (typeof attrs === "string") return fail(ctx, "InvalidParameterValue", operation, attrs);
      const problem = checkAttributes(state, name, attrs);
      if (problem) return fail(ctx, "InvalidAttributeValue", operation, problem);
      const existing = queues.get(name);
      if (existing) {
        // Creating an existing queue returns it, unless the attributes differ.
        if (Object.entries(attrs).some(([k, v]) => (existing.attributes[k] ?? "") !== v)) {
          return fail(ctx, "QueueAlreadyExists", operation, "A queue already exists with the same name and a different value for attribute(s)");
        }
      } else {
        queues.set(name, { attributes: { ...DEFAULTS, ...attrs }, createdAt: state.clock, messages: [], stats: { sent: 0, deleted: 0, redelivered: false, movedToDeadLetter: 0, receivedFromSns: false } });
      }
      json(ctx, { QueueUrl: queueUrl(name) });
      return 0;
    }
    case "list-queues": {
      const prefix = opt("queue-name-prefix") ?? "";
      const urls = [...queues.keys()].filter((n) => n.startsWith(prefix)).sort().map(queueUrl);
      if (urls.length) json(ctx, { QueueUrls: urls });
      return 0;
    }
    case "get-queue-url": {
      if (!requiredCheck(ctx, parsed, ["queue-name"])) return 252;
      if (!queues.has(opt("queue-name")!)) return notExist();
      json(ctx, { QueueUrl: queueUrl(opt("queue-name")!) });
      return 0;
    }
    case "get-queue-attributes": {
      if (!requiredCheck(ctx, parsed, ["queue-url"])) return 252;
      const t = target();
      if (!t) return notExist();
      const [name, queue] = t;
      const visible = queue.messages.filter((m) => m.invisibleUntil <= state.clock);
      const all: Record<string, string> = {
        QueueArn: queueArn(name),
        ApproximateNumberOfMessages: String(visible.length),
        ApproximateNumberOfMessagesNotVisible: String(queue.messages.filter((m) => m.invisibleUntil > state.clock && m.receipt !== null).length),
        ApproximateNumberOfMessagesDelayed: String(queue.messages.filter((m) => m.invisibleUntil > state.clock && m.receipt === null).length),
        CreatedTimestamp: String(Math.floor(EPOCH_MS / 1000) + queue.createdAt),
        ...queue.attributes,
      };
      const wanted = parsed.options.get("--attribute-names") ?? ["All"];
      const keys = wanted.includes("All") ? Object.keys(all) : wanted.filter((k) => k in all);
      json(ctx, { Attributes: Object.fromEntries(keys.map((k) => [k, all[k]])) });
      return 0;
    }
    case "set-queue-attributes": {
      if (!requiredCheck(ctx, parsed, ["queue-url", "attributes"])) return 252;
      const t = target();
      if (!t) return notExist();
      const attrs = readAttributes(ctx, opt("attributes")!);
      if (typeof attrs === "string") return fail(ctx, "InvalidParameterValue", operation, attrs);
      const problem = checkAttributes(state, t[0], attrs);
      if (problem) return fail(ctx, "InvalidAttributeValue", operation, problem);
      for (const [k, v] of Object.entries(attrs)) {
        if (v === "" && (k === "RedrivePolicy" || k === "Policy")) delete t[1].attributes[k];
        else t[1].attributes[k] = v;
      }
      return 0;
    }
    case "send-message": {
      if (!requiredCheck(ctx, parsed, ["queue-url", "message-body"])) return 252;
      const t = target();
      if (!t) return notExist();
      const body = opt("message-body")!;
      if (!body) return fail(ctx, "InvalidParameterValue", operation, "The message body must be at least 1 character.");
      const delay = int("delay-seconds", 0, 900);
      if (delay === null) return fail(ctx, "InvalidParameterValue", operation, "Value for parameter DelaySeconds is invalid.（範圍是 0 到 900 秒）");
      const queue = t[1];
      const id = makeId(state, "msg");
      queue.messages.push({ id, body, sentAt: state.clock, receiveCount: 0, invisibleUntil: state.clock + (delay ?? Number(queue.attributes.DelaySeconds)), receipt: null, fromSns: false });
      queue.stats.sent++;
      json(ctx, { MD5OfMessageBody: md5(body), MessageId: id });
      return 0;
    }
    case "receive-message": {
      if (!requiredCheck(ctx, parsed, ["queue-url"])) return 252;
      const t = target();
      if (!t) return notExist();
      const [, queue] = t;
      const max = int("max-number-of-messages", 1, 10);
      if (max === null) return fail(ctx, "InvalidParameterValue", operation, "Value for parameter MaxNumberOfMessages is invalid. Reason: Must be between 1 and 10.");
      const vt = int("visibility-timeout", 0, 43200);
      if (vt === null) return fail(ctx, "InvalidParameterValue", operation, "Value for parameter VisibilityTimeout is invalid.");
      if (int("wait-time-seconds", 0, 20) === null) return fail(ctx, "InvalidParameterValue", operation, "Value for parameter WaitTimeSeconds is invalid. Reason: Must be >= 0 and <= 20.");
      const redrive = queue.attributes.RedrivePolicy ? (JSON.parse(queue.attributes.RedrivePolicy) as { deadLetterTargetArn: string; maxReceiveCount: number | string }) : null;
      const dlq = redrive ? queues.get(nameFromArn(redrive.deadLetterTargetArn) ?? "") : undefined;
      const received: SqsMessage[] = [];
      for (const m of [...queue.messages]) {
        if (received.length >= (max ?? 1)) break;
        if (m.invisibleUntil > state.clock) continue;
        // Received too many times without being deleted: move it to the dead-letter queue.
        if (redrive && dlq && m.receiveCount >= Number(redrive.maxReceiveCount)) {
          queue.messages.splice(queue.messages.indexOf(m), 1);
          dlq.messages.push({ ...m, receiveCount: 0, receipt: null, invisibleUntil: state.clock });
          queue.stats.movedToDeadLetter++;
          continue;
        }
        m.receiveCount++;
        m.receipt = makeId(state, "receipt");
        m.invisibleUntil = state.clock + (vt ?? Number(queue.attributes.VisibilityTimeout));
        if (m.receiveCount > 1) queue.stats.redelivered = true;
        if (m.fromSns) queue.stats.receivedFromSns = true;
        received.push(m);
      }
      if (!received.length) {
        // The real CLI prints nothing for an empty receive; say why here.
        ctx.out("（沒有可接收的訊息：佇列是空的，或訊息正在處理中、還沒過可見性逾時）\n");
        return 0;
      }
      const wanted = [...(parsed.options.get("--attribute-names") ?? []), ...(parsed.options.get("--message-system-attribute-names") ?? [])];
      json(ctx, {
        Messages: received.map((m) => {
          const attributes: Record<string, string> = {
            SenderId: "AIDAEXAMPLE123456789",
            ApproximateFirstReceiveTimestamp: String(EPOCH_MS + state.clock * 1000),
            ApproximateReceiveCount: String(m.receiveCount),
            SentTimestamp: String(EPOCH_MS + m.sentAt * 1000),
          };
          const keys = wanted.includes("All") ? Object.keys(attributes) : wanted.filter((k) => k in attributes);
          return { MessageId: m.id, ReceiptHandle: m.receipt, MD5OfBody: md5(m.body), Body: m.body, ...(keys.length ? { Attributes: Object.fromEntries(keys.map((k) => [k, attributes[k]])) } : {}) };
        }),
      });
      return 0;
    }
    case "delete-message":
    case "change-message-visibility": {
      if (!requiredCheck(ctx, parsed, sub === "delete-message" ? ["queue-url", "receipt-handle"] : ["queue-url", "receipt-handle", "visibility-timeout"])) return 252;
      const t = target();
      if (!t) return notExist();
      const queue = t[1];
      const m = queue.messages.find((x) => x.receipt === opt("receipt-handle"));
      if (!m) {
        return fail(ctx, "ReceiptHandleIsInvalid", operation, `The input receipt handle "${opt("receipt-handle")}" is not a valid receipt handle.（要用最近一次 receive-message 拿到的 ReceiptHandle）`);
      }
      if (sub === "delete-message") {
        queue.messages.splice(queue.messages.indexOf(m), 1);
        queue.stats.deleted++;
      } else {
        const vt = int("visibility-timeout", 0, 43200);
        if (vt == null) return fail(ctx, "InvalidParameterValue", operation, "Value for parameter VisibilityTimeout is invalid.");
        m.invisibleUntil = state.clock + vt;
      }
      return 0;
    }
    case "purge-queue": {
      if (!requiredCheck(ctx, parsed, ["queue-url"])) return 252;
      const t = target();
      if (!t) return notExist();
      t[1].messages = [];
      return 0;
    }
    case "delete-queue": {
      if (!requiredCheck(ctx, parsed, ["queue-url"])) return 252;
      const t = target();
      if (!t) return notExist();
      queues.delete(t[0]);
      return 0;
    }
    default: {
      // start-message-move-task: redrive a dead-letter queue to its source queue(s), or to --destination-arn.
      if (!requiredCheck(ctx, parsed, ["source-arn"])) return 252;
      const sourceName = nameFromArn(opt("source-arn")!);
      const source = sourceName ? queues.get(sourceName) : undefined;
      if (!source) return fail(ctx, "ResourceNotFoundException", operation, "The resource that you specified for the SourceArn parameter doesn't exist.");
      let destinations: string[];
      if (opt("destination-arn")) {
        const d = nameFromArn(opt("destination-arn")!);
        if (!d || !queues.has(d)) return fail(ctx, "ResourceNotFoundException", operation, "The resource that you specified for the DestinationArn parameter doesn't exist.");
        destinations = [d];
      } else {
        destinations = [...queues].filter(([, q]) => q.attributes.RedrivePolicy && JSON.parse(q.attributes.RedrivePolicy).deadLetterTargetArn === queueArn(sourceName!)).map(([n]) => n);
        if (!destinations.length) return fail(ctx, "InvalidParameterValue", operation, "Source queue must be configured as a Dead Letter Queue.（沒有任何佇列把它設成 dead-letter queue）");
      }
      // Redriven messages are new messages with new ids (simplified: all go to the first source queue).
      const dest = queues.get(destinations[0])!;
      for (const m of source.messages) {
        dest.messages.push({ ...m, id: makeId(state, "msg"), receiveCount: 0, receipt: null, sentAt: state.clock, invisibleUntil: state.clock });
      }
      source.messages = [];
      json(ctx, { TaskHandle: makeId(state, "task") });
      ctx.out("（模擬終端機：搬移工作立即完成）\n");
      return 0;
    }
  }
}
