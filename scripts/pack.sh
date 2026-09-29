#!/usr/bin/env bash
# 打包上架 Chrome 網上應用程式商店用的 zip，只放插件執行需要的檔案
set -euo pipefail

cd "$(dirname "$0")/.."
version=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
out="dist/muse-auto-approve-${version}.zip"

mkdir -p dist
rm -f "$out"
zip -qr "$out" manifest.json content.js popup.html popup.js icons
# 安裝腳本固定抓 release 的 muse-auto-approve.zip，所以多放一份不帶版本號的
cp "$out" dist/muse-auto-approve.zip
echo "$out"
