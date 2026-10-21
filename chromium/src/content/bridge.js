// SPDX-License-Identifier: AGPL-3.0-or-later
// ISOLATED world：把 hook.js 发出的页面事件转发给 service worker，并把扩展设置传给 hook.js。
// 刻意不依赖任何共享脚本：同一个文件同时列在 MAIN 和 ISOLATED 两组 content_scripts 里时，
// 浏览器只会注入一次，ISOLATED world 里就拿不到它定义的全局对象。页面类型由 SW 根据 href 判断。
(() => {
  'use strict';

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // 扩展被重新加载后旧页面的上下文失效，忽略
    }
  }

  send({ type: 'hello', top: window === window.top, href: location.href });

  // 暂停（总开关关掉）时不转发，SW 也不记；设置还没读回时照样转发，由 SW 判断
  let paused = false;
  document.addEventListener('bilicdn:page', (e) => {
    if (paused) return;
    let ev;
    try {
      ev = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (ev && typeof ev.type === 'string') send({ type: 'page', href: location.href, ev });
  });

  // 设置（settings）、测速排名（rank）和卡顿证据（trouble 按节点、protoTrouble 按直播协议）存在 chrome.storage.local，
  // MAIN world 读不到，变化时重新传一次。排名是否过期、哪些节点算出过问题由 route.js 在改写时按当时的时间判断
  // known：本网络以往的测速（网络档案，见 probe.js），没有新测速时用；hls 为直播 HLS 按编码和清晰度汇总的，开播选协议用
  const KEYS = ['settings', 'rank', 'known', 'trouble', 'protoTrouble'];
  const store = {};
  function push() {
    const s = store.settings || {};
    // 暂停时不改写、不交出测速地址（on / probe 都按关）
    paused = s.enabled === false;
    const rank = store.rank || {};
    const trouble = (store.trouble || []).map((x) => ({ t: x.t, h: x.h, p: x.p, w: x.w }));
    const proto = (store.protoTrouble || []).map((x) => ({ t: x.t, p: x.p, qn: x.qn, w: x.w }));
    const k = store.known || {};
    const known = { vod: k.vod || {}, live: k.live || {}, br: k.br || {}, hls: k.hls || {} };
    const config = { on: !paused && !!s.route, vod: s.vodHost || 'auto', live: s.liveProto || 'auto', probe: !paused && !!s.probe, rank: { t: rank.t || 0, vod: rank.vod || {}, live: rank.live || {}, br: rank.br || {} }, known, trouble, proto };
    document.dispatchEvent(new CustomEvent('bilicdn:config', { detail: JSON.stringify(config) }));
    hint(config.on);
  }

  // 线路优化开没开的提示，记在页面的 localStorage 里，下次打开这个网站的页面时 hook.js 能同步读到（设置要等读完存储才到）：
  // 首屏数据赶在设置之前被页面读走时，hook.js 据此决定要不要先不交出去（见 hook.js trapGlobal）。
  // 提示过期（在别的网站页面上改了设置）只影响交不交，改写只按真实设置。没变就不写，免得惊动页面的 storage 事件
  const HINT = 'bilicdn:route';
  function hint(on) {
    try {
      const v = on ? '1' : '0';
      if (localStorage.getItem(HINT) !== v) localStorage.setItem(HINT, v);
    } catch {}
  }
  try {
    chrome.storage.local
      .get(KEYS)
      .then((r) => {
        Object.assign(store, r);
        push();
      })
      .catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !KEYS.some((k) => k in changes)) return;
      for (const k of KEYS) if (k in changes) store[k] = changes[k].newValue;
      push();
    });
  } catch {}
})();
