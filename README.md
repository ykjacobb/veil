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

The overlay is **reactive, no blur**: when something classifies as NSFW it gets
an opaque **white cover** reading "Blocked by VEIL"; when it's no longer NSFW the
cover is removed. Images are classified once near the viewport (and again if
their `src` swaps). Videos are re-checked every 1s: while a frame is NSFW the
overlay is shown and the **audio is muted** (the video is *not* paused, so it
keeps playing and the overlay clears once it plays past the scene). Cross-origin
images are fetched by the offscreen doc (CORS-bypassed via `host_permissions`)
so pixels are readable; cross-origin **video** frames can't be read (canvas
taint), so those are left as-is — VEIL only overlays what it can actually see.

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

- Classification runs after decode and nothing is pre-hidden, so an NSFW image
  or video frame can be visible for a moment before the overlay lands. To keep
  the single classifier from being flooded, elements are only classified when
  near the viewport (IntersectionObserver).
- Cross-origin video frames can't be read (canvas taint), so such videos can't
  be analyzed and aren't overlaid. Cross-origin *images* are fine (fetched by
  the offscreen doc).
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
