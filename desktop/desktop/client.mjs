// SPDX-License-Identifier: AGPL-3.0-or-later
// 找到并启动 B 站 PC 客户端，连上它的调试端口（桌面版开发计划工作项 4）。
// 摸底（docs/pc-client-survey-2026-10-29.md）的结论：
//   - 只能用端口方式（--remote-debugging-port）：pipe 在客户端自己另起进程时会断。端口只绑 127.0.0.1，每次随机；
//   - 客户端已经开着时再带参数启动不生效（单实例，新进程只把已开的窗口调到前台），要用户先从托盘完全退出，不替用户结束进程；
//     开着的是桌面版上次带端口启动的（命令行里有 --remote-debugging-port），直接连上它；
//   - 上一次没正常退出时，客户端启动后会自己另起一个进程（参数照旧，端口不变），启动的那个进程很快就退出了：
//     所以客户端在不在看端口，不看进程。连接断了、端口还开着就重连，端口关了才算客户端退出；
//   - 退出时 Browser.close，客户端正常退出（日志是 Good-bye!），端口跟着关。
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { CDP } from './cdp.mjs';

const EXE = '哔哩哔哩.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跑一段 PowerShell，输出按 UTF-8 读（路径、进程名里有中文）。 */
function powershell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { encoding: 'utf8', windowsHide: true, timeout: 20e3 }, (err, out) => (err ? reject(err) : resolve(out.trim())));
  });
}

/** 从注册表的卸载信息找客户端的 exe（卸载程序、图标都在安装目录下）。找不到为 null。 */
export async function findClient() {
  const keys = ['HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BiliBili', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BiliBili', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BiliBili'];
  const script = `${keys.map((k) => `'${k}'`).join(',')} | ForEach-Object { Get-ItemProperty -LiteralPath $_ -ErrorAction SilentlyContinue } | Select-Object DisplayVersion, DisplayIcon, UninstallString, InstallLocation | ConvertTo-Json -Compress`;
  let out = '';
  try {
    out = await powershell(script);
  } catch {
    return null;
  }
  if (!out) return null;
  const rows = [].concat(JSON.parse(out));
  for (const r of rows) {
    for (const v of [r.InstallLocation, r.DisplayIcon, r.UninstallString]) {
      if (!v) continue;
      const p = String(v).replace(/^"|"$/g, '').replace(/,\d+$/, '');
      const dir = /\.(exe|ico)$/i.test(p) ? path.dirname(p) : p;
      const exe = path.join(dir, EXE);
      if (fs.existsSync(exe)) return { exe, version: r.DisplayVersion || '' };
    }
  }
  return null;
}

/** 正在运行的客户端进程：[{ pid, path, port }]，port 为命令行里的调试端口（不是桌面版启动的为 null）。 */
export async function runningClients() {
  const script = `Get-CimInstance Win32_Process -Filter "Name='${EXE}'" | Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress`;
  let out = '';
  try {
    out = await powershell(script);
  } catch {
    return [];
  }
  if (!out) return [];
  return [].concat(JSON.parse(out)).map((p) => {
    const cmd = String(p.CommandLine || '');
    const m = /--remote-debugging-port=(\d+)/.exec(cmd);
    // Electron 的子进程（渲染、GPU 等）命令行里有 --type=，只看主进程
    return { pid: p.ProcessId, path: p.ExecutablePath || '', port: m ? Number(m[1]) : null, child: /\s--type=/.test(cmd) };
  }).filter((p) => !p.child);
}

/** 找一个空闲端口（只绑 127.0.0.1）。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 调试端口开着时返回 /json/version（浏览器级 WebSocket 地址、UA），没开为 null。 */
export async function probePort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * 客户端的连接。用法：const c = new Client(opts); await c.start(); c.cdp 是当前的连接；
 * c.onconnect(cdp, { fresh }) 每次连上（含重连）调一次，fresh 为客户端是这次新启动的；c.onexit() 客户端退出了。
 * opts：exe（不给就从注册表找）、userDataDir（另开一个独立数据目录的实例，测试用，不碰用户的登录状态）、log、extraArgs。
 */
export class Client {
  constructor({ exe = null, userDataDir = null, extraArgs = [], log = () => {}, waitRunning = null } = {}) {
    this.exe = exe;
    this.userDataDir = userDataDir;
    this.extraArgs = extraArgs;
    this.log = log;
    // 客户端已经在跑、不是桌面版启动的：调这个提示用户退出，返回 false 就不等了
    this.waitRunning = waitRunning;
    this.port = null;
    this.version = null;
    this.cdp = null;
    this.onconnect = async () => {};
    this.onexit = () => {};
    this.onstate = () => {};
    this.closing = false;
    this.proc = null;
  }

  async start() {
    if (!this.exe) {
      const found = await findClient();
      if (!found) throw Object.assign(new Error('找不到 B 站客户端'), { code: 'NO_CLIENT' });
      this.exe = found.exe;
    }
    if (!this.userDataDir) {
      // 用户平时的数据目录：客户端只能开一个
      for (;;) {
        const running = await runningClients();
        const mine = running.find((p) => p.port);
        if (mine && (await probePort(mine.port))) {
          this.port = mine.port;
          return this.connect(false);
        }
        if (!running.length) break;
        if (!this.waitRunning || !(await this.waitRunning(running))) throw Object.assign(new Error('客户端已经在运行'), { code: 'RUNNING' });
      }
    }
    this.port = await freePort();
    this.launch();
    return this.connect(true);
  }

  launch() {
    const args = [`--remote-debugging-port=${this.port}`, ...(this.userDataDir ? [`--user-data-dir=${this.userDataDir}`] : []), ...this.extraArgs];
    this.onstate('launching');
    this.proc = spawn(this.exe, args, { stdio: 'ignore', detached: false, windowsHide: false });
    this.proc.on('error', (e) => this.log(`启动客户端失败：${e.message}`));
  }

  /** 等端口开，连上浏览器级 WebSocket。 */
  async connect(fresh, timeout = 30e3) {
    const until = Date.now() + timeout;
    let info = null;
    while (!(info = await probePort(this.port))) {
      if (Date.now() > until) throw Object.assign(new Error(`等不到客户端的调试端口 ${this.port}`), { code: 'NO_PORT' });
      await sleep(200);
    }
    this.version = info;
    const cdp = new CDP(info.webSocketDebuggerUrl);
    await cdp.open();
    this.cdp = cdp;
    cdp.onclose = () => this.lost(cdp);
    this.onstate('connected');
    await this.onconnect(cdp, { fresh });
    return cdp;
  }

  /** 连接断了：端口还开着（客户端自己另起了进程）就重连，15 秒内都连不上算客户端退出了。 */
  async lost(cdp) {
    if (cdp !== this.cdp) return;
    this.cdp = null;
    if (this.closing) return this.onexit();
    this.onstate('reconnecting');
    const until = Date.now() + 15e3;
    while (Date.now() < until) {
      if (await probePort(this.port)) {
        try {
          await this.connect(false, 5e3);
          return;
        } catch (e) {
          this.log(`重连失败：${e.message}`);
        }
      }
      await sleep(500);
    }
    this.onexit();
  }

  /** 让客户端正常退出（Browser.close），等端口关上。 */
  async close() {
    this.closing = true;
    const cdp = this.cdp;
    if (!cdp) return;
    await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(3000)]);
    const until = Date.now() + 8e3;
    while (Date.now() < until && (await probePort(this.port))) await sleep(300);
  }
}
