import { fail, json, operationName, parse, unsupported } from "./aws-observability";
import { EPOCH_MS, deliverToQueue, queueAllows } from "./aws-sqs";
import type { Ctx } from "./context";
import { md5 } from "./encoding";
import { error } from "./gcloud-common";
import { PROJECT_NUMBER, publish } from "./gcloud-pubsub";
import { resolvePath, type LabState, type S3QueueNotification } from "./state";

const REGION = "us-east-1";
/** The Cloud Storage service agent that publishes bucket notifications. */
export const STORAGE_SERVICE_AGENT = `service-${PROJECT_NUMBER}@gs-project-accounts.iam.gserviceaccount.com`;

export type ObjectChange = "put" | "copy" | "delete";

const isoAt = (state: LabState) => new Date(EPOCH_MS + state.clock * 1000).toISOString();

/**
 * Called by the S3 / Cloud Storage commands after an object changes, so the
 * bucket's notification configurations can send their events.
 * `replaced` is true when the write overwrote an existing object.
 */
export function objectChanged(state: LabState, scheme: "s3" | "gs", bucket: string, key: string, change: ObjectChange, replaced = false) {
  if (scheme === "s3") s3Event(state, bucket, key, change);
  else gcsEvent(state, bucket, key, change, replaced);
}

// ------------------------------------------------------------------- S3

function s3Matches(config: S3QueueNotification, eventName: string, key: string): boolean {
  if (!key.startsWith(config.prefix) || !key.endsWith(config.suffix)) return false;
  return config.events.some((e) => e === `s3:${eventName}` || (e.endsWith(":*") && `s3:${eventName}`.startsWith(e.slice(0, -1))));
}

function s3Event(state: LabState, bucket: string, key: string, change: ObjectChange) {
  const configs = state.aws.s3Notifications.get(bucket) ?? [];
  const eventName = change === "put" ? "ObjectCreated:Put" : change === "copy" ? "ObjectCreated:Copy" : "ObjectRemoved:Delete";
  const content = state.s3.get(bucket)?.objects.get(key);
  for (const config of configs) {
    if (!s3Matches(config, eventName, key)) continue;
    const record = {
      Records: [
        {
          eventVersion: "2.6",
          eventSource: "aws:s3",
          awsRegion: REGION,
          eventTime: isoAt(state),
          eventName,
          userIdentity: { principalId: "AWS:AIDAEXAMPLE123456789" },
          s3: {
            s3SchemaVersion: "1.0",
            configurationId: config.id,
            bucket: { name: bucket, arn: `arn:aws:s3:::${bucket}` },
            // Object keys in events are URL-encoded; a space becomes "+".
            object: { key: encodeURIComponent(key).replace(/%20/g, "+").replace(/%2F/g, "/"), ...(content === undefined ? {} : { size: new TextEncoder().encode(content).length, eTag: md5(content) }) },
          },
        },
      ],
    };
    if (config.kind === "queue") deliverToQueue(state, config.destination, "s3.amazonaws.com", `arn:aws:s3:::${bucket}`, JSON.stringify(record));
  }
}

/** aws s3api put-bucket-notification-configuration | get-bucket-notification-configuration */
export function s3api(ctx: Ctx, args: string[]): number {
  const supported = ["put-bucket-notification-configuration", "get-bucket-notification-configuration"];
  const [sub, ...rest] = args;
  if (sub === undefined || !supported.includes(sub)) return unsupported(ctx, "s3api", sub, supported);
  const parsed = parse(rest, ["--bucket", "--notification-configuration", "--region", "--output"], []);
  if (parsed.unknown) {
    ctx.err(`\nUnknown options: ${parsed.unknown}`);
    return 252;
  }
  const state = ctx.state;
  const operation = operationName(sub);
  const bucket = parsed.options.get("--bucket")?.[0];
  if (!bucket) {
    ctx.err("\naws: error: the following arguments are required: --bucket");
    return 252;
  }
  if (!state.s3.has(bucket)) return fail(ctx, "NoSuchBucket", operation, "The specified bucket does not exist");

  if (sub === "get-bucket-notification-configuration") {
    const configs = state.aws.s3Notifications.get(bucket) ?? [];
    const filter = (c: S3QueueNotification) =>
      c.prefix || c.suffix
        ? { Filter: { Key: { FilterRules: [...(c.prefix ? [{ Name: "Prefix", Value: c.prefix }] : []), ...(c.suffix ? [{ Name: "Suffix", Value: c.suffix }] : [])] } } }
        : {};
    const queues = configs.filter((c) => c.kind === "queue").map((c) => ({ Id: c.id, QueueArn: c.destination, Events: c.events, ...filter(c) }));
    if (queues.length) json(ctx, { QueueConfigurations: queues });
    return 0;
  }

  const raw = parsed.options.get("--notification-configuration")?.[0];
  if (raw === undefined) {
    ctx.err("\naws: error: the following arguments are required: --notification-configuration");
    return 252;
  }
  const text = raw.startsWith("file://") ? state.files.get(resolvePath(state.cwd, raw.slice(7))) : raw;
  if (text === undefined) {
    ctx.err(`\nError parsing parameter '--notification-configuration': Unable to load paramfile ${raw}`);
    return 252;
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text);
  } catch {
    ctx.err("\nError parsing parameter '--notification-configuration': Invalid JSON");
    return 252;
  }
  if (doc.TopicConfigurations || doc.LambdaFunctionConfigurations || doc.EventBridgeConfiguration) {
    return fail(ctx, "InvalidArgument", operation, "這個模擬終端機的事件通知只支援 QueueConfigurations（送到 SQS 佇列）。");
  }
  const configs: S3QueueNotification[] = [];
  const entries = Array.isArray(doc.QueueConfigurations) ? (doc.QueueConfigurations as Record<string, unknown>[]) : [];
  for (const [i, c] of entries.entries()) {
    const events = Array.isArray(c.Events) ? c.Events.map(String) : [];
    if (typeof c.QueueArn !== "string" || !events.length) return fail(ctx, "MalformedXML", operation, "每個 QueueConfiguration 都要有 QueueArn 和 Events。");
    const bad = events.find((e) => !/^s3:(ObjectCreated|ObjectRemoved):(\*|Put|Post|Copy|CompleteMultipartUpload|Delete|DeleteMarkerCreated)$/.test(e));
    if (bad) return fail(ctx, "InvalidArgument", operation, `The event is not supported for notifications（${bad}；這個模擬終端機支援 s3:ObjectCreated:* 和 s3:ObjectRemoved:* 系列）`);
    const rules = ((c.Filter as { Key?: { FilterRules?: { Name?: string; Value?: string }[] } } | undefined)?.Key?.FilterRules ?? []);
    const rule = (name: string) => rules.find((r) => r.Name?.toLowerCase() === name)?.Value ?? "";
    configs.push({ id: typeof c.Id === "string" ? c.Id : `notification-${i + 1}`, destination: c.QueueArn, kind: "queue", events, prefix: rule("prefix"), suffix: rule("suffix") });
  }
  // S3 checks each destination by sending it a test message, which needs the queue policy to allow S3.
  const source = `arn:aws:s3:::${bucket}`;
  const invalid = configs.filter((c) => !queueAllows(state, c.destination, "s3.amazonaws.com", source));
  if (invalid.length) {
    return fail(
      ctx,
      "InvalidArgument",
      operation,
      `Unable to validate the following destination configurations\n（S3 要先送一則測試訊息到 ${invalid.map((c) => c.destination).join("、")}：佇列要存在，而且佇列政策要允許 s3.amazonaws.com 對這個 bucket（aws:SourceArn = ${source}）執行 sqs:SendMessage）`,
    );
  }
  state.aws.s3Notifications.set(bucket, configs);
  for (const c of configs) {
    deliverToQueue(
      state,
      c.destination,
      "s3.amazonaws.com",
      source,
      JSON.stringify({ Service: "Amazon S3", Event: "s3:TestEvent", Time: isoAt(state), Bucket: bucket, RequestId: md5(`${bucket}${state.clock}`).slice(0, 16).toUpperCase(), HostId: "EXAMPLEhostid" }),
    );
  }
  return 0;
}

// ------------------------------------------------------------- Cloud Storage

function gcsEvent(state: LabState, bucket: string, key: string, change: ObjectChange, replaced: boolean) {
  const configs = state.gcp.storageNotifications.get(bucket) ?? [];
  const member = `serviceAccount:${STORAGE_SERVICE_AGENT}`;
  const content = state.gcs.get(bucket)?.objects.get(key);
  // A replaced object gets an OBJECT_DELETE for the old version as well.
  const events = change === "delete" ? ["OBJECT_DELETE"] : replaced ? ["OBJECT_FINALIZE", "OBJECT_DELETE"] : ["OBJECT_FINALIZE"];
  for (const eventType of events) {
    const generation = String(1763280000000000 + state.clock * 1000 + state.gcp.pubsub.counter);
    for (const config of configs) {
      if (!key.startsWith(config.prefix)) continue;
      if (config.eventTypes.length && !config.eventTypes.includes(eventType)) continue;
      const topic = state.gcp.pubsub.topics.get(config.topic);
      // The service agent needs permission to publish to the topic.
      if (!topic || !["roles/pubsub.publisher", "roles/pubsub.editor", "roles/pubsub.admin"].some((r) => topic.iam.get(r)?.has(member))) continue;
      const payload =
        config.payload === "none" || content === undefined
          ? ""
          : JSON.stringify({ kind: "storage#object", name: key, bucket, generation, size: String(new TextEncoder().encode(content).length), timeCreated: isoAt(state) });
      publish(state, config.topic, payload, {
        notificationConfig: `projects/_/buckets/${bucket}/notificationConfigs/${config.id}`,
        eventType,
        payloadFormat: config.payload === "none" ? "NONE" : "JSON_API_V1",
        bucketId: bucket,
        objectId: key,
        objectGeneration: generation,
        eventTime: isoAt(state),
      });
    }
  }
}

/** gcloud storage buckets notifications create | list | delete */
export function storageNotifications(ctx: Ctx, args: string[]): number {
  const [action, ...rest] = args;
  const command = `gcloud.storage.buckets.notifications.${action}`;
  if (!["create", "list", "delete"].includes(action ?? "")) {
    return error(ctx, "gcloud.storage.buckets.notifications", `不支援的指令 '${action ?? ""}'。支援 create、list、delete。`);
  }
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  const known = ["--topic", "--event-types", "--object-prefix", "--payload-format", "--custom-attributes", "--project", "-t", "-e", "-p", "-f"];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--skip-topic-setup" || a === "-s") flags.add("--skip-topic-setup");
    else if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (!known.includes(name)) return error(ctx, command, `unrecognized arguments: ${a}`);
      const long = ({ "-t": "--topic", "-e": "--event-types", "-p": "--object-prefix", "-f": "--payload-format" } as Record<string, string>)[name] ?? name;
      options.set(long, eq === -1 ? (rest[++i] ?? "") : a.slice(eq + 1));
    } else positional.push(a);
  }
  const state = ctx.state;
  const url = positional[0];
  const m = url?.match(/^gs:\/\/([^/]+)\/?$/);
  if (!m) return error(ctx, command, "argument URL: 要指定 bucket，例如 gs://my-bucket");
  const bucket = m[1];
  if (!state.gcs.has(bucket)) return error(ctx, command, `gs://${bucket} not found: 404.`);
  const configs = state.gcp.storageNotifications.get(bucket) ?? [];

  if (action === "list") {
    if (!configs.length) ctx.out("Listed 0 items.\n");
    for (const c of configs) {
      ctx.out(
        `---\nid: '${c.id}'\npayload_format: ${c.payload === "none" ? "NONE" : "JSON_API_V1"}\n${c.eventTypes.length ? `event_types:\n${c.eventTypes.map((e) => `- ${e}\n`).join("")}` : ""}${c.prefix ? `object_name_prefix: ${c.prefix}\n` : ""}topic: //pubsub.googleapis.com/projects/${state.gcp.project}/topics/${c.topic}\n`,
      );
    }
    return 0;
  }
  if (action === "delete") {
    state.gcp.storageNotifications.delete(bucket);
    return 0;
  }

  const topic = (options.get("--topic") ?? bucket).replace(new RegExp(`^projects/${state.gcp.project}/topics/`), "");
  const types = (options.get("--event-types") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const badType = types.find((t) => !["OBJECT_FINALIZE", "OBJECT_METADATA_UPDATE", "OBJECT_DELETE", "OBJECT_ARCHIVE"].includes(t));
  if (badType) return error(ctx, command, `argument --event-types: Invalid choice: '${badType}'.`);
  const payload = options.get("--payload-format") ?? "json";
  if (payload !== "json" && payload !== "none") return error(ctx, command, "argument --payload-format: Invalid choice. 要是 json 或 none。");
  if (configs.length >= 100) return error(ctx, command, "一個 bucket 最多 100 個通知設定。");

  const topics = state.gcp.pubsub.topics;
  if (!flags.has("--skip-topic-setup")) {
    // gcloud creates the topic if needed and grants the Cloud Storage service agent permission to publish to it.
    if (!topics.has(topic)) {
      topics.set(topic, { iam: new Map(), published: 0 });
      ctx.out(`Created Pub/Sub topic [projects/${state.gcp.project}/topics/${topic}].\n`);
    }
    const iam = topics.get(topic)!.iam;
    const members = iam.get("roles/pubsub.publisher") ?? new Set<string>();
    if (!members.has(`serviceAccount:${STORAGE_SERVICE_AGENT}`)) {
      members.add(`serviceAccount:${STORAGE_SERVICE_AGENT}`);
      iam.set("roles/pubsub.publisher", members);
      ctx.out(`Granted roles/pubsub.publisher on [${topic}] to the Cloud Storage service agent [${STORAGE_SERVICE_AGENT}].\n`);
    }
  } else if (!topics.has(topic)) {
    return error(ctx, command, `NOT_FOUND: Pub/Sub topic projects/${state.gcp.project}/topics/${topic} does not exist.（加上 --skip-topic-setup 時，主題要先建立好）`);
  }
  const id = String(configs.length ? Math.max(...configs.map((c) => Number(c.id))) + 1 : 1);
  configs.push({ id, topic, eventTypes: types, prefix: options.get("--object-prefix") ?? "", payload });
  state.gcp.storageNotifications.set(bucket, configs);
  ctx.out(`---\nid: '${id}'\npayload_format: ${payload === "none" ? "NONE" : "JSON_API_V1"}\n${types.length ? `event_types:\n${types.map((e) => `- ${e}\n`).join("")}` : ""}topic: //pubsub.googleapis.com/projects/${state.gcp.project}/topics/${topic}\n`);
  return 0;
}
