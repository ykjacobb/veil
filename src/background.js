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
  pornThreshold: 0.85,
  hentaiThreshold: 0.85,
  sexyThreshold: 0.7
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

// Content script asks whether the visual layer is unlocked + thresholds.
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === "veil:getConfig") {
    getSettings().then(function (s) {
      sendResponse({
        visualFilteringEnabled: s.visualFilteringEnabled && s.paid,
        pornThreshold: s.pornThreshold,
        hentaiThreshold: s.hentaiThreshold,
        sexyThreshold: s.sexyThreshold
      });
    });
    return true; // async
  }

  // Inject the NSFW bundle into the requesting frame. executeScript bypasses
  // the page CSP (which blocks content-script dynamic import) and runs in the
  // same isolated world, so the content script then sees globalThis.__VEIL_NSFW.
  if (msg && msg.type === "veil:ensureModel") {
    if (!sender.tab) {
      sendResponse({ ok: false, error: "no tab" });
      return false;
    }
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
        files: ["vendor/nsfw-bundle.js"],
        world: "ISOLATED"
      })
      .then(function () {
        sendResponse({ ok: true });
      })
      .catch(function (e) {
        sendResponse({ ok: false, error: String(e) });
      });
    return true; // async
  }

  // Cross-origin image fetch for the classifier. SW fetches bypass page CORS
  // via host_permissions, so the bytes are readable and yield an untainted
  // bitmap the content script can classify.
  if (msg && msg.type === "veil:fetchImage" && msg.url) {
    (async function () {
      try {
        var resp = await fetch(msg.url);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        var blob = await resp.blob();
        var buf = await blob.arrayBuffer();
        var bytes = new Uint8Array(buf);
        var bin = "";
        var CHUNK = 0x8000;
        for (var i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        sendResponse({ ok: true, contentType: blob.type, data: btoa(bin) });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // async
  }
});
