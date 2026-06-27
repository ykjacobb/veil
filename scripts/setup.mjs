// One-time setup: stage the onnxruntime-web runtime files into vendor/ort/ and
// download the ViT NSFW model into model/. These are large binaries kept out of
// git; run `npm run setup` after `npm install` (or to refresh them).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ortDist = path.join(repo, "node_modules", "onnxruntime-web", "dist");
const ortOut = path.join(repo, "vendor", "ort");
const modelDir = path.join(repo, "model");
const modelPath = path.join(modelDir, "vit-nsfw-int8.onnx");
const MODEL_URL =
  "https://huggingface.co/AdamCodd/vit-base-nsfw-detector/resolve/main/onnx/model_quantized.onnx";

const ORT_FILES = [
  "ort.wasm.min.js",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs"
];

function copyOrtFiles() {
  fs.mkdirSync(ortOut, { recursive: true });
  for (const f of ORT_FILES) {
    const src = path.join(ortDist, f);
    if (!fs.existsSync(src)) {
      throw new Error("missing " + src + " — run `npm install` first");
    }
    fs.copyFileSync(src, path.join(ortOut, f));
    console.log("copied vendor/ort/" + f);
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const go = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return go(res.headers.location);
      }
      if (res.statusCode !== 200) {
        reject(new Error("HTTP " + res.statusCode + " for " + u));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    }).on("error", reject);
    go(url);
  });
}

async function ensureModel() {
  fs.mkdirSync(modelDir, { recursive: true });
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1_000_000) {
    console.log("model already present (" + (fs.statSync(modelPath).size / 1e6).toFixed(0) + " MB)");
    return;
  }
  console.log("downloading model (~88 MB) ...");
  await download(MODEL_URL, modelPath);
  console.log("saved model/vit-nsfw-int8.onnx");
}

copyOrtFiles();
await ensureModel();
console.log("setup complete.");
