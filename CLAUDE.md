@AGENTS.md

# 雲端工程師學院

- 開發規劃與階段：`docs/PLAN.md`。一次只做一個階段；階段 1、2 已完成。
- 內容放在 `content/`，格式定義在 `src/lib/content/schema.ts`，載入與交叉檢查在 `src/lib/content/loader.ts`。新增課程不應該需要改 `src/`。
- 學習進度的邏輯是 `src/lib/progress/progress.ts` 的純函式，儲存透過 `ProgressStore` 介面；元件用 `useProgress()`，不要直接碰 localStorage。
- 介面文字用繁體中文；程式碼、註解、commit 訊息用英文。
- 完成前執行：`npm test`、`npm run lint`、`npm run build`（內容格式錯誤會讓測試與建置失敗）。
