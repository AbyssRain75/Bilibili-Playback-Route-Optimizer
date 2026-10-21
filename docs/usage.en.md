# User guide

[简体中文](usage.md) | English · [Project home](../README.en.md)

Applies to **1.0.1**, based on the current Chromium extension. Use Chrome / Edge 120 or later. A Firefox release and store installation are not available yet.

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
| On | Enabled | Master switch. Turning it off pauses recording, URL rewriting, tests, and marking. Saved settings and records remain. Reload Bilibili after enabling it again |
| Route optimization | Off | Enables playback URL rewriting. Changes apply when fresh addresses are obtained; reload the current page to apply them |
| Auto speed test | Off | Enables periodic tests, subject to buffer checks |
| VOD node | Auto | Selects from recent problems and measurements, or a node chosen from the list; requires optimization |
| Live protocol | Auto | Automatic choice, **Prefer FLV**, or **Prefer HLS**; requires optimization |
| Mark button on the player | On | Shows the flag on the right of the player controls |
| Interface language | Browser language | Chinese for a Chinese browser interface, English otherwise. Switch manually at the top of the panel or stats page |
| Keep records | 15 days | Set on the stats page: 7, 15, or 30 days, or 2–6 months, with 30 days per month |

The language button names its destination: **EN** switches to English; **中文** switches to Chinese. Switching back to the browser's language restores automatic selection. The panel, stats page, and player button change together; the browser's extensions-page description still follows the browser language.

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

Periodic testing attempts a round every **30 seconds**, provided there have been recent media requests. A round tests up to 4 nodes sequentially, downloading up to **512 KB** per node, about **2 MB** per round. This uses extra data. Rankings, recent test times, and failure backoff determine rotation; the whole list is not tested every round.

When player state is available, it is checked before each node:

- Videos: paused, or at least **15 seconds** buffered ahead.
- Live streams: not buffering, with at least **1 second** buffered.

Insufficient buffer defers testing. If buffer drops during a round, subsequent nodes wait. Follow-up tests triggered by optimization use the same checks. If player state cannot be read, periodic tests can proceed; follow-up tests wait first and can proceed if state is still unavailable after 20 seconds. Buffer headroom therefore cannot be verified in every page state.

The score estimates sustainable throughput, with failures counted as 0. A short test cannot predict every segment. Measurements not updated within **30 minutes** stop being used for automatic node selection. Network history keeps each node's latest 12 scores from the past 7 days for follow-up tests and live protocol decisions.

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

- **Node performance:** search hosts and filter **All nodes**, **With failures or stalls**, **Speed tested**, or **PCDN**. Compare first-byte time, speed, failures, stalls, and marks.
- **Problem marks:** inspect type, cause, notes, and playback position. Video position links can reopen the relevant point.
- **Session timeline:** inspect media requests, failures, startup, stalls, marks, and rewrites in context. Enable **All sessions** or click **Show more** when needed.
- **Network & pages:** inspect page-type distribution and network changes.

TTFB measures request start to response headers. Request throughput counts only sufficiently large responses. Direct browser-cache responses, deliberate aborts, and timeouts have distinct rules; expand **Definitions** at the bottom for details. **Refresh** on the stats page rereads records; it does not reload Bilibili playback.

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

Records stay in this browser's extension storage. The extension does not upload them or use analytics. It queries Bilibili's network-location API without cookies and saves country, region, city, and ISP to distinguish networks; it does not save the user's public IP returned by that API. CDN / PCDN node IPs from media requests are diagnostic records.

| Permission | Purpose |
|---|---|
| `storage`, `unlimitedStorage` | Store settings, records, tests, and network history locally |
| `webRequest` | Observe media-request nodes, IPs, timing, speed, and failures |
| `alarms` | Schedule periodic tests |
| `declarativeNetRequestWithHostAccess` | Add Bilibili's Referer only to the extension's own test requests |
| `*.bilibili.com` | Inject playback observation, selection, and marking, and query network location |
| `*.bilivideo.com`, `*.bilivideo.cn`, `*.akamaized.net`, `*.szbdyd.com` | Observe media requests and test CDN / PCDN nodes |

Pages without playback activity are not written to playback records. Playback addresses, media requests, or other playback activity cause a page to be recorded. To pause all extension activity, turn off **On** in the panel.

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
| High scores but playback stalls | Mark the real problem and inspect recent problems and the timeline. Short tests, real media segments, and cache state can differ |
| Healthy buffer but choppy picture | Check dropped frames, quality, and decoding. A node change may not help |
| Optimization makes playback worse | Disable it and reload. Turn periodic testing off too to return to default observation |
| Old records absent from Since install | The range includes only retained data and cannot restore expired or manually deleted records |

For further help, open an [issue](https://github.com/AbyssRain75/Bilibili-Playback-Route-Optimizer/issues) with the extension and browser versions, video or live playback, settings, and reproduction steps. If attaching records, use a standard export covering the problem and review its contents first.

This project is released under **AGPL-3.0-or-later**. See [LICENSE](../LICENSE) for the full terms.
