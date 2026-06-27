/*
 * VEIL on-device NSFW inference — runs in the service worker (extension origin,
 * so no page CSP blocks onnxruntime-web's wasm glue, and it's off the page's
 * main thread). Model: AdamCodd/vit-base-nsfw-detector (ViT-base, 384px, int8),
 * classes [sfw, nsfw]. Loaded via importScripts after ort.wasm.min.js.
 */
(function () {
  "use strict";

  var SIZE = 384;
  var configured = false;
  var sessionPromise = null;

  function configureOrt() {
    if (configured) return;
    var w = self.ort.env.wasm;
    w.numThreads = 1; // no SharedArrayBuffer / cross-origin isolation needed
    w.simd = true;
    w.proxy = false; // run on this thread, no worker
    w.wasmPaths = chrome.runtime.getURL("vendor/ort/");
    configured = true;
  }

  function getSession() {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async function () {
      configureOrt();
      var url = chrome.runtime.getURL("model/vit-nsfw-int8.onnx");
      var buf = await (await fetch(url)).arrayBuffer();
      return self.ort.InferenceSession.create(new Uint8Array(buf), {
        executionProviders: ["wasm"]
      });
    })();
    return sessionPromise;
  }

  // RGBA SIZE×SIZE ImageData -> normalized NCHW float32 tensor ((v/127.5)-1).
  function toTensor(imageData) {
    var data = imageData.data;
    var n = SIZE * SIZE;
    var f = new Float32Array(3 * n);
    for (var i = 0; i < n; i++) {
      var j = i * 4;
      f[i] = data[j] / 127.5 - 1;
      f[n + i] = data[j + 1] / 127.5 - 1;
      f[2 * n + i] = data[j + 2] / 127.5 - 1;
    }
    return new self.ort.Tensor("float32", f, [1, 3, SIZE, SIZE]);
  }

  function nsfwProb(logits) {
    // logits = [sfw, nsfw]; return softmax P(nsfw).
    var m = Math.max(logits[0], logits[1]);
    var e0 = Math.exp(logits[0] - m);
    var e1 = Math.exp(logits[1] - m);
    return e1 / (e0 + e1);
  }

  async function runOnImageData(imageData) {
    var session = await getSession();
    var feeds = {};
    feeds[session.inputNames[0]] = toTensor(imageData);
    var out = await session.run(feeds);
    return { nsfw: nsfwProb(out[session.outputNames[0]].data) };
  }

  function drawToImageData(source) {
    var canvas = new OffscreenCanvas(SIZE, SIZE);
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, SIZE, SIZE);
    return ctx.getImageData(0, 0, SIZE, SIZE);
  }

  // Fetch (CORS-bypassed in SW), decode, classify.
  async function classifyUrl(url) {
    var resp = await fetch(url);
    if (!resp.ok) throw new Error("fetch " + resp.status);
    var bitmap = await createImageBitmap(await resp.blob());
    try {
      return await runOnImageData(drawToImageData(bitmap));
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  // Classify raw RGBA pixels (already SIZE×SIZE) sent from a content script.
  async function classifyPixels(rgbaBytes) {
    return runOnImageData({ data: rgbaBytes, width: SIZE, height: SIZE });
  }

  self.veilClassifyUrl = classifyUrl;
  self.veilClassifyPixels = classifyPixels;
  self.veilWarmModel = getSession;
  self.VEIL_INPUT_SIZE = SIZE;
})();
