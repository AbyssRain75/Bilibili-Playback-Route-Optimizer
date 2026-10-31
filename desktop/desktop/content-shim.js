// SPDX-License-Identifier: AGPL-3.0-or-later
// 桌面版：客户端页面的隔离 world（bilicdn）里给内容脚本（bridge.js、player.js）用的 chrome 垫片（桌面版开发计划工作项 6）。
// 由 pages.mjs 放在 bridge.js、player.js 前面一起注入，只在播放器窗口、直播窗口里运行（判断见 pages.mjs 的 GUARD）。
// 页面 → 桌面版：调 CDP 的绑定 __bilicdnSend（Runtime.addBinding，只在这个 world 里有，页面自己的脚本调不到），传 JSON 文本；
// 桌面版 → 页面：Runtime.evaluate 在这个 world 里调 __bilicdnShim 的函数。跨 world、跨进程都只传 JSON 文本，和扩展一样。
// 内容脚本只用到 runtime.sendMessage / onMessage、storage.local 和 storage.onChanged、i18n.getUILanguage（desktop/test/shim.test.mjs 核对）；
// 和 Chrome 一样，内容脚本拿不到 storage.session。
(() => {
  'use strict';

  const send = globalThis.__bilicdnSend;
  if (typeof send !== 'function' || globalThis.__bilicdnShim) return;

  let seq = 0;
  const waits = new Map();
  function call(k, data) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waits.set(id, { resolve, reject });
      try {
        send(JSON.stringify({ k, id, href: location.href, top: window === window.top, ...data }));
      } catch (e) {
        waits.delete(id);
        reject(e);
      }
    });
  }
  const parse = (text) => (text === null || text === undefined ? undefined : JSON.parse(text));

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
  const onMessage = event();
  const onChanged = event();
  const localChanged = event();

  const storageCall = (fn, args) => call('storage', { fn, args: JSON.stringify(args) }).then(parse);

  globalThis.chrome = {
    runtime: {
      id: 'bpro-desktop',
      sendMessage: (msg) => call('msg', { msg: JSON.stringify(msg) }).then(parse),
      onMessage,
      getURL: (p = '') => `chrome-extension://bpro-desktop/${String(p).replace(/^\//, '')}`,
    },
    storage: {
      local: {
        get: (keys = null) => storageCall('get', [keys]),
        set: (items) => storageCall('set', [items]),
        remove: (keys) => storageCall('remove', [keys]),
        onChanged: localChanged,
      },
      onChanged,
    },
    // 同 Chrome 扩展：按浏览器（这里是客户端）的界面语言
    i18n: { getUILanguage: () => navigator.language || '' },
  };

  globalThis.__bilicdnShim = {
    /** 桌面版回复 call()：ok 为 false 时 value 是出错信息。 */
    resolve(id, ok, value) {
      const w = waits.get(id);
      if (!w) return;
      waits.delete(id);
      if (ok) w.resolve(value);
      else w.reject(new Error(value || 'failed'));
    },

    /** storage 有变化（只有 local，格式同 Chrome 的 storage.onChanged）。 */
    changed(json, area) {
      const changes = JSON.parse(json);
      for (const fn of [...onChanged.fns]) {
        try {
          fn(changes, area);
        } catch (e) {
          console.error(e);
        }
      }
      if (area === 'local') {
        for (const fn of [...localChanged.fns]) {
          try {
            fn(changes);
          } catch (e) {
            console.error(e);
          }
        }
      }
    },

    /**
     * 后台发来的消息（chrome.tabs.sendMessage）：同 Chrome，监听返回 true 的等它调 sendResponse；
     * 都没回复时为 null。返回回复的 JSON 文本。
     */
    message(msgJson, senderJson) {
      const msg = JSON.parse(msgJson);
      const sender = JSON.parse(senderJson);
      return new Promise((resolve) => {
        let done = false;
        let wait = false;
        const reply = (v) => {
          if (done) return;
          done = true;
          resolve(v === undefined ? null : JSON.stringify(v));
        };
        for (const fn of [...onMessage.fns]) {
          try {
            if (fn(msg, sender, reply) === true) wait = true;
          } catch (e) {
            console.error(e);
          }
        }
        if (!wait) reply(undefined);
      });
    },
  };

  // 页面在不在前台：本地界面的「当前标签页」取最近在前台的播放器或直播窗口（见 pages.mjs activeTab）。
  // 客户端关掉播放器窗口只是隐藏，页面还在（见 docs/pc-client-survey-2026-10-29.md），要靠 document.hidden 分开
  if (window === window.top) {
    const state = () => call('state', { hidden: document.hidden, focus: document.hasFocus() }).catch(() => {});
    for (const type of ['focus', 'blur', 'pageshow']) window.addEventListener(type, state);
    document.addEventListener('visibilitychange', state);
    state();
  }
})();
