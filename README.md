# Bilibili Playback Route Optimizer

English | [简体中文](README.zh-CN.md)

A Chrome and Edge extension that observes and optimizes the CDN routes used by Bilibili (bilibili.com) videos and live streams.

By default it runs in **observe mode**: it only records, and changes nothing. It records which nodes the player was assigned, which nodes the media actually came from, each node's time to first byte and throughput, and where playback stalled. Turn on **Route optimization** and the extension rewrites the playback URLs before the player receives them, moving to faster nodes and away from nodes that recently stalled and from PCDN. Turn on **Auto speed test** and it measures the nodes while the buffer is healthy, and uses the results to pick nodes. Both switches are off by default.

> This project is not affiliated with Bilibili and is not an official tool.

## Features

- **Observe and record**: the node assignment of every playback; each media request's node, IP, time to first byte, throughput and failures; startup time and stalls. See the current page in the popup and the totals on the stats page.
- **Route optimization** (off by default):
  - Videos: pin a node, or choose "Auto". Auto avoids nodes that stalled in the last 30 minutes, moves off PCDN to official nodes, and with speed test results only switches when a node scores at least 20% higher than the assigned one, so it doesn't flip back and forth. The original URLs stay as backups, and the player falls back to them if the new node fails.
  - Live: choose FLV or HLS among the lines Bilibili provides, and within a line put PCDN after official hosts and recently stalled hosts last. Auto switches to the other format when one keeps stalling at the current quality, and to FLV when HLS speed tests can't keep up with the bitrate.
- **Auto speed test** (off by default): while a Bilibili page is playing, one round every 30 seconds, and only when the buffer is healthy (videos: at least 15 seconds ahead, or paused; live: at least 1 second), so it doesn't compete with playback. Each node downloads at most 512 KB, up to about 2 MB per round, and nodes that test poorly are tested less often. Results are kept per network and reused when you're back on the same network.
- **Stall detection and manual marks**: detects buffering stalls, slow starts and failed starts, and splits the blame among the nodes by their requests at the time. When playback feels bad, mark it with the flag on the player's control bar, the buttons in the popup, or Alt+Shift+K. A mark also records the buffer ahead and dropped frames, which tells network problems apart from decoding that can't keep up.
- **Stats page**: node table (requests, failure rate, first byte, throughput, speed tests, stalls), manual marks, session timeline and network changes, filtered by today, this week or since install, with JSON export.
- **English and Chinese UI**: follows the browser's UI language, and can be switched at the top right of the popup and the stats page.

PCDN (MCDN) nodes are home broadband and P2P nodes Bilibili rents. They are generally less stable and slower across networks than the official CDN, especially outside mainland China.

## Install

Requires Chrome or Edge 120 or later. The extension is not in the extension stores yet; install it with "Load unpacked":

1. Download the latest `Bilibili-Playback-Route-Optimizer-<version>-chromium.zip` from [Releases](https://github.com/AbyssRain75/Bilibili-Playback-Route-Optimizer/releases) and unzip it into a folder in a fixed location.
2. Open `chrome://extensions` (`edge://extensions` in Edge) and turn on Developer mode (at the bottom of the left sidebar in Edge).
3. Click "Load unpacked" and select the unzipped folder (the one that directly contains `manifest.json`).
4. Reload any Bilibili pages that are already open: the extension only works on pages loaded after it was installed.

You can also `git clone` this repository and load its `chromium` folder; it has the same content as the zip.

Edge puts the extension icon in the puzzle-piece menu on the toolbar; you can choose "Show in toolbar".

A Firefox version is in progress and not usable yet.

### Update

Download the new zip, empty the old folder and unzip the new version into it, keeping the folder in the same place (or `git pull` in the repository). Then click the reload button on the extension's card on the extensions page, and reload your Bilibili pages. Records and settings are kept.

- **Don't click "Remove"**: removing the extension deletes all of its data.
- **Don't move the folder**: unpacked extensions are told apart by their folder path; in a new location it is a different extension with no data.
- To be safe, export a JSON from the stats page before updating.

## Usage

Click the extension icon on the toolbar to open the popup:

- **On** at the top right is the main switch. Turn it off to pause the whole extension (no recording, no rewriting, no speed tests); Bilibili plays as usual.
- Under **Route settings**, turn on **Route optimization** and **Auto speed test**, and choose the video node and the live protocol. Changes apply to videos and live rooms loaded afterwards; reload the page you are watching.
- **Report a problem**: few stalls, many stalls, won't play, A/V out of sync. You can add a note or undo.
- **Advanced** has recent problems, speed test results and node details.
- **Stats** at the top right opens the stats page.

The flag on the right of the player's control bar marks "Many stalls" with one click. Hover over it to see the current playback status (buffer ahead, dropped frames, bitrate, the node in use and its download speed) and the mark menu. You can turn it off in the popup.

Alt+Shift+K marks "Many stalls" directly. Change it at `chrome://extensions/shortcuts` (`edge://extensions/shortcuts` in Edge).

Good to know:

- URLs are only rewritten when the player fetches them, so the video you are watching switches nodes after a page reload (or on the next video).
- Live streams can only choose among the lines Bilibili provides; other hosts refuse the stream.
- Speed tests fetch a random range from the middle of the file. Edge cache nodes (such as Akamai) that don't have it cached fetch it from upstream, so their score can be lower than what they deliver during playback.

## Privacy

- Records are stored only in the browser's extension storage on your device. Nothing is uploaded, and there is no analytics service.
- The extension itself only sends two kinds of requests: a query to Bilibili's API (`api.bilibili.com/x/web-interface/zone`, without cookies) for the current network's country, region, city and ISP, used to keep speed test results per network (the IP is not stored); and, with Auto speed test or Route optimization on, speed tests to Bilibili's CDN nodes.
- Only pages with playback are recorded; pages without playback, such as user spaces and feeds, are not.
- Records are kept for 15 days by default. Change it under "Keep records" at the top right of the stats page, from 7 days to 6 months; older records are deleted automatically.
- JSON export defaults to the **standard export** (redacted): for sessions without problems, page URLs and video IDs are replaced with numbers, and the network location keeps only country and ISP. Use it when reporting problems. The **full export** includes every page watched, the network location history and node IPs; don't share it publicly.

## Permissions

| Permission | Used for |
|---|---|
| `storage`, `unlimitedStorage` | Keeping settings, records and speed test results on your device. Records can grow past the default extension storage quota |
| `webRequest` | Observing the node, IP, time to first byte, throughput and failures of Bilibili media requests. Read-only: nothing is blocked or modified |
| `alarms` | The 30-second timer for Auto speed test |
| `declarativeNetRequestWithHostAccess` | Adding Bilibili's Referer (required by the CDN) to the extension's own speed test requests only; page requests are not affected |
| `*.bilibili.com` | Running scripts on Bilibili pages: reading and rewriting playback URLs, recording startup and stalls, showing the mark button on the player; querying the network location |
| `*.bilivideo.com`, `*.bilivideo.cn`, `*.akamaized.net`, `*.szbdyd.com` | Bilibili's CDN and PCDN domains: observing media requests and speed tests |

## Reporting problems

Describe the problem in [Issues](https://github.com/AbyssRain75/Bilibili-Playback-Route-Optimizer/issues), ideally with a file from "Export JSON" → "Standard export" on the stats page (check the notes in it before posting).

## Credits

These projects inspired some of the ideas; no code from them is used:

- [stabruriss/bilibili-accelerator](https://github.com/stabruriss/bilibili-accelerator): speed tests only when the buffer is healthy, recognizing PCDN and ranking it last, not forging Akamai signatures.
- [bilibili-cdn-switcher](https://github.com/a0972199950/bilibili-cdn-switcher): keeping the original URLs as backups, and falling back to Bilibili's own backup nodes first on errors.
- [Shaka Player](https://github.com/shaka-project/shaka-player)'s grouped playback statistics, and [enhanced-h264ify](https://github.com/alextrv/enhanced-h264ify)'s notes on hardware decoding.

## License

Copyright (C) 2026 AbyssRain75

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version (SPDX: `GPL-3.0-or-later`).

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [LICENSE](LICENSE) file for the full text of the GNU General Public License version 3; the extension folder and the zip carry a copy too.
