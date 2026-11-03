# MSN Video Ad Blocker v2.3 (Microsoft Edge)

## Install (developer mode)
1. Unzip this folder.
2. Open Edge and go to `edge://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `msn-video-adblock` folder.
5. Open msn.com and play videos. Click the extension icon to see what it learned.

If you are updating from v1, click the reload icon on the extension card after replacing the folder.

## What it does
- `rules.json`: static block list of common ad networks (requests from msn.com only).
- `content.css`: hides common ad containers.
- `content.js`: detects video ads, then mutes, speeds up and skips them.
- `background.js`: stores the log and learned items, and turns learned ad domains into live blocking rules.
- `popup.html` / `popup.js`: review, remove, export.

## How it learns
When a video ad plays, the extension looks for cues, and logs each ad event:

| Cue | Used for |
|---|---|
| Known or learned selector in the player (e.g. an "ad playing" class) | Detecting the ad |
| A visible "Ad" / "Advertisement" / "Ad 1 of 2" label overlapping the video | Detecting a **new** ad, then learning a selector from the label's ad-like class |
| Third-party hosts requested shortly before and during the ad | Learning ad domains |
| Video host, duration, size, iframes in the player | Logged for you to inspect |

What it learns, and when it applies next time:
- **Selectors**: learned at the end of the ad, and only if the element disappears with the ad (so it is a true "ad is playing" signal) or is a standalone ad slot with no video in it.
- **Domains**: a host is blocked after it appears in 2 or more ads and never during normal playback (or 5+ ads and at least 5x more often than in normal playback). Blocking only applies to requests started from msn.com.

Safety limits:
- Shared CDNs (akamaized, azureedge, cloudfront...) are never learned. Microsoft/MSN/Bing hosts are only learned if the hostname looks like an ad server (`ads.`, `adserv`, ...).
- Videos longer than 3 minutes are never fast-forwarded.
- If "ad playing" stays true for over 60 s, it is treated as a false positive: the extension backs off and learns nothing from that event.

## Automatic blocking (v2.3)
With "Auto-block ad domains" on, a host seen near an ad is blocked when it meets any of:
1. its hostname looks like an ad server (`ads.`, `adsdk`, `adserv`, ...), after a single sighting;
2. it appears during 2+ ads and never outside them;
3. it appears during 3+ ads and at least 3x more often than outside them.

Guards: at most 8 automatic blocks per hour, and if the video player reports an error within 60 seconds of an automatic block, those blocks are undone and never re-learned (shown as "Undid auto-block" in Activity). Hosts that did not qualify wait in the **Review** tab for a one-click Block.

"Page selectors" stays empty when MSN's ads are caught by the built-in rules; it only fills in when an unknown ad shows an "Ad" text label.

See `ROADMAP.md` for the plan to automate selector learning and support more sites.

## MSN mid-roll ads (found from a real capture)
On msn.com the player is a web component with its own shadow DOM. At a mid-roll the **content video pauses** and an `iframe#ad_iframe` (inside `#ad_iframe_container`) covers it, while the player wrapper gets the class `ad-shown`. So the ad is not in the `<video>` at all.

What v2.2 does about it:
- Detects `ad-shown` / `#ad_iframe_container` as the "ad is showing" signal.
- Removes the ad iframe straight away (this also stops its sound).
- If the player is still in ad state 3 seconds later, clears its `ad-*` state class and calls `play()` on the content video. The "Recent events" list shows what happened (`removed 1 ad frame(s)`, `nudged player`, `video still paused`).
- Never fast-forwards a paused video, or any video longer than 3 minutes.

Not verified on the live site: whether MSN's player resumes cleanly after the ad frame is removed. If it stays stuck, capture again and send the log.

## When an ad is not detected (diagnostics)
1. After installing or reloading the extension, **refresh the msn.com tab**. Pages that were open before the reload do not get the new script.
2. Play a video. The popup's "Recent events" should show "video found" and "source change" entries. If it shows nothing, the extension is not running on that page.
3. While an ad is playing, click **Capture ad now** in the popup (or press **Alt+Shift+A**). Do it again during a second ad.
4. Click **Export log** and send the JSON file. It contains, for each video: the element chain around it, every element overlapping it (class names, text, position), iframes, the video source and duration, and the hosts/paths requested in the last 20 seconds. That is enough to write an exact rule for the ad.

The "source change" entries also show ad breaks as a timeline: a short clip appearing in the middle of a longer video.

## Reviewing and fixing mistakes
Open the popup:
- **Blocked domains / Learned selectors**: click **Remove** to undo a learned item. Removed items are remembered and will not be re-learned.
- **Candidates**: hosts seen during ads that have not met the threshold. Click **Block** to block one manually.
- **Recent ad events**: what was detected, how long it lasted, and what was learned.
- **Export log**: downloads everything (log, stats, learned items) as JSON. Page URLs are stored without query strings. Everything stays in your browser; nothing is sent anywhere.
- Turn off **Auto-block learned ad domains** to log candidates only and approve them by hand.

If a video breaks after a learned block, remove the most recent items in the popup.

## Notes
- The page-hiding CSS (`content.css`) cannot be switched off from the popup. To fully disable the extension, turn it off on `edge://extensions`.
- MSN changes its markup often. If an ad is not detected at all, play it, export the log, and look at the `cue` and `container` entries to find a selector to add to `BUILTIN_INDICATORS` in `content.js`.
- Edge also supports Chrome extensions, so this works in Chrome too.
