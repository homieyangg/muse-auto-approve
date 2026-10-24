#!/usr/bin/env bash
# 把打包好的 zip 上傳到 Chrome 線上應用程式商店並送審，審核通過後自動發布。
# 需要兩個環境變數：
#   CWS_SERVICE_ACCOUNT_KEY  服務帳號 JSON 金鑰的內容（服務帳號要先加進開發人員資訊主頁的「帳戶」）
#   CWS_PUBLISHER_ID         開發人員資訊主頁 → 發布者 → 設定裡的發布者 ID
# 用法：scripts/publish-cws.sh dist/muse-auto-approve-1.3.0.zip
set -euo pipefail

zip=$1
item_id=hbcimibdadjhancbpjibbhnhlcflmoii
base=https://chromewebstore.googleapis.com
item="publishers/${CWS_PUBLISHER_ID}/items/${item_id}"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# 失敗時把回應印出來，才看得出是權限、發布者 ID 還是版本號的問題
api() {
  local out
  if ! out=$(curl -sS --fail-with-body "$@"); then
    echo "$out" >&2
    return 1
  fi
  printf '%s' "$out"
}

# 服務帳號金鑰簽 JWT 換 access token，不用另外裝 gcloud：
# https://developers.google.com/identity/protocols/oauth2/service-account#httprest
access_token() {
  local email key now header claims unsigned signature
  email=$(jq -r .client_email <<<"$CWS_SERVICE_ACCOUNT_KEY")
  key=$(mktemp)
  jq -r .private_key <<<"$CWS_SERVICE_ACCOUNT_KEY" > "$key"
  now=$(date +%s)
  header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
  claims=$(jq -nc --arg iss "$email" --argjson now "$now" \
    '{iss: $iss, scope: "https://www.googleapis.com/auth/chromewebstore", aud: "https://oauth2.googleapis.com/token", iat: $now, exp: ($now + 600)}' | b64url)
  unsigned="$header.$claims"
  signature=$(printf '%s' "$unsigned" | openssl dgst -sha256 -sign "$key" | b64url)
  rm -f "$key"
  api https://oauth2.googleapis.com/token \
    -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
    -d assertion="$unsigned.$signature" | jq -r .access_token
}

token=$(access_token)
auth="Authorization: Bearer $token"

result=$(api -X POST -H "$auth" -T "$zip" "$base/upload/v2/$item:upload")
echo "upload: $result"
state=$(jq -r .uploadState <<<"$result")
# 套件還在處理時先回 IN_PROGRESS，改用 fetchStatus 輪詢，最多等 2 分鐘
for _ in $(seq 24); do
  case $state in IN_PROGRESS | UPLOAD_IN_PROGRESS) ;; *) break ;; esac
  sleep 5
  state=$(api -H "$auth" "$base/v2/$item:fetchStatus" | jq -r .lastAsyncUploadState)
done
if [ "$state" != SUCCEEDED ]; then
  echo "upload failed: $state" >&2
  exit 1
fi

result=$(api -X POST -H "$auth" -H 'Content-Type: application/json' -d '{}' "$base/v2/$item:publish")
echo "publish: $result"
