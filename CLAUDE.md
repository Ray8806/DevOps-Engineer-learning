@AGENTS.md

# 雲端工程師學院

- 開發規劃與階段：`docs/PLAN.md`。一次只做一個階段；階段 1 到 5（MVP）已完成，階段 6（補內容）進行中，進度表在 `docs/PLAN.md`。
- 內容放在 `content/`，格式定義在 `src/lib/content/schema.ts`，載入與交叉檢查在 `src/lib/content/loader.ts`。新增課程不應該需要改 `src/`。
- 學習進度的邏輯是 `src/lib/progress/progress.ts` 的純函式，儲存透過 `ProgressStore` 介面；元件用 `useProgress()`，不要直接碰 localStorage。
- Lab 引擎在 `src/lib/lab-engine/`，是純函式（`execute` 不修改傳入的狀態）。新增 Lab 時要在 `engine.test.ts` 加一條能做完它的指令腳本；新增指令在 `engine.ts` 註冊。
- 證照的考試資訊（`content/certs/*/cert.json`）只能抄自官方考試指南並更新 `source.verifiedOn`，不要憑記憶修改。題目必須原創，不可收錄實際考題。
- 介面文字用繁體中文；程式碼、註解、commit 訊息用英文。
- 完成前執行：`npm test`、`npm run lint`、`npm run build`（內容格式錯誤會讓測試與建置失敗）。
