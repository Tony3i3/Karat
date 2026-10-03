# Karat

A small, ad-free PWA for live gold and silver spot prices, value per gram by purity, and what a
budget buys (or what a weight costs) including a jeweler's craftsmanship and profit.

Plain HTML/CSS/JS, no build step. Prices come from [gold-api.com](https://gold-api.com)
(no key, CORS enabled), refreshed every 30 seconds while the app is open.

## Price chart

- **1D** is drawn from the live prices the app records on the device (every 30 s while it is
  open, kept for 7 days). Gaps show where the app was closed. If the history key's plan includes
  hourly history, that fills in the earlier hours.
- **7D, 1M, 3M, 6M, 1Y, 5Y, All** use gold-api.com price history (`/history`, daily points),
  which needs a free API key. Paste it under "Price history key" in the app; it is stored in
  that device's localStorage only, never in this repository. The free plan allows 10 history
  requests an hour, so the app fetches one long daily series per metal, saves it, and refreshes
  it at most every 6 hours.

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
