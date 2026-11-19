# 設定登入與進度同步（Supabase）

網站沒有設定 Supabase 時照常運作，只是不顯示「登入」，進度只存在瀏覽器。照下面的步驟設定後，學員可以用 Email 登入連結、Google 或 GitHub 登入，進度會同步到帳號。

## 1. 建立 Supabase 專案

1. 到 Supabase 註冊並建立一個新專案（免費方案即可），區域選離使用者近的（例如東京或新加坡）。
2. 專案建好後，在專案設定的 **API** 頁面找到：
   - **Project URL**（`https://<專案代號>.supabase.co`）
   - **anon public** 金鑰
   這兩個值是公開的，會放進網頁裡；資料靠下一步的資料列層級安全性（RLS）保護。**不要**使用 `service_role` 金鑰。

## 2. 建立資料表

打開專案的 **SQL Editor**，貼上 `supabase/migrations/0001_progress.sql` 的內容執行。它會建立 `progress` 資料表，並開啟 RLS，讓每個人只能讀寫自己的那一列。

## 3. 設定登入後回到網站的網址

在 **Authentication → URL Configuration**：

- **Site URL**：`https://dev-ops-engineer-learning.vercel.app`
- **Redirect URLs** 加入：
  - `https://dev-ops-engineer-learning.vercel.app/account`
  - 想在本機測試的話再加 `http://localhost:3000/account`

登入連結和 Google／GitHub 登入完成後都會回到 `/account`。

## 4. 開啟登入方式

在 **Authentication → Providers**（或 Sign In / Providers）：

- **Email**：預設已開啟。內建的寄信服務有每小時的寄送數量限制，正式使用建議在 **SMTP Settings** 設定自己的寄信服務。
- **Google**：
  1. 在 Google Cloud 主控台建立 OAuth 用戶端（類型選「網頁應用程式」）。
  2. 「已授權的重新導向 URI」填 Supabase Google 設定頁上顯示的 Callback URL（`https://<專案代號>.supabase.co/auth/v1/callback`）。
  3. 把用戶端 ID 和密鑰填回 Supabase 的 Google 設定並開啟。
- **GitHub**：
  1. 在 GitHub 的 Settings → Developer settings → OAuth Apps 建立 OAuth App。
  2. Homepage URL 填網站網址，Authorization callback URL 填同一個 Supabase Callback URL。
  3. 把 Client ID 和 Client secret 填回 Supabase 的 GitHub 設定並開啟。

## 5. 設定 Vercel 環境變數並重新部署

在 Vercel 專案的 **Settings → Environment Variables** 加入（Production 和 Preview 都勾選）：

| 名稱 | 值 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 第 1 步的 Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 第 1 步的 anon public 金鑰 |

這兩個值在**建置時**寫進網頁，所以加完之後要**重新部署**一次（Deployments → 最新的部署 → Redeploy）才會生效。

本機開發時，把 `.env.example` 複製成 `.env.local` 填入同樣的值。

## 同步怎麼運作

- 進度先寫在瀏覽器，登入後再同步到 `progress` 資料表（每人一列，整份進度是一個 JSON）。
- 同步時機：登入時、進度改變後約 1.5 秒、切回這個分頁時、在帳號頁按「立即同步」。
- 合併規則（`src/lib/progress/merge.ts`）：和上次同步的內容比較，只有一邊改過的就用那一邊（所以在一台裝置取消「已讀」，另一台也會跟著取消）；兩邊都改了同一項時，保留進度較多的（已讀、較高的測驗分數、作答次數較多的紀錄），模擬考成績兩邊合併。
- 第一次登入時，這台裝置上原本的進度會合併到帳號，不會遺失。
- 登出時進度預設留在這台裝置；公用電腦請選「登出並清除這台裝置的進度」。
- 用 Email 登入連結時，要用**送出 Email 的同一個瀏覽器**打開信中的連結（登入使用 PKCE，驗證碼存在原本的瀏覽器）。
