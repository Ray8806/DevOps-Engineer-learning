import { parseArgs, type Ctx } from "./context";
import { error, list, table } from "./gcloud-common";
import type { LabState, PubsubMessage, PubsubSubscription } from "./state";

/** Project number of the simulated project (also in `gcloud projects describe`). */
export const PROJECT_NUMBER = "498765432109";
/** The service account Pub/Sub uses to forward messages to dead-letter topics. */
export const PUBSUB_SERVICE_AGENT = `service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com`;

/** Pub/Sub resource IDs: 3–255 characters, starting with a letter, not starting with "goog". */
const RESOURCE_ID = /^[A-Za-z][A-Za-z0-9\-_.~+%]{2,254}$/;
const ID_RULE = "ID 要以英文字母開頭，長度 3 到 255，只能用英數字和 - _ . ~ + %，而且不能以 goog 開頭。";
const MEMBER = /^(?:(user|group|serviceAccount):[^\s:@]+@[^\s:@]+|allUsers|allAuthenticatedUsers)$/;
/** Roles that include publishing / acknowledging, for the dead-letter forwarding check. */
const PUBLISH_ROLES = ["roles/pubsub.publisher", "roles/pubsub.editor", "roles/pubsub.admin"];
const ACK_ROLES = ["roles/pubsub.subscriber", "roles/pubsub.editor", "roles/pubsub.admin"];

/** Accepts "orders" or "projects/my-project/topics/orders". */
function shortId(state: LabState, value: string, kind: "topics" | "subscriptions"): string {
  const m = value.match(new RegExp(`^projects/([^/]+)/${kind}/([^/]+)$`));
  return m && m[1] === state.gcp.project ? m[2] : value;
}

function nextId(state: LabState): number {
  return ++state.gcp.pubsub.counter;
}

function hasRole(iam: Map<string, Set<string>>, roles: string[], member: string): boolean {
  return roles.some((r) => iam.get(r)?.has(member));
}

/** Pub/Sub's service account may publish to the dead-letter topic and acknowledge on the subscription. */
function canForward(state: LabState, sub: PubsubSubscription): boolean {
  const member = `serviceAccount:${PUBSUB_SERVICE_AGENT}`;
  const project = state.gcp.bindings;
  const topic = sub.deadLetter ? state.gcp.pubsub.topics.get(sub.deadLetter.topic) : undefined;
  if (!topic) return false;
  return (hasRole(topic.iam, PUBLISH_ROLES, member) || hasRole(project, PUBLISH_ROLES, member)) && (hasRole(sub.iam, ACK_ROLES, member) || hasRole(project, ACK_ROLES, member));
}

/** Writes a message to every subscription the topic has right now. */
function publish(state: LabState, topicId: string, data: string, attributes: Record<string, string>): string {
  const topic = state.gcp.pubsub.topics.get(topicId)!;
  topic.published++;
  const n = nextId(state);
  const id = String(17320000000000000 + n * 7919);
  for (const sub of state.gcp.pubsub.subscriptions.values()) {
    if (sub.topic === topicId) {
      sub.messages.push({ id, data, attributes: { ...attributes }, publishedAt: state.clock, attempts: 0, countedAttempts: 0, outstandingUntil: state.clock, ackId: null });
    }
  }
  return id;
}

function printPolicy(ctx: Ctx, iam: Map<string, Set<string>>) {
  if (iam.size === 0) {
    ctx.out("etag: ACAB\n");
    return;
  }
  ctx.out("bindings:\n");
  for (const [role, members] of [...iam].sort()) ctx.out(`- members:\n${[...members].sort().map((m) => `  - ${m}\n`).join("")}  role: ${role}\n`);
  ctx.out("etag: BwYpUbSNEXA=\nversion: 1\n");
}

function addBinding(ctx: Ctx, command: string, iam: Map<string, Set<string>>, member: string | undefined, role: string | undefined): number | null {
  if (member === undefined || role === undefined) return error(ctx, command, `argument ${member === undefined ? "--member" : "--role"}: Must be specified.`);
  if (!MEMBER.test(member)) return error(ctx, command, `INVALID_ARGUMENT: 成員 '${member}' 的格式不正確，例如 serviceAccount:電子郵件。`);
  if (!/^roles\/pubsub\.[a-zA-Z]+$/.test(role)) return error(ctx, command, `INVALID_ARGUMENT: Role ${role} is not supported for this resource.（主題和訂閱可以授予 roles/pubsub.* 的角色）`);
  const members = iam.get(role) ?? new Set<string>();
  members.add(member);
  iam.set(role, members);
  return null;
}

export function pubsub(ctx: Ctx, args: string[]): number {
  const [group, action, ...rest] = args;
  if (group === "topics") return topics(ctx, action, rest);
  if (group === "subscriptions") return subscriptions(ctx, action, rest);
  return error(ctx, "gcloud.pubsub", `不支援的指令群組 '${group ?? ""}'。這個模擬終端機支援 gcloud pubsub topics 和 gcloud pubsub subscriptions。`);
}

function topics(ctx: Ctx, action: string | undefined, rest: string[]): number {
  const command = `gcloud.pubsub.topics.${action}`;
  const supported = ["create", "list", "delete", "publish", "add-iam-policy-binding", "get-iam-policy"];
  if (!action || !supported.includes(action)) return error(ctx, "gcloud.pubsub.topics", `不支援的指令 '${action ?? ""}'。支援：${supported.join("、")}。`);
  const parsed = parseArgs(rest, { options: ["--message", "--attribute", "--ordering-key", "--member", "--role", "--format", "--project"], flags: ["--quiet", "-q"] });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const state = ctx.state;
  const all = state.gcp.pubsub.topics;
  const project = state.gcp.project;
  if (action === "list") {
    if (!all.size) ctx.out("Listed 0 items.\n");
    for (const id of [...all.keys()].sort()) ctx.out(`---\nname: projects/${project}/topics/${id}\n`);
    return 0;
  }
  const raw = parsed.positional[0];
  if (!raw) return error(ctx, command, "argument TOPIC: Must be specified.");
  const id = shortId(state, raw, "topics");
  const name = `projects/${project}/topics/${id}`;
  if (action === "create") {
    if (!RESOURCE_ID.test(id) || id.startsWith("goog")) return error(ctx, command, `INVALID_ARGUMENT: Invalid [topics] name: (name=${name})（${ID_RULE}）`);
    if (all.has(id)) return error(ctx, command, `Failed to create topic [${name}]: Resource already exists in the project (resource=${id}).`);
    all.set(id, { iam: new Map(), published: 0 });
    ctx.out(`Created topic [${name}].\n`);
    return 0;
  }
  const topic = all.get(id);
  if (!topic) return error(ctx, command, `NOT_FOUND: Resource not found (resource=${id}).`);
  switch (action) {
    case "delete":
      all.delete(id);
      // Subscriptions stay, detached from the deleted topic.
      for (const sub of state.gcp.pubsub.subscriptions.values()) if (sub.topic === id) sub.topic = "_deleted-topic_";
      ctx.out(`Deleted topic [${name}].\n`);
      return 0;
    case "publish": {
      const message = parsed.options.get("--message");
      if (!message) return error(ctx, command, "必須指定 --message（訊息內容），或用 --attribute 附加屬性。");
      const attributes: Record<string, string> = {};
      for (const pair of list(parsed.options.get("--attribute"))) {
        const eq = pair.indexOf("=");
        if (eq <= 0) return error(ctx, command, `argument --attribute: Bad syntax for dict arg: [${pair}]`);
        attributes[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/^"|"$/g, "");
      }
      const messageId = publish(state, id, message, attributes);
      ctx.out(`messageIds:\n- '${messageId}'\n`);
      return 0;
    }
    case "get-iam-policy":
      printPolicy(ctx, topic.iam);
      return 0;
    default: {
      const failed = addBinding(ctx, command, topic.iam, parsed.options.get("--member"), parsed.options.get("--role"));
      if (failed !== null) return failed;
      ctx.out(`Updated IAM policy for topic [${id}].\n`);
      printPolicy(ctx, topic.iam);
      return 0;
    }
  }
}

function subscriptions(ctx: Ctx, action: string | undefined, rest: string[]): number {
  const command = `gcloud.pubsub.subscriptions.${action}`;
  const supported = ["create", "list", "describe", "update", "delete", "pull", "ack", "modify-message-ack-deadline", "add-iam-policy-binding", "get-iam-policy"];
  if (!action || !supported.includes(action)) return error(ctx, "gcloud.pubsub.subscriptions", `不支援的指令 '${action ?? ""}'。支援：${supported.join("、")}。`);
  const parsed = parseArgs(rest, {
    options: [
      "--topic", "--ack-deadline", "--dead-letter-topic", "--max-delivery-attempts", "--message-retention-duration", "--limit",
      "--ack-ids", "--member", "--role", "--format", "--project",
    ],
    flags: ["--auto-ack", "--no-auto-ack", "--clear-dead-letter-policy", "--quiet", "-q"],
  });
  if (parsed.unknown) return error(ctx, command, `unrecognized arguments: ${parsed.unknown}`);
  const state = ctx.state;
  const subs = state.gcp.pubsub.subscriptions;
  const project = state.gcp.project;
  const opt = (n: string) => parsed.options.get(n);

  if (action === "list") {
    if (!subs.size) ctx.out("Listed 0 items.\n");
    for (const [id, s] of [...subs].sort()) ctx.out(`---\nackDeadlineSeconds: ${s.ackDeadline}\nname: projects/${project}/subscriptions/${id}\ntopic: projects/${project}/topics/${s.topic}\n`);
    return 0;
  }
  const raw = parsed.positional[0];
  if (!raw) return error(ctx, command, "argument SUBSCRIPTION: Must be specified.");
  const id = shortId(state, raw, "subscriptions");
  const name = `projects/${project}/subscriptions/${id}`;

  /** --ack-deadline, --dead-letter-topic, --max-delivery-attempts for create and update. */
  const settings = (sub: Pick<PubsubSubscription, "ackDeadline" | "deadLetter" | "topic">): string | null => {
    const deadline = opt("--ack-deadline");
    if (deadline !== undefined) {
      if (!/^\d+$/.test(deadline) || Number(deadline) < 10 || Number(deadline) > 600) return "INVALID_ARGUMENT: The ack deadline must be between 10 and 600 seconds.";
      sub.ackDeadline = Number(deadline);
    }
    const attempts = opt("--max-delivery-attempts");
    const dlTopic = opt("--dead-letter-topic");
    if (parsed.flags.has("--clear-dead-letter-policy")) sub.deadLetter = null;
    if (attempts !== undefined && dlTopic === undefined && !sub.deadLetter) return "--max-delivery-attempts 要和 --dead-letter-topic 一起設定。";
    if (attempts !== undefined && (!/^\d+$/.test(attempts) || Number(attempts) < 5 || Number(attempts) > 100)) {
      return "INVALID_ARGUMENT: max_delivery_attempts must be between 5 and 100.";
    }
    if (dlTopic !== undefined) {
      const t = shortId(state, dlTopic, "topics");
      if (!state.gcp.pubsub.topics.has(t)) return `NOT_FOUND: Resource not found (resource=${t}).（先建立 dead-letter topic）`;
      if (t === sub.topic) return "INVALID_ARGUMENT: dead-letter topic 要和訂閱附加的主題不同。";
      sub.deadLetter = { topic: t, maxAttempts: attempts !== undefined ? Number(attempts) : (sub.deadLetter?.maxAttempts ?? 5) };
    } else if (attempts !== undefined && sub.deadLetter) {
      sub.deadLetter = { ...sub.deadLetter, maxAttempts: Number(attempts) };
    }
    return null;
  };

  if (action === "create") {
    if (!RESOURCE_ID.test(id) || id.startsWith("goog")) return error(ctx, command, `INVALID_ARGUMENT: Invalid [subscriptions] name: (name=${name})（${ID_RULE}）`);
    const topicArg = opt("--topic");
    if (!topicArg) return error(ctx, command, "argument --topic: Must be specified.");
    const topic = shortId(state, topicArg, "topics");
    if (!state.gcp.pubsub.topics.has(topic)) return error(ctx, command, `Failed to create subscription [${name}]: Resource not found (resource=${topic}).`);
    if (subs.has(id)) return error(ctx, command, `Failed to create subscription [${name}]: Resource already exists in the project (resource=${id}).`);
    const sub: PubsubSubscription = { topic, ackDeadline: 10, deadLetter: null, iam: new Map(), messages: [], stats: { acked: 0, redelivered: false, ackedAfterRedelivery: false, forwarded: 0 } };
    const problem = settings(sub);
    if (problem) return error(ctx, command, problem);
    subs.set(id, sub);
    ctx.out(`Created subscription [${name}].\n`);
    return 0;
  }
  const sub = subs.get(id);
  if (!sub) return error(ctx, command, `NOT_FOUND: Resource not found (resource=${id}).`);

  switch (action) {
    case "describe":
      ctx.out(
        `ackDeadlineSeconds: ${sub.ackDeadline}\n${
          sub.deadLetter ? `deadLetterPolicy:\n  deadLetterTopic: projects/${project}/topics/${sub.deadLetter.topic}\n  maxDeliveryAttempts: ${sub.deadLetter.maxAttempts}\n` : ""
        }messageRetentionDuration: 604800s\nname: ${name}\nstate: ACTIVE\ntopic: projects/${project}/topics/${sub.topic}\n`,
      );
      return 0;
    case "update": {
      const problem = settings(sub);
      if (problem) return error(ctx, command, problem);
      ctx.out(`Updated subscription [${name}].\n`);
      return 0;
    }
    case "delete":
      subs.delete(id);
      ctx.out(`Deleted subscription [${name}].\n`);
      return 0;
    case "get-iam-policy":
      printPolicy(ctx, sub.iam);
      return 0;
    case "add-iam-policy-binding": {
      const failed = addBinding(ctx, command, sub.iam, opt("--member"), opt("--role"));
      if (failed !== null) return failed;
      ctx.out(`Updated IAM policy for subscription [${id}].\n`);
      printPolicy(ctx, sub.iam);
      return 0;
    }
    case "pull":
      if (parsed.flags.has("--auto-ack") && parsed.flags.has("--no-auto-ack")) return error(ctx, command, "--auto-ack 和 --no-auto-ack 只能擇一。");
      return pull(ctx, command, id, sub, opt("--limit"), parsed.flags.has("--auto-ack"));
    default: {
      // ack, modify-message-ack-deadline
      const ids = list(opt("--ack-ids"));
      if (!ids.length) return error(ctx, command, "argument --ack-ids: Must be specified.");
      let deadline: number | null = null;
      if (action === "modify-message-ack-deadline") {
        const d = opt("--ack-deadline");
        if (d === undefined || !/^\d+$/.test(d) || Number(d) > 600) return error(ctx, command, "argument --ack-deadline: 要指定 0 到 600 秒（0 表示立刻重新傳送）。");
        deadline = Number(d);
      }
      const found: PubsubMessage[] = [];
      for (const ackId of ids) {
        const m = sub.messages.find((x) => x.ackId === ackId && x.outstandingUntil > state.clock);
        if (!m) {
          return error(ctx, command, `INVALID_ARGUMENT: You have passed an invalid ack ID to the service (ack_id=${ackId}).（可能打錯了，或已經過了確認期限，訊息會重新傳送並拿到新的 ACK_ID）`);
        }
        found.push(m);
      }
      for (const m of found) {
        if (deadline === null) {
          sub.messages.splice(sub.messages.indexOf(m), 1);
          sub.stats.acked++;
          if (m.attempts > 1) sub.stats.ackedAfterRedelivery = true;
        } else m.outstandingUntil = state.clock + deadline;
      }
      ctx.out(deadline === null ? `Acked the messages: [${ids.join(", ")}] for subscription [${name}].\n` : `Set ackDeadlineSeconds to [${deadline}] for messages with ackId [${ids.join(", ")}]] for subscription [${name}].\n`);
      return 0;
    }
  }
}

/**
 * Delivers up to --limit messages that are not outstanding. A message whose
 * counted delivery attempts reached the dead-letter limit is forwarded to the
 * dead-letter topic instead; attempts are only counted when Pub/Sub's service
 * account has the roles to forward it.
 */
function pull(ctx: Ctx, command: string, id: string, sub: PubsubSubscription, limitRaw: string | undefined, autoAck: boolean): number {
  const state = ctx.state;
  const limit = limitRaw === undefined ? 1 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) return error(ctx, command, "argument --limit: Value must be greater than or equal to 1.");
  const forwarding = sub.deadLetter !== null && canForward(state, sub);
  const rows: string[][] = [];
  let stuck = false;
  for (const m of [...sub.messages]) {
    if (rows.length >= limit) break;
    if (m.outstandingUntil > state.clock) continue;
    if (sub.deadLetter && forwarding && m.countedAttempts >= sub.deadLetter.maxAttempts) {
      sub.messages.splice(sub.messages.indexOf(m), 1);
      sub.stats.forwarded++;
      publish(state, sub.deadLetter.topic, m.data, {
        ...m.attributes,
        CloudPubSubDeadLetterSourceDeliveryCount: String(m.countedAttempts),
        CloudPubSubDeadLetterSourceSubscription: id,
        CloudPubSubDeadLetterSourceSubscriptionProject: state.gcp.project,
      });
      continue;
    }
    if (sub.deadLetter && !forwarding && m.attempts >= sub.deadLetter.maxAttempts) stuck = true;
    m.attempts++;
    if (forwarding) m.countedAttempts++;
    if (m.attempts > 1) sub.stats.redelivered = true;
    const ackId = `UAYWLF1GSFE3GQho${String(nextId(state)).padStart(6, "0")}`;
    rows.push([m.data, m.id, "", Object.entries(m.attributes).map(([k, v]) => `${k}=${v}`).join(","), sub.deadLetter && m.countedAttempts ? String(m.countedAttempts) : "", ackId]);
    if (autoAck) {
      sub.messages.splice(sub.messages.indexOf(m), 1);
      sub.stats.acked++;
      if (m.attempts > 1) sub.stats.ackedAfterRedelivery = true;
    } else {
      m.ackId = ackId;
      m.outstandingUntil = state.clock + sub.ackDeadline;
    }
  }
  const header = ["DATA", "MESSAGE_ID", "ORDERING_KEY", "ATTRIBUTES", "DELIVERY_ATTEMPT", "ACK_ID"];
  table(ctx, autoAck ? header.slice(0, 5) : header, autoAck ? rows.map((r) => r.slice(0, 5)) : rows);
  if (stuck) {
    ctx.out(`（模擬終端機提示：訊息已傳送超過 ${sub.deadLetter!.maxAttempts} 次，卻沒有轉到 dead-letter topic。Pub/Sub 只有在服務帳戶 ${PUBSUB_SERVICE_AGENT} 能發布到 dead-letter topic、也能確認這個訂閱的訊息時，才會計算傳送次數並轉送）\n`);
  }
  return 0;
}
