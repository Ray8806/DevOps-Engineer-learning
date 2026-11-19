# 雲端工程師學習網站 — 開發規劃

> 這份文件是後續開發的唯一依據。每次開發只做「第 8 節」的一個階段，完成並驗收後再進下一個。

## 1. 產品定位

- **對象**：零基礎到初階、想入門或轉職雲端工程師的人。
- **語言**：繁體中文介面與內容；服務名稱、指令、證照名稱保留英文。
- **範圍**：AWS 與 GCP 雙平台，加上證照備考。
- **學習方式**：每個單元都是「讀 → 測驗 → 動手做」三步。
- **核心設計原則**：**先教觀念，再分平台**。一個單元教一個通用觀念（例如「物件儲存」），再用分頁呈現 AWS 與 GCP 各自的做法，不把兩個平台做成兩套重複課程。

## 2. 三種學習入口

同一批內容，用三種方式進入：

| 入口 | 給誰 | 呈現方式 |
|---|---|---|
| 技能路線 | 想有系統學完的人 | 技能樹，依階段解鎖 |
| 平台路線 | 只想學 AWS 或只想學 GCP 的人 | 同一棵技能樹，篩選為單一平台 |
| 證照路線 | 以考照為目標的人 | 依考試範圍（domain）列出對應單元與題庫 |

使用者可在設定中選「主要平台」（AWS／GCP／兩者），單元頁預設顯示該平台的分頁。

## 3. 課程內容

### 3.1 技能階段

| 階段 | 觀念單元 | AWS | GCP |
|---|---|---|---|
| 0 基礎 | Linux 指令、網路（IP、DNS、HTTP、子網路）、Git | — | — |
| 1 核心 | 身分與權限 | IAM | Cloud IAM |
| | 虛擬機 | EC2 | Compute Engine |
| | 無伺服器運算 | Lambda | Cloud Run、Cloud Functions |
| | 物件儲存 | S3 | Cloud Storage |
| | 區塊與檔案儲存 | EBS、EFS | Persistent Disk、Filestore |
| | 虛擬網路 | VPC | VPC |
| | 關聯式資料庫 | RDS、Aurora | Cloud SQL、Spanner |
| | NoSQL 資料庫 | DynamoDB | Firestore、Bigtable |
| 2 維運 | 負載平衡與自動擴展 | ELB、Auto Scaling | Cloud Load Balancing、MIG |
| | 監控與日誌 | CloudWatch、CloudTrail | Cloud Monitoring、Cloud Logging |
| | DNS 與 CDN | Route 53、CloudFront | Cloud DNS、Cloud CDN |
| | 資安基礎 | KMS、Security Group、WAF | Cloud KMS、防火牆規則、Cloud Armor |
| | 成本管理 | Cost Explorer、Budgets | Billing、Budgets |
| 3 自動化 | 容器 | ECS、ECR | Artifact Registry、Cloud Run |
| | Kubernetes | EKS | GKE |
| | 基礎架構即程式碼 | Terraform、CloudFormation | Terraform |
| | CI/CD | CodeBuild、CodePipeline | Cloud Build、Cloud Deploy |
| | 訊息佇列 | SQS、SNS | Pub/Sub |
| 4 實戰 | 架構設計案例（高可用網站、資料管線、災難復原）、面試題 | 兩平台各一版解法 | |

### 3.2 服務對照表

獨立頁面，列出 AWS 與 GCP 的對應服務，可搜尋，每列連到對應單元。資料來源就是各單元的 metadata，不另外維護。

### 3.3 證照

第一版支援四張：

| 證照 | 平台 | 等級 |
|---|---|---|
| AWS Certified Cloud Practitioner (CLF-C02) | AWS | 入門 |
| AWS Certified Solutions Architect – Associate (SAA-C03) | AWS | 助理級 |
| Google Cloud Digital Leader | GCP | 入門 |
| Google Associate Cloud Engineer | GCP | 助理級 |

每張證照的考試資訊放在 `content/certs/<id>/cert.json`，題庫放在 `content/certs/<id>/questions/*.json`（格式與單元測驗的題目相同）。

- **考試資訊只能抄自官方來源，不能憑記憶填**（考試會改版）。`source.guideUrl` 記錄出處，`source.verifiedOn` 記錄核對日期。官方沒寫的欄位就留空，頁面會自動不顯示。
- 目前的資料於 2026-11-12 對照官方考試指南。AWS 的指南沒有列出考試時間，所以這一欄是空的。Associate Cloud Engineer 現行指南是 4 個範圍。
- 單元測驗裡標了 `certs` 的題目會自動併入該證照的練習題。
- 題目的 `certs[].domain` 和單元的 `certDomains` 都會對照 `cert.json` 檢查，範圍編號不存在時建置會失敗。

每張證照頁目前提供：考試資訊、範圍與對應單元、依範圍練習（不計時，每輪隨機抽 10 題，只記錄每題對錯）。完整模擬考、錯題本、弱點分析在階段 8。

## 4. 功能規格

### 第一版（MVP）

1. **學習路線圖**：技能樹，顯示完成度，可依平台篩選。
2. **單元頁**：MDX 文章，含 AWS／GCP 分頁、架構圖、程式碼區塊。
3. **單元測驗**：單選與多選，作答後立即顯示每個選項的解析。
4. **模擬終端機 Lab**：在瀏覽器內練 Linux、`aws`、`gcloud`、`gsutil` 指令，由腳本驗證。
5. **證照練習模式**：依證照與 domain 抽題練習，不計時。
6. **服務對照表**。
7. **進度追蹤**：存在 localStorage，不需登入。

### 第二版

8. **會員登入與跨裝置同步**。
9. **完整模擬考**：計時、依 domain 比重抽題、交卷後出成績與各 domain 得分。
10. **錯題本與弱點分析**。
11. **架構圖拖拉練習**：給需求，用元件拼出架構。
12. **AI 助教**：串 Claude API 解釋錯題、回答課程問題。

### 明確不做

- 不連接使用者真實的 AWS／GCP 帳號（費用與金鑰外洩風險）。Lab 一律是模擬。
- 不收錄任何真實考古題（違反考試保密協議）。題目全部原創，依官方範圍撰寫。

## 5. 技術架構

- **框架**：Next.js（App Router）、TypeScript（strict）、Tailwind CSS。
- **內容**：MDX 加 JSON，放在 repo 內，建置時載入並用 Zod 驗證格式。
- **終端機**：自寫的 React 終端機元件加指令模擬引擎。沒有用 xterm.js：它需要自己處理行編輯，中文輸入法、手機鍵盤和螢幕閱讀器的支援都比原生輸入框差，而這裡只需要一行輸入加輸出紀錄。
- **測試**：Vitest（Lab 引擎、抽題邏輯、內容格式驗證），Playwright（主要流程）。
- **會員與資料庫（第二版）**：Supabase（Auth 加 Postgres）。
- **部署**：Vercel。

### 目錄結構

```
content/
  units/<unit-id>/
    unit.json          # metadata
    lesson.mdx         # 課文
    quiz.json          # 單元測驗
    labs/<lab-id>.json # Lab
    flows/<flow-id>.json # 課文裡的流程動畫
  certs/<cert-id>/
    cert.json          # 考試資訊與 domain
    questions/*.json   # 題庫
  stages.json          # 階段與單元順序
src/
  app/                 # 首頁、路線圖、單元、測驗、Lab、證照、對照表
  components/          # Roadmap, ProviderTabs, Quiz, Terminal, ExamRunner
  lib/
    content/           # 載入與 Zod schema
    progress/          # 進度儲存、合併與同步
    auth/              # Supabase 登入與帳號狀態
    lab-engine/        # 指令解析、虛擬狀態、驗證
    exam/              # 抽題、計分
```

## 6. 內容格式

格式在階段 1 定案後不再更動，之後新增課程只加檔案、不改程式。

### unit.json

```json
{
  "id": "object-storage",
  "title": "物件儲存",
  "summary": "一句話說明這個單元，顯示在卡片與單元頁開頭。",
  "stage": 1,
  "prerequisites": ["iam-basics"],
  "providers": {
    "aws": { "services": ["S3"] },
    "gcp": { "services": ["Cloud Storage"] }
  },
  "compare": [
    { "aspect": "命令列工具", "aws": "aws s3", "gcp": "gcloud storage" }
  ],
  "certDomains": ["clf-c02:3", "saa-c03:3"],
  "estimatedMinutes": 25
}
```

- `providers` 留空物件代表不分平台的單元（例如 Linux 基礎）。
- `compare` 是 `<Compare />` 表格的資料來源。
- `certDomains` 的格式是 `<證照 id>:<domain 編號>`；該證照的 `cert.json` 存在時會檢查編號是否有效。

### stages.json

```json
{ "stages": [{ "id": 1, "title": "雲端核心", "description": "…", "units": ["object-storage"] }] }
```

`units` 的順序就是學習順序。每個單元必須剛好列在一個階段，且與 `unit.json` 的 `stage` 一致。

### lesson.mdx

```mdx
## 什麼是物件儲存
（通用觀念）

<ProviderTabs>
  <Provider name="aws">S3 的做法…</Provider>
  <Provider name="gcp">Cloud Storage 的做法…</Provider>
</ProviderTabs>

<Callout title="提醒">補充說明…</Callout>

<Compare />
```

可用元件：`ProviderTabs`、`Provider`、`Callout`、`Compare`（由 `unit.json` 的 `compare` 產生差異表）、`Flow`（流程動畫，見下一節）。`unit.json` 宣告的每個平台都必須有對應的 `<Provider>` 區塊。MDX 內不能使用 `{ }` JavaScript 運算式。

### flows/<flow-id>.json（流程動畫）

課文寫 `<Flow id="pipeline" />`，就會顯示 `flows/pipeline.json` 定義的動畫：方塊和箭頭組成的圖，可以播放或一步步看，每一步有說明文字。

```json
{
  "id": "pipeline",
  "title": "一次提交怎麼走完管線",
  "nodes": [
    { "id": "dev", "label": "開發者", "col": 0, "row": 0 },
    { "id": "build", "label": "建置", "detail": "編譯、單元測試", "col": 1, "row": 0 }
  ],
  "steps": [
    { "from": "dev", "to": "build", "text": "推送提交，啟動建置。" },
    { "from": "build", "text": "只寫 from：強調這個方塊。" },
    { "from": "build", "to": "dev", "text": "status 是 fail 時用紅色顯示。", "status": "fail" }
  ]
}
```

- 方塊放在格子上：`col` 0–4、`row` 0–2，不能兩個方塊同一格。手機上欄列互換（橫向的流程變成直向）。
- `label` 最多 12 字、`detail` 最多 20 字；全形字的 label 建議 8 個字以內。
- 箭頭由步驟的 `from`→`to` 產生；同一對方塊兩個方向都用到時，會畫成兩條平行線。
- 載入時會檢查：步驟引用的方塊存在、檔名和 `id` 一致、每個 flow 都有在課文用到、課文的 `<Flow id>` 都有對應的檔案。
- 系統設定「減少動態效果」時不播放移動的動畫，只切換高亮。

### 題目（單元測驗與證照題庫共用）

```json
{
  "id": "s3-001",
  "type": "single",
  "provider": "aws",
  "certs": [{ "id": "saa-c03", "domain": 1 }],
  "unitId": "object-storage",
  "difficulty": 2,
  "question": "…",
  "options": [
    { "id": "a", "text": "…", "explanation": "…" },
    { "id": "b", "text": "…", "explanation": "…" }
  ],
  "answer": ["b"]
}
```

`type` 為 `single` 或 `multiple`；`provider` 為 `aws`、`gcp` 或 `general`。每個選項都要有解析，說明為什麼對或錯。

### lab.json

```json
{
  "id": "s3-create-bucket",
  "title": "建立 bucket 並上傳檔案",
  "description": "練習 aws s3 最常用的指令。",
  "provider": "aws",
  "estimatedMinutes": 10,
  "initialState": { "files": { "~/report.txt": "hello" }, "cloud": {} },
  "steps": [
    {
      "instruction": "建立一個名為 my-data 的 bucket",
      "hint": "使用 aws s3 mb",
      "check": { "type": "state", "path": ["cloud", "s3", "buckets", "my-data"], "exists": true }
    }
  ]
}
```

Lab 引擎維護一份虛擬狀態（檔案系統加雲端資源），指令會改變狀態，步驟以**狀態**判定通過，而不是比對指令字串，這樣同一步驟的多種正確寫法都能過。

`check.path` 是鍵的陣列而不是用點分隔的字串，因為物件名稱本身會含有點（例如 `report.txt`）。`check` 必須剛好有 `exists` 或 `equals` 其中一個。可檢查的路徑：

| 路徑 | 內容 |
|---|---|
| `["files", "~/a.txt"]` | 檔案內容 |
| `["dirs", "~/projects"]` | 目錄是否存在 |
| `["cwd"]` | 目前目錄，例如 `"~/projects"` |
| `["cloud", "s3", "buckets", 名稱, "region" \| "storageClass" \| "objects", key]` | S3 |
| `["cloud", "gcs", "buckets", 名稱, "location" \| "storageClass" \| "objects", 名稱]` | Cloud Storage |
| `["cloud", "aws", "iam", "users" \| "groups", 名稱, "groups" \| "policies", 名稱或 ARN]` | IAM 使用者、群組、附加的政策 |
| `["cloud", "aws", "ec2", "securityGroups", 群組名稱, "ingress" \| "runningInstances"]` | 安全群組的規則（例如 `"tcp:443:0.0.0.0/0"`）與使用它的執行中執行個體數 |
| `["cloud", "aws", "ec2", "counts", "running" \| "stopped" \| "terminated"]` | 各狀態的執行個體數量（ID 是產生的，Lab 無法預先知道，所以用數量檢查） |
| `["cloud", "aws", "ec2", "volumeSpecs", "可用區/類型/大小", "count" \| "attached" \| "fromSnapshot"]` | EBS 磁碟區依規格分組的數量，例如 `"us-east-1a/gp3/20"`；`["cloud", "aws", "ec2", "snapshotCount"]` 是 EBS 快照數量 |
| `["cloud", "aws", "iam", "roles", 名稱, "trustedServices" \| "policies", 服務或 ARN]` | IAM 角色：信任政策允許扮演的服務（例如 `lambda.amazonaws.com`）與附加的政策 |
| `["cloud", "aws", "lambda", "functions", 名稱, "runtime" \| "handler" \| "role" \| "timeout" \| "memorySize" \| "environment" \| "invoked"]` | Lambda 函式；`invoked` 代表至少成功呼叫過一次 |
| `["cloud", "aws", "ec2", "launchTemplates", 名稱, "imageId" \| "instanceType"]` | 啟動範本 |
| `["cloud", "aws", "elbv2", "targetGroups", 名稱, "protocol" \| "port" \| "healthCheckPath" \| "healthyTargets"]`、`[…, "targets", 執行個體 ID]` | 目標群組；目標的狀態是 `"healthy"`、`"unhealthy"` 或 `"unused"`（還沒有接聽程式轉送到這個群組） |
| `["cloud", "aws", "elbv2", "loadBalancers", 名稱, "scheme" \| "availabilityZones" \| "listeners"]` | ALB；`listeners` 像 `{ "HTTP:80": "web-tg" }` |
| `["cloud", "aws", "autoscaling", "groups", 名稱, "min" \| "max" \| "desired" \| "inService" \| "healthCheckType" \| "replacedInstances"]`、`[…, "policies", 政策名稱]` | Auto Scaling 群組；政策的值像 `{ "metric": "ASGAverageCPUUtilization", "target": 50 }` |
| `["cloud", "gcp", "instanceTemplates", 名稱, "machineType" \| "tags"]`、`["cloud", "gcp", "migs", 名稱, "targetSize" \| "size" \| "namedPorts" \| "autoscaler" \| "recreated"]` | 執行個體範本與 MIG；`autoscaler` 像 `{ "min": 2, "max": 5, "cpu": 0.6 }` |
| `["cloud", "gcp", "backendServices", 名稱, "portName" \| "healthCheck" \| "scheme" \| "backends" \| "healthyInstances"]` | 後端服務；健康的條件是 VM 在執行中，而且有防火牆規則允許 `35.191.0.0/16` 連到健康檢查的連接埠 |
| `["cloud", "gcp", "forwardingRules", 名稱, "ipAddress" \| "port" \| "backendService" \| "serving"]` | 轉送規則；`serving` 代表 proxy、URL 對應、後端服務都接好了，有健康的後端，而且 MIG 有後端服務要的具名連接埠 |
| `["cloud", "aws", "sns", "topics", 名稱, "subscriptions", "通訊協定:端點"]` | SNS 訂閱的狀態，`"PendingConfirmation"` 或 `"Confirmed"` |
| `["cloud", "aws", "cloudwatch", "alarms", 名稱, "condition" \| "notifies" \| "state" \| …]` | CloudWatch 警示；`condition` 像 `"CPUUtilization > 80 for 2 x 300s"`，`notifies` 是通知的 SNS 主題名稱集合 |
| `["cloud", "aws", "logs", "groups", 名稱, "retentionInDays" \| "eventCount" \| "searches" \| "metricFilters", …]` | 記錄群組；`retentionInDays` 為 `null` 代表永久保留，`searches` 是用過的篩選模式 |
| `["cloud", "gcp", "logging", "queries" \| "metrics" \| "buckets" \| "sinks", …]` | `queries` 是 `gcloud logging read` 用過的篩選條件（去掉運算子旁的空白）；`metrics.名稱.filter`；`buckets.ID.retentionDays`；`sinks.名稱` 像 `{ "destination": "…", "filter": "…" }` |
| `["cloud", "gcp", "monitoring", "uptimeChecks" \| "policies", 名稱, …]` | 正常運作時間檢查（`host`、`path`、`period`）與快訊政策（`conditionFilter`、`condition` 像 `"> 5 for 60s"`） |
| `["cloud", "aws", "route53", "zones", "example.com.", "nameServerCount" \| "records" \| "weighted", …]` | Route 53 代管區域（以結尾有句點的網域名稱當鍵）；`records["www.example.com./A"]` 是 `{ ttl, values, aliasTo }`，`aliasTo` 像 `"cloudfront:來源網域"`、`"elb:名稱"`、`"record:名稱"`；`weighted["api.example.com./A"]` 像 `{ "blue": 90, "green": 10 }` |
| `["cloud", "aws", "cloudfront", "distributions", 來源網域, "defaultRootObject" \| "invalidations", …]` | CloudFront 分配（以來源網域當鍵，例如 `my-site.s3.amazonaws.com`）；`invalidations` 是清除過的路徑集合 |
| `["cloud", "gcp", "backendBuckets", 名稱, "gcsBucket" \| "cdn" \| "cacheMode"]`、`["cloud", "gcp", "urlMaps", 名稱, "defaultService" \| "defaultBackendBucket" \| "invalidations", …]` | backend bucket 與 URL 對應；後端服務也有 `cdn`、`cacheMode` |
| `["cloud", "gcp", "dns", "zones", 區域名稱, "dnsName" \| "visibility" \| "records", …]` | Cloud DNS 區域；`records["www.example.com./A"]` 是 `{ ttl, rrdatas, forwardingRule }`，`forwardingRule` 是 IP 對得上的轉送規則名稱 |
| `["cloud", "aws", "kms", "aliases", "alias/名稱", "description" \| "state" \| "rotationPeriodInDays" \| "pendingWindowInDays"]` | KMS 金鑰（以別名當鍵）；`state` 是 `Enabled`、`Disabled` 或 `PendingDeletion`，沒開輪替時 `rotationPeriodInDays` 是 `null` |
| `["cloud", "aws", "wafv2", "webAcls", 名稱, "scope" \| "defaultAction" \| "rules" \| "associatedLoadBalancers", …]` | web ACL；`rules` 像 `{ "common-rules": "managed:AWS/AWSManagedRulesCommonRuleSet" }`，也可能是 `"ipset:名稱:Block"`、`"geo:CN:Block"`、`"rate:1000:Block"` |
| `["cloud", "gcp", "kms", "keyRings", "位置/金鑰環", "keys", 金鑰, "rotationPeriod" \| "primary" \| "versions" \| "recovered", …]` | Cloud KMS 金鑰；`rotationPeriod` 像 `"7776000s"`，`versions["1"]` 是版本狀態，`recovered["1"]` 代表版本 1 被還原後又重新啟用 |
| `["cloud", "gcp", "securityPolicies", 名稱, "rules", 優先順序, "action" \| "srcIpRanges" \| "preview"]` | Cloud Armor 規則；預設規則的優先順序是 `"2147483647"`；後端服務的 `securityPolicy` 是掛上的政策名稱 |
| `["cloud", "aws", "ce", "queries" \| "costAllocationTags", …]` | Cost Explorer：`queries` 有 `"SERVICE"`、`"TAG:Project:active"`（或 `:inactive`）、`"FORECAST"`；`costAllocationTags.Project` 是 `"Active"` 或 `"Inactive"` |
| `["cloud", "aws", "budgets", 名稱, "limit" \| "timeUnit" \| "notifications", …]` | 預算；`limit` 像 `"700 USD"`，`notifications` 像 `{ "ACTUAL > 80%": { "email:a@example.com": true } }` |
| `["cloud", "gcp", "billing", "linked" \| "budgets", …]` | Cloud Billing；`budgets.名稱` 是 `{ amount: "300 USD", thresholds: { "90%": "current-spend" }, filterLabels, filterProjects }` |
| `["cloud", "gcp", "instances", 名稱, "labels"]` | VM 的標籤，像 `{ "team": "web" }` |
| `["docker", "images", "名稱:標籤", "id" \| "base" \| "exposed"]`、`["docker", "containers", 名稱, "image" \| "ports" \| "status"]`、`["docker", "logins", registry]` | 本機的 Docker；`ports` 像 `["8080->80"]` |
| `["cloud", "aws", "ecr", "repositories", 名稱, "mutability" \| "scanOnPush" \| "images", 標籤]` | ECR 儲存庫；`images` 是標籤對映像檔 ID |
| `["cloud", "aws", "ecs", "clusters" \| "taskDefinitions" \| "services", …]` | ECS；`taskDefinitions["family:1"].{cpu, memory, networkMode, executionRole, images}`，`services["叢集/服務"].{taskDefinition, desiredCount, runningCount, launchType}`（映像檔還沒推送到 ECR 時 `runningCount` 是 0） |
| `["cloud", "gcp", "artifacts", "repositories", "位置/名稱", "format" \| "images", "映像檔:標籤"]` | Artifact Registry 儲存庫 |
| `["terraform", "~/目錄", "initialized" \| "resources" \| "outputs" \| "driftRepairs" \| "applies", …]` | Terraform 工作目錄；`resources` 是管理中的位址集合（例如 `google_storage_bucket.site`），`driftRepairs` 是在 Terraform 之外被刪除、又被 apply 建回來的次數 |
| `["cloud", "aws", "cloudformation", "stacks", 名稱, "status" \| "resources" \| "outputs" \| "parameters" \| "drift" \| "retained", …]` | CloudFormation 堆疊；刪除後保留，`status` 是 `DELETE_COMPLETE`；`drift` 是 `IN_SYNC` 或 `DRIFTED`；`retained` 是因為 `DeletionPolicy: Retain` 而保留的邏輯 ID |
| `["cloud", "aws", "codebuild", "projects", 名稱, "source" \| "image" \| "privilegedMode" \| "lastBuild" \| "failedBuilds"]` | CodeBuild 專案；`lastBuild` 是最近一次建置的狀態（`SUCCEEDED`、`FAILED`，還沒建置是 null） |
| `["cloud", "gcp", "cloudbuild", "lastBuild" \| "failedBuilds" \| "builds", …]` | Cloud Build；`lastBuild` 是最近一次建置的狀態（`SUCCESS`、`FAILURE`），`builds[ID]` 有 `status` 和各步驟的狀態 `steps` |
| `["cloud", "aws", "sqs", "queues", 名稱, "messages" \| "visibilityTimeout" \| "deadLetterQueue" \| "maxReceiveCount" \| "hasPolicy" \| "sent" \| "deletedAny" \| "redelivered" \| "movedToDeadLetter" \| "receivedFromSns"]` | SQS 佇列；`redelivered` 是有訊息被接收第二次以上，`movedToDeadLetter` 是有訊息因為超過 maxReceiveCount 被移走，`receivedFromSns` 是收過 SNS 送來的訊息 |
| `["cloud", "gcp", "pubsub", "topics" \| "subscriptions", ID, …]` | Pub/Sub；主題有 `published`、`iam[角色][成員]`；訂閱有 `topic`、`ackDeadline`、`backlog`、`deadLetterTopic`、`maxDeliveryAttempts`、`iam`、`ackedAny`、`redelivered`、`ackedAfterRedelivery`、`forwardedToDeadLetter` |
| `["kube", "currentContext"]` | kubectl 目前的內容：EKS 是叢集 ARN，GKE 是 `gke_專案_位置_叢集` |
| `["cloud", "aws", "eks", "clusters", 名稱, "status" \| "nodegroups" \| "k8s", …]`、`["cloud", "gcp", "gke", "clusters", 名稱, "location" \| "mode" \| "k8s", …]` | 叢集；`k8s.deployments["命名空間/名稱"]` 是 `{ replicas, readyReplicas, images, revision }`，`k8s.services["命名空間/名稱"]` 是 `{ type, port, targetPort, endpoints, externalIp }`，`k8s.namespaces[名稱]` |
| `["cloud", "aws", "dynamodb", "tables", 名稱, "definition"]` | 資料表的定義，值像 `{ "partitionKey": "CustomerId", "sortKey": "OrderId", "billingMode": "PAY_PER_REQUEST" }`，用 `equals` 檢查 |
| `["cloud", "aws", "dynamodb", "tables", 名稱, "itemCount" \| "ttlAttribute"]`、`[…, "items", "分割區鍵值\|排序鍵值"]`、`[…, "queriedPartitions", 分割區鍵值]` | 項目數量、TTL 屬性、某個項目是否存在（簡單主鍵只有分割區鍵值）、是否用 Query 查過某個分割區 |
| `["cloud", "gcp", "firestore", "databases", 資料庫 ID, "location" \| "type" \| "edition" \| "deleteProtection" \| "exportCount"]` | Firestore 資料庫；預設資料庫的 ID 是 `(default)` |
| `["cloud", "gcp", "firestore", "databases", 資料庫 ID, "indexes" \| "ttlFields", 值]` | 手動索引（例如 `"orders(customerId ASCENDING, createdAt DESCENDING)"`）與 TTL 欄位（例如 `"sessions.expiresAt"`） |
| `["cloud", "gcp", "disks", 名稱, "zone" \| "sizeGb" \| "type" \| "sourceSnapshot" \| "users", 執行個體]` | Persistent Disk；`users` 的值是 `"rw"` 或 `"ro"` |
| `["cloud", "gcp", "snapshots", 名稱, "sourceDisk" \| "sizeGb"]` | 磁碟快照 |
| `["cloud", "gcp", "run", "services", 名稱, "region" \| "image" \| "public" \| "concurrency" \| "memory" \| "timeout" \| "minInstances" \| "maxInstances" \| "env" \| "revisionCount"]` | Cloud Run 服務；`public` 代表已關閉 Invoker IAM 檢查，或 `allUsers` 有 `roles/run.invoker` |
| `["cloud", "gcp", "serviceAccounts", 電子郵件]`、`["cloud", "gcp", "bindings", 角色, 成員]` | 服務帳戶與專案的 IAM 授權 |
| `["cloud", "gcp", "instances", 名稱, "status" \| "zone" \| "machineType" \| "tags"]` | Compute Engine 執行個體 |
| `["cloud", "gcp", "instances", 名稱, "networkInterface"]` | 執行個體的網路，值像 `{ "network": "lab-net", "subnet": "web", "externalIp": false }`，用 `equals` 檢查 |
| `["cloud", "gcp", "firewallRules", 名稱, "network"]`、`["cloud", "gcp", "firewallRules", 名稱, "allow" \| "sourceRanges" \| "targetTags", 值]` | 防火牆規則 |
| `["cloud", "aws", "vpcs", VPC 的 CIDR, "internetGateway" \| "internetRoute" \| "publicSubnets"]` | VPC（以 CIDR 而不是產生的 ID 當鍵；同一段 CIDR 有多個 VPC 時取最早建立的）：是否連接網際網路閘道、是否有路由表通往閘道、公有子網路的集合（例如 `{ "10.0.1.0/24": true }`） |
| `["cloud", "aws", "vpcs", VPC 的 CIDR, "subnets", 子網路 CIDR, "availabilityZone" \| "public" \| "mapPublicIpOnLaunch"]` | 子網路；`public` 代表它使用的路由表（明確關聯的或主路由表）有路由通往已連接的網際網路閘道 |
| `["cloud", "aws", "rds", "subnetGroups", 名稱, "subnets" \| "availabilityZones", 值]` | DB 子網路群組 |
| `["cloud", "aws", "rds", "instances", 識別碼, "engine" \| "multiAZ" \| "publiclyAccessible" \| "subnetGroup" \| "backupRetentionPeriod" \| "deletionProtection" \| "readReplicaSource"]` | RDS 執行個體（`readReplicaSource` 是來源的識別碼，不是複本時為 `null`） |
| `["cloud", "aws", "rds", "snapshots", 識別碼, "instance"]` | 手動快照與最終快照 |
| `["cloud", "gcp", "networks", 名稱, "mode" \| "subnets" \| "natRegions", …]` | VPC 網路：`mode` 是 `auto` 或 `custom`；`subnets.名稱.region` 與 `.range`；`natRegions.區域` 代表該區域有 Cloud NAT 服務這個網路 |
| `["cloud", "gcp", "routers", 名稱, "network" \| "region" \| "nats", 名稱]` | Cloud Router 與上面的 NAT |
| `["cloud", "gcp", "sql", "instances", 名稱, "databaseVersion" \| "edition" \| "tier" \| "region" \| "availabilityType" \| "backupsEnabled" \| "masterInstanceName" \| "databases" \| "users" \| "backupCount", …]` | Cloud SQL 執行個體；`backupCount` 是隨選備份的份數 |
| `["git", "~/project", "branch" \| "commitCount" \| "lastMessage" \| "clean"]` | Git 儲存庫目前的分支、提交數等 |
| `["git", "~/project", "branches" \| "staged", 名稱]` | 分支是否存在、檔案是否在暫存區 |
| `["git", "~/project", "branchFiles", 分支, 路徑]` | 某分支最新的提交是否包含某檔案 |

步驟依序完成，完成後不會退回：後面的步驟把前面的條件改掉（例如把剛複製的檔案改名）不影響已完成的步驟。

`initialState.files` 的路徑要以 `~/` 或 `/` 開頭。`initialState.cloud` 可以預先放 bucket，形狀與上表相同；也可以用 `cloud.gcp` 預設專案 ID 和既有的 IAM 授權（`{ "project": "…", "bindings": { 角色: [成員] } }`），用 `cloud.aws.vpcs` 預先建立 VPC 與子網路（`{ VPC ID: { "cidr": "…", "subnets": { 子網路 ID: { "cidr": "…", "availabilityZone": "…" } } } }`，每個 VPC 會自動有只含本地路由的主路由表）。`cloud.aws.logs`（`{ 記錄群組: [{ "stream", "message" }] }`）、`cloud.aws.cloudtrail`（`[{ "eventName", "username", "eventSource", "resourceName", "eventTime" }]`）與 `cloud.gcp.logs`（`[{ "severity", "resourceType", "logName", "text", "timestamp" }]`）預先放記錄；`cloud.aws.kms`（`{ "alias/名稱": { "description" } }`）預先放已有別名的 KMS 金鑰；`cloud.aws.costs`（`[{ "month": "2026-10", "service", "amount", "tags" }]`）預先放費用資料；`cloud.aws.ec2`（`{ "instances": { ID: { instanceType, state } }, "volumes": { ID: { size, type, attachedTo } } }`）預先放執行個體和 EBS 磁碟區；`cloud.gcp.instances`、`cloud.gcp.disks`（`users` 是使用中的 VM）、`cloud.gcp.billingAccount`（`{ id, name }`）預先放 GCP 資源。模擬環境的「今天」是 2026-11-16。

模擬環境的起始狀態：AWS 帳戶裡沒有預設 VPC，執行個體預設啟動在 `us-east-1a`；Google Cloud 專案裡有 auto 模式的 `default` 網路（不另外列出它在各區域的子網路），沒有指定網路的執行個體和防火牆規則都放在 `default`。

### Lab 引擎

程式在 `src/lib/lab-engine/`，是不依賴瀏覽器的純函式：`execute(state, line)` 回傳新的狀態與輸出，不修改傳入的狀態。

- **支援的指令**：`pwd ls cd mkdir touch cat base64 echo cp mv rm rmdir zip clear help whoami`（`zip` 產生的是模擬的封存檔，`cat` 可以看到內容）；`aws s3 mb|rb|ls|cp|mv|rm`；`gcloud storage buckets create|delete|list|describe` 與 `gcloud storage ls|cp|mv|rm|cat`；`gsutil mb|rb|ls|cp|mv|rm|cat`；`aws iam`（使用者、群組、角色、受管政策）；`aws ec2`（安全群組、執行個體、EBS 磁碟區與快照、VPC、子網路、網際網路閘道、路由表）；`aws lambda`（建立、呼叫、修改設定與程式碼；不會真的執行程式碼，呼叫時把事件原樣放在回應的 body）；`aws dynamodb`（資料表、項目、Query、Scan、TTL；不含次要索引與 filter expression）；`aws elbv2`（目標群組、ALB、接聽程式；只支援 HTTP(S) 與 forward 動作）；`aws autoscaling`（群組與目標追蹤政策；群組會啟動執行個體、註冊到目標群組，並替換被停止或終止的執行個體）；`aws rds`（DB 子網路群組、執行個體、唯讀複本、快照；不含 Aurora 叢集）；`gcloud iam service-accounts`；`gcloud projects`（IAM 授權）；`gcloud compute instances|firewall-rules|networks|networks subnets|routers|routers nats|disks|snapshots`；`gcloud run deploy|services|revisions`（只能部署現成的映像檔，不能從原始碼建置）；`gcloud firestore databases|indexes composite|fields ttls|export`（只有管理操作，沒有讀寫文件）；`gcloud compute instance-templates|instance-groups managed|health-checks create http|backend-services|url-maps|target-http-proxies|forwarding-rules`（全域外部 HTTP 負載平衡器；MIG 會用相同名稱重建被停止或刪除的 VM）；`gcloud sql instances|databases|users|backups`；`aws sns`（主題與訂閱；電子郵件訂閱停在待確認）；`aws cloudwatch`（單一指標警示，新警示的狀態是 `INSUFFICIENT_DATA`，可用 `set-alarm-state` 改變）；`aws logs`（記錄群組、保留政策、篩選模式只支援區分大小寫的詞語與引號片語、指標篩選器）；`aws cloudtrail lookup-events`（Lab 預先放的事件）；`gcloud logging read|metrics|buckets|sinks`（篩選只支援 severity、resource.type、logName、textPayload 與關鍵字，用 AND 串接；只有 `_Required` 與 `_Default` 兩個記錄 bucket）；`gcloud monitoring uptime|policies`（只記錄設定，不會真的檢查或發快訊）；`aws route53`（公有代管區域、簡單與加權紀錄、指到 CloudFront、ALB 或同區域紀錄的別名、`test-dns-answer`；不含私有區域、健康檢查和其他路由政策）；`aws cloudfront`（用 `--origin-domain-name` 建立分配、清除快取；不會真的快取內容）；`gcloud dns managed-zones|record-sets`（不含路由政策和 ALIAS 紀錄）；`gcloud compute backend-buckets`、`backend-services update --enable-cdn`、`url-maps invalidate-cdn-cache`（Cloud CDN 的設定）；`aws kms`（對稱加密金鑰、別名、輪替、停用、排程刪除、encrypt／decrypt；密文是模擬的格式，搭配 `base64 -d` 照官方文件的流程操作，`--query` 只支援最上層欄位）；`aws wafv2`（IP set、web ACL、關聯到 ALB；規則支援託管規則群組、IP set、地理位置、頻率，不會真的過濾請求）；`gcloud kms keyrings|keys|keys versions|encrypt|decrypt`（對稱加密金鑰）；`gcloud compute security-policies`（Cloud Armor 依來源 IP 的規則、預設規則、`backend-services update --security-policy`）；`aws ce`（Lab 預先放的月費用資料：依服務或標籤分組、依上個月的日平均預測、成本分配標籤；只支援 MONTHLY）；`aws budgets`（成本預算與通知）；`gcloud billing accounts|projects|budgets`（預算的門檻、標籤與專案篩選）；`gcloud compute instances add-labels|remove-labels`；`docker build|images|tag|run|ps|stop|rm|rmi|login|push|pull`（模擬的 Docker：Dockerfile 支援 FROM、RUN、COPY、ADD、WORKDIR、ENV、EXPOSE、CMD、ENTRYPOINT、ARG、LABEL、USER，只檢查格式和 COPY 的來源，不會真的執行 RUN；只能推送到 ECR 和 Artifact Registry）；`curl http://localhost:連接埠`（回應執行中容器裡複製進去的 index.html）；`aws ecr`（儲存庫、標籤不可變、`get-login-password`）；`aws ecs`（叢集、用 `--cli-input-json` 註冊任務定義、Fargate 服務；映像檔推送到 ECR 後任務才會執行）；`gcloud artifacts repositories|docker images list`、`gcloud auth configure-docker`；`gcloud run deploy` 會檢查專案 Artifact Registry 裡的映像檔是否存在，以及映像檔 EXPOSE 的連接埠和 `--port`（預設 8080）是否一致；`aws eks create-cluster|describe-cluster|create-nodegroup|update-nodegroup-config|update-kubeconfig`（叢集立即就緒；要兩個不同可用區的子網路）；`gcloud container clusters create-auto|create|get-credentials|resize|delete`；`terraform init|validate|fmt|plan|apply|destroy|output|state list|state show`（HCL 子集：resource、variable、output、provider、terraform 區塊，字串插值與引用；支援 `google_storage_bucket`、`aws_s3_bucket`，對應到模擬的 Cloud Storage／S3；狀態檔寫成目錄裡的 `terraform.tfstate`；`apply`／`destroy` 要加 `-auto-approve`，因為不能互動輸入 yes）；`aws cloudformation`（YAML／JSON 範本含 `!Ref`、`!Sub`、`!GetAtt`；支援 `AWS::S3::Bucket`、`AWS::SNS::Topic`、`AWS::Logs::LogGroup`；建立失敗會回復成 ROLLBACK_COMPLETE；變更集、偏移偵測、`DeletionPolicy: Retain`）；`aws codebuild create-project|update-project|list-projects|start-build|batch-get-builds|list-builds-for-project`（來源只支援 S3 上的 zip；建置立即執行：照 buildspec.yml 的 `install`／`pre_build`／`build`／`post_build` 用這個模擬終端機的指令執行，展開 `$變數`，`` `date` `` 換成固定時間；在獨立的 Docker 環境裡建置，不影響本機的映像檔；沒開特權模式時 `docker login` 以外的 Docker 指令會失敗；一個階段失敗後就停止，不執行 `finally`；日誌寫到 CloudWatch Logs 的 `/aws/codebuild/專案名稱`）；`gcloud builds submit|list|log|describe`（`cloudbuild.yaml` 只支援 `gcr.io/cloud-builders/docker`、`gcr.io/cloud-builders/gcloud` 和 entrypoint 是 gcloud 的 Cloud SDK 步驟，依序執行；內建替代變數 `$PROJECT_ID`、`$BUILD_ID`、`$PROJECT_NUMBER`，自訂的以 `_` 開頭；建置中自動登入設定檔裡用到的 Artifact Registry）；`sleep 秒數`（快轉模擬時鐘，讓可見性逾時、確認期限過去）；`aws sqs create-queue|list-queues|get-queue-url|get-queue-attributes|set-queue-attributes|send-message|receive-message|delete-message|change-message-visibility|purge-queue|delete-queue|start-message-move-task`（只有標準佇列；`--attributes` 支援 Key=Value 和 JSON／file://；redrive policy 在接收時把超過 maxReceiveCount 的訊息移到 dead-letter queue；DLQ redrive 立即完成）；`aws sns publish`（送到已確認的 SQS 訂閱，佇列政策要允許 `sns.amazonaws.com` 對這個主題 `sqs:SendMessage`，支援 `aws:SourceArn` 的 ArnEquals／ArnLike 條件）；`gcloud pubsub topics create|list|delete|publish|add-iam-policy-binding|get-iam-policy`、`gcloud pubsub subscriptions create|list|describe|update|delete|pull|ack|modify-message-ack-deadline|add-iam-policy-binding|get-iam-policy`（只有 pull 訂閱；dead-letter topic 在服務帳戶 `service-498765432109@gcp-sa-pubsub.iam.gserviceaccount.com` 有發布者與訂閱者角色時，才計算傳送次數並轉送；不支援排序與篩選）；`gcloud projects describe`；`kubectl apply -f|create|expose|get|describe|scale|set image|rollout status|history|undo|delete|config`（YAML 用 `yaml` 套件解析，支援 Deployment、Service、Namespace；Pod 由 Deployment 推算：沒有節點時 Pending，本帳戶 ECR／本專案 Artifact Registry 沒有的映像檔是 ImagePullBackOff，其他映像檔視為公開可拉取）；`gcloud config`；`git init|status|add|commit|log|branch|switch|checkout|merge`（只有本機操作，沒有遠端；合併衝突會取消合併）。
- **支援的語法**：引號、反斜線跳脫、註解、`>` 與 `>>`、`|`（`cat`、`base64`、`docker login --password-stdin` 會讀取管線的輸入）、`&&` 與 `;`。不支援變數與萬用字元，會明確告知。
- **新增指令**：在 `engine.ts` 的 `commands` 註冊一個 `Command`（收到可修改的草稿狀態與輸出函式，回傳結束碼），並補上測試。
- **輸出訊息是近似值**：格式盡量貼近真實 CLI，但不保證逐字相同。
- 每個 Lab 都必須在測試裡（`engine.test.ts`、`cloud.test.ts`、`network-db.test.ts`、`serverless-storage.test.ts`、`nosql.test.ts`、`lb.test.ts`、`monitoring.test.ts`、`dns-cdn.test.ts`、`security.test.ts`、`cost.test.ts`、`containers.test.ts`、`kubernetes.test.ts`、`iac.test.ts`、`cicd.test.ts` 或 `messaging.test.ts`）有一條能從頭做到完成的指令腳本。

所有格式的權威定義在 `src/lib/content/schema.ts`，本節與它不一致時以程式為準。

## 7. 進度資料

```ts
interface Progress {
  preferredProvider: "aws" | "gcp" | "both";
  units: Record<string, { read: boolean; quizScore?: number; labsDone: string[] }>;
  questions: Record<string, { attempts: number; lastCorrect: boolean }>;
  exams: { certId: string; date: string; score: number; byDomain: Record<string, number> }[];
}
```

`preferredProvider` 預設為 `both`。透過 `ProgressStore` 介面存取（`src/lib/progress/store.ts`），實作為 localStorage。登入後由 `src/lib/progress/sync.ts` 把同一個 store 和 Supabase 的 `progress` 資料表（每人一列）同步：和上次同步的內容做三方合併（`merge.ts`），只有一邊改過的用那一邊，兩邊都改了就保留進度較多的。設定方式見 `docs/SUPABASE.md`；沒有設定 `NEXT_PUBLIC_SUPABASE_URL`／`NEXT_PUBLIC_SUPABASE_ANON_KEY` 時不顯示登入。進度的讀取與判斷都是 `src/lib/progress/progress.ts` 裡的純函式。

- **單元完成的定義**：課文標記為已讀完、單元測驗通過（答對 80% 以上，`QUIZ_PASS_SCORE`），且必做的 Lab 都完成。必做的 Lab 是不分平台的 Lab 加上主要平台的 Lab；主要平台選「兩者」時全部都要做。
- **測驗成績**：`quizScore` 是 0 到 1 的最高分，重考分數較低不會蓋掉。每題的作答次數與最近一次對錯記在 `questions`。
- **測驗題目依主要平台篩選**：選了 AWS 或 GCP 時略過另一個平台的題目，分數以實際作答的題數計算。
- **計分規則**：選項必須與答案完全一致才算對，複選題少選或多選都算錯（`src/lib/quiz/quiz.ts`）。
- **解鎖是建議性的**：先修單元未完成時，路線圖顯示鎖頭與「建議先完成」，但仍可點進去讀，不硬性擋住。
- **主要平台**：在路線圖頁設定，決定路線圖顯示哪些單元。選了 AWS 或 GCP 時，單元頁只顯示那個平台：頁首只列它的服務、課文只有它的分頁（旁邊有「也看看另一個平台怎麼做」可以切換）、另一個平台的 Lab 收在「其他平台的 Lab（選修）」。不分平台的單元在任何篩選下都顯示。

## 8. 開發階段

| # | 階段 | 產出 | 驗收 |
|---|---|---|---|
| 1 ✅ | 骨架與內容系統 | 專案、版面、導覽、內容載入器與 Zod schema、一個完整範例單元（物件儲存，含 AWS 與 GCP 分頁） | 範例單元可瀏覽；格式錯誤的內容會讓建置失敗 |
| 2 ✅ | 路線圖與進度 | 技能樹頁、平台篩選、localStorage 進度、主要平台設定 | 完成單元後路線圖更新，重新整理後仍在 |
| 3 ✅ | 測驗系統 | 單元測驗介面、解析、成績寫入進度 | 單選、多選都正確計分 |
| 4 ✅ | Lab 引擎 | 終端機、虛擬檔案系統、基本 Linux 指令、`aws s3` 與 `gcloud storage` 子集、3 個範例 Lab | Lab 可從頭做到完成；引擎有單元測試 |
| 5 ✅ | 證照練習 | 證照頁、依 domain 抽題練習、服務對照表 | 四張證照頁都可進入並練習 |
| 6 | 內容擴充 | 依第 3 節補齊所有單元、測驗、Lab 與每張證照題庫 | 每單元至少 5 題、每張證照至少 150 題 |
| 7 | 會員 | Supabase 登入（Email 登入連結、Google、GitHub）、進度同步與合併 | 兩個裝置登入後進度一致（正式站已用 Email 登入並同步成功；Google、GitHub 登入待設定） |
| 8 | 模擬考 | 計時考試、依比重抽題、成績報告、錯題本、弱點分析 | 可完成一場完整模擬考並看到各 domain 得分 |
| 9 | 進階功能 | 架構圖練習、AI 助教 | — |

階段 1 到 5 是 MVP。

### 階段 6 的進度

分批進行，每批一個 PR。每個單元要有課文、至少 5 題測驗；適合動手練習的單元要有 Lab。

| 階段 | 單元 | 狀態 |
|---|---|---|
| 0 基礎 | Linux 指令基礎、網路基礎、Git 基礎 | 完成（網路基礎沒有 Lab） |
| 1 雲端核心 | 全部 8 個單元 | 完成 |
| 2 維運 | 全部 5 個單元 | 完成 |
| 3 自動化 | 全部 5 個單元 | 完成 |
| 4 實戰 | 架構設計案例、面試題 | 待寫 |

雲端服務單元的內容要對照官方文件再寫（環境已開放 `docs.aws.amazon.com` 和 `docs.cloud.google.com`）。用 `curl` 下載後閱讀，不要憑記憶寫限制、預設值和用語。

證照題庫目前是每個考試範圍 2 題的起始題庫，目標每張 150 題。

階段 6 的內容量最大，建議一次只產一個階段或一張證照的內容，並逐批人工抽查正確性。

## 9. 開發守則

- 一次只做一個階段，不提前實作後面階段的功能。
- 內容與程式分離：任何課程、題目、Lab 的新增都不應該需要改 `src/`。
- 雲端服務的事實（限制、預設值、價格模型）與考試資訊要對照官方文件，不確定的地方標註 `TODO: verify`，不要猜。
- Lab 引擎與抽題、計分邏輯必須有單元測試。
- 介面文字用繁體中文，程式碼、註解、commit 訊息用英文。
