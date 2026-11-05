// SPDX-License-Identifier: AGPL-3.0-or-later
// 客户端页面的接入（桌面版开发计划工作项 6）：浏览器级 Target.setAutoAttach（flatten、waitForDebuggerOnStart）接上每个窗口，
// 在页面脚本运行之前放进扩展的内容脚本：MAIN world 是 manifest 第一组（cdn.js、playinfo.js、route.js、hook.js），
// 隔离 world（bilicdn）是 content-shim.js 加第二组（bridge.js、player.js）。主题相关的 header-theme.js、theme.js 不放：客户端有自己的主题。
// 注入哪些按 manifest.json 读，扩展加了脚本这里跟着加。
//
// 每个顶层窗口算一个标签页（整数编号，同 Chrome 的 tabId），窗口里的框架按 frameId 编号（主框架 0）；跨进程的 iframe、
// 页面里的 Worker 是单独的 target，归到所在窗口。只有 B 站客户端的播放器窗口（bilipc.bilibili.com/player.html）和直播窗口
// （live.bilibili.com）记录，主窗口、别的网页不管（见 relevant 和 GUARD）。
// 后台（runtime.mjs）经这里拿标签页信息、给页面发消息；页面上的网络事件经 netmap.mjs 换算后交给后台。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EXT_ID } from './runtime.mjs';
import { NetMap } from './netmap.mjs';

export const WORLD = 'bilicdn';
export const BINDING = '__bilicdnSend';
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
// 不放进客户端的内容脚本（客户端有自己的主题）
const SKIP = new Set(['src/main/header-theme.js', 'src/content/theme.js']);
// Network.enable 的缓冲：响应正文最多留 64 KB / 个、合计 1 MB（netmap 只用事件，不读正文）
const NET_ENABLE = { maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 64 * 1024, maxPostDataSize: 0 };

/** 播放器窗口、直播窗口（含直播间里的活动页）才记录。 */
export function relevant(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ((u.hostname === 'bilipc.bilibili.com' && u.pathname === '/player.html') || u.hostname === 'live.bilibili.com');
  } catch {
    return false;
  }
}

// 注入的脚本先判断自己在不在要管的页面里：顶层是播放器窗口或直播窗口，框架自己在 B 站域名下（同 manifest 的 matches）。
// 跨域的 iframe 读不到顶层的地址，看 ancestorOrigins（直播间里的活动页 iframe）
const GUARD = `
  const pcPlayer = (u) => u.hostname === 'bilipc.bilibili.com' && u.pathname === '/player.html';
  const live = (u) => u.hostname === 'live.bilibili.com';
  const wanted = () => {
    const h = location.hostname;
    if (location.protocol !== 'https:' || !(h === 'bilibili.com' || h.endsWith('.bilibili.com'))) return false;
    if (window === window.top) return pcPlayer(location) || live(location);
    let top = null;
    try { top = new URL(window.top.location.href); } catch {}
    if (top) return pcPlayer(top) || live(top);
    const o = location.ancestorOrigins;
    return !!o && o.length > 0 && o[o.length - 1] === 'https://live.bilibili.com';
  };
  if (!wanted()) return;`;

// 「刷新换节点」重新加载播放器窗口之前，在页面里把地址的 p 补成当前分 P（page）。2026-11-05 实测（客户端 1.19.0 和热更新的 1.20.0 一样，
// 计划工作项 20）：重新加载时播放器页在 beforeunload 里把当前地址加上 t=播放位置交给客户端主进程（window/replace），主进程按地址里的 p
// 定放哪一 P，页面加载完再把这份参数发回来（events/playerParamsChange，页面内换地址）。可页面里自动连播、点选集换到别的分 P 时，
// 地址里只写 page=2、没有 p，主进程就当成第 1 P：刷新后跳回第 1 P（进度照旧），记录里先开一个第 2 P 的空会话、紧接着站内切换到第 1 P 的会话。
// 补上 p 以后刷新停在原来那一 P、接着放，只开一个会话。只改地址（replaceState 不触发页面的路由），不是播放器窗口、没有 page 的不动。
// Runtime.evaluate 在页面自己的执行上下文里跑，要照顾 Chromium 108 的写法（工作项 2）
export const KEEP_PART = `(function () {
  try {
    if (location.hostname !== 'bilipc.bilibili.com' || location.pathname !== '/player.html') return;
    var u = new URL(location.href);
    var page = u.searchParams.get('page');
    if (!/^[1-9]\\d*$/.test(page || '') || u.searchParams.get('p') === page) return;
    u.searchParams.set('p', page);
    history.replaceState(history.state, '', u.href);
  } catch (e) {}
})()`;

/** 按 manifest 拼出两段要注入的脚本。key：MAIN world 里防重复注入的记号（每次启动随机，页面猜不到）。 */
export function bundles(extDir, key = `__bpro_${randomBytes(6).toString('hex')}`) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  const groups = manifest.content_scripts || [];
  const main = groups.find((g) => g.world === 'MAIN');
  const iso = groups.find((g) => g.world !== 'MAIN');
  const read = (f) => `// ---- ${f}\n${fs.readFileSync(path.join(extDir, f), 'utf8')}\n;`;
  const files = (g) => (g ? g.js.filter((f) => !SKIP.has(f)) : []);
  const shim = fs.readFileSync(path.join(import.meta.dirname, 'content-shim.js'), 'utf8');
  return {
    mainFiles: files(main),
    isoFiles: files(iso),
    main: `(function () {${GUARD}
  if (Object.getOwnPropertyDescriptor(window, ${JSON.stringify(key)})) return;
  Object.defineProperty(window, ${JSON.stringify(key)}, { value: 1 });
${files(main).map(read).join('\n')}
})();
//# sourceURL=bpro-desktop-main.js`,
    isolated: `(function () {${GUARD}
  if (globalThis.__bilicdnShim) return;
${shim}
  if (!globalThis.__bilicdnShim) return;
${files(iso).map(read).join('\n')}
})();
//# sourceURL=bpro-desktop-isolated.js`,
  };
}

/** changes 里的值是 JSON 文本（见 storage.mjs），拼成 Chrome storage.onChanged 格式的 JSON 文本，不用再解析一遍。 */
export function changesJson(changes) {
  const parts = Object.entries(changes).map(([k, v]) => {
    const f = [];
    if (v.oldValue !== undefined) f.push(`"oldValue":${v.oldValue}`);
    if (v.newValue !== undefined) f.push(`"newValue":${v.newValue}`);
    return `${JSON.stringify(k)}:{${f.join(',')}}`;
  });
  return `{${parts.join(',')}}`;
}

export class Pages {
  /** cdp：浏览器级连接（cdp.mjs）；storage：{ local }（内容脚本只能读写 local）；background：runtime.mjs 的后台（start 之前设好）。 */
  constructor({ cdp, extDir, storage, log = () => {}, bundle = bundles(extDir) }) {
    this.cdp = cdp;
    this.storage = storage;
    this.log = log;
    this.bundle = bundle;
    this.background = null;
    this.tabs = new Map(); // 编号 → 标签页
    this.sessions = new Map(); // CDP sessionId → 接入的 target
    this.tabSeq = 0;
    this.sessSeq = 0;
    this.onTabs = () => {}; // 标签页有增减、换了地址（控制台显示用）
    cdp.on((m) => {
      try {
        this.event(m);
      } catch (e) {
        log(`处理 ${m.method} 出错：${e.stack || e}`);
      }
    });
  }

  async start() {
    await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  /** 连接断了：所有页面都当成关掉了（重连后另起编号）。 */
  reset() {
    for (const tab of [...this.tabs.values()]) this.closeTab(tab);
    this.sessions.clear();
  }

  // ---------------------------------------------------------------- CDP 事件

  event(m) {
    const p = m.params || {};
    if (m.method === 'Target.attachedToTarget') return void this.attached(p, m.sessionId);
    if (m.method === 'Target.detachedFromTarget') return this.detached(p);
    const sess = m.sessionId && this.sessions.get(m.sessionId);
    if (!sess) return;
    switch (m.method) {
      case 'Runtime.executionContextCreated': {
        const c = p.context;
        const aux = c.auxData || {};
        sess.contexts.set(c.id, { frameId: aux.frameId, isDefault: !!aux.isDefault, world: c.name === WORLD && !aux.isDefault, active: false });
        return;
      }
      case 'Runtime.executionContextDestroyed':
        sess.contexts.delete(p.executionContextId);
        return;
      case 'Runtime.executionContextsCleared':
        sess.contexts.clear();
        return;
      case 'Runtime.bindingCalled':
        return this.binding(sess, p);
      case 'Page.frameNavigated':
        if (!p.frame.parentId && p.frame.id === sess.targetId && sess.top) this.setUrl(sess.tab, p.frame.url + (p.frame.urlFragment || ''));
        return;
      case 'Page.navigatedWithinDocument':
        if (p.frameId === sess.targetId && sess.top) this.setUrl(sess.tab, p.url);
        return;
      default:
        if (sess.net && m.method.startsWith('Network.')) sess.net.handle(m.method, p, sess.netCtx);
    }
  }

  async attached({ sessionId, targetInfo: info, waitingForDebugger }, parentId) {
    const send = (method, params = {}) => this.cdp.send(method, params, sessionId);
    const run = () => send('Runtime.runIfWaitingForDebugger').catch(() => {});
    const parent = parentId ? this.sessions.get(parentId) : null;
    const type = info.type;
    // 不管的 target（主窗口、service worker、webview 等）：放行后断开
    const leave = async () => {
      await run();
      await this.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    };
    let tab = null;
    if (type === 'page' && !parentId) {
      // 已知不是播放器、直播的顶层窗口（主窗口 index.html、tracker.html 等），不接入；地址还是空的（新开的窗口）先接入
      if (info.url && info.url !== 'about:blank' && !relevant(info.url) && /^https:\/\/bilipc\.bilibili\.com\//.test(info.url)) return leave();
      tab = this.newTab(info);
    } else if ((type === 'iframe' || type === 'worker') && parent && parent.tab) {
      tab = parent.tab;
    } else {
      return leave();
    }
    const sess = { id: sessionId, type, targetId: info.targetId, tab, top: type === 'page', contexts: new Map(), net: null, netCtx: null };
    this.sessions.set(sessionId, sess);
    tab.sessions.add(sess);
    sess.net = new NetMap((event, d) => this.background && this.background.dispatchRequest(event, d), { prefix: `${tab.id}.${++this.sessSeq}:` });
    sess.netCtx = { tabId: tab.id, frameId: (fid) => this.frameNum(tab, fid || sess.targetId), relevant: () => relevant(tab.url) };

    const cmds = [];
    if (type === 'worker') {
      cmds.push(send('Network.enable', NET_ENABLE), run());
    } else {
      cmds.push(
        send('Runtime.enable'),
        send('Page.enable'),
        send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD }),
        send('Page.addScriptToEvaluateOnNewDocument', { source: this.bundle.main }),
        send('Page.addScriptToEvaluateOnNewDocument', { source: this.bundle.isolated, worldName: WORLD }),
        // 只要事件，不要响应内容：调试协议默认会在内存里留着响应正文（给开发者工具看），客户端一放几个小时，媒体分片都留着
        send('Network.enable', NET_ENABLE),
        send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }),
        // 页面停在开头时这几条要和 runIfWaitingForDebugger 一起发出，一个个等结果会卡住（摸底实测）
        run(),
      );
    }
    const results = await Promise.allSettled(cmds);
    for (const r of results) if (r.status === 'rejected' && !/连接已断开|No session/.test(r.reason.message)) this.log(`接入页面时出错：${r.reason.message}`);
    // 连晚了（桌面版中途连上、客户端自己另起了进程）：已经打开的页面补注入一次
    if (!waitingForDebugger && type !== 'worker' && this.sessions.has(sessionId)) await this.injectExisting(sess).catch((e) => this.log(`补注入失败：${e.message}`));
    if (sess.top) this.onTabs();
  }

  detached({ sessionId }) {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;
    this.sessions.delete(sessionId);
    sess.net.abortAll();
    if (sess.top) this.closeTab(sess.tab);
    else sess.tab.sessions.delete(sess);
  }

  /** 已经打开的页面里补放脚本：各框架的 MAIN world 用页面自己的执行上下文，隔离 world 用 createIsolatedWorld 建一个。 */
  async injectExisting(sess) {
    const send = (method, params = {}) => this.cdp.send(method, params, sess.id);
    const { frameTree } = await send('Page.getFrameTree');
    const frames = [];
    const walk = (t) => {
      frames.push(t.frame);
      for (const c of t.childFrames || []) walk(c);
    };
    walk(frameTree);
    for (const f of frames) {
      const ctx = [...sess.contexts].find(([, c]) => c.isDefault && c.frameId === f.id);
      if (ctx) await send('Runtime.evaluate', { expression: this.bundle.main, contextId: ctx[0] }).catch(() => {});
      const world = await send('Page.createIsolatedWorld', { frameId: f.id, worldName: WORLD }).catch(() => null);
      if (world) await send('Runtime.evaluate', { expression: this.bundle.isolated, contextId: world.executionContextId }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- 标签页

  newTab(info) {
    const tab = { id: ++this.tabSeq, targetId: info.targetId, url: info.url || '', title: info.title || '', frames: new Map(), frameSeq: 0, sessions: new Set(), hidden: false, lastActive: 0, opened: Date.now() };
    this.tabs.set(tab.id, tab);
    return tab;
  }

  closeTab(tab) {
    if (!this.tabs.has(tab.id)) return;
    this.tabs.delete(tab.id);
    for (const s of tab.sessions) {
      s.net.abortAll();
      this.sessions.delete(s.id);
    }
    tab.sessions.clear();
    if (this.background) this.background.tabRemoved(tab.id);
    this.onTabs();
  }

  setUrl(tab, url) {
    if (!url || tab.url === url) return;
    const was = relevant(tab.url);
    tab.url = url;
    if (was !== relevant(url)) this.onTabs();
  }

  /** CDP 的 frameId → 这个标签页里的编号：主框架（和 target 同 id）为 0，别的按第一次见到的顺序从 1 起。 */
  frameNum(tab, frameId) {
    if (!frameId || frameId === tab.targetId) return 0;
    if (!tab.frames.has(frameId)) tab.frames.set(frameId, ++tab.frameSeq);
    return tab.frames.get(frameId);
  }

  tabInfo(tab) {
    const active = this.activeTab();
    return { id: tab.id, index: 0, windowId: tab.id, url: tab.url, title: tab.title, active: tab === active, highlighted: tab === active, status: 'complete', incognito: false, pinned: false, discarded: false };
  }

  /** 「当前标签页」：播放器或直播窗口里，没隐藏的优先，再按最近在前台的。 */
  activeTab() {
    const xs = [...this.tabs.values()].filter((t) => relevant(t.url));
    xs.sort((a, b) => Number(a.hidden) - Number(b.hidden) || b.lastActive - a.lastActive || b.opened - a.opened);
    return xs[0] || null;
  }

  // 给 runtime.mjs 的标签页接口
  get(tabId) {
    const tab = this.tabs.get(tabId);
    return tab ? this.tabInfo(tab) : null;
  }

  query(q = {}) {
    let xs = [...this.tabs.values()].filter((t) => relevant(t.url));
    if (q.active) xs = xs.filter((t) => t === this.activeTab());
    if (q.url) xs = xs.filter((t) => t.url === q.url);
    return xs.map((t) => this.tabInfo(t));
  }

  /** 发给标签页里各框架的隔离 world（options.frameId 只发给一个），第一个回复的算数；没人回复为 undefined。 */
  sendMessage(tabId, msgJson, options = {}) {
    const tab = this.tabs.get(tabId);
    const targets = [];
    if (tab) {
      for (const s of tab.sessions) {
        for (const [ctxId, c] of s.contexts) {
          if (!c.world || !c.active) continue;
          if (options.frameId !== undefined && this.frameNum(tab, c.frameId) !== options.frameId) continue;
          targets.push([s, ctxId]);
        }
      }
    }
    if (!targets.length) return Promise.reject(new Error(NO_RECEIVER));
    const sender = JSON.stringify({ id: EXT_ID, origin: `chrome-extension://${EXT_ID}` });
    const expression = `__bilicdnShim.message(${JSON.stringify(msgJson)}, ${JSON.stringify(sender)})`;
    return new Promise((resolve) => {
      let left = targets.length;
      let done = false;
      for (const [s, contextId] of targets) {
        this.cdp
          .send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true }, s.id)
          .then((r) => (r.exceptionDetails ? null : r.result.value), () => null)
          .then((v) => {
            left -= 1;
            if (!done && typeof v === 'string') {
              done = true;
              resolve(v);
            } else if (!done && left === 0) {
              done = true;
              resolve(undefined);
            }
          });
      }
    });
  }

  /**
   * 「刷新换节点」（popup 的 tabs.reload）：重新加载窗口，页面重新请求播放地址，hook.js 按当时的卡顿证据和测速改写。
   * 2026-10-31 实测（计划工作项 12）：播放器窗口地址里带着 type、bvid，重新加载后客户端接着放同一个视频、从原来的位置接着放
   * （重新加载时地址上多了 t=播放位置），会话重开；直播窗口照常。在主窗口或播放器窗口里再 openPlayerWindow 同一个视频
   * 只是把窗口调到前面，不重新请求播放地址，换不了节点，所以不用它。
   * 多 P 视频要先补上地址里的 p（KEEP_PART，2026-11-05 实测，见计划工作项 20）。
   */
  async reload(tabId) {
    const tab = this.tabs.get(tabId);
    const top = tab && [...tab.sessions].find((s) => s.top);
    if (!top) throw new Error(`No tab with id: ${tabId}.`);
    await this.cdp.send('Runtime.evaluate', { expression: KEEP_PART }, top.id).catch(() => {});
    await this.cdp.send('Page.reload', {}, top.id);
  }

  /** storage.local 有变化：发给每个页面里的内容脚本（同 Chrome，内容脚本只收 local 的）。 */
  broadcastChange(changes, area) {
    if (area !== 'local') return;
    const expression = `__bilicdnShim.changed(${JSON.stringify(changesJson(changes))}, 'local')`;
    for (const sess of this.sessions.values()) {
      for (const [contextId, c] of sess.contexts) {
        if (c.world && c.active) this.cdp.send('Runtime.evaluate', { expression, contextId }, sess.id).catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------- 页面 → 桌面版

  binding(sess, p) {
    if (p.name !== BINDING) return;
    const ctx = sess.contexts.get(p.executionContextId);
    // 只认我们自己的隔离 world（绑定本来也只装在那里）
    if (!ctx || !ctx.world) return;
    ctx.active = true;
    let m;
    try {
      m = JSON.parse(p.payload);
    } catch {
      return;
    }
    const tab = sess.tab;
    const href = typeof m.href === 'string' ? m.href.slice(0, 2000) : '';
    const frameId = this.frameNum(tab, ctx.frameId);
    if (frameId === 0 && href) this.setUrl(tab, href);
    const reply = (ok, value) => {
      const expression = `__bilicdnShim.resolve(${Number(m.id) || 0}, ${ok}, ${JSON.stringify(value ?? null)})`;
      this.cdp.send('Runtime.evaluate', { expression, contextId: p.executionContextId }, sess.id).catch(() => {});
    };
    const fail = (e) => reply(false, String((e && e.message) || e));
    if (m.k === 'msg') {
      if (!this.background || typeof m.msg !== 'string') return fail('no background');
      let origin = '';
      try {
        origin = new URL(href).origin;
      } catch {}
      this.background.message(m.msg, { tab: this.tabInfo(tab), frameId, url: href, origin }).then((v) => reply(true, v), fail);
    } else if (m.k === 'storage') {
      try {
        const args = JSON.parse(m.args || '[]');
        const local = this.storage.local;
        if (m.fn === 'get') reply(true, JSON.stringify(local.get(args[0])));
        else if (m.fn === 'set') reply(true, void local.set(args[0]));
        else if (m.fn === 'remove') reply(true, void local.remove(args[0]));
        else fail(`unknown ${m.fn}`);
      } catch (e) {
        fail(e);
      }
    } else if (m.k === 'state') {
      tab.hidden = !!m.hidden;
      if (m.focus || !m.hidden) tab.lastActive = Date.now();
      reply(true, null);
    }
  }
}
