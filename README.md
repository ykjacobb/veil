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
When unlocked, the service worker injects a self-contained NSFWjs + TensorFlow.js
bundle (`vendor/nsfw-bundle.js`, mobilenet_v2 weights inlined) into the tab via
`chrome.scripting.executeScript`, and the content script classifies every
`<img>`, `<video>`, **and CSS `background-image` thumbnail** 100% on-device.
Lazy-loaded images are re-checked when their `src`/`srcset` swaps in.

There is **no blur** — flagged media is fully replaced with an opaque **white
cover** reading "Blocked by VEIL" plus a one-line reason. Un-classified images /
thumbnails are kept invisible (hide-then-reveal, no blur) until cleared, so NSFW
never flashes. Covered videos are muted and force-paused and can't resume.
Cross-origin images (which would taint the canvas) are re-fetched through the
service worker so their pixels stay readable.

Videos are **fail-closed** and re-sampled every 1s: a video is revealed only
when a frame VEIL can actually read classifies as clean. The moment any frame is
flagged — or a frame can't be read (cross-origin taint, DRM/streamed HLS/DASH or
`blob:` media) — the **whole video is blocked for the session** (it does not
un-block). An explicit poster covers the video before frames even decode. Note
this means legit streamed video (e.g. YouTube) is also covered, by design.

Thresholds: Porn/Hentai ≥ 0.85, Sexy ≥ 0.70 → block.

## Install (dev)

1. `npm install && npm run build:vendor` — builds `vendor/nsfw-bundle.js`
   (already committed, so this is only needed to rebuild it).
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder.
3. Click the VEIL icon → toggle layers. "Unlock (dev)" simulates the paid tier.
   After toggling, reload the tab you want filtered.

## Verify

```
npm run verify:browser     # loads the bundle in real Chrome, classifies an image
npm run verify:extension   # loads the unpacked extension, runs the full pipeline
```

`verify:extension` needs Chrome for Testing (stable Chrome blocks `--load-extension`);
point it at one via `CHROME_BIN`, e.g.
`npx @puppeteer/browsers install chrome@stable`.

## Layout

```
manifest.json
src/
  keywords.js     shared keyword/domain data + matchers (SW + content)
  background.js    DNR rule sync, webNavigation SPA guard, model injection, image fetch
  content.js       URL guard + hide-then-reveal scanning + inlined classifier
  blur.css         block-cover styles (no blur)
rules/domains.json static DNR domain blacklist
pages/             blocked page + popup (settings / paid gate)
vendor/            generated nsfw-bundle.js (see vendor/README.md)
scripts/           build + verification scripts
```

## Known limitations (by design / platform constraints)

- Classification runs after decode, so images/thumbnails are kept invisible
  until classified (hide-then-reveal) — the only flash-free approach. Videos
  aren't pre-hidden (they could get stuck), so a flagged video may show one
  frame before it's covered.
- Keyword matching uses letter boundaries to avoid `sussex`/`camera` false
  positives, but URL filtering will always have some over/under-blocking.
- DNR can't see History-API navigations; those rely on the webNavigation +
  content-script path, which is slightly slower than a network-level block.
- The "500+ domain" list is a structure to fill in; `rules/domains.json` ships
  with the 10 hardcoded seeds.
- The paid gate is local-only (dev). Real billing/license verification is TODO.
- `vendor/nsfw-bundle.js` (~4.6 MB) is injected per-tab when the visual layer is
  on; first classification on a page waits for the model to load (~1–2s).
