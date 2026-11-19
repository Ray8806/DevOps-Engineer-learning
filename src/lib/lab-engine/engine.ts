import { aws } from "./aws";
import type { Command, Ctx } from "./context";
import { gcloud, gsutil } from "./gcloud";
import { curl, docker } from "./docker";
import { git } from "./git";
import { kubectl } from "./kubectl";
import { terraform } from "./terraform";
import { linuxCommands } from "./linux";
import { parseLine } from "./parse";
import { cloneState, createLabState, dirname, displayPath, listDir, resolvePath, type InitialState, type LabState } from "./state";

export interface OutputLine {
  text: string;
  error: boolean;
}

export interface ExecResult {
  /** New state; the input state is never modified. */
  state: LabState;
  lines: OutputLine[];
  /** True when the screen should be cleared (`clear`). */
  clear: boolean;
  /** Exit status of the last command that ran, as `$?` would show. */
  exitCode: number;
}

const HELP = `可用的指令：
  檔案與目錄  pwd  ls  cd  mkdir  touch  cat  echo  cp  mv  rm  rmdir  zip  base64
  時間        sleep 秒數（快轉模擬時鐘，例如 sleep 30）
  Git         git init | status | add | commit | log | branch | switch | checkout | merge
  Docker      docker build | images | tag | run | ps | stop | rm | rmi | login | push | pull，curl http://localhost:連接埠
  Kubernetes  kubectl apply -f | create | expose | get | describe | scale | set image | rollout status | history | undo | delete | config
  Terraform   terraform init | validate | fmt | plan | apply | destroy | output | state list | state show（-var、-auto-approve）
  AWS         aws s3 mb | rb | ls | cp | mv | rm
              aws iam  使用者、群組、角色與政策（輸入 aws iam 看完整清單）
              aws ec2  安全群組、執行個體、啟動範本、EBS 磁碟區與快照、VPC、子網路、閘道與路由表（輸入 aws ec2 看完整清單）
              aws elbv2  目標群組、Application Load Balancer、接聽程式（輸入 aws elbv2 看完整清單）
              aws autoscaling  Auto Scaling 群組與目標追蹤政策（輸入 aws autoscaling 看完整清單）
              aws lambda create-function | invoke | get-function | list-functions | update-function-configuration | update-function-code | delete-function
              aws rds  資料庫子網路群組、執行個體、唯讀複本與快照（輸入 aws rds 看完整清單）
              aws dynamodb create-table | describe-table | list-tables | put-item | get-item | query | scan | delete-item | update-time-to-live | delete-table
              aws cloudwatch put-metric-alarm | describe-alarms | set-alarm-state | delete-alarms，aws sns create-topic | subscribe | list-topics | list-subscriptions-by-topic
              aws logs create-log-group | describe-log-groups | put-retention-policy | filter-log-events | put-metric-filter，aws cloudtrail lookup-events
              aws route53 create-hosted-zone | list-hosted-zones | change-resource-record-sets | list-resource-record-sets | test-dns-answer
              aws cloudfront create-distribution | list-distributions | get-distribution | create-invalidation | list-invalidations
              aws kms create-key | create-alias | enable-key-rotation | encrypt | decrypt | schedule-key-deletion（輸入 aws kms 看完整清單）
              aws wafv2 create-ip-set | list-ip-sets | create-web-acl | list-web-acls | get-web-acl | associate-web-acl
              aws ce get-cost-and-usage | get-cost-forecast | list-cost-allocation-tags | update-cost-allocation-tags-status
              aws budgets create-budget | describe-budgets | delete-budget
              aws ecr create-repository | describe-repositories | describe-images | delete-repository | get-login-password
              aws ecs create-cluster | register-task-definition | create-service | describe-services | update-service | list-tasks
              aws eks create-cluster | describe-cluster | create-nodegroup | update-nodegroup-config | update-kubeconfig
              aws cloudformation validate-template | create-stack | describe-stacks | create-change-set | execute-change-set | detect-stack-drift | delete-stack（輸入 aws cloudformation 看完整清單）
              aws codebuild create-project | update-project | list-projects | start-build | batch-get-builds | list-builds-for-project
              aws sqs create-queue | send-message | receive-message | delete-message | get-queue-attributes | set-queue-attributes（輸入 aws sqs 看完整清單），aws sns publish
              aws s3api put-bucket-notification-configuration | get-bucket-notification-configuration（S3 事件通知送到 SQS）
  GCP         gcloud storage buckets create | delete | list | describe
              gcloud storage ls | cp | mv | rm | cat      （也支援 gsutil）
              gcloud iam service-accounts create | list | delete
              gcloud projects get-iam-policy | add-iam-policy-binding | remove-iam-policy-binding
              gcloud compute instances create | list | describe | stop | start | delete | add-tags | add-labels | remove-labels | attach-disk | detach-disk
              gcloud compute disks create | list | describe | resize | snapshot | delete，snapshots create | list | describe | delete
              gcloud compute firewall-rules create | list | delete
              gcloud compute instance-templates，instance-groups managed create | list | describe | list-instances | resize | set-autoscaling | set-named-ports | delete
              gcloud compute health-checks create http，backend-services create | add-backend | get-health，url-maps，target-http-proxies，forwarding-rules
              gcloud compute networks create | list | describe | delete
              gcloud compute networks subnets create | list | describe | delete
              gcloud compute routers create | list | describe | delete，routers nats create | list | delete
              gcloud run deploy，run services list | describe | update | delete | add-iam-policy-binding，run revisions list
              gcloud sql instances create | list | describe | patch | delete
              gcloud sql databases | users create | list | delete，sql backups create | list
              gcloud firestore databases create | list | describe | update | delete，indexes composite create | list
              gcloud firestore fields ttls update | list，firestore export
              gcloud logging read，logging metrics | sinks create | list | delete，logging buckets list | describe | update
              gcloud monitoring uptime create | list-configs | delete，monitoring policies create | list
              gcloud dns managed-zones create | list | describe | delete，dns record-sets create | list | describe | update | delete
              gcloud compute backend-buckets create | list | describe | delete，backend-services update --enable-cdn，url-maps invalidate-cdn-cache
              gcloud kms keyrings create | list，kms keys create | list | describe，kms keys versions list | create | destroy | restore，kms encrypt | decrypt
              gcloud compute security-policies create | list | describe | delete，security-policies rules create | update | delete
              gcloud billing accounts list，billing projects describe | link | unlink，billing budgets create | list | delete
              gcloud artifacts repositories create | list | describe | delete，artifacts docker images list，auth configure-docker
              gcloud container clusters create-auto | create | list | describe | get-credentials | resize | delete
              gcloud builds submit --config=cloudbuild.yaml [--substitutions=_KEY=value] [--region=…] | list | log | describe
              gcloud pubsub topics create | list | publish | add-iam-policy-binding，gcloud pubsub subscriptions create | update | pull | ack | describe
              gcloud storage buckets notifications create | list | delete（Cloud Storage 事件通知送到 Pub/Sub）
  其他        clear  help  whoami
支援 > 與 >> 輸出到檔案、用 | 把輸出交給下一個指令（cat、base64、docker login --password-stdin 會讀取）、用 && 或 ; 串接指令。按 Tab 補完路徑，上下鍵瀏覽歷史指令。
`;

const help: Command = (ctx) => {
  ctx.out(HELP);
  return 0;
};

const commands: Record<string, Command> = { ...linuxCommands, aws, gcloud, gsutil, git, docker, curl, kubectl, terraform, help };

export const COMMAND_NAMES = [...Object.keys(commands), "clear"].sort();

function splitLines(text: string, error: boolean): OutputLine[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((t) => ({ text: t, error }));
}

/** Runs one input line against the state and returns the new state and output. */
export function execute(state: LabState, line: string): ExecResult {
  const parsed = parseLine(line);
  if (!parsed.ok) return { state, lines: [{ text: `bash: ${parsed.error}`, error: true }], clear: false, exitCode: 2 };

  const draft = cloneState(state);
  const lines: OutputLine[] = [];
  let clear = false;
  let lastCode = 0;

  // Output captured for the next command of a pipeline.
  let piped: string | undefined;
  for (const [index, command] of parsed.commands.entries()) {
    const stdin = command.joiner === "pipe" ? (piped ?? "") : undefined;
    piped = undefined;
    const pipesOut = parsed.commands[index + 1]?.joiner === "pipe";
    if (command.joiner === "and" && lastCode !== 0) break;
    const [name, ...args] = command.argv;

    if (name === "clear") {
      lines.length = 0;
      clear = true;
      lastCode = 0;
      continue;
    }

    let stdout = "";
    const ctx: Ctx = {
      state: draft,
      out: (text) => {
        // Like bash, a redirect wins over the pipe: the next command then reads nothing.
        if (command.redirect || pipesOut) stdout += text;
        else lines.push(...splitLines(text, false));
      },
      err: (text) => lines.push(...splitLines(text, true)),
      stdin,
    };

    // Like a shell, open the redirect target before running the command.
    let target: string | undefined;
    if (command.redirect) {
      target = resolvePath(draft.cwd, command.redirect.path);
      const problem = draft.dirs.has(target)
        ? "Is a directory"
        : !draft.dirs.has(dirname(target))
          ? "No such file or directory"
          : null;
      if (problem) {
        ctx.err(`bash: ${command.redirect.path}: ${problem}`);
        lastCode = 1;
        continue;
      }
    }

    const run = Object.hasOwn(commands, name) ? commands[name] : undefined;
    if (!run) {
      ctx.err(`bash: ${name}: command not found（輸入 help 查看可用的指令）`);
      lastCode = 127;
    } else {
      lastCode = run(ctx, args);
    }

    if (target !== undefined && command.redirect) {
      draft.files.set(target, (command.redirect.append ? (draft.files.get(target) ?? "") : "") + stdout);
    } else if (pipesOut) piped = stdout;
  }

  return { state: draft, lines, clear, exitCode: lastCode };
}

/**
 * A lab's starting state: the seeded files and cloud, then its setup
 * commands. Throws when a setup command fails, since the lab would be broken.
 */
export function startLab(initial: InitialState): LabState {
  let state = createLabState(initial);
  for (const line of initial.setup ?? []) {
    const result = execute(state, line);
    if (result.exitCode !== 0) throw new Error(`Lab setup failed at "${line}": ${result.lines.map((l) => l.text).join(" ")}`);
    state = result.state;
  }
  return { ...state, cwd: createLabState({}).cwd };
}

/** Shell prompt for the current directory. */
export function prompt(state: LabState): string {
  return `learner@cloud:${displayPath(state.cwd)}$`;
}

/**
 * Tab completion: command names for the first word, local paths otherwise.
 * Returns the completed line, or the input unchanged when nothing (or more
 * than one thing with no longer common prefix) matches.
 */
export function complete(state: LabState, line: string): string {
  const start = line.lastIndexOf(" ") + 1;
  const word = line.slice(start);
  const head = line.slice(0, start);
  if (/["'\\]/.test(word)) return line;

  let candidates: string[];
  let base = "";
  if (head.trim() === "") {
    if (word === "") return line;
    candidates = COMMAND_NAMES.filter((c) => c.startsWith(word)).map((c) => `${c} `);
  } else {
    const slash = word.lastIndexOf("/");
    base = word.slice(0, slash + 1);
    const partial = word.slice(slash + 1);
    if (word.includes("://")) return line;
    const dir = resolvePath(state.cwd, base === "" ? "." : base);
    if (!state.dirs.has(dir)) return line;
    candidates = listDir(state, dir)
      .filter(([name]) => name.startsWith(partial) && (partial.startsWith(".") || !name.startsWith(".")))
      .map(([name, isDir]) => (isDir ? `${name}/` : `${name} `));
  }

  if (candidates.length === 0) return line;
  let common = candidates[0];
  for (const c of candidates) {
    while (!c.startsWith(common)) common = common.slice(0, -1);
  }
  if (candidates.length > 1) common = common.trimEnd();
  return common.length > word.length - base.length ? head + base + common : line;
}
