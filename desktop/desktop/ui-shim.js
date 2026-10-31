// SPDX-License-Identifier: AGPL-3.0-or-later
// 桌面版：本地界面（扩展的 popup、统计页原样提供，见 ui.mjs）里的 chrome 垫片（桌面版开发计划工作项 8）。
// ui.mjs 把它插在页面脚本前面，前面另有一行 globalThis.__bproDesktop = { base, manifest }（base 是带令牌的地址前缀）。
// chrome.* 的调用都发给桌面版（POST base/__desktop/call），storage.onChanged 由桌面版用事件流（EventSource）推过来。
// 页面用到的 chrome API 见 desktop/test/shim.test.mjs 的核对。
(() => {
  'use strict';

  const { base, manifest } = globalThis.__bproDesktop;

  async function call(fn, ...args) {
    const res = await fetch(`${base}__desktop/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn, args }),
    });
    const r = await res.json();
    if (!res.ok || r.error) throw new Error(r.error || `HTTP ${res.status}`);
    return r.value;
  }

  function event() {
    const fns = [];
    return {
      fns,
      addListener: (fn) => fns.push(fn),
      removeListener: (fn) => {
        const i = fns.indexOf(fn);
        if (i >= 0) fns.splice(i, 1);
      },
      hasListener: (fn) => fns.includes(fn),
    };
  }
  const fire = (e, ...args) => {
    for (const fn of [...e.fns]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(err);
      }
    }
  };

  const onChanged = event();
  const areaChanged = { local: event(), session: event() };
  const area = (name) => ({
    get: (keys = null) => call('storage.get', name, keys),
    set: (items) => call('storage.set', name, items),
    remove: (keys) => call('storage.remove', name, keys),
    clear: () => call('storage.clear', name),
    getBytesInUse: (keys = null) => call('storage.getBytesInUse', name, keys),
    onChanged: areaChanged[name],
  });

  // 扩展里统计页是 popup 打开的另一个标签页，这里一样在浏览器里开新标签页
  const page = (p) => `${base}${p}`;

  globalThis.chrome = {
    runtime: {
      id: 'bpro-desktop',
      getManifest: () => JSON.parse(JSON.stringify(manifest)),
      getURL: (p = '') => page(String(p).replace(/^\//, '')),
      sendMessage: (msg) => call('runtime.sendMessage', msg),
      openOptionsPage: async () => {
        window.open(page(manifest.options_ui.page), '_blank');
      },
      onMessage: event(),
    },
    storage: { local: area('local'), session: area('session'), onChanged },
    tabs: {
      TAB_ID_NONE: -1,
      query: (q) => call('tabs.query', q || {}),
      reload: (tabId) => call('tabs.reload', tabId),
    },
    // 桌面版没有快捷键（计划「目标与范围」：先不做全局快捷键）
    commands: { getAll: async () => [] },
    i18n: { getUILanguage: () => navigator.language || '' },
  };

  // 客户端有自己的主题，桌面版不往客户端里放主题脚本（见 pages.mjs 的 SKIP），popup 里的「B 站页面主题」在这里不起作用，收起来
  document.addEventListener('DOMContentLoaded', () => {
    const theme = document.getElementById('theme-card');
    if (theme) theme.style.display = 'none';
  });

  // 桌面版推过来的存储变化；断了浏览器会自己重连
  const events = new EventSource(`${base}__desktop/events`);
  events.addEventListener('changed', (e) => {
    const { area: name, changes } = JSON.parse(e.data);
    fire(onChanged, changes, name);
    if (areaChanged[name]) fire(areaChanged[name], changes);
  });
})();
