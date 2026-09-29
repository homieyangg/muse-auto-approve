# Chrome 網上應用程式商店上架資料

上架前先跑 `./scripts/pack.sh`，上傳 `dist/muse-auto-approve-<version>.zip`。

## 商店資訊

- 名稱：Auto Approve for Muse（取自 manifest）
- 摘要：取自 manifest 的 description
- 類別：工具（Tools）
- 語言：中文（繁體）
- 商店圖示：`icons/icon128.png`
- 螢幕截圖：`store/screenshot-1280x800.png`
- 首頁網址：https://github.com/homieyangg/muse-auto-approve
- 支援網址：https://github.com/homieyangg/muse-auto-approve/issues

### 說明（繁體中文）

muse.ai 的助理存取新網站或敏感網站時，會跳一張審批卡等你按「允許」。沒人按，任務就停在那裡，排程任務特別常遇到。

這個插件看到審批卡就自動按允許：

・有「一律允許」時優先按，同一個網站之後就不會再問
・審批來自其他聊天室時，會先按「檢閱」把卡片叫出來再允許
・只在卡片裡同時有「允許」和「拒絕」、內容跟網站存取有關時才會按，卡片外的按鈕不會被點到
・點工具列圖示可以暫停、切換偏好、查看最近 20 筆紀錄

插件不會把任何資料送出瀏覽器，設定和紀錄只存在本機。

注意：muse.ai 的分頁要開著才有作用。自動允許等於跳過人工確認，請自行評估風險。

本插件為非官方工具，與 Meta、muse.ai 無關。原始碼：https://github.com/homieyangg/muse-auto-approve

### Description (English)

When the muse.ai assistant tries to access a new or sensitive website, it shows an approval card and waits for you to click "Allow". If nobody clicks, the task stalls, which happens a lot with scheduled tasks.

This extension clicks "Allow" for you when an approval card appears:

- Prefers "Always allow" when available, so the same site is not asked again
- Handles approvals from other chats by opening the review card first
- Only clicks inside cards that have both Allow and Deny buttons and mention website access; buttons elsewhere on the page are never clicked
- The toolbar popup lets you pause it, change preferences, and see the last 20 approvals

No data leaves your browser. Settings and records are stored locally.

Note: a muse.ai tab must be open for it to work. Auto-approving skips the human check, so evaluate the risk yourself.

This is an unofficial tool and is not affiliated with Meta or muse.ai. Source code: https://github.com/homieyangg/muse-auto-approve

## 隱私權做法

- 單一用途：在 muse.ai 頁面自動按下審批卡的允許按鈕。 / Automatically clicks the approve button on muse.ai approval cards.
- `storage` 權限用途：在本機儲存開關設定和最近 20 筆審批紀錄。 / Stores the on/off setting and the last 20 approval records locally.
- 主機權限（content script 限 `muse.ai`）用途：需要讀取 muse.ai 頁面找出審批卡並點擊允許按鈕，不在其他網站執行。 / Needed to find approval cards on muse.ai pages and click the approve button. It does not run on any other site.
- 遠端程式碼：否，所有程式碼都在套件內。 / No remote code.
- 資料使用：不收集任何使用者資料，三個聲明（不販售、不用於無關用途、不用於信用評估）都勾選。
- 隱私權政策網址：https://github.com/homieyangg/muse-auto-approve/blob/main/PRIVACY.md

## 發布設定

- 瀏覽權限：公開，或選「不公開」（只有拿到連結的人能安裝）
- 發布地區：所有地區
