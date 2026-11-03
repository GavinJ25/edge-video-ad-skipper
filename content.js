// MSN Video Ad Blocker v2.1 - content script (learning + diagnostics)
//
// 1. Detects video ads (known/learned selectors, an "Ad"/"Advertisement" label or
//    promo text overlapping the video) and mutes, speeds up and skips them.
//    Looks inside open shadow DOM too.
// 2. When it sees an ad it did not already know, it logs the cues and learns
//    selectors and ad domains for next time.
// 3. Diagnostics: logs every video it finds, logs source/duration changes of
//    those videos (so ad breaks show up as a timeline), and can capture a full
//    snapshot of the player on demand (popup button or Alt+Shift+A).

(() => {
  "use strict";
  if (window.__msnAdBlockLoaded) return;
  window.__msnAdBlockLoaded = true;

  const LOG = (...a) => console.debug("[MSN-AdBlock]", ...a);
  const FRAME_ID = Math.random().toString(36).slice(2, 8);
  const FRAME_NAME = () => (window === window.top ? "top" : "iframe:" + location.hostname);
  const DEFAULTS = { enabled: true, learn: true, autoBlock: true };

  const TICK_MIN_MS = 250;
  const END_GRACE_MS = 1500;
  const LOOKBACK_MS = 8000;
  const FLUSH_MS = 3000;
  const MAX_AD_MS = 60000;
  const MAX_SKIPPABLE_DURATION_S = 180;
  const CONTAINER_LEVELS = 4;
  const SHADOW_RESCAN_MS = 2000;
  const MAX_VIDEOS_REPORTED = 5;
  const MAX_MEDIA_EVENTS = 60;
  const MEDIA_EVENTS = ["loadstart", "durationchange", "emptied", "pause", "play"];
  const UNSTICK_MS = 3000;         // after removing an ad frame, nudge the player this much later
  const AD_IFRAME_SELECTORS = '#ad_iframe_container,iframe#ad_iframe,[id^="ad_iframe"],[class*="ad-iframe"],[class*="ad_iframe"]';
  const AD_STATE_CLASS_SELECTOR = '[class*="ad-shown"],[class*="ad-showing"],[class*="ad-playing"]';
  const AD_STATE_CLASS_RE = /^ad[-_]?(shown|showing|playing)$/i;

  const BUILTIN_INDICATORS = [
    '[class*="ad-showing"]',
    '[class*="ad-playing"]',
    '[class*="adPlaying"]',
    '[class*="ad-badge"]',
    '[class*="adBadge"]',
    '[class*="ad-countdown"]',
    '[class*="adCountdown"]',
    '[class*="ad-label"]',
    '[class*="adLabel"]',
    '[class*="ima-ad-container"]',
    '[aria-label="Advertisement"]',
    // MSN player (seen in a real capture): wrapper gets class "ad-shown" and an
    // iframe#ad_iframe inside #ad_iframe_container covers the paused video.
    '[class~="ad-shown"]',
    '#ad_iframe_container',
    'iframe#ad_iframe',
    '[id^="ad_iframe"]'
  ];

  const SKIP_SELECTORS = [
    '[class*="ad-skip"]',
    '[class*="adSkip"]',
    '[class*="skip-ad"]',
    '[class*="skipAd"]',
    '[class*="skip-button"]',
    'button[aria-label*="Skip" i]',
    'button[title*="Skip" i]'
  ].join(",");

  const SKIP_TEXT = /^(skip( ad(s)?)?|skip now|close ad)$/i;

  // Short visible text that labels a video ad.
  const LABEL_TEXT = /^(ad|ads|advert|advertisement|sponsored|ad\s*\d+\s*(of|\/)\s*\d+|ad\s*[·•:-]?\s*\d{1,2}(:\d{2})?s?|your video will (resume|play) after (the )?ads?|visit advertiser|why this ad\??|ad ?choices)$/i;
  // Promo text seen on house ads (e.g. Bing Wallpaper promos).
  const PROMO_TEXT = /bing wallpaper/i;

  const AD_PARTS = new Set([
    "ad", "ads", "advert", "advertisement", "advertiser", "sponsored", "sponsor", "adbreak"
  ]);

  const NEVER_BLOCK = [
    "akamaized.net", "akamaihd.net", "azureedge.net", "cloudfront.net", "fastly.net",
    "cloudflare.com", "gstatic.com", "googleapis.com", "windows.net", "msecnd.net",
    "sharepoint.com", "office.com", "office.net", "live.com", "microsoftonline.com",
    "s-microsoft.com"
  ];
  const FIRST_PARTY = ["msn.com", "microsoft.com", "bing.com", "bing.net"];
  const AD_HOST_RE = /(^|[.-])(ads?|ad(sdk|serv|server|x|delivery|nxs|tech)\w*|advert\w*|sponsor\w*)([.-]|$)/;

  // ---------- state ----------
  let settings = { ...DEFAULTS };
  let learnedIndicators = [];
  let learnedHide = [];
  let indicatorQuery = BUILTIN_INDICATORS.join(",");
  let hideStyleEl = null;

  let adActive = false;
  let adStart = 0;
  let adEventId = 0;
  let lastAdSeen = 0;
  let suppressed = false;
  let falsePositive = false;
  let candidate = null;
  let adEventHosts = new Set();
  let adVideo = null;
  let adActions = {};

  let buffer = [];
  const pending = { ad: new Set(), content: new Set() };
  const contentSeen = new Set();
  let flushTimer = null;
  let recentReqs = [];              // last requests of any host, for captures

  let shadowRoots = [];
  let shadowObserver = null;
  const observedRoots = new WeakSet();
  const seenVideos = new WeakSet();
  const lastMediaKey = new WeakMap();
  let videosReported = 0;
  let mediaEvents = 0;

  let lastTick = 0;
  let lastErrorSent = -1e9;
  let rafPending = false;
  const saved = new WeakMap();

  // ---------- small helpers ----------
  const send = (msg) => {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    } catch (_) { /* extension was reloaded */ }
  };

  const under = (host, list) => list.some((s) => host === s || host.endsWith("." + s));

  function learnable(host) {
    if (host === location.hostname) return false;
    if (under(host, NEVER_BLOCK) || under(host, FIRST_PARTY)) return AD_HOST_RE.test(host);
    return true;
  }

  function safeHost(url) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol === "blob:") return "blob";
      return u.hostname;
    } catch (_) { return ""; }
  }

  function urlKey(raw) {
    if (!raw) return "";
    try {
      const u = new URL(raw, location.href);
      if (u.protocol === "blob:") return "blob";
      if (u.protocol === "about:" || u.protocol === "data:" || u.protocol === "javascript:") return u.protocol;
      return u.hostname + u.pathname.slice(0, 90);
    } catch (_) { return ""; }
  }

  function frameInfo(f) {
    const src = urlKey(f.getAttribute("src") || "") || (f.hasAttribute("srcdoc") ? "srcdoc" : "no-src");
    return (f.id ? "#" + f.id + " " : "") + src;
  }

  // host + path without the query string (blob: URLs collapse to "blob")
  function srcKey(v) {
    const raw = v.currentSrc || v.src || "";
    if (!raw) return "";
    try {
      const u = new URL(raw, location.href);
      if (u.protocol === "blob:") return "blob";
      return u.hostname + u.pathname.slice(0, 90);
    } catch (_) { return ""; }
  }

  function safeSelector(sel) {
    if (typeof sel !== "string" || !sel || sel.length > 200) return false;
    if (/[{}<>;@\n\r]|\/\*/.test(sel)) return false;
    try { document.querySelector(sel); return true; } catch (_) { return false; }
  }

  function isAdLikeToken(tok) {
    const parts = tok.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
      .split(/[^a-z0-9]+/).filter(Boolean);
    if (parts.includes("free") || parts.includes("block") || parts.includes("blocker")) return false;
    return parts.some((p) => AD_PARTS.has(p));
  }

  const adTokens = (cls) => cls.split(/\s+/).filter(Boolean).filter(isAdLikeToken);

  const overlaps = (a, b) =>
    b.width > 0 && b.height > 0 &&
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

  // ---------- shadow DOM support ----------
  function shadowOf(el) {
    try {
      if (chrome.dom && chrome.dom.openOrClosedShadowRoot) {
        const r = chrome.dom.openOrClosedShadowRoot(el);
        if (r) return r;
      }
    } catch (_) {}
    return el.shadowRoot || null;
  }

  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const r = el.getRootNode && el.getRootNode();
    return r && r.host ? r.host : null;
  }

  function composedContains(box, node) {
    for (let n = node; n; n = parentOf(n)) if (n === box) return true;
    return false;
  }

  function rescanShadowRoots() {
    const found = [];
    const seen = new Set();
    const visit = (root, depth) => {
      if (depth > 6 || found.length > 200) return;
      for (const el of root.querySelectorAll("*")) {
        const sr = shadowOf(el);
        if (sr && !seen.has(sr)) {
          seen.add(sr);
          found.push(sr);
          visit(sr, depth + 1);
        }
      }
    };
    try { visit(document, 0); } catch (_) {}
    shadowRoots = found;
    if (shadowObserver) {
      for (const sr of found) {
        if (observedRoots.has(sr)) continue;
        observedRoots.add(sr);
        try {
          shadowObserver.observe(sr, {
            childList: true, subtree: true, attributes: true, attributeFilter: ["class"]
          });
        } catch (_) {}
      }
    }
  }

  // querySelectorAll that also looks inside shadow roots under `box`
  function deepAll(box, sel) {
    const out = [...box.querySelectorAll(sel)];
    for (const sr of shadowRoots) {
      if (sr.host.isConnected && composedContains(box, sr.host)) {
        out.push(...sr.querySelectorAll(sel));
      }
    }
    return out;
  }

  function allVideos() {
    const out = [...document.querySelectorAll("video")];
    for (const sr of shadowRoots) {
      if (sr.host.isConnected) out.push(...sr.querySelectorAll("video"));
    }
    return out;
  }

  const anyVideoPlaying = () =>
    allVideos().some((v) => !v.paused && !v.ended && v.readyState > 2);

  function containerOf(video) {
    let c = video;
    for (let i = 0; i < CONTAINER_LEVELS; i++) {
      const p = parentOf(c);
      if (!p || p === document.body || p === document.documentElement) break;
      c = p;
    }
    return c;
  }

  // ---------- describing elements ----------
  function nodeLabel(n) {
    let s = n.tagName.toLowerCase();
    if (n.id) s += "#" + CSS.escape(n.id);
    else s += [...n.classList].slice(0, 2).map((x) => "." + CSS.escape(x)).join("");
    if (shadowOf(n)) s += "[shadow-host]";
    return s;
  }

  function cssPath(el) {
    const parts = [];
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 6; i++) {
      parts.unshift(nodeLabel(n));
      if (n.parentElement) {
        n = n.parentElement;
      } else {
        const h = parentOf(n);
        if (h) parts.unshift("#shadow");
        n = h;
      }
    }
    return parts.join(" > ");
  }

  function describe(el, withText = true) {
    const d = {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: (el.getAttribute("class") || "").slice(0, 160) || undefined,
      role: el.getAttribute("role") || undefined,
      aria: el.getAttribute("aria-label") || undefined,
      shadow: el.getRootNode && el.getRootNode() !== document ? true : undefined,
      path: cssPath(el)
    };
    if (el.tagName === "IFRAME") d.frame = frameInfo(el);
    if (withText) d.text = (el.textContent || "").trim().slice(0, 60) || undefined;
    return d;
  }

  const ownText = (el) =>
    [...el.childNodes].filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim()).join(" ").trim().slice(0, 80);

  // ---------- state from storage ----------
  function applyHideStyle() {
    if (!hideStyleEl) {
      hideStyleEl = document.createElement("style");
      hideStyleEl.id = "msn-adblock-learned";
    }
    if (!hideStyleEl.isConnected && document.documentElement) {
      document.documentElement.appendChild(hideStyleEl);
    }
    hideStyleEl.textContent = settings.enabled
      ? learnedHide.map((s) => `${s}{display:none!important}`).join("\n")
      : "";
  }

  function loadState() {
    try {
      chrome.storage.local.get(["settings", "learnedSelectors"], (r) => {
        if (chrome.runtime.lastError) return;
        settings = { ...DEFAULTS, ...((r && r.settings) || {}) };
        const ls = ((r && r.learnedSelectors) || []).filter((x) => safeSelector(x.selector));
        learnedIndicators = ls
          .filter((x) => x.kind === "indicator" || x.kind === "both")
          .map((x) => x.selector);
        learnedHide = ls
          .filter((x) => x.kind === "hide" || x.kind === "both")
          .map((x) => x.selector);
        indicatorQuery = BUILTIN_INDICATORS.concat(learnedIndicators).join(",");
        applyHideStyle();
        schedule();
      });
    } catch (_) { /* extension was reloaded */ }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes.settings || changes.learnedSelectors)) loadState();
    });
  } catch (_) {}

  // ---------- ad detection ----------
  function cueForVideo(video) {
    const box = containerOf(video);

    // 1. Known / learned selectors somewhere in the player container.
    let hit = null;
    try { hit = box.matches(indicatorQuery) ? box : deepAll(box, indicatorQuery)[0]; } catch (_) {}
    if (hit) return { kind: "indicator", el: hit };

    // 2. A visible ad label or promo text overlapping the video.
    const vr = video.getBoundingClientRect();
    if (vr.width > 0 && vr.height > 0) {
      let n = 0;
      for (const c of deepAll(box, "span,div,p,a,button,label,li")) {
        if (++n > 600) break;
        if (c.children.length > 2) continue;
        const t = (c.textContent || "").trim();
        if (!t || t.length > 80) continue;
        const isLabel = t.length <= 40 && LABEL_TEXT.test(t);
        const isPromo = PROMO_TEXT.test(t);
        if (!isLabel && !isPromo) continue;
        const r = c.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && overlaps(r, vr)) {
          return { kind: isLabel ? "text" : "promo-text", el: c, text: t };
        }
      }
    }
    return null;
  }

  function candidateSelector(el, video) {
    let n = el;
    for (let i = 0; i < 4 && n && n !== document.body && n !== document.documentElement;
         i++, n = n.parentElement) {
      const toks = adTokens(n.getAttribute("class") || "");
      if (!toks.length) continue;
      const sel = n.tagName.toLowerCase() +
        toks.slice(0, 2).map((t) => "." + CSS.escape(t)).join("");
      if (!safeSelector(sel)) continue;
      let count = 0;
      try { count = document.querySelectorAll(sel).length; } catch (_) { continue; }
      if (count === 0 || count > 10) continue; // 0 also covers elements inside shadow DOM
      const holdsVideo = n.contains(video) || video.contains(n) || !!n.querySelector("video");
      const bigText = (n.textContent || "").length > 300;
      return {
        selector: sel,
        kind: holdsVideo || bigText ? "indicator" : "both",
        holdsVideo: holdsVideo || bigText,
        node: describe(n, false)
      };
    }
    return null;
  }

  function videoFacts(v) {
    const vr = v.getBoundingClientRect();
    return {
      host: safeHost(v.currentSrc || v.src),
      src: srcKey(v),
      duration: round1(v.duration),
      currentTime: round1(v.currentTime),
      paused: v.paused,
      width: Math.round(vr.width),
      height: Math.round(vr.height)
    };
  }

  function overlayCandidates(box, v, limit = 40) {
    const vr = v.getBoundingClientRect();
    if (!(vr.width > 0 && vr.height > 0)) return [];
    const out = [];
    let n = 0;
    for (const el of deepAll(box, "*")) {
      if (el === v || /^(SCRIPT|STYLE)$/i.test(el.tagName)) continue;
      if (++n > 1500) break;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0) || !overlaps(r, vr)) continue;
      const text = ownText(el);
      const interesting = text || el.getAttribute("aria-label") ||
        el.getAttribute("role") === "button" ||
        /^(A|BUTTON|IMG|IFRAME|VIDEO|CANVAS|SVG)$/i.test(el.tagName);
      if (!interesting) continue;
      const d = describe(el);
      d.rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      try { d.pos = getComputedStyle(el).position; } catch (_) {}
      out.push(d);
      if (out.length >= limit) break;
    }
    return out;
  }

  function videoInfo(v) {
    const box = containerOf(v);
    const chain = [];
    for (let n = v, i = 0; n && i < 8; n = parentOf(n), i++) chain.push(nodeLabel(n));
    return {
      page: location.origin + location.pathname,
      frame: FRAME_NAME(),
      video: videoFacts(v),
      container: describe(box, false),
      chain,
      overlays: overlayCandidates(box, v),
      iframes: deepAll(box, "iframe").map(frameInfo).slice(0, 5)
    };
  }

  function snapshot(cue, video) {
    const box = containerOf(video);
    return {
      page: location.origin + location.pathname,
      frame: FRAME_NAME(),
      cue: { kind: cue.kind, text: cue.text, el: describe(cue.el) },
      container: describe(box, false),
      video: videoFacts(video),
      iframes: deepAll(box, "iframe").map(frameInfo).slice(0, 5),
      recentHosts: [...adEventHosts].slice(0, 30),
      candidate: candidate ? candidate.selector : null,
      learnable: settings.learn && cue.kind !== "indicator" ? !!candidate : null
    };
  }

  function startAd(first, now) {
    adActive = true;
    adStart = now;
    adEventId += 1;
    suppressed = false;
    falsePositive = false;
    adEventHosts = new Set();
    candidate = null;
    adVideo = first.v;
    adActions = {};

    for (const b of buffer) {
      if (now - b.t <= LOOKBACK_MS) {
        adEventHosts.add(b.host);
        pending.ad.add(b.host);
      }
    }
    buffer = [];

    if (settings.learn && first.cue.kind !== "indicator") {
      candidate = candidateSelector(first.cue.el, first.v);
    }
    const snap = snapshot(first.cue, first.v);
    LOG("ad detected", snap);
    send({ type: "adEvent", id: `${FRAME_ID}:${adEventId}`, snapshot: snap });
  }

  function endAd(now) {
    adActive = false;

    let learnResult = null;
    if (candidate && settings.learn && !falsePositive) {
      let persists = false;
      try { persists = !!document.querySelector(candidate.selector); } catch (_) {}
      if (!persists) {
        send({ type: "selector", selector: candidate.selector, kind: candidate.kind, cue: candidate.node });
        learnResult = "learned:" + candidate.kind;
      } else if (!candidate.holdsVideo) {
        send({ type: "selector", selector: candidate.selector, kind: "hide", cue: candidate.node });
        learnResult = "learned:hide";
      } else {
        learnResult = "skipped:persists-and-holds-video";
      }
    } else if (falsePositive) {
      learnResult = "skipped:false-positive";
    }

    send({
      type: "adEnd",
      id: `${FRAME_ID}:${adEventId}`,
      durationMs: Math.round(now - adStart),
      hosts: [...adEventHosts].slice(0, 30),
      possibleFalsePositive: falsePositive,
      learnResult,
      actions: (() => {
        const { removedAt, ...rest } = adActions;
        return { ...rest, videoPlayingAtEnd: adVideo ? !adVideo.paused : null };
      })()
    });

    if (falsePositive) pending.ad.clear();
    suppressed = false;
    falsePositive = false;
    candidate = null;
    flushObs();
  }

  // ---------- acting on ads ----------
  function handleAdVideo(v) {
    // A paused video is the content waiting behind an ad, not the ad itself.
    if (v.paused || v.ended) return;
    const d = v.duration;
    if (Number.isFinite(d) && d > MAX_SKIPPABLE_DURATION_S) return;
    if (!saved.has(v)) saved.set(v, { muted: v.muted, rate: v.playbackRate });
    v.muted = true;
    if (Number.isFinite(d) && d > 0) {
      v.playbackRate = 16;
      if (v.currentTime < d - 0.1) {
        try { v.currentTime = d; } catch (_) {}
      }
    }
  }

  function restoreVideo(v) {
    const s = saved.get(v);
    if (!s) return;
    v.muted = s.muted;
    v.playbackRate = s.rate || 1;
    saved.delete(v);
  }

  function clickIfVisible(el) {
    if (el.offsetParent !== null) el.click();
  }

  function clickSkipIn(box) {
    deepAll(box, SKIP_SELECTORS).forEach(clickIfVisible);
    deepAll(box, "button,[role='button']").forEach((el) => {
      if (SKIP_TEXT.test((el.textContent || "").trim())) clickIfVisible(el);
    });
  }

  // ---------- ads rendered in an iframe over a paused video ----------
  // MSN mid-roll ads: the content video is paused and an <iframe id="ad_iframe">
  // covers it. Removing the frame stops the ad and its sound.
  function removeAdFrames(box, video) {
    let removed = 0;
    for (const el of deepAll(box, AD_IFRAME_SELECTORS)) {
      if (el.isConnected) { el.remove(); removed += 1; }
    }
    const vr = video.getBoundingClientRect();
    if (vr.width > 0 && vr.height > 0) {
      for (const f of deepAll(box, "iframe")) {
        if (!f.isConnected) continue;
        const r = f.getBoundingClientRect();
        const w = Math.min(r.right, vr.right) - Math.max(r.left, vr.left);
        const h = Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top);
        if (w > 0 && h > 0 && w * h >= 0.6 * vr.width * vr.height) { f.remove(); removed += 1; }
      }
    }
    return removed;
  }

  // If the player is still in "ad" state a few seconds after we removed the ad
  // frame, clear its ad-state class and resume the content video.
  function maybeUnstick(first, now) {
    if (!adActions.removedAt || adActions.unstuck || now - adActions.removedAt < UNSTICK_MS) return;
    adActions.unstuck = true;
    const cleared = [];
    for (const el of deepAll(containerOf(first.v), AD_STATE_CLASS_SELECTOR)) {
      for (const t of [...el.classList]) {
        if (AD_STATE_CLASS_RE.test(t)) { el.classList.remove(t); cleared.push(t); }
      }
    }
    adActions.classesCleared = cleared;
    if (first.v.paused) {
      try {
        const p = first.v.play();
        if (p && p.catch) p.catch((e) => { adActions.playError = String((e && e.name) || e); });
      } catch (e) { adActions.playError = String((e && e.name) || e); }
    }
  }

  // ---------- video diagnostics ----------
  function onMediaEvent(v, type) {
    if (!settings.enabled || !settings.learn || mediaEvents >= MAX_MEDIA_EVENTS) return;
    const duration = round1(v.duration);
    const key = `${srcKey(v)}|${duration}|${v.paused}`;
    if (lastMediaKey.get(v) === key) return;
    lastMediaKey.set(v, key);
    mediaEvents += 1;
    send({
      type: "media",
      info: {
        page: location.origin + location.pathname,
        frame: FRAME_NAME(),
        event: type,
        src: srcKey(v),
        duration,
        currentTime: round1(v.currentTime),
        paused: v.paused,
        adActive
      }
    });
  }

  function registerVideo(v) {
    if (seenVideos.has(v)) return;
    seenVideos.add(v);
    for (const type of MEDIA_EVENTS) v.addEventListener(type, () => onMediaEvent(v, type));
    // A media error right after an auto-block may mean we broke the player.
    v.addEventListener("error", () => {
      const t = performance.now();
      if (!settings.enabled || t - lastErrorSent < 10000) return;
      lastErrorSent = t;
      send({ type: "playerError" });
    });
    if (settings.learn && videosReported < MAX_VIDEOS_REPORTED) {
      videosReported += 1;
      send({ type: "videoSeen", snapshot: videoInfo(v) });
    }
  }

  // Full snapshot of every video in this frame, on demand.
  function doCapture() {
    const now = performance.now();
    const videos = allVideos();
    send({
      type: "capture",
      capture: {
        page: location.origin + location.pathname,
        frame: FRAME_NAME(),
        adActive,
        videoCount: videos.length,
        videos: videos.slice(0, 4).map(videoInfo),
        recentRequests: recentReqs
          .filter((r) => r.t >= now - 20000)
          .slice(-80)
          .map((r) => ({ host: r.host, path: r.path, type: r.type, secAgo: round1((now - r.t) / 1000) }))
      }
    });
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg && msg.type === "capture" && sender && sender.id === chrome.runtime.id) doCapture();
    });
  } catch (_) {}

  // ---------- network observation ----------
  function onResource(e) {
    let u;
    try { u = new URL(e.name); } catch (_) { return; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
    const host = u.hostname.toLowerCase();

    recentReqs.push({ host, path: u.pathname.slice(0, 90), type: e.initiatorType, t: performance.now() });
    if (recentReqs.length > 250) recentReqs.splice(0, recentReqs.length - 250);

    if (!settings.enabled || !settings.learn) return;
    if (!learnable(host)) return;

    if (adActive) {
      adEventHosts.add(host);
      pending.ad.add(host);
    } else {
      buffer.push({ host, t: performance.now(), playing: anyVideoPlaying() });
      if (buffer.length > 300) buffer.splice(0, buffer.length - 300);
    }
    scheduleFlush();
  }

  function drainBuffer(now) {
    const keep = [];
    let added = false;
    for (const b of buffer) {
      if (now - b.t > LOOKBACK_MS) {
        if (b.playing && !contentSeen.has(b.host)) {
          contentSeen.add(b.host);
          pending.content.add(b.host);
          added = true;
        }
      } else {
        keep.push(b);
      }
    }
    buffer = keep;
    if (added) scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flushObs(); }, FLUSH_MS);
  }

  function flushObs() {
    const ad = adActive ? [] : [...pending.ad];
    const content = [...pending.content];
    if (!ad.length && !content.length) return;
    if (!adActive) pending.ad.clear();
    pending.content.clear();
    send({ type: "obs", ad, content, page: location.origin + location.pathname });
  }

  // ---------- main loop ----------
  function tick() {
    lastTick = performance.now();
    if (!settings.enabled) return;
    const now = lastTick;
    let first = null;
    const videos = allVideos();

    for (const v of videos) {
      registerVideo(v);
      const cue = cueForVideo(v);
      if (!cue) {
        restoreVideo(v);
        continue;
      }
      if (!first) {
        first = { cue, v };
        if (!adActive) startAd(first, now);
      }
      if (!suppressed) {
        handleAdVideo(v);
        clickSkipIn(containerOf(v));
        const n = removeAdFrames(containerOf(v), v);
        if (n > 0) {
          adActions.iframesRemoved = (adActions.iframesRemoved || 0) + n;
          if (!adActions.removedAt) adActions.removedAt = now;
        }
      }
    }

    if (first) {
      lastAdSeen = now;
      if (!suppressed && now - adStart > MAX_AD_MS) {
        suppressed = true;
        falsePositive = true;
        videos.forEach(restoreVideo);
        LOG("ad state lasted over 60s; treating as a false positive and backing off");
      } else if (!suppressed) {
        maybeUnstick(first, now);
      }
    } else if (adActive && now - lastAdSeen > END_GRACE_MS) {
      endAd(now);
    }

    drainBuffer(now);
  }

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (performance.now() - lastTick >= TICK_MIN_MS) tick();
    });
  }

  function start() {
    loadState();
    shadowObserver = new MutationObserver(schedule);
    rescanShadowRoots();
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["class"]
    });
    setInterval(rescanShadowRoots, SHADOW_RESCAN_MS);
    setInterval(tick, 500);
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(onResource))
        .observe({ type: "resource" });
    } catch (_) {}
    tick();
  }

  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
