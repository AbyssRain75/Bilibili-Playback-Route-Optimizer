# User guide

[简体中文](usage.md) | English · [Project home](../README.en.md)

Applies to **1.1.0**, based on the current Chromium extension. Use Chrome / Edge 120 or later. A Firefox release and store installation are not available yet.

[Installation and updates](#installation-and-updates) · [Quick start](#quick-start) · [Panel and settings](#panel-and-settings) · [Route optimization](#route-optimization) · [Speed tests](#speed-tests) · [Marking problems](#marking-problems) · [Stats and exports](#stats-and-exports) · [Troubleshooting](#troubleshooting)

## Installation and updates

### First installation

1. Open the [latest release](https://github.com/AbyssRain75/Bilibili-Playback-Route-Optimizer/releases/latest). Under **Assets**, download `Bilibili-Playback-Route-Optimizer-<version>-chromium.zip`.
2. Extract it to a folder you intend to keep. Check that it directly contains `manifest.json`. GitHub's automatic **Source code** archives contain the whole release repository; for these installation steps, use the named extension zip.
3. Open `chrome://extensions` in the address bar, or `edge://extensions` in Edge. Turn on **Developer mode**.
4. Click **Load unpacked** and select the folder directly containing `manifest.json`.
5. Pin the extension icon from the toolbar's extensions menu, or choose **Show in toolbar** in Edge.
6. **Reload any Bilibili pages already open**, play a video or enter a live room, and click the extension icon.

Git users can clone this release repository and load its `chromium/` folder directly. No Node.js installation or build is needed.

### Update and keep your data

1. Export JSON from the stats page first if you want to keep a diagnostic copy.
2. Download and extract the new extension zip, checking that its files are present.
3. Replace all contents of the **original loaded extension folder** with the new files, keeping the same path. For a Git installation, run `git pull` in the release repository.
4. Click **Reload** on the extension's card in the extensions page, then reload open Bilibili pages.

Settings and records live in the browser's extension storage. **Do not remove the extension or move its loaded folder**: removal deletes its data, and loading from another path can create a different extension ID that cannot access the original data. JSON exports are for analysis; there is currently no record import feature.

## Quick start

The default is **Observe mode**. Watch normally to record actual media nodes, startup, stalls, and request performance.

To try automatic route selection:

1. Select the Bilibili tab that is playing and open the extension panel.
2. Keep **On** enabled at the top right. Under **Route settings**, enable **Route optimization**.
3. Leave **VOD node** and **Live protocol** on **Auto**. Enable **Auto speed test** as well if you want ongoing measurements.
4. Reload the Bilibili page. Selection happens when playback addresses are obtained; changing settings does not immediately replace an existing media connection.
5. Mark problems as they occur. If the panel offers **Reload for a new node**, use it when you can interrupt playback.

Optimization and periodic testing work independently. Testing alone leaves playback routes unchanged. Optimization alone can use recent problems and existing measurements, and may run follow-up tests.

## Panel and settings

The panel focuses on the selected tab. To inspect another playback, select its tab before opening the panel.

| Setting | Default | Purpose and when it applies |
|---|---|---|
| On | Enabled | Master switch. Turning it off pauses recording, URL rewriting, tests, and marking. Saved settings and records remain, and the page theme keeps working. What is already playing doesn't switch back to the original route by itself: reload after pausing to play with Bilibili's own settings, and reload again after enabling it |
| Route optimization | Off | Enables playback URL rewriting. Changes apply when fresh addresses are obtained; reload the current page to apply them |
| Auto speed test | Off | Enables periodic tests, subject to buffer checks |
| VOD node | Auto | Selects from recent problems and measurements, or a node chosen from the list; requires optimization |
| Live protocol | Auto | Automatic choice, **Prefer FLV**, or **Prefer HLS**; requires optimization |
| Mark button on the player | On | Shows the flag on the right of the player controls |
| Interface language | Browser language | Chinese for a Chinese browser interface, English otherwise. Switch manually at the top of the panel or stats page |
| Bilibili page theme | Unchanged | Switches Bilibili pages to Light, Dark, or System; open pages change right away. Not affected by **On** |
| Turn off Bilibili P2P (Experimental) | Off | Makes Bilibili's web player skip P2P and fetch videos and live streams over HTTP; mainly matters on networks in mainland China. Takes effect after reloading the page and does nothing while paused; see Turn off Bilibili P2P (Experimental) below |
| Keep records | 15 days | Set on the stats page: 7, 15, or 30 days, or 2–6 months, with 30 days per month |

The language button names its destination: **EN** switches to English; **中文** switches to Chinese. Switching back to the browser's language restores automatic selection. The panel, stats page, and player button change together; the browser's extensions-page description still follows the browser language.

**Bilibili page theme** uses Bilibili's own dark theme (the one under the avatar menu → Theme when signed in) and also works when signed out. Pages Bilibili has not made a dark version of stay as they are. With Light, Dark, or System selected, the extension sets Bilibili's theme cookie (`theme_style`) to match, switching the theme from Bilibili's avatar menu updates the panel, and switching it in the panel updates the avatar menu on open pages. **System** follows the system's light or dark appearance and switches open pages when it changes. **Unchanged** leaves the theme to Bilibili: light when signed out, the last chosen theme when signed in. To avoid a flash of light colors, the extension keeps a hint (`bilicdn:theme`, the theme you chose) in the localStorage of each Bilibili subdomain, so pages switch as soon as they open; after switching back to **Unchanged**, open pages remove it straight away and other subdomains remove it the next time a page opens there. The first page opened on a subdomain (such as `search.bilibili.com`) doesn't have the hint yet and may briefly show light colors.

### Turn off Bilibili P2P (Experimental)

In mainland China, Bilibili's web player often fetches most audio and video over Bilibili's own P2P (WebRTC connections between browsers; in tests, over 80% of a popular video and 60–90% of live streams). Data passes between your browser and other viewers: a few minutes of a live stream can upload tens of MB, videos you watched are stored in the browser for others to fetch, and the extension can't see that part (see Traffic the extension can't see below). Bilibili's website has no option to turn it off.

1. Turn on **Turn off Bilibili P2P (Experimental)** in the panel (it is off by default and leaves Bilibili's behavior unchanged).
2. **Reload the Bilibili page.** The player reads this setting only when it loads; pages already open don't change until reloaded.
3. Videos and live streams are then fetched over HTTP. Let it play for a while, then check the stats page: the hover note under **Media requests** and the node-map finding say how many sessions had P2P turned off. The overview includes earlier records from the selected range that did use P2P, so the P2P share may not drop to 0 straight away.

Keep in mind:

- This is an experimental feature, and **the switch in the extension has not yet been tested on a network in mainland China**. It is based on earlier tests on a mainland network where P2P was turned off by hand: video P2P dropped to 0, live streams no longer opened P2P connections, upload fell from tens of MB to about 1 MB, playback was normal and the first frame was not slower. Those tests covered only two low-bitrate videos and two live rooms on a data-center network; how it does on home broadband isn't known yet.
- It mainly matters on networks in mainland China. If the player wasn't using P2P anyway (as is mostly the case elsewhere), it makes little difference.
- On networks where P2P works well, playback may get slower. If it does, turn the switch off and reload the page.
- It relies on the player's internal settings. If Bilibili changes them, it stops working, which is the same as leaving things unchanged; playback is not affected.
- With P2P off, videos in mainland China may fetch much of their data from PCDN outside the extension's site access, which the extension still can't see (the stats page counts it as HTTP the extension can't see); with route optimization on Auto as well, the player switches to Bilibili's official mirrors where one is available.
- It does nothing while the extension is paused (**On** turned off). After turning the switch off or pausing the extension, reload the page to get P2P back. P2P data the browser already cached is not cleared.
- The extension only changes the switches the player reads in the page (the video player's settings and the live stream's playback assignment). It does not change the settings Bilibili has stored, does not remove the browser's WebRTC support, and needs no new permissions. It also keeps a hint (`bilicdn:p2p`) in the Bilibili page's localStorage so the setting applies even when it arrives late, and removes it when the switch is turned off.

Read **Now playing** together with **Advanced**:

| Reading | Meaning |
|---|---|
| Buffer ahead | Downloaded playback time still available. Little buffer and repeated spinning can indicate that the connection or node cannot keep up |
| Recent dropped frames | Frames lost during decoding or rendering. With enough buffer but many drops, try lower quality or check hardware decoding |
| Session stalls | Automatically detected buffering in the current playback session; waiting caused by seeking is distinguished |
| Nodes in use / Node details | Nodes actually serving requests, rather than every candidate returned by the playback API. Audio and video can use different nodes |
| Recent problems | Recent node and live-protocol evidence, including whether automatic selection will avoid them |
| Speed tests | Active test results, reasons for deferring tests, and whether playback addresses have expired |

Request **download speed** and test **score** use different calculations. Download speed mainly measures data transfer; test scores also account for first-byte waits and segment fetching. A live connection or small segments may have no request download-speed reading.

## Route optimization

### Videos: Auto or a chosen node

Auto avoids nodes judged to have recent stalls and avoids PCDN. If the assigned node has no recent problems, a candidate needs a test score roughly 20% higher to replace it. Keeping Bilibili's assigned official node is expected when there are no measurements or problems to act on.

Auto also looks at how real page requests perform (each node's first-byte time and failures over the last **30 minutes**). When the assigned node performs well on the page (at least 5 requests, median first byte no more than **60 ms**, under 10% failures), it is kept however high other nodes score in speed tests; a node that did worse on the page than the assigned one (more failures, or a first byte over 20% slower) is not chosen based on speed tests. A node needs **3** speed tests within 30 minutes before Auto switches to it; **Survey** tests each node once, which doesn't count. A node that already performs well on the page doesn't need to wait for those tests, though its score still has to be roughly 20% higher. When the assigned node has stalled or is PCDN and must be replaced, Auto prefers a node that performs well on the page, then the best-scoring node with enough tests, then Bilibili's assigned order.

Recent node evidence covers **30 minutes**, weighted by responsibility and severity. One **Few stalls** mark may not trigger a switch. Mirror names that connect to the same server share problem evidence, helping avoid a domain change that still reaches the same server.

After selecting a specific VOD node, reload the page to compare it. Return to **Auto** and reload if it performs poorly. Availability depends on the video addresses and your network. Original addresses remain as fallbacks, but successful fallback still depends on the player.

Backups are reordered too: official nodes before PCDN, with recently problematic nodes moved later. **main URL kept, backups reordered** means the main node stayed the same and only fallback order changed.

### Live streams: Auto, Prefer FLV, Prefer HLS

Live selection uses only the lines and formats Bilibili supplies for the current room; it cannot substitute arbitrary hosts. Supported web choices include FLV and HLS fmp4. If only HLS ts is available, or the requested format is absent, the extension will not force a nonexistent line.

- **Auto:** combines recent node problems, protocol problems at the current quality, measurements, and this network's history. It may choose FLV when HLS cannot keep up with the bitrate.
- **Prefer FLV:** tries an available FLV line.
- **Prefer HLS:** tries an available HLS fmp4 line.

Protocol problem evidence is kept by protocol and quality for **12 hours**. Consistently high HLS download occupancy means segment fetching consumes nearly all playback time, leaving little margin. A high test peak can therefore coexist with repeated buffering. Reload the room after changing protocol, then compare buffer and stalls.

### Network history and limits

Measurements are separated by Bilibili's detected country, region, and ISP. A city-only change does not count as a new network. Network changes reset recent rankings and problem evidence. Returning to a known network uses history to choose follow-up tests; VOD candidates must be retested before history is used to switch to them. Results usually help the next playback address load.

PCDN can be identified from domains, ports, IP addresses, or request parameters. The extension lowers its priority while keeping original addresses as final fallbacks. Request statistics cover only domains with granted host access and may miss other PCDN domains.

The extension does not bypass membership, payment, regional, or account restrictions, and does not change the player's quality or codec choice. Decoding, rendering, and synchronization problems may not improve by changing nodes.

## Speed tests

Periodic testing attempts a round every **30 seconds**, provided there have been recent media requests. A round tests up to 4 nodes sequentially, reading up to about **512 KB** per node, about **2 MB** per round, plus the playlists for HLS tests. This uses extra data. Rankings, recent test times, and failure backoff determine rotation; the whole list is not tested every round.

When player state is available, it is checked before each node:

- Videos: paused, or at least **15 seconds** buffered ahead; close to the end, buffered through to the end is enough.
- Live streams: not buffering, with at least **1 second** buffered.

Insufficient buffer defers testing. If buffer drops during a round, subsequent nodes wait. Follow-up tests triggered by optimization use the same checks. If player state cannot be read, periodic tests can proceed; follow-up tests wait first and can proceed if state is still unavailable after 20 seconds. Buffer headroom therefore cannot be verified in every page state.

The score estimates sustainable throughput, with failures counted as 0. A short test cannot predict every segment. To get past node caches, video tests fetch a piece from the middle of the file (which isn't guaranteed to be uncached), while playback mostly fetches cached popular content; first-byte times can differ tenfold, so automatic selection also considers real page requests (see Videos: Auto or a chosen node above). Measurements not updated within **30 minutes** stop being used for automatic node selection. Network history keeps each node's latest 12 scores from the past 7 days for follow-up tests and live protocol decisions.

Tests use the current playback addresses and stop with a notice when signatures approach expiry. Reload to obtain fresh addresses. Turning off **Auto speed test** stops periodic tests. To stop follow-up tests too, disable **Route optimization**, or turn off the master **On** switch.

## Marking problems

| Entry point | Action |
|---|---|
| Player flag | Click for **Many stalls**. Hover for playback state and **Normal**, **Few stalls**, **Many stalls**, **Won't play**, or **A/V out of sync** |
| Extension panel | Under **Report a problem**, enter an optional note before clicking the problem type. Notes have a 100-character limit |
| Keyboard shortcut | Default **Alt+Shift+K**, for **Many stalls** |

Use **Undo** in the panel after a mistake. For 1 minute after a mark, the player menu highlights the latest mark; choosing **Normal** undoes it. After 1 minute the highlight returns to **Normal**, while the record remains. You can also use the undo message shown just after marking.

Change the shortcut at `chrome://extensions/shortcuts` or `edge://extensions/shortcuts`. If it does not work, check assignment, conflicts with other software, and whether the extension is on.

Marks save playback position, buffer, frame drops, and related nodes, helping interpret the issue alongside automatic events. **A/V out of sync** and marks judged as dropped frames or buffer OK do not add node stall weight. Marking is unavailable with the master switch off or when the selected tab is not an eligible Bilibili page.

## Stats and exports

### Read the report

Click **Stats** at the top of the panel. Choose **Today**, **This week**, or **Since install**. Date ranges use browser local time and include only records that have not expired.

- **Media requests** (top): the number of media requests the extension recorded; the line below shows how much of the media traffic the extension sees, the P2P share, and how much was uploaded over P2P, plus how much the PCDN loader fetched when it was used. See Traffic the extension can't see below.
- **Node map:** summarised per network (country, region and ISP as Bilibili detects them); the current network is shown by default and the selector at the top right switches networks. It starts with a few conclusions (which kind of node Bilibili mostly assigns, how it performs on the page, whether a node is much faster, how much PCDN serves, which node stalls most, which nodes can't be reached, how much of the traffic the extension sees, and so on), then node-type shares, names on the same server and all nodes on that network; with two or more networks there is a side-by-side comparison. See Node map and survey below.
- **Node performance:** search hosts and filter **All nodes**, **With failures or stalls**, **Speed tested**, or **PCDN**. Compare first-byte time, speed, failures, stalls, and marks.
- **Problem marks:** inspect type, cause, notes, and playback position. Video position links can reopen the relevant point.
- **Session timeline:** inspect media requests, failures, startup, stalls, marks, and rewrites in context. Enable **All sessions** or click **Show more** when needed.
- **Network & pages:** inspect page-type distribution and network changes.

TTFB measures request start to response headers. Request throughput counts only sufficiently large responses. Direct browser-cache responses, deliberate aborts, and timeouts have distinct rules; expand **Definitions** at the bottom for details. **Refresh** on the stats page rereads records; it does not reload Bilibili playback.

### Node map and survey

Different places get different Bilibili nodes, and the same node can be fast in one place and slow in another: in some regions the assigned main node is the fastest, in others a backup node is dozens of times faster, and in mainland China PCDN is common. The extension therefore records and compares each network separately, and conclusions from one network are never applied to another.

- **Survey this network:** start a video or live room in a tab, then click this button on the stats page. Each candidate node of that video or live room is speed tested once: for videos, the assigned nodes, the built-in UPOS mirrors and a few mirrors tested only in surveys, about twenty nodes and roughly 10 MB; for live rooms, the lines Bilibili provides.
- It works with auto speed test off, but **On** has to be enabled. It still respects the buffer: when the buffer is low it waits, and stops after 2 minutes of waiting in total, keeping what it tested; paused videos are tested normally. With several pages playing, it tests the one that most recently loaded media.
- Results are recorded like auto speed tests and help pick candidates for "Auto"; each node is tested only once, so "Auto" waits for a few more auto or follow-up tests before switching to it based on scores (a node that already does well on the page doesn't have to wait). Only the current network can be surveyed.
- Mirrors that test well on this network but are not in the built-in list are included in later auto speed tests and considered by "Auto".
- Conclusions marked preliminary rest on few speed tests (survey tests don't count); keep auto speed test on for a while and check again. When the assigned node performs well on the page, the conclusion says so and doesn't suggest switching because another node scores higher.

### Traffic the extension can't see

The extension sees media requests through the browser's webRequest API, so it only sees HTTP requests to the Bilibili CDN domains in its permissions. In mainland China, Bilibili's web player often fetches most audio and video over Bilibili's own P2P (WebRTC connections between browsers; in tests, over 80% for a popular video and 60–90% for live streams), and without P2P it often uses PCDN domains outside the extension's site access. The extension can't see either, so its statistics, stall attribution, node map and route optimization only cover the part it sees.

- The extension reads the byte counts Bilibili's video player keeps per source (HTTP, Bilibili's P2P, the PCDN loader) and counts the bytes sent and received over WebRTC data channels on the page (the only source for live streams), every 30 seconds and when the page goes to the background or closes; Bilibili's player resets its own counts every 5 minutes and when the page closes, and the extension keeps the counts from just before each reset, so nothing is missed. It records byte counts only, never the content, and needs no new permissions; unless **Turn off Bilibili P2P (Experimental)** is on, it leaves Bilibili's P2P alone.
- Sessions with **Turn off Bilibili P2P** on are noted separately, and the stats page says how many there were, so a P2P share of 0 from turning it off isn't mistaken for a network that doesn't use P2P.
- "Seen" = media request bytes the extension recorded ÷ media data: for videos, the bytes the player counts; for live streams, request bytes plus bytes received over P2P. Whatever is neither seen nor P2P is HTTP the extension can't see (such as PCDN outside its site access); the node map mentions it when it reaches 5%. Bilibili's PCDN loader also fetches over HTTP; whatever of it the extension sees is already counted as seen, and the stats page adds a sentence on how much it fetched only when it was used. The line under **Media requests** at the top totals the selected range; the node map has one line per network, listed first when the extension sees less than half. P2P upload is shown separately (live P2P uploads, sometimes about as much as it downloads).
- Records from older versions, and sessions where the player's counts can't be read and P2P isn't used (live streams outside mainland China, for example), don't have this and count as unknown, not zero; the stats page says how many sessions the figure is based on.
- It relies on internal interfaces of Bilibili's player; if Bilibili changes them, this figure is simply missing and playback is unaffected.

### Export JSON

1. Choose a report range covering the problem.
2. Click **Export JSON**. **Standard export (redacted)** is selected by default.
3. Click **Export** to save the file. A full export requires an additional confirmation.

| Type | Information kept |
|---|---|
| Standard export (redacted) | Node hosts / IPs, country, and ISP. Problem sessions keep video or room URLs and mark notes. Other sessions have page URLs, video IDs, region, and city replaced with numbered labels; notes on undone marks are removed |
| Full export | Original records from the selected range, including browsing pages, network-location history, node IPs, and notes. Intended for your own investigation |

**A standard export can still contain personal details; review it before sharing. Keep full exports private.** Exporting saves a file and does not send it to the project or a third party. Necessary context for sessions in the selected range can also be included from outside that range.

### Retention and clearing

**Keep records** defaults to 15 days. If shortening it would delete records, the stats page shows the count and dates and asks for confirmation. Legacy records also prompt before their first deletion. Automatic pruning is batched, so expired data can remain for a few extra hours. Sessions crossing the cutoff retain necessary opening and assignment context.

**Clear all** requires confirmation. It deletes playback records and resets test rankings, recent problems, and network history, while keeping settings. Deletion cannot be undone; export anything you need first. Increasing retention does not restore deleted records.

## Privacy and permissions

Records stay in this browser's extension storage. The extension does not upload them or use analytics. It queries Bilibili's network-location API without cookies and saves country, region, city, and ISP to distinguish networks; it does not save the user's public IP returned by that API. CDN / PCDN node IPs from media requests are diagnostic records. To work out how much traffic it sees, the extension reads the byte counts Bilibili's player keeps per source and counts the bytes sent and received over WebRTC data channels on Bilibili pages; it records byte counts only, never the content. With Light, Dark, or System selected, the extension sets Bilibili's theme cookie (`theme_style`) to match and keeps a hint (`bilicdn:theme`) in the localStorage of each Bilibili subdomain; after switching back to **Unchanged**, the hint is removed and the cookie is left alone. With **Turn off Bilibili P2P (Experimental)** on, the extension only changes the P2P switches Bilibili's player reads in the page, not the settings Bilibili has stored, and keeps a hint (`bilicdn:p2p`) in the Bilibili page's localStorage, removed when the switch is turned off.

| Permission | Purpose |
|---|---|
| `storage`, `unlimitedStorage` | Store settings, records, tests, and network history locally |
| `webRequest` | Observe media-request nodes, IPs, timing, speed, and failures |
| `alarms` | Schedule periodic tests |
| `declarativeNetRequestWithHostAccess` | Set Bilibili's Referer and Origin only on the extension's own test requests |
| `*.bilibili.com` | Inject playback observation, selection, and marking, change the P2P switches the player reads when Bilibili's P2P is turned off, switch the page theme, and query network location |
| `*.bilivideo.com`, `*.bilivideo.cn`, `*.akamaized.net`, `*.szbdyd.com` | Observe media requests and test CDN / PCDN nodes |

Whether route optimization is on is also kept as a hint (`bilicdn:route`) in Bilibili pages' localStorage, so the next page can read it early; only the switch is stored, no playback records.

Pages without playback activity are not written to playback records. Playback addresses, media requests, or other playback activity cause a page to be recorded. To pause recording, URL rewriting, and tests, turn off **On** in the panel (the page theme keeps working).

## Troubleshooting

| Problem | What to do |
|---|---|
| Missing `manifest.json` | Extract the extension zip and choose the folder directly containing that file |
| No panel data or player flag | Select the Bilibili playback tab, check the extension, **On**, and **Mark button on the player**, then reload |
| Controls fail after an update | Reload the extension in the extensions page, then reload Bilibili |
| Choosing a node makes no difference | Enable optimization and reload. Auto keeps the assigned node without enough evidence; an unchanged primary can still have reordered backups |
| Empty or waiting speed tests | Enable testing and playback, allow enough buffer, and check address expiry, backoff, and test rotation |
| Test requests continue after testing is off | Optimization can trigger follow-up tests independently. Turn it off too, or use the master switch |
| HLS still buffers | Try **Prefer FLV**, reload the room, and compare buffer and stalls. Formats depend on the room |
| A note says the extension sees only part of the traffic | On this network most of Bilibili's audio and video comes over P2P or from PCDN the extension can't see, so statistics and route optimization only cover what it sees; see Traffic the extension can't see. By default the extension only reports the share and leaves Bilibili's P2P alone; to send the traffic over HTTP, try **Turn off Bilibili P2P (Experimental)** |
| Nothing changed after turning on **Turn off Bilibili P2P** | Reload the Bilibili page (the player reads this setting only when it loads) and check that **On** is enabled. It stops working if Bilibili changes the player's internal settings |
| Playback got slower after turning off Bilibili P2P | P2P may be faster on this network: turn the switch off and reload the page |
| High scores but playback stalls | Speed tests fetch uncached data and may not match playback; Auto considers real page requests and stops switching to nodes that did worse on the page. Mark the real problem and inspect recent problems and the timeline |
| Healthy buffer but choppy picture | Check dropped frames, quality, and decoding. A node change may not help |
| Optimization makes playback worse | Disable it and reload. Turn periodic testing off too to return to default observation |
| Old records absent from Since install | The range includes only retained data and cannot restore expired or manually deleted records |
| Dark selected, but some pages stay light | The extension uses Bilibili's own dark theme, so pages Bilibili has not made dark stay as they are. Open pages usually switch at once; reload any that did not |

For further help, open an [issue](https://github.com/AbyssRain75/Bilibili-Playback-Route-Optimizer/issues) with the extension and browser versions, video or live playback, settings, and reproduction steps. If attaching records, use a standard export covering the problem and review its contents first.

This project is released under **AGPL-3.0-or-later**. See [LICENSE](../LICENSE) for the full terms.
