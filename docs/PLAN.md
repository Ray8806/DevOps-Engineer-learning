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

每張證照的題數、時間、及格分數、各 domain 比重都放在 `content/certs/<id>/cert.json`，**撰寫時必須對照官方 exam guide 填入，不要憑記憶**（考試版本會改版）。

每張證照頁提供：考試資訊、範圍與對應單元、分 domain 練習、完整模擬考、錯題本、弱點分析。

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
- **終端機**：xterm.js 加自寫的指令模擬引擎。
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

`check.path` 是鍵的陣列而不是用點分隔的字串，因為物件名稱本身會含有點（例如 `report.txt`）。`check` 必須剛好有 `exists` 或 `equals` 其中一個。

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

- **單元完成的定義**：目前是「課文標記為已完成」。階段 3、4 加入測驗與 Lab 後，在 `isUnitDone` 擴充。
- **解鎖是建議性的**：先修單元未完成時，路線圖顯示鎖頭與「建議先完成」，但仍可點進去讀，不硬性擋住。
- **主要平台**：在路線圖頁設定，決定路線圖顯示哪些單元，以及課文預設開啟哪個平台的分頁。不分平台的單元在任何篩選下都顯示。

## 8. 開發階段

| # | 階段 | 產出 | 驗收 |
|---|---|---|---|
| 1 ✅ | 骨架與內容系統 | 專案、版面、導覽、內容載入器與 Zod schema、一個完整範例單元（物件儲存，含 AWS 與 GCP 分頁） | 範例單元可瀏覽；格式錯誤的內容會讓建置失敗 |
| 2 ✅ | 路線圖與進度 | 技能樹頁、平台篩選、localStorage 進度、主要平台設定 | 完成單元後路線圖更新，重新整理後仍在 |
| 3 | 測驗系統 | 單元測驗介面、解析、成績寫入進度 | 單選、多選都正確計分 |
| 4 | Lab 引擎 | 終端機、虛擬檔案系統、基本 Linux 指令、`aws s3` 與 `gcloud storage` 子集、3 個範例 Lab | Lab 可從頭做到完成；引擎有單元測試 |
| 5 | 證照練習 | 證照頁、依 domain 抽題練習、服務對照表 | 四張證照頁都可進入並練習 |
| 6 | 內容擴充 | 依第 3 節補齊所有單元、測驗、Lab 與每張證照題庫 | 每單元至少 5 題、每張證照至少 150 題 |
| 7 | 會員 | Supabase 登入、進度同步與合併 | 兩個裝置登入後進度一致 |
| 8 | 模擬考 | 計時考試、依比重抽題、成績報告、錯題本、弱點分析 | 可完成一場完整模擬考並看到各 domain 得分 |
| 9 | 進階功能 | 架構圖練習、AI 助教 | — |

階段 1 到 5 是 MVP。階段 6 的內容量最大，建議一次只產一個階段或一張證照的內容，並逐批人工抽查正確性。

## 9. 開發守則

- 一次只做一個階段，不提前實作後面階段的功能。
- 內容與程式分離：任何課程、題目、Lab 的新增都不應該需要改 `src/`。
- 雲端服務的事實（限制、預設值、價格模型）與考試資訊要對照官方文件，不確定的地方標註 `TODO: verify`，不要猜。
- Lab 引擎與抽題、計分邏輯必須有單元測試。
- 介面文字用繁體中文，程式碼、註解、commit 訊息用英文。
