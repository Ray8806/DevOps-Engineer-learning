# 雲端工程師學院

學習雲端工程師技能的網站：AWS 與 GCP 雙平台課程、測驗、模擬終端機實作與證照備考。規劃見 [docs/PLAN.md](docs/PLAN.md)。

## 開發

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # 內容格式與載入器測試
npm run lint
npm run build
```

## 新增單元

1. 建立 `content/units/<unit-id>/`，放入 `unit.json`、`lesson.mdx`、`quiz.json`，Lab 放在 `labs/<lab-id>.json`。
2. 把單元 id 加到 `content/stages.json` 對應階段的 `units`。
3. 執行 `npm test`。格式或交叉參照有錯時，會一次列出所有問題。

可以直接複製 `content/units/object-storage/` 當範本。
