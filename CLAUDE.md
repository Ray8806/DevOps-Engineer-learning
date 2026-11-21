@AGENTS.md

# 雲端工程師學院

- 開發規劃與階段：`docs/PLAN.md`。一次只做一個階段；階段 1 到 5（MVP）已完成，階段 6（補內容）進行中，進度表在 `docs/PLAN.md`。
- 內容放在 `content/`，格式定義在 `src/lib/content/schema.ts`，載入與交叉檢查在 `src/lib/content/loader.ts`。新增課程不應該需要改 `src/`。
- 課文的流程動畫是 `content/units/*/flows/*.json`，用 `<Flow id="…" />` 放進課文；版面與每一步的狀態是 `src/lib/flow/layout.ts` 的純函式。
- 課文的即時運轉模擬是 `content/units/*/sims/*.json`，用 `<Sim id="…" />` 放進課文；模擬引擎是 `src/lib/sim/engine.ts` 的純函式。每一步的 `expect` 寫出這一步要教的結果（p95、錯誤數），`src/lib/sim/engine.test.ts` 會確認引擎跑出來真的是這樣。
- 學習進度的邏輯是 `src/lib/progress/progress.ts` 的純函式，儲存透過 `ProgressStore` 介面；元件用 `useProgress()`，不要直接碰 localStorage。登入與同步在 `src/lib/auth/`（帳號狀態用 `useAccount()`），合併規則是 `src/lib/progress/merge.ts` 的純函式；Supabase 設定見 `docs/SUPABASE.md`。
- Lab 引擎在 `src/lib/lab-engine/`，是純函式（`execute` 不修改傳入的狀態）。新增 Lab 時要在測試加一條能做完它的指令腳本（Linux 與儲存在 `engine.test.ts`，IAM 與虛擬機在 `cloud.test.ts`，網路與資料庫在 `network-db.test.ts`，無伺服器與區塊儲存在 `serverless-storage.test.ts`，NoSQL 在 `nosql.test.ts`，負載平衡在 `lb.test.ts`，監控與日誌在 `monitoring.test.ts`，DNS 與 CDN 在 `dns-cdn.test.ts`，資安基礎在 `security.test.ts`，成本管理在 `cost.test.ts`，容器在 `containers.test.ts`，Kubernetes 在 `kubernetes.test.ts`，基礎架構即程式碼在 `iac.test.ts`，CI/CD 在 `cicd.test.ts`，訊息佇列在 `messaging.test.ts`，階段 4 的架構案例在 `architecture.test.ts`；用 `initialState.setup` 先建好環境的 Lab 以 `startLab()` 開始）；新增指令在 `engine.ts` 註冊。
- 闖關是 `content/challenges/*.json`（填空題：空格寫成 `{{id}}`，答案在 Lab 引擎真的執行後判斷過關），執行邏輯在 `src/lib/challenges/run.ts`。`src/lib/challenges/run.test.ts` 確認每一關用正確答案能過關、每個錯誤選項都會失敗；新增關卡後要跑測試。
- 證照的考試資訊（`content/certs/*/cert.json`）只能抄自官方考試指南並更新 `source.verifiedOn`，不要憑記憶修改。題目必須原創，不可收錄實際考題。
- 介面文字用繁體中文；程式碼、註解、commit 訊息用英文。
- 完成前執行：`npm test`、`npm run lint`、`npm run build`（內容格式錯誤會讓測試與建置失敗）。
