# vendor/

`nsfw-bundle.js` is a **generated** file — do not edit by hand.

It is an IIFE bundle (built by `scripts/build-vendor.mjs` via esbuild) containing:

- TensorFlow.js
- NSFWjs **core** + the **mobilenet_v2** model with weights inlined

It exposes `globalThis.__VEIL_NSFW = { loadModel, tf }` and runs 100% on-device —
no CDN, no network calls, no separate model download.

### Rebuild

```bash
npm install
npm run build:vendor   # -> vendor/nsfw-bundle.js  (~4.6 MB)
```

### Why only mobilenet_v2?

Importing nsfwjs's top-level entry inlines all three models (~40 MB). We import
`nsfwjs/core` + `nsfwjs/models/mobilenet_v2` only, which keeps the bundle ~4.6 MB.

### How it's loaded at runtime

The content script does **not** `import()` this file (page CSP blocks content-script
dynamic imports). Instead the service worker injects it with
`chrome.scripting.executeScript`, which bypasses page CSP and shares the content
script's isolated world — so `globalThis.__VEIL_NSFW` becomes visible to the
content script.
