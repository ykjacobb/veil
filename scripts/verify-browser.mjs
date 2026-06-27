// Loads vendor/nsfw-bundle.js in a real headless Chrome, loads the model, and
// classifies a generated image — verifies the exact path the extension uses.
import puppeteer from "puppeteer-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

// Minimal static server so the bundle loads as a real ES module over http.
const server = http.createServer((req, res) => {
  if (req.url === "/test") {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><meta charset=utf8><body><script type=module>
      import { loadModel, tf } from '/vendor/nsfw-bundle.js';
      window.__run = async () => {
        const model = await loadModel();
        // Build a 224x224 image with random skin-ish noise.
        const c = document.createElement('canvas'); c.width = 224; c.height = 224;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(224, 224);
        for (let i = 0; i < img.data.length; i += 4) {
          img.data[i] = 200 + Math.random()*40; img.data[i+1] = 150; img.data[i+2] = 130; img.data[i+3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        const preds = await model.classify(c);
        return { backend: tf.getBackend(), preds };
      };
    </script>`);
    return;
  }
  const file = path.join(repo, req.url);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.setHeader("content-type", req.url.endsWith(".js") ? "text/javascript" : "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  } else {
    res.statusCode = 404;
    res.end("nope");
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/test`, { waitUntil: "networkidle0" });
  const result = await page.evaluate(() => window.__run());
  console.log("backend:", result.backend);
  console.log("predictions:");
  result.preds.forEach((p) => console.log("  " + p.className + " = " + p.probability.toFixed(4)));
  const sum = result.preds.reduce((a, p) => a + p.probability, 0);
  const ok = result.preds.length === 5 && Math.abs(sum - 1) < 0.05;
  if (errors.length) console.log("page errors:", errors);
  console.log(ok ? "RESULT: PASS — model loads & classifies in-browser" : "RESULT: FAIL");
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
