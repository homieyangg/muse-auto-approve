#!/usr/bin/env bash
# 下載 Auto Approve for Muse 到固定資料夾並打開 chrome://extensions；Chrome 不允許程式直接裝插件，最後一步要使用者自己按「載入未封裝項目」
set -euo pipefail

REPO="homieyangg/muse-auto-approve"
ZIP_URL="${MUSE_AA_ZIP_URL:-https://github.com/$REPO/releases/latest/download/muse-auto-approve.zip}"
DEST="${MUSE_AA_DIR:-$HOME/muse-auto-approve}"
EXT_NAME='"Auto Approve for Muse"'

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$ZIP_URL" -o "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$1" "$ZIP_URL"
  else fail "curl or wget is required"; fi
}

unpack() {
  if command -v unzip >/dev/null 2>&1; then unzip -q -o "$1" -d "$2"
  elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$1" "$2"
  else fail "unzip or python3 is required"; fi
}

copy_to_clipboard() {
  if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$1" | pbcopy
  elif command -v wl-copy >/dev/null 2>&1; then printf '%s' "$1" | wl-copy
  elif command -v xclip >/dev/null 2>&1; then printf '%s' "$1" | xclip -selection clipboard
  elif command -v xsel >/dev/null 2>&1; then printf '%s' "$1" | xsel --clipboard --input
  else return 1; fi
}

open_extensions_page() {
  if [ "$(uname)" = "Darwin" ]; then
    for app in "Google Chrome" "Chromium"; do
      if open -Ra "$app" 2>/dev/null; then open -a "$app" "chrome://extensions"; return 0; fi
    done
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    for bin in google-chrome google-chrome-stable chromium chromium-browser; do
      if command -v "$bin" >/dev/null 2>&1; then nohup "$bin" "chrome://extensions" >/dev/null 2>&1 & return 0; fi
    done
  fi
  return 1
}

is_update=false
if [ -e "$DEST" ]; then
  grep -qsF "$EXT_NAME" "$DEST/manifest.json" "$DEST/_locales/en/messages.json" \
    || fail "$DEST already exists and isn't this extension. Remove it or set MUSE_AA_DIR to another folder."
  is_update=true
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fetch "$tmp/ext.zip"
unpack "$tmp/ext.zip" "$tmp/ext"
[ -f "$tmp/ext/manifest.json" ] || fail "the downloaded archive has no manifest.json"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$tmp/ext" "$DEST"

version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DEST/manifest.json")"

if $is_update; then
  printf 'Updated Auto Approve for Muse to %s in %s\n' "$version" "$DEST"
  printf 'Open chrome://extensions and click the reload icon on its card, or restart Chrome.\n'
  exit 0
fi

printf 'Downloaded Auto Approve for Muse %s to %s\n\n' "$version" "$DEST"
copied=false
copy_to_clipboard "$DEST" && copied=true
open_extensions_page || printf 'Open chrome://extensions in Chrome.\n'

printf 'Finish in Chrome:\n'
printf '  1. Turn on "Developer mode" in the top right corner.\n'
printf '  2. Click "Load unpacked" and choose this folder:\n'
printf '       %s\n' "$DEST"
if $copied; then
  printf '     The path is on your clipboard. In the folder picker, press '
  if [ "$(uname)" = "Darwin" ]; then printf 'Cmd+Shift+G'; else printf 'Ctrl+L'; fi
  printf ', paste, and confirm.\n'
fi
printf '  3. Reload any open muse.ai tabs.\n\n'
printf 'Run the same command again later to update.\n'
