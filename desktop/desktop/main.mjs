#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// 桌面版的入口（桌面版开发计划工作项 9）：一个控制台窗口。启动 B 站 PC 客户端并接入，后台原样跑扩展的 sw.js，
// 本地界面（popup、统计页）在默认浏览器里打开。按 Ctrl+C、q 或关掉窗口退出，退出时客户端也正常退出。
// 默认和扩展一样是观察模式：线路优化、自动测速都关着，在界面里打开。
//
// 用法（在 dev/ 下，或双击 desktop/start.cmd）：
//   node desktop/main.mjs                    # 找到客户端、启动并接入
//   node desktop/main.mjs --client "D:\…\哔哩哔哩.exe"   # 找不到客户端时指定（路径是示例）
//   node desktop/main.mjs --user-data-dir <临时目录> --data <临时目录>   # 另开一个独立的测试实例，不碰平时的登录和记录
//   node desktop/main.mjs --no-client        # 不启动客户端，只打开界面看以往的记录
// 控制台里按 p 打开 popup、s 打开统计页、q 退出。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from './app.mjs';
import { lockDir } from './storage.mjs';

if (Number(process.versions.node.split('.')[0]) < 22 || typeof WebSocket !== 'function') {
  console.error(`桌面版需要 Node 22 以上（当前 ${process.version}） / Needs Node 22+ (current ${process.version})`);
  process.exit(1);
}

const { values: opts } = parseArgs({
  options: {
    client: { type: 'string' },
    data: { type: 'string' },
    'user-data-dir': { type: 'string' },
    ext: { type: 'string' },
    lang: { type: 'string' },
    'no-browser': { type: 'boolean', default: false },
    'no-client': { type: 'boolean', default: false },
    'ui-port': { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});

const EXT = path.resolve(opts.ext || path.join(import.meta.dirname, '..', 'extension'));
const DATA = path.resolve(opts.data || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'bpro-desktop'));
const SYS_LANG = opts.lang || Intl.DateTimeFormat().resolvedOptions().locale || 'en';
const ZH = /^zh(?:[-_]|$)/i.test(SYS_LANG);
// 控制台的提示中英文两份，按系统语言（界面里的语言另按设置，见 cdn.js setLang）
const L = (zh, en) => (ZH ? zh : en);
const TITLE = L('B 站播放线路优化 · 桌面版', 'Bilibili Playback Route Optimizer · Desktop');

const stamp = () => new Date().toLocaleTimeString(ZH ? 'zh-CN' : 'en-GB', { hour12: false });
const say = (text) => console.log(`${stamp()}  ${text}`);

let titleState = L('启动中', 'starting');
let paused = false;
function setTitle(state = titleState) {
  titleState = state;
  const extra = [paused ? L('已暂停', 'paused') : '', state].filter(Boolean).join(' · ');
  process.title = extra ? `${TITLE} [${extra}]` : TITLE;
}

function openUrl(url) {
  // 用默认浏览器打开（rundll32 不经过 cmd，地址里的符号不会被当成命令）
  spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

const CONFIG = path.join(DATA, 'desktop.json');
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  setTitle();
  let unlock;
  try {
    unlock = lockDir(DATA);
  } catch (e) {
    if (e.code !== 'LOCKED') throw e;
    console.error(L(`桌面版已经开着了（${e.message}）。`, `The desktop app is already running (${e.message}).`));
    process.exit(1);
  }

  let quitting = false;
  let warnedRunning = false;
  let app = null;
  async function quit(code = 0, closeClient = true) {
    if (quitting) return;
    quitting = true;
    say(L('正在退出…', 'Exiting…'));
    if (app) await app.close(closeClient);
    unlock();
    process.exit(code);
  }
  // 关控制台窗口是 SIGHUP（Windows 只给几秒）；Ctrl+Break 是 SIGBREAK
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => quit(0));

  app = await createApp({
    extDir: EXT,
    dataDir: DATA,
    uiPort: Number(opts['ui-port']) || readConfig().uiPort || 0,
    uiLang: SYS_LANG,
    client: {
      exe: opts.client || null,
      userDataDir: opts['user-data-dir'] ? path.resolve(opts['user-data-dir']) : null,
      waitRunning: async () => {
        if (!warnedRunning) {
          warnedRunning = true;
          say(L('B 站客户端已经开着，桌面版要自己启动它才能接入：请在托盘图标上右键「退出」，完全退出后这里会接着启动。', 'The Bilibili client is already running. The desktop app has to start it itself: right-click the tray icon and choose Exit; it will be started here once it has fully quit.'));
        }
        await new Promise((r) => setTimeout(r, 2000));
        return !quitting;
      },
    },
    on: {
      log: (t) => say(t),
      debug: (t) => opts.verbose && say(`· ${t}`),
      badge: ({ global }) => {
        const off = global === '关' || global === 'OFF';
        if (off === paused) return;
        paused = off;
        say(off ? L('已暂停（在 popup 里打开「启用」后恢复）', 'Paused (turn "On" back on in the popup)') : L('已恢复记录', 'Recording resumed'));
        setTitle();
      },
      state: (s) => {
        if (s === 'launching') say(L('正在启动 B 站客户端…', 'Starting the Bilibili client…'));
        if (s === 'reconnecting') {
          setTitle(L('重连中', 'reconnecting'));
          say(L('和客户端的连接断了，正在重连…', 'Lost the connection to the client, reconnecting…'));
        }
      },
      connect: ({ fresh, version }) => {
        const ver = (version && /bilibili\/[\d.]+/.exec(version['User-Agent'] || '')?.[0]) || (version && version.Browser) || '';
        say(fresh ? L(`已接入客户端（${ver}）`, `Connected to the client (${ver})`) : L(`已接入客户端（${ver}），已打开的页面补注入了`, `Connected to the client (${ver}); injected into pages already open`));
        // 摸底用的是 1.19.0，别的版本提示一下（计划「风险」第 3 条）
        if (ver && !/^bilibili\/1\.19\./.test(ver)) say(L(`这个客户端版本（${ver}）没测过，有问题请反馈。`, `This client version (${ver}) hasn't been tested; please report problems.`));
        setTitle('');
      },
      tabs: (urls) => say(urls.length ? L(`在接入的窗口：${urls.map(short).join('，')}`, `Windows in use: ${urls.map(short).join(', ')}`) : L('还没有打开播放器或直播窗口', 'No player or live window open')),
      exit: () => {
        say(L('客户端已退出。', 'The client has exited.'));
        quit(0, false);
      },
    },
  });
  try {
    fs.writeFileSync(CONFIG, JSON.stringify({ ...readConfig(), uiPort: app.ui.port }, null, 2));
  } catch {}

  say(`${TITLE} · ${L('扩展', 'extension')} ${app.bg.manifest.version}`);
  say(L(`数据目录：${DATA}`, `Data folder: ${DATA}`));
  say(L(`界面：${app.ui.popupUrl}`, `Popup: ${app.ui.popupUrl}`));
  if (opts['no-client']) {
    setTitle(L('只看记录', 'records only'));
    say(L('没有启动客户端，只看以往的记录。按 p 打开 popup，s 打开统计页，q 退出。', 'Client not started; viewing past records only. Press p for the popup, s for stats, q to quit.'));
    if (!opts['no-browser']) openUrl(app.ui.statsUrl);
    return keys();
  }
  try {
    await app.start();
  } catch (e) {
    const msg = {
      NO_CLIENT: L('找不到 B 站客户端。装好以后再试，或者用 --client 指定 哔哩哔哩.exe 的位置。', 'Bilibili client not found. Install it, or pass --client with the path to 哔哩哔哩.exe.'),
      RUNNING: L('客户端还开着，没有启动。', 'The client is still running; not started.'),
      NO_PORT: L('客户端没有打开调试端口（可能是客户端更新后关掉了这个功能）。', "The client didn't open the debugging port (an update may have disabled it)."),
    }[e.code];
    say(msg || L(`启动失败：${e.message}`, `Failed to start: ${e.message}`));
    return quit(1, false);
  }

  if (!opts['no-browser']) openUrl(app.ui.popupUrl);
  say(L('按 p 打开 popup，s 打开统计页，q 退出（客户端也会退出）。', 'Press p for the popup, s for stats, q to quit (the client quits too).'));
  keys();

  function keys() {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (b) => {
      const k = String(b).toLowerCase();
      if (k === '\u0003' || k === 'q') quit(0);
      else if (k === 'p') openUrl(app.ui.popupUrl);
      else if (k === 's') openUrl(app.ui.statsUrl);
    });
  }
}

const short = (u) => u.replace(/^https:\/\//, '').replace(/\?.*$/, (q) => (q.length > 60 ? `${q.slice(0, 60)}…` : q));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
