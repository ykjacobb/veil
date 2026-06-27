// Verifies CSS background-image thumbnails are scanned and covered.
import puppeteer from "puppeteer-core";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe";

function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c; }
function solidPng(w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = 120; raw[o + 1] = 90; raw[o + 2] = 160; raw[o + 3] = 255; } }
  const idat = zlib.deflateSync(raw);
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = solidPng(200, 200);

const imgServer = http.createServer((req, res) => { res.setHeader("content-type", "image/png"); res.end(PNG); });
let imgPort;
const pageServer = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><meta charset=utf8><body>
    <div id=t style="width:200px;height:200px;background-image:url('http://127.0.0.1:${imgPort}/x.png')"></div></body>`);
});
await new Promise((r) => imgServer.listen(0, "127.0.0.1", r));
imgPort = imgServer.address().port;
await new Promise((r) => pageServer.listen(0, "localhost", r));
const pagePort = pageServer.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", `--disable-extensions-except=${repo}`, `--load-extension=${repo}`]
});
try {
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 });
  const worker = await sw.worker();
  // Wait for onInstalled's default write to land first, then override, so its
  // delayed write can't clobber our seed; confirm it stays put after a delay.
  for (let i = 0; i < 25; i++) {
    await worker.evaluate(() => new Promise((res) => chrome.storage.sync.set({ paid: true, visualFilteringEnabled: true, urlFilteringEnabled: true, nsfwThreshold: 0 }, () => res(1))));
    await new Promise((r) => setTimeout(r, 300));
    const rb = await worker.evaluate(() => new Promise((res) => chrome.storage.sync.get(null, res)));
    if (rb.paid && rb.visualFilteringEnabled && rb.nsfwThreshold === 0) break;
  }
  const page = await browser.newPage();
  await page.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });
  const res = await page.waitForFunction(() => {
    const el = document.getElementById("t");
    if (!el) return false;
    const wrap = el.parentElement;
    if (!wrap || !wrap.classList.contains("veil-cover-wrap")) return false;
    const cover = wrap.querySelector(".veil-cover");
    if (!cover) return false;
    const er = el.getBoundingClientRect(), cr = cover.getBoundingClientRect();
    return cr.left <= er.left + 1 && cr.top <= er.top + 1 && cr.right >= er.right - 1 && cr.bottom >= er.bottom - 1;
  }, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
  console.log(res ? "RESULT: PASS — background-image thumbnail covered" : "RESULT: FAIL — background thumbnail not covered");
  process.exitCode = res ? 0 : 1;
} finally {
  await browser.close();
  imgServer.close();
  pageServer.close();
}
