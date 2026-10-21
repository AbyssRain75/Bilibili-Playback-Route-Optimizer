# Bilibili Playback Route Optimizer

[简体中文](README.md) | English

A Chrome and Edge extension for checking which CDN nodes Bilibili videos and live streams use, finding playback problems, and trying a better route.

After installation, it starts in **observe mode**: it records playback and connection data while Bilibili chooses the route as usual. To let the extension choose nodes, turn on **Route optimization**. You can also enable **Auto speed test** to measure available nodes when there is enough buffered video. Both options are off by default.

This is an independent project, with no affiliation to Bilibili. Results depend on your network, the video, and the available nodes; changing routes will not fix every playback problem.

[Installation](#installation) · [Usage guide](#usage-guide) · [Updating](#updating-without-losing-records) · [Troubleshooting](#troubleshooting) · [Privacy](#privacy)

See the [full user guide](docs/usage.en.md) ([简体中文](docs/usage.md)) for detailed steps, setting defaults, route selection, and speed test rules.

## What it does

- **Shows the current playback state.** Check the buffer, dropped frames, stalls, and nodes actually serving the video in the extension panel.
- **Helps choose a route.** For videos, use automatic selection or pick a node yourself. For live streams, use automatic selection or prefer FLV or HLS from the lines Bilibili provides. The original addresses remain as fallbacks.
- **Tests nodes when the buffer allows.** With Auto speed test on, the extension runs a round every 30 seconds while a Bilibili page is playing, subject to buffer checks. Results are saved separately for each network.
- **Records playback problems.** It detects buffering and slow or failed starts. You can also mark a problem from the player, the extension panel, or a keyboard shortcut.
- **Keeps a playback history.** The stats page brings together node performance, problem marks, session timelines, and network changes, with JSON export.
- **Supports Chinese and English.** The interface follows your browser's language. Use the language button in the panel or stats page to switch manually.

PCDN (also called MCDN) uses connections such as home broadband and P2P nodes. Its performance can vary between networks. Automatic route selection avoids PCDN and nodes with recent stalls; it does not assume the same node is best everywhere.

## Installation

Use **Chrome or Edge 120 or later**. The extension is not in the stores yet, so it needs to be loaded from a local folder. Firefox is not supported yet.

### 1. Download and extract

Open the [latest release](https://github.com/AbyssRain75/Bilibili-Playback-Route-Optimizer/releases/latest). Under **Assets**, download:

```text
Bilibili-Playback-Route-Optimizer-<version>-chromium.zip
```

Extract it to a folder you intend to keep. Choose the named zip above rather than GitHub's automatically generated **Source code (zip)** or **Source code (tar.gz)** archives. The extension zip contains `manifest.json` at its root.

### 2. Load it in your browser

| Browser | Address to open | Steps |
|---|---|---|
| Chrome | `chrome://extensions` | Turn on **Developer mode**, then click **Load unpacked** |
| Edge | `edge://extensions` | Turn on **Developer mode**, then click **Load unpacked** |

Paste the address into the browser's address bar. In the folder picker, select the extracted folder that directly contains `manifest.json`. If extraction created an extra outer folder, open it and select the folder inside.

Once **Bilibili Playback Route Optimizer** appears in the extensions list, make sure it is enabled. Open the puzzle-piece menu on the toolbar and pin the icon in Chrome, or choose **Show in toolbar** in Edge, for easy access.

### 3. Check that it is working

1. Reload any Bilibili pages that were already open, then play a video or enter a live room.
2. Click the extension icon to open its panel.
3. Check that **On** is enabled and the mode reads **Observe mode**. **Now playing** should show the current page and begin displaying playback data.

At this point, recording is active. To enable route selection, follow the steps below.

If you prefer Git, clone this repository and load its `chromium/` folder. There is no need to install Node.js or run a build. The browser's loading steps are also described in the official [Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) and [Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading) guides.

## Usage guide

### Enable route optimization

1. Open a Bilibili video or live room, then click the extension icon.
2. Under **Route settings**, turn on **Route optimization**. Enable **Auto speed test** as well if you want it to gather node measurements while you watch.
3. Start with **VOD node → Auto** and **Live protocol → Auto**.
4. Reload the Bilibili page to apply the settings to a fresh playback load.

The two switches work independently. Auto speed test alone gathers measurements while leaving Bilibili's route unchanged. Route optimization can use recent problems and saved test results even when periodic speed tests are off; it may also run a follow-up test while choosing a route.

With automatic video selection, the extension avoids nodes that stalled within the last 30 minutes. When the assigned official node has no recent problems, a candidate needs a score at least 20% higher before the extension switches to it. This helps avoid frequent changes for small differences. If there are no measurements or problems to act on, keeping the assigned node is expected.

To try a specific video node, choose it under **VOD node** and reload the page. If it performs poorly, switch back to **Auto** and reload. For live streams, try **Prefer FLV** or **Prefer HLS** if Auto is not working well. Live selection is limited to the lines and formats Bilibili offers for that room.

### Read the playback status

Open the panel while the Bilibili tab is selected. **Now playing** shows buffer ahead, recent dropped frames, session stalls, and nodes in use. **Advanced** contains **Recent problems**, **Speed tests**, and **Node details**.

Use the readings together:

| What you see | What it suggests |
|---|---|
| Low buffer and repeated buffering | The connection or current node may not be keeping up. Mark the problem; with optimization on, reload to try another route |
| Healthy buffer but many dropped frames | Decoding or rendering may be struggling. Try lower quality or check hardware decoding |
| Healthy buffer and few dropped frames | Playback currently has enough data; there may be no benefit from changing nodes |

Speed tests wait for enough buffer: at least 15 seconds ahead for videos, or a paused video; at least 1 second for live streams. Each node test downloads up to 512 KB, with about 2 MB at most per round. Poorly performing nodes are tested less often. An empty results list just after installation, or a paused test while buffering, is normal.

### Mark a playback problem

Use whichever method is easiest while watching:

- **Player button:** click the small flag on the right of the player's control bar to mark **Many stalls**. Hover over it for playback details and the other mark options.
- **Extension panel:** under **Report a problem**, choose **Few stalls**, **Many stalls**, **Won't play**, or **A/V out of sync**. Add a note if useful. To include it, type the note before clicking a problem button.
- **Shortcut:** press **Alt+Shift+K** to mark **Many stalls** without opening the panel.

Use **Undo** in the panel if you marked by mistake. To hide the flag, turn off **Mark button on the player**. Change the shortcut at `chrome://extensions/shortcuts` or `edge://extensions/shortcuts`; if it does nothing, check whether another shortcut has taken the key combination.

Marks capture the buffer and dropped frames at that moment. Marks attributed to decoding or rendering, and A/V sync marks, do not count against a node. If the panel offers **Reload for a new node**, use it when you are ready to interrupt playback and try another route.

### View and export records

Click **Stats** at the top of the panel. Choose **Today**, **This week**, or **Since install**, then browse **Nodes**, **Problem marks**, **Session timeline**, and **Network & pages**. The range covers retained records; **Since install** does not recover records that have already expired.

Records are kept for **15 days** by default. Change **Keep records** at the top of the stats page to between 7 days and 6 months. Shortening the period asks for confirmation if records would be deleted.

To report a problem, select a range that includes it, click **Export JSON**, and choose **Standard export (redacted)**. This keeps the data needed to investigate. It still includes node hosts and IPs, and the video or live-room URLs and notes for sessions with problems, so review the file before sharing. **Full export** includes all retained browsing and network details; keep it private.

### Pause the extension or switch language

Turn off **On** at the top of the panel to pause recording, URL rewriting, and speed tests. Settings and saved records remain available. After turning it back on, reload the Bilibili page so it can be recorded fully.

Turning off **Route optimization** returns future playback loads to Bilibili's routes; reload the current page to apply it. Turn off **Auto speed test** too if you no longer want periodic tests.

The **中文 / EN** button at the top of the panel or stats page switches the interface language, including the player button.

## Updating without losing records

1. Optionally export your records from the stats page first.
2. Download and extract the new extension zip. Check that it contains `manifest.json`.
3. Empty the **original extension folder**, then copy the new files into that same folder. Keep its path unchanged. If you installed with Git, run `git pull` instead.
4. Open the browser's extensions page and click **Reload** on the extension's card.
5. Reload any open Bilibili pages.

Records and settings are held in the browser's extension storage, so replacing the files and reloading keeps them. **Do not remove the extension or move its folder**: removal deletes its data, and loading an unpacked extension from another path can give it a different identity.

## Troubleshooting

| Problem | What to check |
|---|---|
| Loading reports a missing `manifest.json` | Extract the zip first, then select the folder directly containing that file |
| The icon is missing | Open the browser's extensions menu, check that the extension is enabled, and pin or show it in the toolbar |
| The panel has no playback data | Select a Bilibili video or live-room tab, check **On**, then reload the page and start playback |
| Settings changed but the node did not | Reload the page. Optimization acts when playback addresses are loaded, and Auto can keep the current node if there is no reason to switch |
| Speed test results are empty | Check **Auto speed test**, play a video, and allow enough buffer and time for a round to run |
| A high-scoring node still stalls | Mark the problem and try Auto again. Short tests cannot predict every request, and uncached content may take longer to arrive |
| Playback became worse with optimization | Turn off **Route optimization** and reload. Stop **Auto speed test** too if you want to compare with observation alone |
| Controls stopped responding after an update | Reload the extension, then reload the Bilibili page so its scripts match the new version |

For unresolved problems, open an [issue](https://github.com/AbyssRain75/Bilibili-Playback-Route-Optimizer/issues) with the browser and extension versions, whether it affects videos or live streams, your route settings, and steps to reproduce it. A standard JSON export covering the problem is helpful.

## Privacy

- Records stay in extension storage on your device. The extension does not upload them or use an analytics service.
- It queries Bilibili's network-location API (`api.bilibili.com/x/web-interface/zone`, without cookies) to separate measurements by network. It saves the country, region, city, and ISP returned by Bilibili, but not your public IP. CDN node IPs are recorded as part of media-request diagnostics.
- With Auto speed test or Route optimization enabled, the extension can send test requests to Bilibili CDN nodes. These tests use additional data, as described above.
- It records pages with playback activity. Pages without playback activity, such as profiles or feeds, are not recorded.
- Expired records are deleted automatically. The standard export redacts some details, but still contains problem-session URLs, mark notes, and node IPs. Review exports before sharing, and keep full exports private.

## Permissions

| Permission | Purpose |
|---|---|
| `storage`, `unlimitedStorage` | Save settings, records, and test results locally, including records that exceed the default storage quota |
| `webRequest` | Observe media-request nodes, IPs, timing, throughput, and failures; this observer does not block or modify requests |
| `alarms` | Schedule Auto speed test rounds every 30 seconds |
| `declarativeNetRequestWithHostAccess` | Add Bilibili's required Referer to the extension's own test requests; page requests are unaffected |
| `*.bilibili.com` | Read playback information, rewrite playback URLs when enabled, detect stalls, show the player button, and query network location |
| `*.bilivideo.com`, `*.bilivideo.cn`, `*.akamaized.net`, `*.szbdyd.com` | Observe media requests and test Bilibili CDN and PCDN nodes |

## Credits

These projects informed the design. No code from them is included:

- [stabruriss/bilibili-accelerator](https://github.com/stabruriss/bilibili-accelerator): testing when buffer allows, identifying and deprioritizing PCDN, and respecting Akamai signatures.
- [bilibili-cdn-switcher](https://github.com/a0972199950/bilibili-cdn-switcher): retaining original addresses and trying Bilibili's own backups on errors.
- [Shaka Player](https://github.com/shaka-project/shaka-player): grouped playback statistics.
- [enhanced-h264ify](https://github.com/alextrv/enhanced-h264ify): information about hardware decoding support.

## License

Copyright (C) 2026 AbyssRain75

This program is free software, licensed under the GNU Affero General Public License, **version 3 or (at your option) any later version** (`AGPL-3.0-or-later`). You may redistribute and modify it under those terms.

It is provided without warranty, including any implied warranty of merchantability or fitness for a particular purpose. See [LICENSE](LICENSE) for the full terms. A copy is included in both the extension folder and the release zip.
