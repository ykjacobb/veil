# vendor/ort/

onnxruntime-web runtime files, **staged by `npm run setup`** from the installed
`onnxruntime-web` package (not committed — see `.gitignore`):

- `ort.wasm.min.js` — the loader (global `ort`)
- `ort-wasm-simd-threaded.wasm` + `.mjs` — the WASM backend (run single-threaded,
  so no cross-origin isolation is needed)

These are loaded by the **offscreen document** (`pages/offscreen.html` →
`src/inference.js`), which runs the ViT NSFW model. They run there rather than
in the service worker because a service worker can't use dynamic `import()`
(which onnxruntime-web's wasm loader requires), and not in the content script
because the page CSP would block it.

The model itself (`model/vit-nsfw-int8.onnx`, AdamCodd/vit-base-nsfw-detector,
int8) is also fetched by `npm run setup`.
