// Bundles tfjs + nsfwjs (mobilenet_v2, weights inlined) into a single IIFE that
// exposes globalThis.__VEIL_NSFW = { loadModel, tf }.
//
// It is injected on demand via chrome.scripting.executeScript (NOT a dynamic
// import), because content-script dynamic import() is subject to the page's CSP
// and fails on most real sites. executeScript injections bypass page CSP and
// run in the same isolated world as the content script, so the global is shared.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "..");

await build({
  entryPoints: [path.join(root, "vendor-entry.mjs")],
  bundle: true,
  format: "iife",
  globalName: "__VEIL_NSFW",
  // Guarantee the bundle is reachable from other scripts in the isolated world.
  footer: { js: "globalThis.__VEIL_NSFW = __VEIL_NSFW;" },
  platform: "browser",
  target: ["chrome120"],
  minify: true,
  legalComments: "none",
  outfile: path.join(repo, "vendor", "nsfw-bundle.js")
});

console.log("Built vendor/nsfw-bundle.js (IIFE -> globalThis.__VEIL_NSFW)");
