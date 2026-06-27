// End-to-end: load the unpacked extension in Chrome, enable the visual tier,
// and load a page with a CROSS-ORIGIN image to exercise the full pipeline
// (content script -> getConfig -> model load -> SW cross-origin fetch -> classify
// -> CSS class applied).
import puppeteer from "puppeteer-core";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Stable Google Chrome blocks --load-extension; use Chrome for Testing.
const CHROME =
  process.env.CHROME_BIN ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

// Tiny solid-color PNG (benign -> should classify Neutral -> veil-clean).
function solidPng(w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter byte
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = 90; raw[o + 1] = 110; raw[o + 2] = 200; raw[o + 3] = 255;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))
  ]);
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c;
}

const PNG = solidPng(300, 300);

// Image server (origin B).
const imgServer = http.createServer((req, res) => {
  res.setHeader("content-type", "image/png");
  res.end(PNG);
});
// Page server (origin A) — references the image cross-origin.
let imgPort;
const pageServer = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><meta charset=utf8><body>
    <img id=t src="http://127.0.0.1:${imgPort}/x.png" width=300 height=300></body>`);
});

await new Promise((r) => imgServer.listen(0, "127.0.0.1", r));
imgPort = imgServer.address().port;
await new Promise((r) => pageServer.listen(0, "localhost", r));
const pagePort = pageServer.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    `--disable-extensions-except=${repo}`,
    `--load-extension=${repo}`
  ]
});

function fail(msg) { console.log("RESULT: FAIL —", msg); }

try {
  // Find the extension service worker.
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker", { timeout: 15000 }
  ).catch(() => null);
  if (!swTarget) { fail("extension service worker never started"); process.exit(1); }

  const worker = await swTarget.worker();
  // onInstalled writes defaults asynchronously; seeding before it settles gets
  // clobbered. Wait for the default write, then set our overrides and confirm.
  let readBack;
  for (let attempt = 0; attempt < 25; attempt++) {
    await worker.evaluate(() => new Promise((res) => {
      chrome.storage.sync.set(
        {
          paid: true,
          visualFilteringEnabled: true,
          urlFilteringEnabled: true,
          // Force the cover path on the benign test image so we can verify the
          // overlay geometry (real NSFW images hit this threshold naturally).
          nsfwThreshold: 0
        },
        () => res(true)
      );
    }));
    // Wait, then read — so onInstalled's delayed default write can't clobber us
    // unseen. Re-seed until it stays put.
    await new Promise((r) => setTimeout(r, 300));
    readBack = await worker.evaluate(() => new Promise((res) => {
      chrome.storage.sync.get(null, (v) => res(v));
    }));
    if (readBack.paid === true && readBack.visualFilteringEnabled === true && readBack.nsfwThreshold === 0) break;
  }
  console.log("storage after seed:", JSON.stringify(readBack));

  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push("PAGEERR " + e));

  await page.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });

  const cfg = await worker.evaluate(() => getSettings().then((s) => ({
    visualFilteringEnabled: s.visualFilteringEnabled && s.paid,
    paid: s.paid
  }))).catch((e) => ({ error: String(e) }));
  console.log("computed config (SW):", JSON.stringify(cfg));

  // Wait for VEIL to cover the image, then measure whether the overlay fully
  // covers it.
  const result = await page.waitForFunction(() => {
    const img = document.getElementById("t");
    if (!img) return false;
    const wrap = img.parentElement;
    if (!wrap || !wrap.classList.contains("veil-cover-wrap")) return false;
    const cover = wrap.querySelector(".veil-cover");
    if (!cover) return false;
    const ir = img.getBoundingClientRect();
    const cr = cover.getBoundingClientRect();
    const op = getComputedStyle(cover);
    return {
      covers:
        cr.left <= ir.left + 1 && cr.top <= ir.top + 1 &&
        cr.right >= ir.right - 1 && cr.bottom >= ir.bottom - 1,
      opaque: op.backgroundColor,
      label: cover.textContent,
      imgArea: Math.round(ir.width * ir.height),
      coverArea: Math.round(cr.width * cr.height)
    };
  }, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);

  const sawActive = await page.evaluate(() =>
    document.documentElement.classList.contains("veil-active"));

  console.log("veil-active on <html>:", sawActive);
  console.log("cover result:", JSON.stringify(result));
  if (logs.length) console.log("page logs:", logs.slice(0, 8));

  if (result && result.covers && result.opaque !== "rgba(0, 0, 0, 0)") {
    console.log("RESULT: PASS — flagged image fully covered by opaque VEIL overlay");
    process.exitCode = 0;
  } else {
    fail("overlay did not fully/opaquely cover the image");
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  imgServer.close();
  pageServer.close();
}
