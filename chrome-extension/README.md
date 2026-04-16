# CAVS Over Reddit

This Chrome extension adds a CAVS badge to Reddit posts and can run either the
direct CAVS pipeline or the oracle queue flow.

## Files

- `manifest.json`
  Chrome extension manifest and host permissions.
- `content.js`, `content.css`
  Reddit page integration and badge UI.
- `background.js`
  Background worker logic.
- `options.html`, `options.js`
  Configuration page.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `chrome-extension/`.

## Configure

The options page exposes these settings:

- `Mode`: `cavs` or `oracle`
- `CAVS base URL`: default `http://127.0.0.1:4200`
- `Skill mapping mode`: `extract` or `keywords`
- `Oracle queue base URL`: default `http://127.0.0.1:20000`
- `Auto-analyze`
- oracle wait and poll settings

## Use

- Open Reddit.
- Click a badge to open or close details.
- Double-click a badge to analyze a post unless auto-analyze is enabled.

## Notes

- Results are cached in `chrome.storage.local`.
- Default permissions cover local CAVS and local oracle queue endpoints.
- If you point the extension at hosted services, update `host_permissions` in
  `manifest.json`.
