# Privacy Policy

Auto Approve for Muse does not collect, sell, or share any user data. It has no server and makes no network requests of its own.

- The extension only runs on `muse.ai` pages. It reads the page to find approval cards and clicks the approve button. To tell approvals apart, it also reads the approval ID, the permission type, the site a browser upload goes to, the approval's own host field, and which option each approval button stands for, which the muse page already holds. That data stays in your browser.
- Your settings (on/off, mode, preferences, language) and your trusted sites, actions, and chats are stored with `chrome.storage.sync`. If you are signed in to Chrome, Chrome syncs them between your own browsers through your Google account, the same way it syncs other extension settings. The developer never receives them.
- The activity log (the last 200 approval cards, with time, site, chat name, and the approval ID, permission type and host field read from muse) and the requests waiting for your decision are stored only on your device in `chrome.storage.local` and `chrome.storage.session`. The IDs of up to 500 approvals that a read saw as a purchase or as several approvals are kept there too, so that no tab auto-approves them with a rule saved from recent activity; clearing the log keeps this list. You can clear the log at any time, and everything is removed when the extension is uninstalled.
- Export creates a file on your computer that only you can see. Nothing is uploaded.

If you have questions, open an issue at https://github.com/homieyangg/muse-auto-approve/issues.

# 隱私權政策

Auto Approve for Muse 不收集、不販售、也不分享任何使用者資料。插件沒有伺服器，自己不會發送任何網路請求。

- 插件只在 `muse.ai` 頁面執行，讀取頁面來找審批卡並按下允許。為了分辨每一筆審批，也會讀 muse 頁面本來就有的審批 ID、權限種類、瀏覽器上傳的目的網站、審批本身的 host 欄位，以及每顆審批按鈕對應的選項，這些資料只在你的瀏覽器裡用。
- 設定（開關、模式、偏好、語言）和信任的網站、動作、聊天室存在 `chrome.storage.sync`。你有登入 Chrome 的話，Chrome 會透過你的 Google 帳號在你自己的瀏覽器之間同步，跟其他插件設定一樣。開發者不會拿到這些資料。
- 紀錄（最近 200 筆審批卡的時間、網站、聊天室名稱，以及從 muse 讀到的審批 ID、權限種類與 host 欄位）和等你決定的請求，只存在你裝置上的 `chrome.storage.local` 與 `chrome.storage.session`。讀到是購買或多筆審批的審批，最多 500 筆的審批 ID 也存在那裡，讓每個分頁都不會用從紀錄存的規則自動允許它們；清除紀錄不會清掉這份清單。紀錄可以隨時清除，移除插件時也會一起刪掉。
- 匯出的設定檔只會存到你自己的電腦，不會上傳。

有問題請到 https://github.com/homieyangg/muse-auto-approve/issues 開 issue。

# プライバシーポリシー

Auto Approve for Muse は、ユーザーデータを収集・販売・共有しません。サーバーを持たず、自分からネットワークリクエストを送ることもありません。

- 拡張機能は `muse.ai` のページでのみ動作します。ページを読み取って承認カードを見つけ、許可ボタンを押します。承認を見分けるために、muse のページがすでに保持している承認 ID、権限種別、ブラウザアップロードの送信先も読み取ります。これらのデータはブラウザ内に留まります。
- 設定（オン・オフ、モード、好み、言語）と、信頼するサイト・アクション・チャットは `chrome.storage.sync` に保存されます。Chrome にサインインしている場合、Chrome が他の拡張機能設定と同じように、あなたの Google アカウント経由で自分のブラウザ間を同期します。開発者が受け取ることはありません。
- アクティビティログ（直近 200 件の承認カードの時刻・サイト・チャット名）と承認待ちのリクエストは、`chrome.storage.local` と `chrome.storage.session` として端末上にのみ保存されます。購入または複数の承認と読み取られた承認の ID（最大 500 件）もそこに保存され、どのタブもアクティビティから保存したルールでそれらを自動承認しません。ログを消去してもこの一覧は残ります。ログはいつでも消去でき、拡張機能を削除するとすべて消えます。
- エクスポートで作成されるファイルはあなたのコンピューター上だけに保存されます。どこにもアップロードされません。

質問がある場合は https://github.com/homieyangg/muse-auto-approve/issues で issue を作成してください。
