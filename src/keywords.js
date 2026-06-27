/*
 * VEIL shared keyword + domain data.
 * Loaded in BOTH the service worker (via importScripts) and content scripts
 * (as the first file in the content_scripts list), so everything here must be
 * plain globals with no module syntax.
 */

// Adult keyword stems. These are matched with word-ish boundaries (see
// veilKeywordRegex) so "sex" does NOT trip on "sussex"/"essex" and "cam"
// does NOT trip on "camera"/"cambridge".
var VEIL_KEYWORDS = [
  "porn",
  "xxx",
  "nude",
  "naked",
  "nsfw",
  "masturbat",
  "escort",
  "onlyfans",
  "hentai",
  "gonewild",
  "fetish",
  "erotic",
  "camgirl",
  "camwhore",
  "stripper",
  // "sex" is handled as its own boundary-tight rule below to avoid sussex/essex.
  "sex"
];

// Hardcoded domain blacklist. The full "500+" list is expected to live in
// rules/domains.json (static DNR ruleset); this in-code copy is the fast-path
// fallback the content script uses for in-page (SPA) navigations that DNR
// never sees as a network request.
var VEIL_DOMAINS = [
  "pornhub.com",
  "xvideos.com",
  "xhamster.com",
  "redtube.com",
  "youporn.com",
  "onlyfans.com",
  "chaturbate.com",
  "livejasmin.com",
  "brazzers.com",
  "bangbros.com"
];

// Platforms we deliberately do NOT fully block — we scan their URLs/queries
// instead and hand clean pages to the visual layer.
var VEIL_MIXED_PLATFORMS = [
  "x.com",
  "twitter.com",
  "reddit.com",
  "tumblr.com"
];

/**
 * Build a single case-insensitive regex from the keyword stems.
 * We require a non-letter (or string edge) on each side of the stem so we get
 * "?q=sex" / "/r/nsfw" / "porn-hub" but not "sussex" or "camera".
 */
function veilKeywordRegex() {
  var alternation = VEIL_KEYWORDS
    .map(function (k) {
      return k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("|");
  // (?<![a-z]) / (?![a-z]) = letter-boundary without consuming chars.
  return new RegExp("(?<![a-z])(" + alternation + ")(?![a-z])", "i");
}

/** True if the given full URL string should be blocked on keyword grounds. */
function veilUrlHasKeyword(urlString) {
  try {
    return veilKeywordRegex().test(urlString);
  } catch (e) {
    return false;
  }
}

/** True if a hostname is (or is a subdomain of) a blacklisted domain. */
function veilHostIsBlacklisted(hostname) {
  hostname = (hostname || "").toLowerCase().replace(/^www\./, "");
  return VEIL_DOMAINS.some(function (d) {
    return hostname === d || hostname.endsWith("." + d);
  });
}

// Make the helpers reachable from the service worker too.
if (typeof self !== "undefined") {
  self.VEIL_KEYWORDS = VEIL_KEYWORDS;
  self.VEIL_DOMAINS = VEIL_DOMAINS;
  self.VEIL_MIXED_PLATFORMS = VEIL_MIXED_PLATFORMS;
  self.veilKeywordRegex = veilKeywordRegex;
  self.veilUrlHasKeyword = veilUrlHasKeyword;
  self.veilHostIsBlacklisted = veilHostIsBlacklisted;
}
