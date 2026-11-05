# Bilibili Playback Route Optimizer

[简体中文](README.md) | English

A Chrome and Edge extension that shows which CDN nodes Bilibili videos and live streams actually come from, keeps track of stalls, and can try a faster route.

Out of the box it runs in **observe mode**: it only records, and Bilibili still picks the route. Turn on **Route optimization** to let the extension choose nodes, and **Auto speed test** to have it measure the nodes while there's enough video buffered. Both are off by default.

This is a personal project and has nothing to do with Bilibili. Whether a different route helps depends on your network, what you're watching and which nodes are available at the time; not every stall can be fixed by switching routes.

[Installation](#installation) · [Usage guide](#usage-guide) · [Updating](#updating-without-losing-records) · [Troubleshooting](#troubleshooting) · [Privacy](#privacy) · [Desktop app](#desktop-app-preview)

The [user guide](docs/usage.en.md) ([简体中文](docs/usage.md)) covers the details: every setting and its default, and how route selection and speed tests work.

If you watch in the Bilibili PC client on Windows, try the [desktop app](#desktop-app-preview) (preview).

## What it does

- **Shows what's playing right now.** The panel shows the buffer ahead, dropped frames, how many times playback stalled, and which nodes the audio and video are coming from.
- **Switches routes.** For videos, let the extension pick a node or choose one yourself. For live streams, let it decide or prefer the FLV or HLS lines Bilibili offers. The original addresses stay as fallbacks.
- **Tests nodes when the buffer allows.** With Auto speed test on, it tries a round every 30 seconds while a Bilibili page is playing, and waits when the buffer is low. Results are kept separately for each network.
- **Records stalls.** Buffering, slow starts and videos that won't start are logged automatically. You can also mark a problem from the player, the panel or a keyboard shortcut.
- **Maps nodes per network.** Different places get different nodes, and the same node can be fast in one place and slow in another. The stats page sums up, per network, which nodes Bilibili assigns, which servers they reach and how they perform, with a few conclusions. **Survey** speed-tests every candidate node of the video or live room that's playing.
- **Shows how much of the traffic it can see.** In mainland China, Bilibili's web player often gets most of the audio and video over Bilibili's own P2P (WebRTC connections between browsers), and some of the rest from PCDN outside the extension's site access. The extension can't see either. The stats page shows, per network, roughly how much the extension sees, how much came over P2P and how much was uploaded. When it sees less than half, it points out that statistics and route optimization only cover that part. By default it only counts bytes and leaves Bilibili's P2P alone.
- **Turns off Bilibili's P2P (Experimental).** Off by default. When on, Bilibili's web player stops using P2P and fetches videos and live streams over HTTP, so it no longer uses your upload. It mainly matters in mainland China and takes effect after you reload the page. On networks where P2P works well, playback may get slower, and since it relies on the player's internal settings, it stops working if Bilibili changes them. It hasn't been tested on a network in mainland China yet.
- **Keeps a history you can export.** The stats page brings together node performance, problem marks, session timelines and network changes, and can export JSON for analysis or bug reports.
- **Speaks Chinese and English.** The interface follows your browser's language, and the panel and stats page have a button to switch.
- **Switches Bilibili between light and dark.** It uses Bilibili's own dark theme, works without signing in, and can follow the system. Unchanged by default.

PCDN (also called MCDN) is made up of nodes such as home broadband connections that Bilibili rents. They serve ordinary HTTP requests and are not the same thing as the browser-to-browser P2P above. How well PCDN works varies a lot between networks. Automatic selection avoids the PCDN it can recognise and nodes that stalled recently; when there's no better node, it stays on the original route.

## Installation

You need **Chrome or Edge 120 or later**. The extension isn't in the stores yet, so for now you load it from a folder. Firefox isn't supported yet.

### 1. Download and extract

Go to the [latest release](https://github.com/AbyssRain75/Bilibili-Playback-Route-Optimizer/releases/latest) and download this file under **Assets**:

```text
Bilibili-Playback-Route-Optimizer-<version>-chromium.zip
```

Extract it to a folder you won't move later. Make sure you get this zip and not GitHub's automatic **Source code (zip)** or **Source code (tar.gz)**, which contain the whole repository. Once extracted, `manifest.json` sits right at the top of the folder.

### 2. Load it in your browser

| Browser | Open this address | Then |
|---|---|---|
| Chrome | `chrome://extensions` | Turn on **Developer mode** and click **Load unpacked** |
| Edge | `edge://extensions` | Turn on **Developer mode** and click **Load unpacked** |

Paste the address into the address bar. When picking the folder, choose the one that directly contains `manifest.json`; some unzip tools add an extra folder around it, in which case go one level deeper.

When **Bilibili Playback Route Optimizer** shows up in the list, check that it's enabled. Then click the puzzle-piece icon on the toolbar and pin it in Chrome, or choose **Show in toolbar** in Edge, so it's one click away.

### 3. Check that it works

1. Reload any Bilibili pages you already had open, then play a video or open a live room.
2. Click the extension icon to open the panel.
3. **On** at the top should be enabled and the mode should read **Observe mode**. **Now playing** shows the page you're watching, and data starts coming in.

That's it: the extension is recording. To let it pick routes, read on.

If you use Git, you can also clone this repository and load its `chromium/` folder directly. There's nothing to build and no need for Node.js. Chrome and Edge also explain loading unpacked extensions in their own guides: [Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked), [Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading).

## Usage guide

### Turn on route optimization

1. Open a Bilibili video or live room and click the extension icon.
2. Under **Route settings**, turn on **Route optimization**. If you want it to collect speed tests while you watch, turn on **Auto speed test** too.
3. To start with, leave **VOD node** and **Live protocol** on **Auto**.
4. Reload the Bilibili page. The new settings apply when the player fetches its playback addresses again.

The two switches are independent. Auto speed test on its own only collects measurements; playback stays on Bilibili's route. Route optimization on its own still uses recent stalls and any saved measurements, and may run an extra test while it picks a route.

For videos, **Auto** avoids nodes that stalled enough in the last 30 minutes; a single **Few stalls** mark won't necessarily trigger a switch. If the node Bilibili assigned has been fine, another node has to score at least 20% higher before Auto switches, so it doesn't flip back and forth over small differences. Right after installing, with no measurements and no stalls yet, staying on the assigned node is expected.

If the assigned node already does well on the page (real requests get their first byte quickly and rarely fail), Auto keeps it no matter how well other nodes score. Speed tests fetch a small piece of uncached data, which isn't the same as the popular content fetched during playback. A node also needs a few speed tests before Auto switches to it, and the single test from **Survey** doesn't count; a node that has already done well on the page doesn't have to wait.

To try a specific video node, pick it under **VOD node** and reload the page. If it doesn't help, go back to **Auto**. If a live stream still stalls on Auto, try **Prefer FLV** and **Prefer HLS**. Live streams can only use the lines and formats Bilibili offers for that room.

### Read the playback status

Switch to the Bilibili tab that's playing, then open the panel. **Now playing** shows the buffer ahead, recent dropped frames, session stalls and the nodes in use. Expand **Advanced** for **Recent problems**, **Speed tests** and **Node details**.

Read these together:

| What you see | What it probably means |
|---|---|
| Little buffer, and the player keeps spinning | The connection or the current node can't keep up. Mark it; with optimization on, reload to try another route |
| Plenty of buffer, but lots of dropped frames | Decoding or rendering is struggling. Try a lower quality or check that hardware decoding is on |
| Plenty of buffer, few dropped frames | There's enough data; changing nodes probably won't help |

When the extension can read the player's state, speed tests wait for the buffer: for videos, at least 15 seconds ahead (or buffered to the end when close to it), or a paused video; for live streams, not spinning and at least 1 second ahead. When it can't read the state, periodic tests may still run, so they can't be guaranteed never to affect playback.

A round tests up to 4 nodes, reading up to about 512 KB from each, roughly 2 MB in total, plus the playlists for HLS tests. Slow nodes are tested less often. **Survey** tests more nodes and uses extra data on top of that. No results right after installing, or tests on hold while the buffer is low, are both normal.

### Mark a playback problem

Use whichever is handiest:

- **Player button:** click the small flag on the right of the player's control bar to mark **Many stalls**. Hover over it to see the playback status and the other problem types.
- **Extension panel:** under **Report a problem**, click **Few stalls**, **Many stalls**, **Won't play** or **A/V out of sync**. To add a note, type it before clicking.
- **Shortcut:** press **Alt+Shift+K** to mark **Many stalls** without opening the panel.

If you marked something by mistake, click **Undo** in the panel to take back the latest mark on that page. Don't want the flag? Turn off **Mark button on the player**. You can change the shortcut at `chrome://extensions/shortcuts` or `edge://extensions/shortcuts`; if it does nothing, check whether another shortcut already uses those keys.

Each mark also records the buffer and dropped frames at that moment. Marks put down to decoding or rendering, and A/V sync marks, don't count against a node. If the panel shows **Reload for a new node**, click it when you don't mind interrupting playback, and the route is picked again; whether it lands on another node depends on what's available at the time.

### View and export records

Click **Stats** at the top of the panel and choose **Today**, **This week** or **Since install**. Below are **Node map**, **Nodes**, **Problem marks**, **Session timeline** and **Network & pages**.

**Node map** is split by network and shows the current one by default. Keep a video or live room playing, then click **Survey this network** on the stats page to speed-test each of its candidate nodes once. A video survey uses about 10 MB. If the buffer is low it waits, and gives up after 2 minutes of waiting in total. It works with auto speed test off, but **On** has to be enabled. With several pages playing, it tests the one that most recently loaded media. The stats refresh when it's done.

Under **Media requests** at the top, the page shows how much of the media traffic the extension sees, with the P2P share and upload, plus how much the PCDN loader fetched if it was used. The node map has the same line for each network. Records from older versions don't have this and count as unknown.

The stats only cover records that haven't expired; **Since install** can't bring back deleted data. Records are kept for **15 days** by default, and **Keep records** at the top of the stats page goes from 7 days to 6 months. If shortening it would delete records, the page asks first.

To report a problem, pick a range that includes it, click **Export JSON** and choose **Standard export (redacted)**. It has what's needed to investigate, but it still contains node hosts and IPs, plus the video or live-room addresses and notes for sessions that had problems, so have a look before you share it. **Full export** is the raw records for the range (plus the context needed to read them), browsing and network details included; keep it to yourself.

### Switch Bilibili between light and dark

Under **Bilibili page theme** in the panel, choose **Light**, **Dark** or **System**. Open Bilibili pages switch straight away, no reload needed. The default, **Unchanged**, leaves it to Bilibili's own setting. It uses Bilibili's own dark theme (signed in, you can also switch it from the avatar menu → Theme, and the two stay in sync), so pages Bilibili hasn't made a dark version of stay as they are. This only changes page colors, and it keeps working while the extension is paused.

### Turn off Bilibili's P2P (Experimental)

In tests on networks in mainland China, Bilibili's web player got most of the audio and video over Bilibili's own P2P, passing data back and forth between your browser and other viewers. It uses your upload (a few minutes of a live stream can send out tens of MB), keeps videos you've watched in the browser for others to fetch, and the extension can't see any of it. Bilibili's website has no option to turn it off.

Turn on **Turn off Bilibili P2P (Experimental)** in the panel, then **reload the Bilibili page**. The player stops using P2P and fetches videos and live streams over HTTP. The switch is off by default and leaves Bilibili alone. A few things to know:

- It's experimental, and **the switch in the extension hasn't been tested on a network in mainland China yet**. P2P was only turned off by hand before, on a mainland data-center network, with two low-bitrate videos and two live rooms; they played normally and weren't slower. How it does on home broadband isn't known yet.
- It mainly matters in mainland China. If the player wasn't using P2P anyway (as is mostly the case elsewhere), it makes little difference.
- On networks where P2P works well, playback may get slower. If it does, turn the switch off and reload the page.
- It relies on the player's internal settings. If Bilibili changes them, it stops working and things behave as if it were off.
- With P2P off, PCDN outside the extension's site access is still invisible to it.
- It does nothing while the extension is paused. After turning the switch off or pausing the extension, reload the page to get P2P back. P2P data already cached in the browser isn't cleared.

After reloading, let it play for a while, then check the traffic figures and the number of sessions with P2P turned off on the stats page. The overview includes earlier records from the selected range that did use P2P, so the P2P share may not drop to 0 straight away.

### Pause the extension or switch language

Turn off **On** at the top of the panel to pause the extension: no recording, no further address rewriting, no speed tests. Your settings and records stay, and the Bilibili page theme keeps working. Whatever is already playing doesn't switch back to the original route by itself; reload the page after pausing to play it with Bilibili's own settings. After turning it back on, reload again so the current playback is recorded in full.

To just go back to Bilibili's own routes, turn off **Route optimization** and reload the page. Turn off **Auto speed test** as well if you don't want periodic tests either.

The **中文 / EN** button at the top of the panel or stats page switches the language, and the player button follows.

## Updating without losing records

1. If you like, export your records from the stats page first. The JSON is for analysis; it can't be imported back to restore records.
2. Download and extract the new zip, and check that it extracted fully and contains `manifest.json`.
3. Empty the **folder you originally loaded**, then copy the new files into it, keeping the folder itself and its location. If you installed with Git, just run `git pull` in the release repository.
4. Open the browser's extensions page and click **Reload** on the extension's card.
5. Reload any open Bilibili pages.

Records and settings live in the browser's extension storage, so replacing the files and reloading keeps them. **Don't click Remove, and don't move the folder**: removing the extension deletes its data, and loading an unpacked extension from a different path can make the browser treat it as a different extension.

## Troubleshooting

| Problem | What to try |
|---|---|
| Loading says `manifest.json` is missing | Extract the zip first, then pick the folder that directly contains that file |
| Can't find the icon | Open the browser's extensions menu (the puzzle piece), check the extension is enabled, then pin it or show it in the toolbar |
| The panel shows no playback data | Switch to a Bilibili video or live-room tab, check that **On** is enabled, then reload the page and start playing |
| Changed settings but the node didn't change | Reload the page. Routes are picked when playback addresses are fetched, and Auto keeps the current node if there's no reason to switch |
| Speed test results stay empty | Check that **Auto speed test** is on, start playing, and give it time to build up buffer and run a round |
| The stats show less traffic than you watched, with a note that the extension sees only part of it | In mainland China, Bilibili's web player often gets most of the audio and video over its own P2P, or from PCDN outside the extension's site access. The extension can't see that part, so statistics, stall attribution and route optimization only cover what it sees. By default it just reports the share and leaves Bilibili's P2P alone. You can try **Turn off Bilibili P2P (Experimental)**, but it doesn't help with PCDN and can't guarantee the extension sees everything |
| Nothing changed after turning on "Turn off Bilibili P2P" | Reload the Bilibili page, since the player reads this setting when it loads, and check that **On** is enabled. It stops working if Bilibili changes the player's internal settings |
| A high-scoring node still stalls | Speed tests fetch uncached data, so a high score doesn't mean fast playback. Auto also looks at how real page requests do: once a node does worse on the page than the assigned one, Auto stops switching to it based on speed tests. Mark the stalls and Auto will avoid that node |
| Playback got worse with optimization on | Turn off **Route optimization** and reload. To compare with plain observation, turn off **Auto speed test** too |
| Buttons stopped working after an update | Reload the extension, then reload the Bilibili page so the page scripts match the new version |

Still stuck? Open an [issue](https://github.com/AbyssRain75/Bilibili-Playback-Route-Optimizer/issues) with your browser and extension versions, whether it's a video or a live stream, your route settings and how to reproduce it. A standard JSON export covering the problem makes it much easier to track down.

## Privacy

- Records stay in the extension's storage on your device. The extension doesn't upload them and doesn't use any analytics service.
- To keep measurements separate per network, it queries Bilibili's network-location API (`api.bilibili.com/x/web-interface/zone`, without cookies) and saves the country, region, city and ISP Bilibili returns, but not your public IP. The IPs of CDN nodes serving media requests are recorded for diagnosis.
- With Auto speed test or Route optimization on, or when you start a **Survey**, the extension may send test requests to Bilibili's CDN nodes, which uses the extra data described above.
- Only pages with playback are recorded; pages without it, such as profiles or feeds, are not.
- To work out how much traffic it sees, the extension reads the byte counts Bilibili's player keeps per source, and counts the bytes sent and received over WebRTC data channels on Bilibili pages (Bilibili's P2P uses them). It records byte counts only, never the content, and keeps them on your device like everything else.
- With Light, Dark or System selected, the extension sets Bilibili's own theme cookie (`theme_style`) to match, which Bilibili uses to pick the theme when you're signed in. It also keeps a hint (`bilicdn:theme`, the theme you chose) in the localStorage of each Bilibili subdomain, so pages switch colors as soon as they open instead of flashing light first. After switching back to **Unchanged**, open pages drop the hint straight away and other subdomains drop it the next time a page opens there; the cookie is left alone.
- Whether route optimization is on is also kept as a hint (`bilicdn:route`) in Bilibili pages' localStorage, so the next page can read it early. Only the switch is stored, no playback records.
- With "Turn off Bilibili P2P" on, the extension only changes the P2P switches Bilibili's player reads in the page, not the settings Bilibili has stored. It also keeps a hint (`bilicdn:p2p`) in the Bilibili page's localStorage and removes it when the switch is turned off.
- Expired records are deleted automatically. The standard export only redacts some details and still contains problem-session addresses, mark notes and node IPs, so check it before sharing; don't share full exports publicly.

## Permissions

| Permission | Why |
|---|---|
| `storage`, `unlimitedStorage` | Save settings, records and test results on your device, without hitting the default storage limit as records grow |
| `webRequest` | Watch media requests for nodes, IPs, timing, throughput and failures; it only observes and never blocks or changes requests |
| `alarms` | Schedule an Auto speed test round every 30 seconds |
| `declarativeNetRequestWithHostAccess` | Set the Bilibili Referer and Origin the CDN requires, only on the extension's own test requests; page requests are untouched |
| `*.bilibili.com` | Read playback information, rewrite playback addresses when optimization is on, change the P2P switches the player reads when Bilibili's P2P is turned off, detect stalls, show the player button, switch the page theme and query network location |
| `*.bilivideo.com`, `*.bilivideo.cn`, `*.akamaized.net`, `*.szbdyd.com` | Watch media requests and test Bilibili CDN and PCDN nodes |

## Desktop app (preview)

The desktop app brings the extension's observation, route selection, speed tests and problem marking to the **Bilibili PC client on Windows**. It starts the client and connects to it, puts the extension's page scripts into the client's player and live windows, and runs the extension's background unchanged, so records, route selection and speed tests follow the same rules as the extension. The panel and stats page open in your default browser. It is a preview (0.x), tested with client 1.19.0 and its automatic 1.20.0 update.

### Install and start

1. On [Releases](https://github.com/AbyssRain75/Bilibili-Playback-Route-Optimizer/releases), find the desktop release marked **Pre-release** (its tag starts with `desktop-v`) and download `Bilibili-Playback-Route-Optimizer-Desktop-<version>-win-x64.zip`.
2. Extract it to a folder. The zip includes the official Node.js runtime (`node\node.exe`), so there is nothing else to install.
3. **Fully quit** the Bilibili client from the tray first (right-click the tray icon → Exit), then double-click `start.cmd` in the folder.

A console window opens. The desktop app starts the client, connects, and opens the panel in your browser. In the console, press `p` for the panel, `s` for the stats page and `q` to quit; closing the console window also quits the client cleanly. As with the extension, it starts in observation mode with route optimization and auto speed test off.

### How it differs from the extension

- Windows (64-bit) only. It only connects to player and live windows; the client's home page and other windows are left alone.
- The client has to be started by the desktop app. If it is already running, quit it from the tray first; the desktop app waits and then starts it.
- Records and settings are separate from the browser extension and are stored in `%APPDATA%\bpro-desktop`.
- There is no Bilibili page theme and no Alt+Shift+K shortcut; mark problems with the flag on the player or in the panel.
- **Reload for a new node** reloads the client's player window, which resumes from the same position.

### Privacy and risks

- The desktop app starts the client with a debugging port. The port is bound to this computer only (127.0.0.1), random each time, and closes with the client when you quit. While it is open, other programs on this computer could in principle use it to control the logged-in client.
- The desktop app doesn't modify the client's files and doesn't read cookies or login information. The panel and stats page are served by a web server bound to this computer only, with a token in the address that is generated at each start. Records stay on this computer.
- This is an unofficial tool, and Bilibili may treat it as third-party use. A client update could also break it (for example by turning off the debugging port). Antivirus software may flag a program that starts another program with a debugging port.

See the [Desktop app](docs/usage.en.md#desktop-app-preview) section of the user guide for more, including updating and troubleshooting.

## Credits

These projects shaped the design, though none of their code is used here:

- [stabruriss/bilibili-accelerator](https://github.com/stabruriss/bilibili-accelerator): testing only when the buffer allows, spotting and deprioritizing PCDN, and respecting Akamai's signatures.
- [bilibili-cdn-switcher](https://github.com/a0972199950/bilibili-cdn-switcher): keeping the original addresses as fallbacks and trying Bilibili's own backups on errors.
- [Shaka Player](https://github.com/shaka-project/shaka-player): grouping playback statistics.
- [enhanced-h264ify](https://github.com/alextrv/enhanced-h264ify): notes on hardware decoding support.

## License

Copyright (C) 2026 AbyssRain75

This project is open source under the GNU Affero General Public License, version 3 or any later version (AGPL-3.0-or-later):

- You may use, modify and redistribute it freely
- If you release a modified version, it must use the same license and make its source code available
- It comes with no warranty

See [LICENSE](LICENSE) for the full terms.
