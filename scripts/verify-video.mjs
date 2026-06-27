// Verifies the fail-closed video policy: a CROSS-ORIGIN video (whose frames
// can't be read due to canvas taint) must end up fully covered.
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

// Image/video origin (B).
const mediaServer = http.createServer((req, res) => {
  res.setHeader("content-type", "video/mp4");
  res.setHeader("accept-ranges", "bytes");
  res.end(VIDEO);
});
let mediaPort;
// Page origin (A) — references the video cross-origin (no crossorigin attr).
const pageServer = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><meta charset=utf8><body>
    <video id=v src="http://127.0.0.1:${mediaPort}/v.mp4"
           width=200 height=200 autoplay muted loop playsinline></video></body>`);
});

await new Promise((r) => mediaServer.listen(0, "127.0.0.1", r));
mediaPort = mediaServer.address().port;
await new Promise((r) => pageServer.listen(0, "localhost", r));
const pagePort = pageServer.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required",
    `--disable-extensions-except=${repo}`, `--load-extension=${repo}`]
});

try {
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 });
  const worker = await sw.worker();
  for (let i = 0; i < 20; i++) {
    await worker.evaluate(() => new Promise((res) =>
      chrome.storage.sync.set({ paid: true, visualFilteringEnabled: true, urlFilteringEnabled: true }, () => res(1))));
    const rb = await worker.evaluate(() => new Promise((res) => chrome.storage.sync.get(null, res)));
    if (rb.paid && rb.visualFilteringEnabled) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });

  const covered = await page.waitForFunction(() => {
    const v = document.getElementById("v");
    if (!v) return false;
    const wrap = v.parentElement;
    if (!wrap || !wrap.classList.contains("veil-cover-wrap")) return false;
    const cover = wrap.querySelector(".veil-cover");
    if (!cover) return false;
    const vr = v.getBoundingClientRect();
    const cr = cover.getBoundingClientRect();
    return {
      paused: v.paused,
      label: cover.textContent,
      covers: cr.left <= vr.left + 1 && cr.top <= vr.top + 1 &&
        cr.right >= vr.right - 1 && cr.bottom >= vr.bottom - 1
    };
  }, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);

  console.log("cover result:", JSON.stringify(covered));
  if (logs.length) console.log("logs:", logs.slice(0, 6));

  if (covered && covered.covers && covered.paused) {
    console.log("RESULT: PASS — cross-origin video failed closed: fully covered & paused");
    process.exitCode = 0;
  } else {
    console.log("RESULT: FAIL — cross-origin video was not covered");
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  mediaServer.close();
  pageServer.close();
}
