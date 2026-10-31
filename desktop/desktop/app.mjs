// SPDX-License-Identifier: AGPL-3.0-or-later
// 桌面版各部分接在一起：存储 → 后台（vm 里的 sw.js）→ 本地界面 → 客户端和页面接入。控制台（main.mjs）和客户端 e2e（tools/e2e-client.mjs）共用。
// 存储的变化发给三处：后台（sw.js 的 storage.onChanged）、客户端页面里的内容脚本（只有 local）、打开着的界面。
import path from 'node:path';
import { Client } from './client.mjs';
import { Pages } from './pages.mjs';
import { startBackground } from './runtime.mjs';
import { StorageArea } from './storage.mjs';
import { startUi } from './ui.mjs';

/**
 * opts：extDir、dataDir（存储放在 dataDir/storage/local）、uiPort、uiLang、client（Client 的参数：exe、userDataDir、waitRunning）；
 * on：{ log(文本), debug(文本), badge({ global }), state(客户端状态), connect({ fresh, version }), tabs(地址数组), exit() }。
 * 返回 { storage, bg, ui, client, pages(), start(), close() }；start() 启动并接入客户端。
 */
export async function createApp({ extDir, dataDir, uiPort = 0, uiLang = 'zh-CN', client: clientOpts = {}, on = {} }) {
  const log = on.log || (() => {});
  const debug = on.debug || (() => {});
  const listeners = [];
  const onChange = (changes, area) => {
    for (const fn of listeners) fn(changes, area);
  };
  const storage = {
    local: new StorageArea('local', { dir: path.join(dataDir, 'storage', 'local'), onChange }),
    session: new StorageArea('session', { onChange }),
  };

  let pages = null;
  let client = null;
  // 后台拿标签页信息、给页面发消息都经当前的 pages（重连后换一个）
  const tabs = {
    get: (id) => (pages ? pages.get(id) : null),
    query: (q) => (pages ? pages.query(q) : []),
    sendMessage: (id, msg, o) => (pages ? pages.sendMessage(id, msg, o) : Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'))),
    reload: (id) => (pages ? pages.reload(id) : Promise.reject(new Error(`No tab with id: ${id}.`))),
  };
  const bg = startBackground({
    extDir,
    storage,
    tabs,
    uiLang,
    ua: () => (client && client.version ? client.version['User-Agent'] : ''),
    log,
    onBadge: (b) => on.badge && on.badge(b),
  });
  await bg.ready;
  listeners.push((changes, area) => bg.storageChanged(changes, area));
  listeners.push((changes, area) => pages && pages.broadcastChange(changes, area));

  const ui = await startUi({ extDir, background: bg, storage, port: uiPort, log: debug });
  listeners.push((changes, area) => ui.broadcast(changes, area));

  client = new Client({ log, ...clientOpts });
  client.onstate = (s) => on.state && on.state(s);
  client.onconnect = async (cdp, { fresh }) => {
    if (pages) pages.reset();
    pages = new Pages({ cdp, extDir, storage, log: debug });
    pages.background = bg;
    ui.setTabs(pages);
    pages.onTabs = () => on.tabs && on.tabs(pages.query({}).map((t) => t.url));
    await pages.start();
    if (on.connect) on.connect({ fresh, version: client.version });
  };
  client.onexit = () => on.exit && on.exit();

  let closed = false;
  return {
    storage,
    bg,
    ui,
    client,
    pages: () => pages,
    start: () => client.start(),
    /**
     * 退出：先把记录、存储写一遍（关控制台窗口时 Windows 只给几秒），closeClient 时再让客户端正常退出，
     * 最后把客户端关掉前后的记录（页面关掉、请求中止）也写完。
     */
    async close(closeClient = true) {
      if (closed) return;
      closed = true;
      const flush = async () => {
        try {
          await Promise.race([bg.flush(), new Promise((r) => setTimeout(r, 2000))]);
        } catch {}
        storage.local.flush();
      };
      await flush();
      try {
        if (closeClient) await client.close();
      } catch {}
      await flush();
      bg.close();
      ui.close();
    },
  };
}
