# VEIL

A Manifest V3 Chrome extension that filters adult content in two passive layers.

## Layers

**Layer 1 — URL + path filtering (free).**
`declarativeNetRequest` blocks blacklisted domains (`rules/domains.json`) and
keyword matches in the full URL (dynamic rules generated in `src/background.js`
from `src/keywords.js`). In-page SPA navigations (e.g. X search updating the URL
without a network request) are caught via the `webNavigation` API in the service
worker and a `document_start` check in the content script.

**Layer 2 — visual AI block (paid).**
Classification uses **onnxruntime-web + a ViT model**
(`AdamCodd/vit-base-nsfw-detector`, int8, 384px, classes sfw/nsfw), running 100%
on-device. Because a service worker can't `import()` (which ORT needs) and the
page CSP would block it in a content script, inference runs in an **offscreen
document** (`pages/offscreen.html` + `src/inference.js`). The content script
finds every `<img>`, `<video>`, **and CSS `background-image` thumbnail**, the SW
relays them to the offscreen doc, and a single `P(nsfw)` comes back. Lazy-loaded
images are re-checked when their `src`/`srcset` swaps in.

There is **no blur** — flagged media is fully replaced with an opaque **white
cover** reading "Blocked by VEIL". Un-classified images/thumbnails are kept
invisible (hide-then-reveal) until cleared, so NSFW never flashes. Covered videos
are muted and force-paused and can't resume. Cross-origin images are fetched by
the offscreen doc (CORS-bypassed via `host_permissions`) so pixels are readable.

Videos are **fail-closed** and re-sampled every 1s: revealed only when a frame
VEIL can read classifies as clean. The moment any frame is flagged — or can't be
read (cross-origin taint, DRM/streamed HLS/DASH or `blob:`) — the **whole video
is blocked for the session**. An explicit poster covers it before frames decode.
This means legit streamed video (e.g. YouTube) is also covered, by design.

Block threshold: `P(nsfw) ≥ nsfwThreshold` (default 0.6; lower = stricter).

## Install (dev)

1. `npm install && npm run setup` — installs deps and fetches the large binaries
   (`vendor/ort/*` + `model/vit-nsfw-int8.onnx`, ~100MB, not committed).
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder.
3. Click the VEIL icon → toggle layers. "Unlock (dev)" simulates the paid tier.
   After toggling, reload the tab you want filtered.

## Verify

```
npm run verify:ort         # ViT inference runs in the offscreen document
npm run verify:extension   # full pipeline: image flagged + covered
npm run verify:video       # cross-origin video fails closed
npm run verify:bg          # background-image thumbnail covered
```

These need Chrome for Testing (stable Chrome blocks `--load-extension`); point at
one via `CHROME_BIN`, e.g. `npx @puppeteer/browsers install chrome@stable`.
`verify:video` also needs a small clip via `TEST_MP4`.

## Layout

```
manifest.json
src/
  keywords.js      shared keyword/domain data + matchers (SW + content)
  background.js    DNR rules, webNavigation SPA guard, offscreen lifecycle + relay
  content.js       URL guard + image/video/background scanning + block cover
  inference.js     ViT classifier (runs in the offscreen document)
  blur.css         block-cover styles (no blur)
pages/
  offscreen.html/js  hosts onnxruntime-web + the model
  blocked.html/js    blocked page;  popup.*  settings / paid gate
rules/domains.json static DNR domain blacklist
vendor/ort/        onnxruntime-web runtime (staged by `npm run setup`)
model/             ViT ONNX weights (fetched by `npm run setup`)
scripts/           setup + verification scripts
```

## Known limitations (by design / platform constraints)

- Classification runs after decode. Images/thumbnails are classified only when
  near the viewport (IntersectionObserver) and hidden just for that brief
  window, with a safety timeout that reveals them if the classifier is too slow
  — so a heavy page never ends up all-hidden waiting on the serial model.
  Videos aren't pre-hidden (they could get stuck), so a flagged video may show
  one frame before it's covered.
- Keyword matching uses letter boundaries to avoid `sussex`/`camera` false
  positives, but URL filtering will always have some over/under-blocking.
- DNR can't see History-API navigations; those rely on the webNavigation +
  content-script path, which is slightly slower than a network-level block.
- The "500+ domain" list is a structure to fill in; `rules/domains.json` ships
  with the 10 hardcoded seeds.
- The paid gate is local-only (dev). Real billing/license verification is TODO.
- The model (~88 MB) loads once into the offscreen document on first use
  (~2–3s cold), then stays warm; inference is ~0.3–1s per image on the WASM
  backend, run through a relay so it's off the page's main thread.
- The model is binary (sfw/nsfw); it doesn't distinguish "explicit" vs
  "suggestive", so the cover reason is a single "Adult content".
