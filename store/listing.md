# Chrome 網上應用程式商店上架資料

上架前先跑 `./scripts/pack.sh`，上傳 `dist/muse-auto-approve-<version>.zip`。

1.1.0 沒有新增權限（還是只有 `storage`），新加的背景 service worker、設定頁、歡迎頁都不需要額外權限。

## 商店資訊

- 名稱：Auto Approve for Muse（取自 manifest）
- 摘要：取自 manifest 的 description
- 類別：工具（Tools）
- 語言：中文（繁體）
- 商店圖示：`icons/icon128.png`
- 在地化螢幕截圖（中文）：`store/screenshot-1.png`、`store/screenshot-2.png`、`store/screenshot-3.png`（照順序上傳，舊的那張刪掉）
- 在地化螢幕截圖（英文）：`store/screenshot-en-1.png`、`store/screenshot-en-2.png`、`store/screenshot-en-3.png`
- 小型宣傳圖塊（440×280）：`store/promo-small.png`（中文）或 `store/promo-small-en.png`（英文）
- 跑馬燈宣傳圖塊（1400×560）：`store/promo-marquee.png`（中文）或 `store/promo-marquee-en.png`（英文）
- 宣傳圖塊屬於「通用資產」，所有語言共用一張，中英文擇一上傳。
- 宣傳圖塊的背景插圖 `store/promo-bg.jpg` 是 codex 生成的（無文字），字和 icon 由 `store/promo.html` 疊上去（加 `&lang=en` 產生英文版）：`promo.html?t=small&bg=promo-bg.jpg`、`promo.html?t=marquee&bg=promo-bg.jpg&pos=center%2045%25`
- 首頁網址：https://github.com/homieyangg/muse-auto-approve
- 支援網址：https://github.com/homieyangg/muse-auto-approve/issues

### 說明（繁體中文）

muse.ai 的助理存取新網站或敏感網站時，會跳一張審批卡等你按「允許」。沒人按，任務就停在那裡，排程任務特別常遇到。

這個插件會幫你按。你可以選：

・只允許我信任的（推薦）：第一次遇到新的網站或聊天室會先問你。工具列圖示出現紅色數字時點開，選要信任到什麼範圍，按一次就記住
・全部自動允許：Ren 要開什麼都直接允許

其他功能：

・信任範圍可以選「這個網站」「只限某個聊天室」「整個聊天室」或「只允許這一次」
・設定頁可以管理完整清單、把網站限定在某些聊天室、先停用不刪掉、看紀錄、匯出匯入設定
・審批來自其他聊天室時，會先按「檢閱」把卡片叫出來
・有「一律允許」時優先按，同一個網站之後就不會再問
・只在卡片裡同時有「允許」和「拒絕」、內容跟網站存取有關時才會按，卡片外的按鈕不會被點到
・介面有繁體中文和英文

插件沒有伺服器，不會把資料送出去。信任清單透過 Chrome 同步到你自己登入的瀏覽器，紀錄只存在本機。

注意：muse.ai 的分頁要開著才有作用。自動允許等於跳過人工確認，請自行評估風險。

本插件為非官方工具，與 Meta、muse.ai 無關。原始碼：https://github.com/homieyangg/muse-auto-approve

### Description (English)

When the muse.ai assistant tries to open a new or sensitive website, it shows an approval card and waits for you to click "Allow". If nobody clicks, the task stalls, which happens a lot with scheduled tasks.

This extension clicks it for you. Pick how it works:

- Only what I trust (recommended): the first time a new site or chat shows up, it asks you. A red number appears on the toolbar icon. Open it, choose how far to trust the request, and it's remembered.
- Allow everything: whatever Ren asks for is allowed.

Also:

- Trust a site, a site only from one chat, a whole chat, or just allow once
- Settings has the full lists: limit a site to certain chats, turn entries off without deleting them, see the activity log, and export or import your settings
- Opens review banners for approvals that come from other chats
- Prefers "Always allow" when available, so the same site isn't asked again
- Only clicks inside cards that have both Allow and Deny buttons and mention website access
- English and Traditional Chinese interface

No server, nothing sent anywhere. Trusted lists sync between your own signed-in Chrome browsers through Chrome sync; the activity log stays on your computer.

Note: a muse.ai tab must be open for it to work. Auto-approving skips the human check, so evaluate the risk yourself.

This is an unofficial tool and is not affiliated with Meta or muse.ai. Source code: https://github.com/homieyangg/muse-auto-approve

## 隱私權做法

- 單一用途：在 muse.ai 頁面自動按下審批卡的允許按鈕。 / Automatically clicks the approve button on muse.ai approval cards.
- `storage` 權限用途：儲存模式、信任的網站和聊天室（chrome.storage.sync，Chrome 會在使用者自己登入的瀏覽器之間同步），以及最近 200 筆審批紀錄（只在本機）。 / Stores the mode and the trusted sites and chats (chrome.storage.sync, synced by Chrome between the user's own signed-in browsers) and the last 200 approval records (local only).
- 主機權限（content script 限 `muse.ai`）用途：需要讀取 muse.ai 頁面找出審批卡並點擊允許按鈕，不在其他網站執行。 / Needed to find approval cards on muse.ai pages and click the approve button. It does not run on any other site.
- 遠端程式碼：否，所有程式碼都在套件內。 / No remote code.
- 資料使用：不收集任何使用者資料，三個聲明（不販售、不用於無關用途、不用於信用評估）都勾選。
- 隱私權政策網址：https://github.com/homieyangg/muse-auto-approve/blob/main/PRIVACY.md

## 發布設定

- 瀏覽權限：公開，或選「不公開」（只有拿到連結的人能安裝）
- 發布地區：所有地區
