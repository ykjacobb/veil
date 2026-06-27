/*
 * VEIL service worker.
 *  - Generates dynamic declarativeNetRequest rules from the keyword list.
 *  - Catches SPA / query-param navigations via webNavigation that DNR misses.
 *  - Owns the free/paid feature gate stored in chrome.storage.
 */

importScripts("keywords.js");

var BLOCKED_PAGE = chrome.runtime.getURL("pages/blocked.html");

// Dynamic-rule id space (static domain rules live in rules/domains.json).
var KEYWORD_RULE_ID_BASE = 100000;

var DEFAULT_SETTINGS = {
  urlFilteringEnabled: true, // free tier
  visualFilteringEnabled: false, // paid tier
  paid: false,
  // ViT model outputs a single P(nsfw); block at/above this. Lower = stricter.
  nsfwThreshold: 0.6
};

async function getSettings() {
  var stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return Object.assign({}, DEFAULT_SETTINGS, stored);
}

/** Translate the keyword regex into DNR dynamic rules that redirect to the blocked page. */
async function syncKeywordRules() {
  var settings = await getSettings();

  // Remove any existing VEIL dynamic rules first.
  var existing = await chrome.declarativeNetRequest.getDynamicRules();
  var removeIds = existing
    .filter(function (r) {
      return r.id >= KEYWORD_RULE_ID_BASE;
    })
    .map(function (r) {
      return r.id;
    });

  var addRules = [];
  if (settings.urlFilteringEnabled) {
    // RE2 (used by DNR) does not support lookbehind, so we approximate the
    // letter boundary with explicit non-letter / edge classes.
    VEIL_KEYWORDS.forEach(function (kw, i) {
      var stem = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var regex = "(^|[^a-z])(" + stem + ")([^a-z]|$)";
      addRules.push({
        id: KEYWORD_RULE_ID_BASE + i,
        priority: 1,
        action: {
          type: "redirect",
          // NB: never embed the matched keyword/URL in the redirect target —
          // DNR re-evaluates redirects, so a target containing "porn" would
          // match this very rule and loop. Pass only a generic reason.
          redirect: { url: BLOCKED_PAGE + "?reason=keyword" }
        },
        condition: {
          regexFilter: regex,
          isUrlFilterCaseSensitive: false,
          resourceTypes: ["main_frame", "sub_frame"]
        }
      });
    });
  }

  // Remove existing VEIL rules AND every id we're about to add, so a leftover
  // rule from a previous (possibly interrupted) run can never collide.
  var addIds = addRules.map(function (r) {
    return r.id;
  });
  var removeRuleIds = Array.from(new Set(removeIds.concat(addIds)));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeRuleIds,
    addRules: addRules
  });
}

// Toggle the static domain ruleset with the free-tier switch.
async function syncStaticRulesetState() {
  var settings = await getSettings();
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      settings.urlFilteringEnabled
        ? { enableRulesetIds: ["veil_domains"] }
        : { disableRulesetIds: ["veil_domains"] }
    );
  } catch (e) {
    // Ruleset may already be in the requested state; ignore.
  }
}

// Serialize all rule updates. onInstalled writes storage (which fires
// storage.onChanged -> reconcile) and also calls reconcile directly; without a
// queue those overlap and DNR rejects the duplicate rule ids.
var reconcileChain = Promise.resolve();
function reconcile() {
  reconcileChain = reconcileChain
    .catch(function () {})
    .then(function () {
      return Promise.all([syncKeywordRules(), syncStaticRulesetState()]);
    })
    .catch(function (e) {
      console.warn("[VEIL] reconcile failed:", e);
    });
  return reconcileChain;
}

chrome.runtime.onInstalled.addListener(function () {
  getSettings().then(function (s) {
    chrome.storage.sync.set(s).then(reconcile);
  });
});
chrome.runtime.onStartup.addListener(reconcile);

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "sync" && (changes.urlFilteringEnabled || changes.paid)) {
    reconcile();
  }
});

/*
 * SPA fallback: X/Reddit etc. update the URL via the History API without
 * firing a blockable network request, so DNR never sees "?q=porn". Catch those
 * here and redirect the tab to the blocked page.
 */
function checkNavigation(details) {
  if (details.frameId !== 0) return; // top frame only
  getSettings().then(function (settings) {
    if (!settings.urlFilteringEnabled) return;
    var url = details.url || "";
    var host;
    try {
      host = new URL(url).hostname;
    } catch (e) {
      return;
    }
    if (veilHostIsBlacklisted(host) || veilUrlHasKeyword(url)) {
      chrome.tabs.update(details.tabId, {
        url: BLOCKED_PAGE + "?reason=spa"
      });
    }
  });
}

chrome.webNavigation.onHistoryStateUpdated.addListener(checkNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(checkNavigation);

// --- Offscreen classifier (onnxruntime-web can't run in a SW: no dynamic
// import). We keep one offscreen document alive and relay classify requests. ---
var creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "pages/offscreen.html",
        reasons: ["WORKERS"],
        justification: "Runs the on-device NSFW image classifier (WebAssembly)."
      })
      .catch(function (e) {
        // A concurrent caller may have created it first; ignore that race.
        if (!/single offscreen|already/i.test(String(e))) throw e;
      })
      .finally(function () {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

// chrome.offscreen.createDocument resolves when the document exists, but its
// scripts (and onMessage listener) may not have run yet — so the first send can
// fail with "Receiving end does not exist". Retry briefly until it's listening.
async function sendToOffscreen(message) {
  for (var i = 0; i < 20; i++) {
    try {
      var r = await chrome.runtime.sendMessage(message);
      if (r !== undefined) return r;
    } catch (e) {
      if (!/Receiving end does not exist|Could not establish connection/i.test(String(e))) {
        throw e;
      }
    }
    await new Promise(function (res) {
      setTimeout(res, 150);
    });
  }
  throw new Error("offscreen document not responding");
}

async function classifyViaOffscreen(op, payload) {
  await ensureOffscreen();
  return sendToOffscreen(Object.assign({ type: "veil:offscreen", op: op }, payload));
}

// Content script asks whether the visual layer is unlocked + thresholds.
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === "veil:getConfig") {
    getSettings().then(function (s) {
      sendResponse({
        visualFilteringEnabled: s.visualFilteringEnabled && s.paid,
        nsfwThreshold: s.nsfwThreshold
      });
    });
    return true; // async
  }

  // Warm up the offscreen document + model load proactively.
  if (msg && msg.type === "veil:warm") {
    classifyViaOffscreen("warm", {}).then(
      function (r) {
        sendResponse(r || { ok: false });
      },
      function (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    );
    return true; // async
  }

  // Classify an image URL: the offscreen document fetches it (CORS-bypassed by
  // host_permissions), decodes, and runs the ViT model. Returns { ok, nsfw }.
  if (msg && msg.type === "veil:classifyUrl" && msg.url) {
    classifyViaOffscreen("url", { url: msg.url }).then(
      function (r) {
        sendResponse(r || { ok: false, error: "no response" });
      },
      function (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    );
    return true; // async
  }

  // Classify raw 384x384 RGBA pixels (a video frame the content script read).
  if (msg && msg.type === "veil:classifyPixels" && msg.data) {
    classifyViaOffscreen("pixels", { data: msg.data }).then(
      function (r) {
        sendResponse(r || { ok: false, error: "no response" });
      },
      function (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    );
    return true; // async
  }
});
