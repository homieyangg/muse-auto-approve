# Auto Approve for Muse

[繁體中文](README.zh-TW.md)

When the muse.ai assistant tries to open a new or sensitive website, it shows an approval card and waits for you to click "Allow". If nobody is around, the task just sits there, which happens a lot with scheduled tasks.

This Chrome extension clicks Allow for you. If the card offers "Always allow", it picks that one, so the same site won't ask again.

> This is an unofficial tool and is not affiliated with Meta or muse.ai. Auto-approving removes the human check on what the assistant can access, so make sure you're fine with that.

## Install

Install it from the Chrome Web Store (link coming once the listing is approved), or load it yourself:

1. Clone or download this repo.
2. Open `chrome://extensions` and turn on Developer mode in the top right corner.
3. Click "Load unpacked" and select the repo folder.
4. Reload any open muse.ai tabs.

Click the toolbar icon to pause it, choose whether to prefer "Always allow", or see the last 20 cards it approved.

## How it decides what to click

- It starts from the Deny button and looks for Allow or Always allow in the same block, so an Allow button anywhere else on the page is never clicked.
- The card itself has to mention a website, access, the browser, or permissions. Unrelated dialogs such as a delete confirmation are left alone.
- An approval that comes from another chat only shows up as a banner with a Review button. The extension clicks Review to open the card, then approves it.
- It won't click the same card twice within 5 seconds, and it clicks Review at most once every 10 seconds.

It has only been tested with the Traditional Chinese UI. English and Simplified Chinese button labels are in the matching rules but haven't been tested on the live site.

## Limitations

- A muse.ai tab has to stay open. If you close it, nothing gets approved.
- It approves every card that matches, whatever the site or action.
- A muse.ai redesign can break the matching. Button labels and the markup of the review banner are the parts most likely to change.

## Running it around the clock

If your computer doesn't stay on, you can run Chromium on a server with the extension loaded. `deploy/compose.yml` uses [linuxserver/chromium](https://github.com/linuxserver/docker-chromium) and runs on both amd64 and arm64.

```bash
cd deploy
docker compose up -d
```

You need to sign in to muse.ai once through the web UI. The compose file binds it to `127.0.0.1:13000` on the server, so connect through an SSH tunnel:

```bash
ssh -L 13000:127.0.0.1:13000 <your-server>
# then open http://localhost:13000
```

Once you're signed in, you can close the page and the SSH session. Chromium keeps running on the server, and the login is stored in the `muse-browser-config` Docker volume.

A few things to keep in mind:

- The web UI includes a terminal with passwordless sudo. Never expose the port to the internet.
- Chromium in the container defaults to English, and muse.ai follows the browser language. The compose file passes `--lang=zh-TW` because that's the UI the extension was tested with. After signing in, also set Chromium's language to Traditional Chinese and turn off page translation, since a translated page changes the button labels the extension looks for.
- Streaming the web UI takes a fair amount of CPU, so close it when you're done.
- After updating the extension, run `docker compose restart` so Chromium loads the new version.

## Privacy

The extension never sends anything out of your browser. Settings and the last 20 approval records are kept in `chrome.storage.local`. See [PRIVACY.md](PRIVACY.md) for details.

## Packaging

```bash
./scripts/pack.sh
```

This writes a zip for the Chrome Web Store to `dist/`, containing only the files the extension needs.

## License

MIT
