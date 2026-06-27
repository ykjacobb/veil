/*
 * VEIL content script (classic script, isolated world).
 *  - Belt-and-braces URL check on document_start (covers in-page SPA changes).
 *  - When the visual layer is unlocked, finds images / videos / background
 *    thumbnails and sends them to the service worker, which relays to the
 *    offscreen document running the ViT NSFW model. Applies the block cover.
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
  // Classification runs in the offscreen document (onnxruntime-web + ViT model);
  // the content script just sends image URLs / video-frame pixels and applies
  // the verdict. Scores are { nsfw } in [0,1].
  var config = null;
  var MIN_DIMENSION = 36;
  var INPUT_SIZE = 384;
  var videoTimers = new WeakMap();
  var SEEN = new WeakSet();

  function tooSmall(w, h) {
    return (w || 0) < MIN_DIMENSION || (h || 0) < MIN_DIMENSION;
  }

  // Classify an image by URL (offscreen doc fetches it, CORS-bypassed).
  async function classifyUrl(url) {
    var r = await sendMessage({ type: "veil:classifyUrl", url: url });
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : "classify failed");
    return { nsfw: r.nsfw };
  }

  async function classifyImage(img) {
    if (!img.complete || !img.naturalWidth) {
      await new Promise(function (resolve) {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      });
    }
    if (tooSmall(img.naturalWidth, img.naturalHeight)) return { nsfw: 0 };
    var src = img.currentSrc || img.src;
    if (!src) return { nsfw: 0 };
    return classifyUrl(src);
  }

  function rgbaToBase64(bytes) {
    var bin = "";
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  // Draw the current video frame to 384x384 and send its pixels for scoring.
  // getImageData throws on cross-origin taint — the caller then fails closed.
  async function classifyVideoFrameDirect(video) {
    var canvas = document.createElement("canvas");
    canvas.width = INPUT_SIZE;
    canvas.height = INPUT_SIZE;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, INPUT_SIZE, INPUT_SIZE);
    var imageData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE); // may throw (taint)
    var r = await sendMessage({
      type: "veil:classifyPixels",
      data: rgbaToBase64(new Uint8Array(imageData.data.buffer))
    });
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : "classify failed");
    return { nsfw: r.nsfw };
  }

  function isNsfw(scores) {
    return (scores.nsfw || 0) >= config.nsfwThreshold;
  }

  // Lightweight diagnostic so you can see detection working in the page console.
  function logScore(kind, scores) {
    var n = scores && typeof scores.nsfw === "number" ? scores.nsfw : -1;
    console.log(
      "[VEIL] " + kind + " nsfw=" + n.toFixed(3) +
      " threshold=" + config.nsfwThreshold +
      (n >= config.nsfwThreshold ? " → BLOCKED" : "")
    );
  }

  // Wrap an element once so we can lay a cover over it (sized via inset:0). The
  // cover starts hidden; setBlocked toggles it.
  function ensureCover(el) {
    if (el.__veilCover) return el.__veilCover;
    var parent = el.parentNode;
    if (!parent) return null;
    var wrap = document.createElement("span");
    wrap.className = "veil-cover-wrap";
    parent.insertBefore(wrap, el);
    wrap.appendChild(el);

    var cover = document.createElement("div");
    cover.className = "veil-cover";
    var titleEl = document.createElement("div");
    titleEl.className = "veil-cover-title";
    titleEl.textContent = "Blocked by VEIL";
    var subEl = document.createElement("div");
    subEl.className = "veil-cover-sub";
    subEl.textContent = "Adult content";
    cover.appendChild(titleEl);
    cover.appendChild(subEl);
    wrap.appendChild(cover);
    el.__veilCover = cover;
    return cover;
  }

  // Reactive overlay: show the cover (and mute video audio) while NSFW; hide it
  // (and unmute) once the content is no longer NSFW. Videos are NOT paused, so
  // they keep playing and the overlay clears when the scene passes.
  function setBlocked(el, blocked) {
    if (blocked) {
      var cover = ensureCover(el);
      if (cover) cover.classList.add("veil-on");
      if (el.tagName === "VIDEO" && !el.muted) {
        el.__veilMutedByUs = true;
        el.muted = true;
      }
    } else {
      if (el.__veilCover) el.__veilCover.classList.remove("veil-on");
      if (el.tagName === "VIDEO" && el.__veilMutedByUs) {
        el.__veilMutedByUs = false;
        el.muted = false;
      }
    }
  }

  // Only classify elements near the viewport (keeps the single classifier from
  // being flooded by an entire long page at once).
  var io = null;
  function whenNearViewport(el, fn) {
    if (!("IntersectionObserver" in window)) {
      fn();
      return;
    }
    if (!io) {
      io = new IntersectionObserver(
        function (entries) {
          for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.isIntersecting && e.target.__veilRun) {
              var run = e.target.__veilRun;
              e.target.__veilRun = null;
              io.unobserve(e.target);
              run();
            }
          }
        },
        { rootMargin: "400px" }
      );
    }
    el.__veilRun = fn;
    io.observe(el);
  }

  // Images are static: classify once it's near the viewport, then block/unblock.
  function scanImage(img) {
    if (SEEN.has(img)) return;
    SEEN.add(img);
    whenNearViewport(img, function () {
      classifyImage(img).then(
        function (s) {
          logScore("image", s);
          setBlocked(img, isNsfw(s));
        },
        function (e) {
          console.log("[VEIL] image classify failed:", String(e));
        }
      );
    });
  }

  // Videos: re-check the current frame every second and toggle the overlay, so
  // it covers NSFW scenes and clears once the video plays past them. Cross-origin
  // frames can't be read (canvas taint); those are left as-is (we can't see them).
  function watchVideo(video) {
    if (SEEN.has(video)) return;
    SEEN.add(video);
    whenNearViewport(video, function () {
      startWatchingVideo(video);
    });
  }

  function startWatchingVideo(video) {
    if (video.poster) {
      classifyUrl(video.poster).then(function (s) {
        if (isNsfw(s)) setBlocked(video, true);
      }, function () {});
    }
    var tick = function () {
      if (tooSmall(video.videoWidth, video.videoHeight)) return; // not ready yet
      classifyVideoFrameDirect(video).then(
        function (s) {
          logScore("video", s);
          setBlocked(video, isNsfw(s));
        },
        function () {
          /* frame unreadable (cross-origin/DRM) — leave current state */
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
    if (SEEN.has(el)) return;
    var url = bgImageUrl(el);
    if (!url) return;
    var rect = el.getBoundingClientRect();
    if (tooSmall(rect.width, rect.height)) return;
    // Skip near-fullscreen backgrounds (page/hero art, not thumbnails).
    if (rect.width >= innerWidth * 0.9 && rect.height >= innerHeight * 0.9) return;
    SEEN.add(el);
    whenNearViewport(el, function () {
      classifyUrl(url).then(
        function (s) {
          logScore("background", s);
          setBlocked(el, isNsfw(s));
        },
        function () {}
      );
    });
  }

  function scanBackgrounds(root) {
    if (root.nodeType === 1) scanBackgroundEl(root);
    if (!root.querySelectorAll) return;
    var els = root.querySelectorAll("*");
    var limit = Math.min(els.length, 4000);
    for (var i = 0; i < limit; i++) scanBackgroundEl(els[i]);
  }

  function scanRoot(root) {
    if (!config || !config.visualFilteringEnabled) return;
    if (root.querySelectorAll) {
      root.querySelectorAll("img").forEach(scanImage);
      root.querySelectorAll("video").forEach(watchVideo);
    }
    scanBackgrounds(root);
  }

  // Re-evaluate an element whose relevant attribute changed (lazy-loading,
  // carousels, src swaps) — re-classify and toggle the overlay accordingly.
  function onAttrChange(target, attr) {
    if (!target || target.nodeType !== 1) return;
    if (target.tagName === "IMG" && (attr === "src" || attr === "srcset")) {
      SEEN.delete(target);
      scanImage(target);
    } else if (target.tagName === "VIDEO" && attr === "poster") {
      if (target.poster) {
        classifyUrl(target.poster).then(function (s) {
          setBlocked(target, isNsfw(s));
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

  function initVisualLayer() {
    document.documentElement.classList.add("veil-active");
    // Kick off offscreen-doc + model load early so the first verdict is faster.
    sendMessage({ type: "veil:warm" });

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

  // React to settings changes (e.g. the sensitivity slider) without a reload.
  // New threshold applies to subsequent classifications; turning the layer on
  // starts scanning immediately.
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "sync") return;
    sendMessage({ type: "veil:getConfig" }).then(function (cfg) {
      if (!cfg) return;
      var wasOn = config && config.visualFilteringEnabled;
      config = cfg;
      if (config.visualFilteringEnabled && !wasOn) initVisualLayer();
    });
  });
})();
