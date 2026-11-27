# Chrome 網上應用程式商店上架資料

上架前先跑 `./scripts/pack.sh`，上傳 `dist/muse-auto-approve-<version>.zip`。

1.1.0、1.2.0 都沒有新增權限（還是只有 `storage`），新加的背景 service worker、設定頁、歡迎頁都不需要額外權限。

## 商店資訊

- 名稱：Auto Approve for Muse（取自 manifest）
- 摘要：取自 manifest 的 description
- 類別：工具（Tools）
- 語言：中文（繁體）／中文（简体）／English／日本語
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

muse.ai 跳出審批卡時自動幫你按「允許」，人不在電腦前任務也不會卡住，跑排程特別有感。

有兩種模式可以選：

- 只允許我信任的（推薦）：第一次遇到的網站、動作或聊天室會先停著，工具列圖示顯示紅色數字。點開選好信任範圍，按一次就會記住。
- 全部自動允許：Ren 要開的網站直接放行。發文、傳訊息這類動作預設還是會先問你，要一起自動按再到設定打開。

其他功能：

- 信任範圍可選這個網站、這個動作（像發文到 Threads）、只限特定聊天室、整個聊天室，或只允許這一次。
- 卡片有「一律允許」就優先按，同一個網站之後不用再問。
- 審批來自別的聊天室或排程時，會先按「檢閱」把卡片叫出來。
- 設定頁可管理完整清單、把網站限定在特定聊天室、先停用不刪掉、看紀錄，也能匯出匯入設定。
- 插件介面和 muse.ai 審批卡都支援繁體中文、簡體中文、英文、日文。

不會亂點：

只在同時有「允許」和「拒絕」、而且內容跟存取權限有關的審批卡裡動作。頁面上的其他按鈕不會碰，結帳和購買類的卡片也不會自動按。

隱私：

沒有伺服器，資料不會往外傳。模式和信任清單走 Chrome 同步，只存在你自己登入的瀏覽器；紀錄只留在本機電腦。

提醒：muse.ai 分頁要開著插件才會動。自動允許等於跳過人工確認，請先評估風險。

非官方工具，與 Meta、muse.ai 無關。
原始碼：https://github.com/homieyangg/muse-auto-approve

### 说明（简体中文）

muse.ai 弹出审批卡时自动帮你点击「允许」，人不在电脑前任务也不会卡住，跑定时任务时尤其明显。

有两种模式可选：

- 只允许我信任的（推荐）：第一次遇到的网站、操作或聊天会先暂停，工具栏图标上显示红色数字。点开选好信任范围，点一次就会记住。
- 全部自动允许：Ren 要打开的网站直接放行。发帖、发消息这类操作默认仍会先问你，要一起自动点击再到设置里打开。

其他功能：

- 信任范围可选这个网站、这个操作（如发帖到 Threads）、仅限特定聊天、整个聊天，或只允许这一次。
- 卡片有「始终允许」会优先点击，同一个网站之后不再重复询问。
- 审批来自其他聊天或定时任务时，会先点击「审阅」把卡片展开。
- 设置页可管理完整列表、把网站限定在特定聊天、先停用不删除、查看记录，也支持导出导入设置。
- 插件界面和 muse.ai 审批卡均支持简体中文、繁体中文、英文、日文。

不会乱点：

只在同时有「允许」和「拒绝」、且内容与访问权限相关的审批卡里操作。页面上的其他按钮不会碰，结账和购买类卡片也不会自动点击。

隐私：

没有服务器，数据不会向外发送。模式和信任列表通过 Chrome 同步，只保存在你自己登录的浏览器中；记录只留在本机电脑。

提醒：muse.ai 标签页需要保持打开，插件才会工作。自动允许相当于跳过人工确认，请先评估风险。

非官方工具，与 Meta、muse.ai 无关。
源代码：https://github.com/homieyangg/muse-auto-approve

### Description (English)

Clicks Allow on muse.ai approval cards so your tasks do not stall while you are away, scheduled tasks most of all.

Pick one of two modes:

- Only what I trust (recommended): New sites, actions, and chats pause and show a red number on the toolbar icon. Open the popup, choose how far to trust the request, and it is remembered.
- Allow everything: Approves every website Ren asks to open. Actions like posting or sending messages still ask first unless you enable them in Settings.

What it does:

- Trust a site, an action (like posting to Threads), either one only from a specific chat, a whole chat, or just once.
- Picks "Always allow" when offered, so the same site does not ask again.
- Opens Review banners for approvals coming from other chats or scheduled tasks.
- Full controls in Settings: limit a site to specific chats, pause an entry without deleting it, check the activity log, and export or import your rules.
- Supports English, Traditional Chinese, Simplified Chinese, and Japanese for both the extension interface and muse.ai approval cards.

What it will not click:

Only clicks inside approval cards that have both an Allow and a Deny button and are about access. Other buttons on the page are left alone, and checkouts or purchases are never auto-approved.

Privacy:

No server and nothing sent anywhere. Your mode and trusted lists sync between your signed-in Chrome browsers through Chrome sync. The activity log stays on your computer.

Note: A muse.ai tab must stay open for the extension to work. Auto-approving skips the human check, so make sure you are comfortable with that risk.

Unofficial tool, not affiliated with Meta or muse.ai.
Source code: https://github.com/homieyangg/muse-auto-approve

### 説明（日本語）

muse.ai のアシスタントが新しいサイトや重要なサイトを開こうとすると、承認カードが表示され、「許可」を押すまで待ちます。誰も操作しないとタスクは止まったままになり、スケジュールタスクでは特に頻繁に起こります。

この拡張機能が代わりに「許可」を押します。動かし方は2つから選べます。

- 信頼したものだけ（おすすめ）: 新しいサイト・アクション・チャットが初めて表示されたときに確認します。ツールバーのアイコンに赤い数字が出たら開き、どこまで信頼するかを選べば記憶されます。
- すべて許可: Ren が求めるすべてのウェブサイトを許可します。投稿やメッセージなどのアクションは、設定でオンにしない限り確認されます。

そのほか:

- サイト、アクション、特定のチャットだけ、チャット全体、今回だけ、の範囲で信頼できます
- Threads への投稿などのアクションカードも認識します
- 設定ページで完全なリストを管理し、サイトを特定のチャットに限定したり、削除せずにオフにしたり、アクティビティログの確認や設定のエクスポート・インポートができます
- ほかのチャットからの承認は「確認」バナーを開いて処理します
- 「常に許可」があれば優先するので、同じサイトで何度も確認されません
- カード内に許可と拒否の両方のボタンがあり、内容がサイトへのアクセスや権限に関係するときだけ押します
- 操作を誤らないよう、購入・決済のカードは自動で許可しません
- 画面は日本語・英語・繁体字中国語・簡体字中国語に対応しています

サーバーはなく、データをどこにも送信しません。信頼リストは Chrome の同期で、同じ Google アカウントでサインインしたブラウザ間に保存されます。アクティビティログはこのコンピューターにだけ残ります。

注意: muse.ai のタブを開いたままにする必要があります。自動許可は人の確認を省くため、リスクを理解したうえで使用してください。

非公式ツールです。Meta や muse.ai とは関係ありません。ソースコード: https://github.com/homieyangg/muse-auto-approve

## 隱私權做法

- 單一用途：在 muse.ai 頁面自動按下審批卡的允許按鈕。 / Automatically clicks the approve button on muse.ai approval cards.
- `storage` 權限用途：儲存模式、信任的網站、動作和聊天室（chrome.storage.sync，Chrome 會在使用者自己登入的瀏覽器之間同步），以及最近 200 筆審批紀錄（只在本機）。 / Stores the mode and the trusted sites, actions, and chats (chrome.storage.sync, synced by Chrome between the user's own signed-in browsers) and the last 200 approval records (local only).
- 主機權限（content script 限 `muse.ai`）用途：需要讀取 muse.ai 頁面找出審批卡並點擊允許按鈕，不在其他網站執行。 / Needed to find approval cards on muse.ai pages and click the approve button. It does not run on any other site.
- 遠端程式碼：否，所有程式碼都在套件內。 / No remote code.
- 資料使用：不收集任何使用者資料，三個聲明（不販售、不用於無關用途、不用於信用評估）都勾選。
- 隱私權政策網址：https://github.com/homieyangg/muse-auto-approve/blob/main/PRIVACY.md

## 發布設定

- 瀏覽權限：公開，或選「不公開」（只有拿到連結的人能安裝）
- 發布地區：所有地區
