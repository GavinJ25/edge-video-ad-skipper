# Roadmap: from "MSN blocker" to a self-learning video ad blocker

Where we are (v2.3): one site, hand-found selectors for MSN's player, ad domains learned from network cues, auto-block with a revert safety net. This plan covers (1) making the learning fully automatic and (2) supporting other sites.

## 1. What we learned from MSN (the pattern to generalise)

| Observation | Generalisable signal |
|---|---|
| Content video **pauses**, an iframe covers it | Paused `<video>` + large iframe overlapping it |
| Player wrapper gets a state class (`ad-shown`) | A class on a player ancestor that appears when the video pauses and disappears later |
| Ad hosts fire pixels during normal playback too | "Seen only near ads" is too strict; hostname and request type matter |
| Player lives in nested shadow DOM | All DOM queries must pierce shadow roots (done) |
| Blocking the ad host made ads stop for 4 videos | Network blocking of ad-tech hosts is the cheapest, most durable fix |

## 2. Automation: close the loop with no manual steps

Goal: the user installs it, browses, and it gets better. They only intervene to undo.

**2.1 Confidence-scored detection (replace hand-written indicators)**
Each signal adds weight; act when the total passes a threshold, and log which signals fired.
- Large third-party iframe overlapping a video (+3)
- Video paused by the page, not the user, while an overlay appears (+2)
- Ancestor class diff: a token appears exactly when the iframe appears and vanishes after (+3)
- Visible text label ("Ad", "Advertisement", countdown) (+2)
- Video source switches to a short clip from a different host (+2)
- Ad-like hostnames/paths in requests within the window (+1)

**2.2 Automatic selector learning from class diffs**
Snapshot player ancestor classes every 250 ms. When an ad iframe appears, record which class tokens were added; confirm on the next ad; promote to a learned indicator after 2 confirmations. This would have discovered `ad-shown` on its own.

**2.3 Host learning with better evidence**
Already shipped: tiered rules (ad-like name, ad-only, mostly-ad), 8/hour cap, revert on player error. Next:
- Count by **request type** too: third-party `sub_frame`, `ping`, 1x1 images near an ad are stronger than `xmlhttprequest`.
- A bundled seed list of well-known ad/tracker hosts (EasyList/uBO-style) so common hosts are blocked from the first visit.
- Probation widened beyond `error` events: also stalls (no `timeupdate` for 10 s after a block) and play-button no-ops.
- Group learned hosts into **one** DNR rule with a long `requestDomains` array (saves rule count).

**2.4 Safety and trust**
- Every automatic change is logged with its reason and one-click undo (exists), plus a "cautious / balanced / aggressive" setting.
- Never learn from a page where the user is paused for a long time or the tab was hidden.
- Canary check: after any new rule, watch the next video for errors before keeping the rule.

**2.5 Optional: share what was learned**
Export/import a profile JSON (domains + selectors per site). Later, an opt-in community list. No telemetry by default.

## 3. Multiple websites

**3.1 Site profiles instead of hard-coded MSN logic**

```
sites/
  msn.json        { "match": ["*.msn.com"], "indicators": [...], "adFrames": [...], "domains": [...], "quirks": {...} }
  generic.json    fallback heuristics (section 2.1)
```

`content.js` loads the profile for the current hostname, merges it with learned items stored per site, and falls back to `generic.json`. Adding a site = adding a JSON file plus a test fixture, no code change.

**3.2 Permissions**
Today: `host_permissions` for `*.msn.com` only (store reviewers like this).
To scale: move to `optional_host_permissions` and a popup button, "Enable on this site". It calls `chrome.permissions.request` and registers the content script with `chrome.scripting.registerContentScripts`. Users opt in per site; the store listing stays narrow.

**3.3 Per-site storage**
Key everything by site: `learned[site].domains`, `.selectors`, `hostStats[site]`. Network rules use `initiatorDomains: [site]` so a block learned on one site never leaks to another.

**3.4 Naming**
"MSN" in the name can be a store-policy problem. Rename (e.g. "Video Ad Skipper") when the second site lands.

## 4. Testing so it does not rot

- **Fixture library:** every exported capture JSON becomes a test fixture. A jsdom builder recreates its DOM (as the current tests do) and asserts detection plus the right action.
- **Replay harness:** a script feeds a recorded request timeline to the background logic and checks what gets blocked.
- **Real-browser smoke test:** Playwright with the extension loaded against a local mock player page (ad iframe over a paused video). Runs in CI.
- **Regression log:** keep a list of "ad seen but missed" and "video broken" cases, each with a fixture.

## 5. Milestones

| Version | Scope | Done when |
|---|---|---|
| 2.3 | Tiered auto-block, revert guard, new popup | (this release) |
| 2.4 | Class-diff selector learning, request-type weighting, one-rule host grouping | Unknown MSN ad variants are learned without a code change |
| 2.5 | Site-profile loader + `generic.json`; MSN moved into `sites/msn.json` | MSN behaviour unchanged, tests pass |
| 3.0 | Optional host permissions, "Enable on this site", per-site storage, rename | A second site works end to end |
| 3.1 | Profile export/import, seed list, Playwright CI | Fresh install blocks common ads on day one |
| 3.2 | Store submission: privacy policy, permission justification, screenshots | Listed on Edge Add-ons |

## 6. Known limits

- Ads stitched into the video stream itself (server-side ad insertion) have no separate iframe or host to block. They can only be detected by timing and skipped, not removed.
- A site that pairs ad delivery with the content API can break when its ad host is blocked; the revert guard helps but does not cover every failure.
- Sites change markup. Learning reduces, but never removes, maintenance.
