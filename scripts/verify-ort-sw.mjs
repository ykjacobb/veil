// Smoke test: can the service worker run ViT inference via onnxruntime-web?
// Serves two solid images and classifies them in the SW context.
import puppeteer from "puppeteer-core";
import http from "node:http";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe";

function crc32(b){let c=~0;for(let i=0;i<b.length;i++){c^=b[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c;}
function png(w,h,r,g,bl){const raw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++){raw[y*(w*4+1)]=0;for(let x=0;x<w;x++){const o=y*(w*4+1)+1+x*4;raw[o]=r;raw[o+1]=g;raw[o+2]=bl;raw[o+3]=255;}}const idat=zlib.deflateSync(raw);const ch=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(td)>>>0);return Buffer.concat([l,td,c]);};const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ch("IHDR",ih),ch("IDAT",idat),ch("IEND",Buffer.alloc(0))]);}

const GRAY = png(384, 384, 128, 128, 128);
const srv = http.createServer((req, res) => { res.setHeader("content-type", "image/png"); res.end(GRAY); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", `--disable-extensions-except=${repo}`, `--load-extension=${repo}`]
});
try {
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 });
  const worker = await sw.worker();
  const t0 = Date.now();
  const result = await worker.evaluate(async (url) => {
    try {
      const r = await classifyViaOffscreen("url", { url });
      return r;
    } catch (e) {
      return { ok: false, error: String((e && e.stack) || e) };
    }
  }, `http://127.0.0.1:${port}/gray.png`);
  console.log("result:", JSON.stringify(result), "elapsed(ms):", Date.now() - t0);
  if (result.ok && typeof result.nsfw === "number") {
    console.log("RESULT: PASS — ViT inference runs in the service worker (nsfw=" + result.nsfw.toFixed(4) + ")");
    process.exitCode = 0;
  } else {
    console.log("RESULT: FAIL —", result.error);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  srv.close();
}
