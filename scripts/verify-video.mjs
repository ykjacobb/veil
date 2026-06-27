// Verifies the reactive video overlay: a readable (same-origin) video whose
// frames score NSFW gets the overlay + audio muted (NOT paused, so it can play
// past the scene). Forces nsfwThreshold:0 so the benign test clip is "NSFW".
import puppeteer from "puppeteer-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const MP4 = process.env.TEST_MP4;
if (!MP4 || !fs.existsSync(MP4)) {
  console.log("RESULT: FAIL — set TEST_MP4 to a small .mp4 path");
  process.exit(1);
}
const VIDEO = fs.readFileSync(MP4);

// Single server serves BOTH page and video (same origin) so frames are readable.
const srv = http.createServer((req, res) => {
  if (req.url.startsWith("/v.mp4")) {
    res.setHeader("content-type", "video/mp4");
    res.setHeader("accept-ranges", "bytes");
    res.end(VIDEO);
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><meta charset=utf8><body>
    <video id=v src="/v.mp4" width=200 height=200 autoplay muted loop playsinline></video></body>`);
});
await new Promise((r) => srv.listen(0, "localhost", r));
const port = srv.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required",
    `--disable-extensions-except=${repo}`, `--load-extension=${repo}`]
});
try {
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 });
  const worker = await sw.worker();
  for (let i = 0; i < 25; i++) {
    await worker.evaluate(() => new Promise((res) =>
      chrome.storage.sync.set({ paid: true, visualFilteringEnabled: true, urlFilteringEnabled: true, nsfwThreshold: 0 }, () => res(1))));
    await new Promise((r) => setTimeout(r, 300));
    const rb = await worker.evaluate(() => new Promise((res) => chrome.storage.sync.get(null, res)));
    if (rb.paid && rb.visualFilteringEnabled && rb.nsfwThreshold === 0) break;
  }

  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });

  const result = await page.waitForFunction(() => {
    const v = document.getElementById("v");
    if (!v) return false;
    const wrap = v.parentElement;
    if (!wrap || !wrap.classList.contains("veil-cover-wrap")) return false;
    const cover = wrap.querySelector(".veil-cover.veil-on");
    if (!cover) return false;
    const vr = v.getBoundingClientRect();
    const cr = cover.getBoundingClientRect();
    return {
      muted: v.muted,
      paused: v.paused,
      covers: cr.left <= vr.left + 1 && cr.top <= vr.top + 1 &&
        cr.right >= vr.right - 1 && cr.bottom >= vr.bottom - 1
    };
  }, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);

  console.log("result:", JSON.stringify(result));
  // Overlay must cover and audio must be muted; it must NOT be paused.
  if (result && result.covers && result.muted && !result.paused) {
    console.log("RESULT: PASS — NSFW video overlaid + muted (still playing, not paused)");
    process.exitCode = 0;
  } else {
    console.log("RESULT: FAIL — video not overlaid/muted correctly");
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  srv.close();
}
