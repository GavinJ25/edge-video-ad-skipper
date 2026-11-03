// MSN Video Ad Blocker v2 - background service worker
// Single writer for all stored state. Content scripts send observations here;
// this worker decides what to learn, writes the log, and keeps the dynamic
// network-blocking rules in sync with the learned domains.
"use strict";

const DEFAULT_SETTINGS = { enabled: true, learn: true, autoBlock: true };
const LOG_MAX = 400;
const CAPTURE_MAX = 30;
const STATS_MAX = 500;
const RULE_BASE_ID = 1000;
const STATIC_RULESET = "msn_ad_rules";
const RESOURCE_TYPES = [
  "script", "image", "xmlhttprequest", "sub_frame", "media", "ping", "other"
];

// Auto-block tiers, strongest evidence first. Returns the reason or null.
//  1. The hostname itself says "ad server" (ads., adserv, adsdk, ...). Ad hosts
//     also fire tracking pixels during normal playback, so the "content"
//     count is ignored for these.
//  2. Seen during 2+ ads and never outside them.
//  3. Seen during 3+ ads and at least 3x more often than outside them.
const AD_HOST_RE = /(^|[.-])(ads?|ad(sdk|serv|server|x|delivery|nxs|tech)\w*|advert\w*|sponsor\w*)([.-]|$)/;
const AUTO_BLOCK_PER_HOUR = 8;     // runaway guard
const PROBATION_MS = 60000;        // a player error this soon after an auto-block reverts it

function autoBlockReason(host, s) {
  if (AD_HOST_RE.test(host) && s.ad >= 1) return "ad-like hostname";
  if (s.ad >= 2 && s.content === 0) return "only seen during ads";
  if (s.ad >= 3 && s.ad >= 3 * s.content) return "mostly seen during ads";
  return null;
}

const CONTENT_TYPES = new Set([
  "obs", "selector", "adEvent", "adEnd", "videoSeen", "media", "capture", "playerError"
]);
const POPUP_TYPES = new Set([
  "setSettings", "removeDomain", "blockDomain", "removeSelector",
  "clearLog", "resetLearning"
]);

// ---------- helpers ----------
let queue = Promise.resolve();
const enqueue = (fn) =>
  (queue = queue.then(fn).catch((e) => console.error("[MSN-AdBlock]", e)));

const get = (keys) => chrome.storage.local.get(keys);

async function getSettings() {
  const { settings } = await get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function validHost(h) {
  return typeof h === "string" &&
    /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(h);
}

// Selectors are written into a stylesheet, so keep them boring.
function validSelector(s) {
  return typeof s === "string" && s.length > 0 && s.length <= 200 &&
    !/[{}<>;@\n\r]|\/\*/.test(s);
}

async function addLog(entry) {
  const { adLog = [] } = await get("adLog");
  adLog.push({ t: Date.now(), ...entry });
  while (adLog.length > LOG_MAX) adLog.shift();
  await chrome.storage.local.set({ adLog });
}

async function syncRules() {
  const [{ learnedDomains = [] }, settings] = await Promise.all([
    get("learnedDomains"),
    getSettings()
  ]);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = settings.enabled
    ? learnedDomains.map((d, i) => ({
        id: RULE_BASE_ID + i,
        priority: 1,
        action: { type: "block" },
        condition: {
          requestDomains: [d.host],
          initiatorDomains: ["msn.com"],
          resourceTypes: RESOURCE_TYPES
        }
      }))
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    settings.enabled
      ? { enableRulesetIds: [STATIC_RULESET] }
      : { disableRulesetIds: [STATIC_RULESET] }
  );
}

// ---------- handlers from content scripts ----------
async function onObs(msg) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.learn) return;

  const adHosts = (msg.ad || []).filter(validHost);
  const contentHosts = (msg.content || []).filter(validHost);
  if (!adHosts.length && !contentHosts.length) return;

  const stored = await get(["hostStats", "learnedDomains", "ignoredDomains"]);
  const hostStats = stored.hostStats || {};
  const learnedDomains = stored.learnedDomains || [];
  const ignoredDomains = stored.ignoredDomains || [];
  const now = Date.now();

  const bump = (host, field) => {
    const s = hostStats[host] || (hostStats[host] = { ad: 0, content: 0, last: 0 });
    s[field] += 1;
    s.last = now;
  };
  new Set(adHosts).forEach((h) => bump(h, "ad"));
  new Set(contentHosts).forEach((h) => bump(h, "content"));

  const newly = [];
  const reasons = {};
  if (settings.autoBlock) {
    const hourAgo = now - 3600000;
    let budget = AUTO_BLOCK_PER_HOUR -
      learnedDomains.filter((d) => d.auto && d.learnedAt > hourAgo).length;
    for (const h of new Set(adHosts)) {
      if (budget <= 0) break;
      if (ignoredDomains.includes(h)) continue;
      if (learnedDomains.some((d) => d.host === h)) continue;
      const reason = autoBlockReason(h, hostStats[h]);
      if (!reason) continue;
      learnedDomains.push({
        host: h, ad: hostStats[h].ad, content: hostStats[h].content,
        learnedAt: now, auto: true, reason
      });
      reasons[h] = reason;
      newly.push(h);
      budget -= 1;
    }
  }

  const keys = Object.keys(hostStats);
  if (keys.length > STATS_MAX) {
    keys.sort((a, b) => hostStats[a].last - hostStats[b].last)
      .slice(0, keys.length - STATS_MAX)
      .forEach((k) => delete hostStats[k]);
  }

  await chrome.storage.local.set({ hostStats, learnedDomains });
  if (newly.length) {
    await syncRules();
    for (const h of newly) {
      await addLog({
        type: "learned-domain", host: h, stats: hostStats[h], page: msg.page,
        auto: true, reason: reasons[h]
      });
    }
  }
}

async function onSelector(msg) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.learn) return;
  if (!validSelector(msg.selector)) return;
  if (!["indicator", "hide", "both"].includes(msg.kind)) return;

  const stored = await get(["learnedSelectors", "ignoredSelectors"]);
  const learnedSelectors = stored.learnedSelectors || [];
  const ignoredSelectors = stored.ignoredSelectors || [];
  if (ignoredSelectors.includes(msg.selector)) return;
  if (learnedSelectors.some((s) => s.selector === msg.selector)) return;

  learnedSelectors.push({
    selector: msg.selector, kind: msg.kind, learnedAt: Date.now(), cue: msg.cue || null
  });
  await chrome.storage.local.set({ learnedSelectors });
  await addLog({ type: "learned-selector", selector: msg.selector, kind: msg.kind, cue: msg.cue || null });
}

async function onAdEvent(msg) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.learn) return;
  await addLog({ type: "ad-detected", id: msg.id, snapshot: msg.snapshot });
}

async function bumpCounters(delta) {
  const { counters = {} } = await get("counters");
  for (const [k, v] of Object.entries(delta)) counters[k] = (counters[k] || 0) + v;
  await chrome.storage.local.set({ counters });
}

const clampCount = (x) => Math.max(0, Math.min(20, Number(x) || 0));

async function onAdEnd(msg) {
  const a = msg.actions || {};
  await bumpCounters({ ads: 1, framesRemoved: clampCount(a.iframesRemoved) });
  const { adLog = [] } = await get("adLog");
  for (let i = adLog.length - 1; i >= 0; i--) {
    if (adLog[i].id === msg.id) {
      adLog[i].durationMs = msg.durationMs;
      adLog[i].hosts = (msg.hosts || []).slice(0, 30);
      adLog[i].possibleFalsePositive = !!msg.possibleFalsePositive;
      adLog[i].learnResult = msg.learnResult || null;
      adLog[i].actions = msg.actions || null;
      await chrome.storage.local.set({ adLog });
      return;
    }
  }
}

// Safety net: if the player errors right after we auto-blocked something,
// assume we broke it, undo those blocks and never re-learn them.
async function onPlayerError() {
  const stored = await get(["learnedDomains", "ignoredDomains"]);
  const learned = stored.learnedDomains || [];
  const cutoff = Date.now() - PROBATION_MS;
  const bad = learned.filter((d) => d.auto && d.learnedAt > cutoff);
  if (!bad.length) return;
  const ignored = stored.ignoredDomains || [];
  for (const d of bad) if (!ignored.includes(d.host)) ignored.push(d.host);
  await chrome.storage.local.set({
    learnedDomains: learned.filter((d) => !bad.includes(d)),
    ignoredDomains: ignored
  });
  await syncRules();
  await bumpCounters({ reverts: bad.length });
  await addLog({ type: "reverted", hosts: bad.map((d) => d.host) });
}

// Diagnostics: every video the extension finds, and its source/duration changes.
async function onVideoSeen(msg) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.learn) return;
  await addLog({ type: "video-seen", snapshot: msg.snapshot });
}

async function onMedia(msg) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.learn) return;
  await addLog({ type: "media", info: msg.info });
}

// On-demand snapshot of the player (popup button or keyboard shortcut).
async function onCapture(msg) {
  const { captures = [] } = await get("captures");
  captures.push({ t: Date.now(), ...msg.capture });
  while (captures.length > CAPTURE_MAX) captures.shift();
  await chrome.storage.local.set({ captures });
}

// ---------- handlers from the popup ----------
async function onSetSettings(msg) {
  const settings = { ...(await getSettings()), ...(msg.patch || {}) };
  await chrome.storage.local.set({ settings });
  await syncRules();
}

async function onRemoveDomain(msg) {
  const stored = await get(["learnedDomains", "ignoredDomains"]);
  const learnedDomains = (stored.learnedDomains || []).filter((d) => d.host !== msg.host);
  const ignoredDomains = stored.ignoredDomains || [];
  if (!ignoredDomains.includes(msg.host)) ignoredDomains.push(msg.host);
  await chrome.storage.local.set({ learnedDomains, ignoredDomains });
  await syncRules();
}

async function onBlockDomain(msg) {
  if (!validHost(msg.host)) return;
  const stored = await get(["learnedDomains", "ignoredDomains", "hostStats"]);
  const learnedDomains = stored.learnedDomains || [];
  const ignoredDomains = (stored.ignoredDomains || []).filter((h) => h !== msg.host);
  const s = (stored.hostStats || {})[msg.host] || { ad: 0, content: 0 };
  if (!learnedDomains.some((d) => d.host === msg.host)) {
    learnedDomains.push({
      host: msg.host, ad: s.ad, content: s.content, learnedAt: Date.now(), auto: false
    });
  }
  await chrome.storage.local.set({ learnedDomains, ignoredDomains });
  await syncRules();
  await addLog({ type: "learned-domain", host: msg.host, stats: s, manual: true });
}

async function onRemoveSelector(msg) {
  const stored = await get(["learnedSelectors", "ignoredSelectors"]);
  const learnedSelectors = (stored.learnedSelectors || []).filter((s) => s.selector !== msg.selector);
  const ignoredSelectors = stored.ignoredSelectors || [];
  if (!ignoredSelectors.includes(msg.selector)) ignoredSelectors.push(msg.selector);
  await chrome.storage.local.set({ learnedSelectors, ignoredSelectors });
}

async function onClearLog() {
  await chrome.storage.local.set({ adLog: [] });
}

async function onResetLearning() {
  await chrome.storage.local.set({
    learnedDomains: [], learnedSelectors: [], hostStats: {},
    ignoredDomains: [], ignoredSelectors: []
  });
  await syncRules();
}

const handlers = {
  obs: onObs, selector: onSelector, adEvent: onAdEvent, adEnd: onAdEnd,
  videoSeen: onVideoSeen, media: onMedia, capture: onCapture, playerError: onPlayerError,
  setSettings: onSetSettings, removeDomain: onRemoveDomain, blockDomain: onBlockDomain,
  removeSelector: onRemoveSelector, clearLog: onClearLog, resetLearning: onResetLearning
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return;
  const handler = handlers[msg.type];
  if (!handler) return;
  const fromContent = !!sender.tab;
  if (fromContent && !CONTENT_TYPES.has(msg.type)) return;
  if (!fromContent && !POPUP_TYPES.has(msg.type)) return;

  enqueue(async () => {
    try {
      await handler(msg, sender);
      sendResponse({ ok: true });
    } catch (e) {
      console.error("[MSN-AdBlock]", e);
      sendResponse({ ok: false, error: String(e) });
    }
  });
  return true; // keep the channel open for the async response
});

chrome.runtime.onInstalled.addListener(() => enqueue(syncRules));
chrome.runtime.onStartup.addListener(() => enqueue(syncRules));

// Keyboard shortcut (default Alt+Shift+A): capture the player in the active tab.
if (chrome.commands) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "capture-ad") return;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.id != null) {
      chrome.tabs.sendMessage(tab.id, { type: "capture" }).catch(() => {});
    }
  });
}
