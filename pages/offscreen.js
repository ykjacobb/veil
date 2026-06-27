/* Offscreen document message handler: runs the ViT classifier (inference.js). */

function base64ToBytes(b64) {
  var bin = atob(b64);
  var arr = new Uint8ClampedArray(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== "veil:offscreen") return;
  (async function () {
    try {
      var r;
      if (msg.op === "url") {
        r = await self.veilClassifyUrl(msg.url);
      } else if (msg.op === "pixels") {
        r = await self.veilClassifyPixels(base64ToBytes(msg.data));
      } else if (msg.op === "warm") {
        await self.veilWarmModel();
        r = { nsfw: 0 };
      } else {
        throw new Error("unknown op: " + msg.op);
      }
      sendResponse({ ok: true, nsfw: r.nsfw });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.stack) || e) });
    }
  })();
  return true; // async response
});
