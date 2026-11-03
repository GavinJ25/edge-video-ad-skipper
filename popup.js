"use strict";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
const DEFAULTS = { enabled: true, learn: true, autoBlock: true };
const TABS = ["blocked", "review", "activity"];

// Log text comes from web pages, so everything is rendered with textContent only.
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function button(label, cls, onClick, aria) {
  const b = el("button", "btn " + cls, label);
  b.type = "button";
  if (aria) b.setAttribute("aria-label", aria);
  b.addEventListener("click", onClick);
  return b;
}

function listItem(name, meta, action, mono) {
  const li = el("li", "row");
  const main = el("div", "main");
  main.appendChild(el("span", "name" + (mono ? " mono" : ""), name));
  if (meta) main.appendChild(el("span", "meta", meta));
  li.appendChild(main);
  if (action) li.appendChild(action);
  return li;
}

function fill(ul, nodes, emptyText) {
  if (nodes.length) {
    ul.replaceChildren(...nodes);
  } else {
    ul.replaceChildren(el("li", "empty", emptyText));
  }
}

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
}

// kind: ad | block | warn | other
function describeEvent(e) {
  if (e.type === "ad-detected") {
    const cue = (e.snapshot && e.snapshot.cue) || {};
    const a = e.actions || {};
    const bits = [];
    if (e.durationMs != null) bits.push((e.durationMs / 1000).toFixed(1) + "s");
    if (a.iframesRemoved) bits.push("removed ad frame");
    if (a.unstuck) bits.push("resumed player");
    if (a.videoPlayingAtEnd === false) bits.push("video still paused");
    if (e.learnResult && e.learnResult.startsWith("learned")) bits.push(e.learnResult);
    if (e.possibleFalsePositive) bits.push("possible false positive");
    return { kind: e.possibleFalsePositive ? "warn" : "ad", title: "Ad handled", meta: bits.join(" · ") || "in progress", cue: cue.kind };
  }
  if (e.type === "learned-domain") {
    return { kind: "block", title: "Blocked " + e.host, meta: e.manual ? "blocked by you" : (e.reason || "auto") };
  }
  if (e.type === "learned-selector") {
    return { kind: "block", title: "Learned " + e.selector, meta: e.kind };
  }
  if (e.type === "reverted") {
    return { kind: "warn", title: "Undid auto-block", meta: (e.hosts || []).join(", ") + " (player error)" };
  }
  if (e.type === "video-seen") {
    const v = (e.snapshot && e.snapshot.video) || {};
    return { kind: "other", title: "Video found", meta: (v.duration != null ? v.duration + "s " : "") + (v.src || "") };
  }
  if (e.type === "media") {
    const m = e.info || {};
    return { kind: "other", title: "Source change" + (m.adActive ? " (ad)" : ""), meta: (m.duration != null ? m.duration + "s " : "") + (m.src || "") };
  }
  return { kind: "other", title: e.type, meta: "" };
}

function eventItem(e) {
  const d = describeEvent(e);
  const li = el("li", "row event");
  li.appendChild(el("span", "mark " + d.kind));
  const main = el("div", "main");
  main.appendChild(el("span", "name", d.title));
  if (d.meta) main.appendChild(el("span", "meta", d.meta));
  li.appendChild(main);
  return li;
}

function selectTab(name) {
  if (!TABS.includes(name)) name = "blocked";
  for (const t of TABS) {
    $("t-" + t).setAttribute("aria-selected", String(t === name));
    $("p-" + t).hidden = t !== name;
  }
  try { localStorage.setItem("tab", name); } catch (_) {}
}

async function render() {
  const s = await chrome.storage.local.get([
    "settings", "learnedDomains", "learnedSelectors", "hostStats", "adLog", "counters"
  ]);
  const settings = { ...DEFAULTS, ...(s.settings || {}) };
  for (const k of Object.keys(DEFAULTS)) $(k).checked = !!settings[k];
  document.body.classList.toggle("off", !settings.enabled);
  $("sub").textContent = settings.enabled ? "Protecting msn.com" : "Paused";

  const domains = s.learnedDomains || [];
  const selectors = s.learnedSelectors || [];
  const counters = s.counters || {};
  const learnedHosts = new Set(domains.map((d) => d.host));

  const stats = s.hostStats || {};
  const candidates = Object.keys(stats)
    .filter((h) => !learnedHosts.has(h) && stats[h].ad > 0)
    .sort((a, b) => stats[b].ad - stats[a].ad)
    .slice(0, 20);

  $("statAds").textContent = counters.ads || 0;
  $("statDomains").textContent = domains.length;
  $("statSel").textContent = selectors.length;
  $("bBlocked").textContent = domains.length;
  $("bReview").textContent = candidates.length;
  $("bReview").classList.toggle("hot", candidates.length > 0);

  fill($("domains"), domains.slice().reverse().map((d) =>
    listItem(d.host, (d.auto ? "auto · " + (d.reason || "learned") : "blocked by you") + " · " + ago(d.learnedAt) + " ago",
      button("Remove", "ghost small", () => send({ type: "removeDomain", host: d.host }), "Remove " + d.host), true)
  ), "Nothing blocked yet. Ad domains show up here as they are found.");

  fill($("selectors"), selectors.map((x) =>
    listItem(x.selector, x.kind,
      button("Remove", "ghost small", () => send({ type: "removeSelector", selector: x.selector }), "Remove " + x.selector), true)
  ), "None needed so far. MSN's ads are already caught by built-in rules; this fills in when an unknown ad shows an \"Ad\" label.");

  fill($("candidates"), candidates.map((h) =>
    listItem(h, `near ads ${stats[h].ad}× · elsewhere ${stats[h].content}×`,
      button("Block", "primary small", () => send({ type: "blockDomain", host: h }), "Block " + h), true)
  ), "Nothing to review.");

  fill($("log"), (s.adLog || []).slice(-30).reverse().map((e) => {
    const li = eventItem(e);
    li.insertBefore(el("span", "when", ago(e.t)), li.firstChild);
    return li;
  }), "No activity yet. Refresh the msn.com tab and play a video.");
}

// ---------- wiring ----------
for (const k of Object.keys(DEFAULTS)) {
  $(k).addEventListener("change", () => send({ type: "setSettings", patch: { [k]: $(k).checked } }));
}

for (const t of TABS) $("t-" + t).addEventListener("click", () => selectTab(t));
let initialTab = "blocked";
try { initialTab = localStorage.getItem("tab") || "blocked"; } catch (_) {}
selectTab(initialTab);

$("clearLog").addEventListener("click", () => send({ type: "clearLog" }));

$("reset").addEventListener("click", () => {
  if (confirm("Forget everything learned (domains, selectors, stats)?")) {
    send({ type: "resetLearning" });
  }
});

// Ask every frame of the active tab to capture its video player(s).
$("capture").addEventListener("click", async () => {
  const status = $("status");
  status.textContent = "Capturing…";
  const since = Date.now();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) {
    status.textContent = "No active tab.";
    return;
  }
  try { await chrome.tabs.sendMessage(tab.id, { type: "capture" }); } catch (_) {}
  setTimeout(async () => {
    const { captures = [] } = await chrome.storage.local.get("captures");
    const fresh = captures.filter((c) => c.t >= since);
    if (!fresh.length) {
      status.textContent = "Nothing responded. Refresh the msn.com tab and try again.";
    } else {
      const vids = fresh.reduce((n, c) => n + (c.videoCount || 0), 0);
      status.textContent = vids
        ? `Captured ${vids} video(s). Click Export log to save it.`
        : "Running, but no video found yet. Start the video, then capture again.";
    }
  }, 1500);
});

$("export").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(null);
  const blob = new Blob(
    [JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2)],
    { type: "application/json" }
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "msn-adblock-log.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

chrome.storage.onChanged.addListener(render);
render();
