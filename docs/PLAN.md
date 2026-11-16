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
| | CI/CD | CodePipeline、GitHub Actions | Cloud Build、GitHub Actions |
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
  certs/<cert-id>/
    cert.json          # 考試資訊與 domain
    questions/*.json   # 題庫
  stages.json          # 階段與單元順序
src/
  app/                 # 首頁、路線圖、單元、測驗、Lab、證照、對照表
  components/          # Roadmap, ProviderTabs, Quiz, Terminal, ExamRunner
  lib/
    content/           # 載入與 Zod schema
    progress/          # 進度儲存（介面化，之後可換成 Supabase）
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

可用元件：`ProviderTabs`、`Provider`、`Callout`、`Compare`（由 `unit.json` 的 `compare` 產生差異表）。`unit.json` 宣告的每個平台都必須有對應的 `<Provider>` 區塊。MDX 內不能使用 `{ }` JavaScript 運算式。

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

`initialState.files` 的路徑要以 `~/` 或 `/` 開頭。`initialState.cloud` 可以預先放 bucket，形狀與上表相同；也可以用 `cloud.gcp` 預設專案 ID 和既有的 IAM 授權（`{ "project": "…", "bindings": { 角色: [成員] } }`），用 `cloud.aws.vpcs` 預先建立 VPC 與子網路（`{ VPC ID: { "cidr": "…", "subnets": { 子網路 ID: { "cidr": "…", "availabilityZone": "…" } } } }`，每個 VPC 會自動有只含本地路由的主路由表）。

模擬環境的起始狀態：AWS 帳戶裡沒有預設 VPC，執行個體預設啟動在 `us-east-1a`；Google Cloud 專案裡有 auto 模式的 `default` 網路（不另外列出它在各區域的子網路），沒有指定網路的執行個體和防火牆規則都放在 `default`。

### Lab 引擎

程式在 `src/lib/lab-engine/`，是不依賴瀏覽器的純函式：`execute(state, line)` 回傳新的狀態與輸出，不修改傳入的狀態。

- **支援的指令**：`pwd ls cd mkdir touch cat echo cp mv rm rmdir zip clear help whoami`（`zip` 產生的是模擬的封存檔，`cat` 可以看到內容）；`aws s3 mb|rb|ls|cp|mv|rm`；`gcloud storage buckets create|delete|list|describe` 與 `gcloud storage ls|cp|mv|rm|cat`；`gsutil mb|rb|ls|cp|mv|rm|cat`；`aws iam`（使用者、群組、角色、受管政策）；`aws ec2`（安全群組、執行個體、EBS 磁碟區與快照、VPC、子網路、網際網路閘道、路由表）；`aws lambda`（建立、呼叫、修改設定與程式碼；不會真的執行程式碼，呼叫時把事件原樣放在回應的 body）；`aws dynamodb`（資料表、項目、Query、Scan、TTL；不含次要索引與 filter expression）；`aws elbv2`（目標群組、ALB、接聽程式；只支援 HTTP(S) 與 forward 動作）；`aws autoscaling`（群組與目標追蹤政策；群組會啟動執行個體、註冊到目標群組，並替換被停止或終止的執行個體）；`aws rds`（DB 子網路群組、執行個體、唯讀複本、快照；不含 Aurora 叢集）；`gcloud iam service-accounts`；`gcloud projects`（IAM 授權）；`gcloud compute instances|firewall-rules|networks|networks subnets|routers|routers nats|disks|snapshots`；`gcloud run deploy|services|revisions`（只能部署現成的映像檔，不能從原始碼建置）；`gcloud firestore databases|indexes composite|fields ttls|export`（只有管理操作，沒有讀寫文件）；`gcloud compute instance-templates|instance-groups managed|health-checks create http|backend-services|url-maps|target-http-proxies|forwarding-rules`（全域外部 HTTP 負載平衡器；MIG 會用相同名稱重建被停止或刪除的 VM）；`gcloud sql instances|databases|users|backups`；`gcloud config`；`git init|status|add|commit|log|branch|switch|checkout|merge`（只有本機操作，沒有遠端；合併衝突會取消合併）。
- **支援的語法**：引號、反斜線跳脫、註解、`>` 與 `>>`、`&&` 與 `;`。不支援管線、變數與萬用字元，會明確告知。
- **新增指令**：在 `engine.ts` 的 `commands` 註冊一個 `Command`（收到可修改的草稿狀態與輸出函式，回傳結束碼），並補上測試。
- **輸出訊息是近似值**：格式盡量貼近真實 CLI，但不保證逐字相同。
- 每個 Lab 都必須在測試裡（`engine.test.ts`、`cloud.test.ts`、`network-db.test.ts`、`serverless-storage.test.ts`、`nosql.test.ts` 或 `lb.test.ts`）有一條能從頭做到完成的指令腳本。

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

`preferredProvider` 預設為 `both`。透過 `ProgressStore` 介面存取（`src/lib/progress/store.ts`），第一版實作為 localStorage，第二版加上 Supabase 實作並在登入時合併。進度的讀取與判斷都是 `src/lib/progress/progress.ts` 裡的純函式。

- **單元完成的定義**：課文標記為已讀完、單元測驗通過（答對 80% 以上，`QUIZ_PASS_SCORE`），且必做的 Lab 都完成。必做的 Lab 是不分平台的 Lab 加上主要平台的 Lab；主要平台選「兩者」時全部都要做。
- **測驗成績**：`quizScore` 是 0 到 1 的最高分，重考分數較低不會蓋掉。每題的作答次數與最近一次對錯記在 `questions`。
- **測驗題目依主要平台篩選**：選了 AWS 或 GCP 時略過另一個平台的題目，分數以實際作答的題數計算。
- **計分規則**：選項必須與答案完全一致才算對，複選題少選或多選都算錯（`src/lib/quiz/quiz.ts`）。
- **解鎖是建議性的**：先修單元未完成時，路線圖顯示鎖頭與「建議先完成」，但仍可點進去讀，不硬性擋住。
- **主要平台**：在路線圖頁設定，決定路線圖顯示哪些單元，以及課文預設開啟哪個平台的分頁。不分平台的單元在任何篩選下都顯示。

## 8. 開發階段

| # | 階段 | 產出 | 驗收 |
|---|---|---|---|
| 1 ✅ | 骨架與內容系統 | 專案、版面、導覽、內容載入器與 Zod schema、一個完整範例單元（物件儲存，含 AWS 與 GCP 分頁） | 範例單元可瀏覽；格式錯誤的內容會讓建置失敗 |
| 2 ✅ | 路線圖與進度 | 技能樹頁、平台篩選、localStorage 進度、主要平台設定 | 完成單元後路線圖更新，重新整理後仍在 |
| 3 ✅ | 測驗系統 | 單元測驗介面、解析、成績寫入進度 | 單選、多選都正確計分 |
| 4 ✅ | Lab 引擎 | 終端機、虛擬檔案系統、基本 Linux 指令、`aws s3` 與 `gcloud storage` 子集、3 個範例 Lab | Lab 可從頭做到完成；引擎有單元測試 |
| 5 ✅ | 證照練習 | 證照頁、依 domain 抽題練習、服務對照表 | 四張證照頁都可進入並練習 |
| 6 | 內容擴充 | 依第 3 節補齊所有單元、測驗、Lab 與每張證照題庫 | 每單元至少 5 題、每張證照至少 150 題 |
| 7 | 會員 | Supabase 登入、進度同步與合併 | 兩個裝置登入後進度一致 |
| 8 | 模擬考 | 計時考試、依比重抽題、成績報告、錯題本、弱點分析 | 可完成一場完整模擬考並看到各 domain 得分 |
| 9 | 進階功能 | 架構圖練習、AI 助教 | — |

階段 1 到 5 是 MVP。

### 階段 6 的進度

分批進行，每批一個 PR。每個單元要有課文、至少 5 題測驗；適合動手練習的單元要有 Lab。

| 階段 | 單元 | 狀態 |
|---|---|---|
| 0 基礎 | Linux 指令基礎、網路基礎、Git 基礎 | 完成（網路基礎沒有 Lab） |
| 1 雲端核心 | 全部 8 個單元 | 完成 |
| 2 維運 | 負載平衡與自動擴展 | 完成 |
| 2 維運 | 監控與日誌、DNS 與 CDN、資安基礎、成本管理 | 待寫 |
| 3 自動化 | 全部 5 個單元 | 待寫 |
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
