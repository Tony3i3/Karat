# Karat

A small, ad-free PWA for live gold and silver spot prices, value per gram by purity, and what a
budget buys (or what a weight costs) including a jeweler's craftsmanship and profit.

Plain HTML/CSS/JS, no build step. Prices come from [gold-api.com](https://gold-api.com)
(no key, CORS enabled), refreshed every 30 seconds while the app is open.

## Files

- `index.html`: the whole app (CSS and JS inline)
- `manifest.webmanifest`: install metadata
- `sw.js`: service worker (offline app shell, cached fonts; prices always go to the network)
- `icons/`: app icons, favicon and apple-touch-icon

All URLs are relative, so the app works from a domain root or a subfolder.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

## Deploy

Any static HTTPS host works. Publish the repository root as-is (no build command).

**On every deploy, bump `CACHE` in `sw.js`** (`karat-v1` → `karat-v2` → …) so installed copies
pick up the new files. The app reloads itself once when the new version takes over.

## Install on iPhone

Open the site in Safari → Share → Add to Home Screen.
