// Regression test for "everything goes black": a tall page of many benign
// images must NOT end up stuck hidden. Off-screen images are never hidden;
// near-viewport ones are briefly hidden then revealed (clean) within timeout.
import puppeteer from "puppeteer-core";
import http from "node:http";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe";

function crc32(b){let c=~0;for(let i=0;i<b.length;i++){c^=b[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c;}
function png(w,h){const raw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++){raw[y*(w*4+1)]=0;for(let x=0;x<w;x++){const o=y*(w*4+1)+1+x*4;raw[o]=90;raw[o+1]=140;raw[o+2]=90;raw[o+3]=255;}}const idat=zlib.deflateSync(raw);const ch=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(td)>>>0);return Buffer.concat([l,td,c]);};const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ch("IHDR",ih),ch("IDAT",idat),ch("IEND",Buffer.alloc(0))]);}
const P = png(250, 250);
const N = 15;

const isrv = http.createServer((q, r) => { r.setHeader("content-type", "image/png"); r.end(P); });
await new Promise((r) => isrv.listen(0, "127.0.0.1", r));
const ip = isrv.address().port;
const psrv = http.createServer((q, r) => {
  let imgs = "";
  for (let i = 0; i < N; i++) imgs += `<img class=t src="http://127.0.0.1:${ip}/x.png?i=${i}" width=250 height=250><br>`;
  r.setHeader("content-type", "text/html");
  r.end(`<!doctype html><meta charset=utf8><body style="background:#000">${imgs}</body>`);
});
await new Promise((r) => psrv.listen(0, "localhost", r));
const pp = psrv.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", `--disable-extensions-except=${repo}`, `--load-extension=${repo}`]
});
try {
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 });
  const worker = await sw.worker();
  // Default threshold (0.6): benign images classify clean and should reveal.
  for (let i = 0; i < 25; i++) {
    await worker.evaluate(() => new Promise((res) => chrome.storage.sync.set({ paid: true, visualFilteringEnabled: true, urlFilteringEnabled: true }, () => res(1))));
    await new Promise((r) => setTimeout(r, 250));
    const rb = await worker.evaluate(() => new Promise((res) => chrome.storage.sync.get(null, res)));
    if (rb.paid && rb.visualFilteringEnabled) break;
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  await page.goto(`http://localhost:${pp}/`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 8000));

  const stats = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll("img.t")];
    let hidden = 0, pending = 0;
    for (const im of imgs) {
      if (getComputedStyle(im).visibility === "hidden") hidden++;
      if (im.classList.contains("veil-pending")) pending++;
    }
    return { total: imgs.length, hidden, pending };
  });
  console.log("stats:", JSON.stringify(stats));
  if (stats.hidden === 0) {
    console.log("RESULT: PASS — no image left hidden/black");
    process.exitCode = 0;
  } else {
    console.log("RESULT: FAIL —", stats.hidden, "of", stats.total, "images stuck hidden");
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  isrv.close();
  psrv.close();
}
