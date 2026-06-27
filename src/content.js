/*
 * VEIL content script (classic script, isolated world).
 *  - Belt-and-braces URL check on document_start (covers in-page SPA changes).
 *  - When the visual layer is unlocked, asks the service worker to inject the
 *    NSFW bundle (globalThis.__VEIL_NSFW) via chrome.scripting.executeScript —
 *    NOT dynamic import(), which the page CSP would block — then runs
 *    hide-then-reveal over <img>/<video>, including DOM mutations.
 *
 * keywords.js has already run in this same isolated world, so VEIL_* globals
 * are available.
 */
(function () {
  "use strict";

  // ---- Layer 1: in-page URL guard -----------------------------------------
  function urlIsBlocked() {
    return veilHostIsBlacklisted(location.hostname) || veilUrlHasKeyword(location.href);
  }

  if (urlIsBlocked()) {
    location.replace(chrome.runtime.getURL("pages/blocked.html") + "?reason=content");
    return;
  }

  // ---- helpers -------------------------------------------------------------
  function sendMessage(msg) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(resp);
      });
    });
  }

  // ---- Layer 2: visual filtering -------------------------------------------
  var config = null;
  var api = null; // globalThis.__VEIL_NSFW
  var model = null;
  var MIN_DIMENSION = 36;
  var videoTimers = new WeakMap();
  var SEEN = new WeakSet();

  function tooSmall(w, h) {
    return (w || 0) < MIN_DIMENSION || (h || 0) < MIN_DIMENSION;
  }

  function scoresToObject(predictions) {
    var out = {};
    predictions.forEach(function (p) {
      out[p.className] = p.probability;
    });
    return out;
  }

  // Cross-origin images taint the canvas, so model.classify throws. Refetch the
  // bytes via the service worker (bypasses page CORS) -> untainted bitmap.
  async function fetchBitmapViaSW(url) {
    var resp = await sendMessage({ type: "veil:fetchImage", url: url });
    if (!resp || !resp.ok) throw new Error("SW image fetch failed");
    var bin = atob(resp.data);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var blob = new Blob([arr], { type: resp.contentType || "image/jpeg" });
    return createImageBitmap(blob);
  }

  async function classifyImage(img) {
    if (!img.complete || !img.naturalWidth) {
      await new Promise(function (resolve) {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      });
    }
    if (tooSmall(img.naturalWidth, img.naturalHeight)) return { Neutral: 1 };
    try {
      return scoresToObject(await model.classify(img));
    } catch (e) {
      var src = img.currentSrc || img.src;
      if (!src) throw e;
      var bitmap = await fetchBitmapViaSW(src);
      try {
        return scoresToObject(await model.classify(bitmap));
      } finally {
        if (bitmap.close) bitmap.close();
      }
    }
  }

  // Draw the current frame and classify it. Throws on cross-origin taint
  // (canvas pixel read blocked) — that's the signal to fail closed.
  async function classifyVideoFrameDirect(video) {
    var canvas = document.createElement("canvas");
    canvas.width = Math.min(video.videoWidth, 224);
    canvas.height = Math.min(video.videoHeight, 224);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return scoresToObject(await model.classify(canvas));
  }

  // Classify a remote image URL (e.g. a video poster) via the SW fetch path.
  async function classifyUrlViaSW(url) {
    var bitmap = await fetchBitmapViaSW(url);
    try {
      return scoresToObject(await model.classify(bitmap));
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  // Silence + freeze a covered video so its audio stops and it can't resume,
  // even if the page tries to autoplay/unmute it again.
  function silenceVideo(el) {
    try {
      el.muted = true;
      el.pause();
      el.removeAttribute("autoplay");
      if (!el.dataset.veilMuted) {
        el.dataset.veilMuted = "1";
        el.addEventListener("play", function () {
          el.muted = true;
          el.pause();
        });
        el.addEventListener("volumechange", function () {
          if (!el.muted) el.muted = true;
        });
      }
    } catch (e) {
      /* ignore */
    }
  }

  // Fully block a flagged element: hide it and lay an opaque white cover over it
  // that says it's blocked. We wrap the element so the cover sizes to it via
  // inset:0; the element itself is hidden underneath as a backstop.
  function coverElement(el, title, sub) {
    el.classList.remove("veil-pending", "veil-clean");
    el.classList.add("veil-blocked-el");
    if (el.tagName === "VIDEO") silenceVideo(el);
    if (el.dataset.veilCovered) return;
    el.dataset.veilCovered = "1";

    try {
      var parent = el.parentNode;
      if (!parent) return; // can't wrap; element stays hidden as backstop
      var wrap = document.createElement("span");
      wrap.className = "veil-cover-wrap";
      parent.insertBefore(wrap, el);
      wrap.appendChild(el);

      var cover = document.createElement("div");
      cover.className = "veil-cover";
      var titleEl = document.createElement("div");
      titleEl.className = "veil-cover-title";
      titleEl.textContent = title;
      var subEl = document.createElement("div");
      subEl.className = "veil-cover-sub";
      subEl.textContent = sub;
      cover.appendChild(titleEl);
      cover.appendChild(subEl);
      wrap.appendChild(cover);
    } catch (e) {
      /* wrapping failed (exotic layout) — element stays hidden as backstop */
    }
  }

  // Map scores -> a block verdict, or null if clean.
  function verdictFor(scores) {
    var porn = scores.Porn || 0;
    var hentai = scores.Hentai || 0;
    var sexy = scores.Sexy || 0;
    if (porn >= config.pornThreshold || hentai >= config.hentaiThreshold) {
      return { title: "Blocked by VEIL", sub: "Explicit content" };
    }
    if (sexy >= config.sexyThreshold) {
      return { title: "Blocked by VEIL", sub: "Sensitive content" };
    }
    return null;
  }

  function applyVerdict(el, scores) {
    var v = verdictFor(scores);
    if (v) {
      coverElement(el, v.title, v.sub);
    } else {
      el.classList.remove("veil-pending");
      el.classList.add("veil-clean");
    }
  }

  // Cover-only: blocks if scores are explicit, but never reveals.
  // Used for video posters, where a clean poster doesn't prove the video is clean.
  function coverIfExplicit(el, scores) {
    var v = verdictFor(scores);
    if (v) {
      coverElement(el, v.title, v.sub);
      return true;
    }
    return false;
  }

  function failOpen(el) {
    el.classList.remove("veil-pending");
    el.classList.add("veil-clean");
  }

  function scanImage(img) {
    if (SEEN.has(img)) return;
    SEEN.add(img);
    img.classList.add("veil-pending");
    classifyImage(img).then(
      function (s) {
        applyVerdict(img, s);
      },
      function () {
        failOpen(img);
      }
    );
  }

  /*
   * Video policy (fail-closed): a video is revealed ONLY when a frame we can
   * actually read classifies as clean. If frames can't be read (cross-origin
   * taint, DRM/streamed) the video stays covered. The poster, if present, is an
   * early cover-only catch. Stays blurred (veil-pending) until first decision.
   */
  function watchVideo(video) {
    if (SEEN.has(video)) return;
    SEEN.add(video);
    // Videos are NOT pre-hidden: an un-classifiable video could otherwise get
    // stuck hidden forever. They're covered the moment a frame is flagged or
    // can't be verified (usually the first readable tick for cross-origin).

    var stop = function () {
      var t = videoTimers.get(video);
      if (t) {
        clearInterval(t);
        videoTimers.delete(video);
      }
    };

    // Early catch: an explicit poster covers before frames even decode.
    if (video.poster) {
      classifyUrlViaSW(video.poster).then(function (s) {
        if (!video.dataset.veilCovered && coverIfExplicit(video, s)) stop();
      }, function () {});
    }

    var tick = function () {
      if (video.dataset.veilCovered) {
        stop();
        return;
      }
      if (tooSmall(video.videoWidth, video.videoHeight)) return; // not ready; retry
      classifyVideoFrameDirect(video).then(
        function (scores) {
          applyVerdict(video, scores); // clean frame reveals; explicit covers
          if (video.dataset.veilCovered) stop();
        },
        function () {
          // Frame unreadable (cross-origin/DRM) -> fail closed.
          coverElement(video, "Blocked by VEIL", "Video couldn't be verified");
          stop();
        }
      );
    };

    tick();
    videoTimers.set(video, setInterval(tick, 1000));
  }

  // Extract a non-data background-image URL from an element, if any.
  function bgImageUrl(el) {
    var bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg.indexOf("url(") === -1) return null;
    var m = bg.match(/url\((?:'|")?([^'")]+)(?:'|")?\)/);
    if (!m) return null;
    var url = m[1];
    if (!url || url.indexOf("data:") === 0) return null;
    return url;
  }

  // Thumbnails are often CSS background-images (not <img>). Classify those too.
  function scanBackgroundEl(el) {
    if (SEEN.has(el) || el.dataset.veilCovered) return;
    var url = bgImageUrl(el);
    if (!url) return;
    var rect = el.getBoundingClientRect();
    if (tooSmall(rect.width, rect.height)) return;
    // Skip near-fullscreen backgrounds (page/hero art, not thumbnails).
    if (rect.width >= innerWidth * 0.9 && rect.height >= innerHeight * 0.9) return;
    SEEN.add(el);
    el.classList.add("veil-pending");
    classifyUrlViaSW(url).then(
      function (s) {
        applyVerdict(el, s); // reveals if clean, covers if explicit
      },
      function () {
        failOpen(el);
      }
    );
  }

  function scanBackgrounds(root) {
    if (root.nodeType === 1) scanBackgroundEl(root);
    if (!root.querySelectorAll) return;
    var els = root.querySelectorAll("*");
    var limit = Math.min(els.length, 4000);
    for (var i = 0; i < limit; i++) scanBackgroundEl(els[i]);
  }

  function scanRoot(root) {
    if (!model) return;
    if (root.querySelectorAll) {
      root.querySelectorAll("img").forEach(scanImage);
      root.querySelectorAll("video").forEach(watchVideo);
    }
    scanBackgrounds(root);
  }

  // Re-evaluate an element whose relevant attribute changed (lazy-loading).
  function onAttrChange(target, attr) {
    if (!target || target.nodeType !== 1) return;
    if (target.tagName === "IMG" && (attr === "src" || attr === "srcset")) {
      if (target.dataset.veilCovered) return; // already covered; keep
      SEEN.delete(target);
      target.classList.remove("veil-clean");
      scanImage(target);
    } else if (target.tagName === "VIDEO" && attr === "poster") {
      if (!target.dataset.veilCovered && target.poster) {
        classifyUrlViaSW(target.poster).then(function (s) {
          coverIfExplicit(target, s);
        }, function () {});
      }
    } else if (attr === "style" || attr === "class") {
      scanBackgroundEl(target); // lazy background-image swap
    }
  }

  function startObserving() {
    new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === "attributes") {
          onAttrChange(m.target, m.attributeName);
          continue;
        }
        var added = m.addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.tagName === "IMG") scanImage(node);
          else if (node.tagName === "VIDEO") watchVideo(node);
          else scanRoot(node);
        }
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "poster", "style", "class"]
    });
  }

  async function initVisualLayer() {
    document.documentElement.classList.add("veil-active");
    try {
      if (!globalThis.__VEIL_NSFW) {
        var resp = await sendMessage({ type: "veil:ensureModel" });
        if (!resp || !resp.ok || !globalThis.__VEIL_NSFW) {
          throw new Error(resp && resp.error ? resp.error : "model injection failed");
        }
      }
      api = globalThis.__VEIL_NSFW;
      model = await api.loadModel();
    } catch (e) {
      console.warn("[VEIL] visual layer unavailable:", e);
      document.documentElement.classList.remove("veil-active");
      document.querySelectorAll(".veil-pending").forEach(failOpen);
      return;
    }

    var run = function () {
      scanRoot(document);
      startObserving();
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run);
    } else {
      run();
    }
  }

  sendMessage({ type: "veil:getConfig" }).then(function (cfg) {
    if (!cfg) return;
    config = cfg;
    if (config.visualFilteringEnabled) initVisualLayer();
  });
})();
