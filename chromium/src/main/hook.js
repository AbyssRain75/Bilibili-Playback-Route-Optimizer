// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN world，document_start 注入：
//   - 捕获播放地址分配：fetch / XHR 的播放接口响应，以及首屏全局变量；
//   - 开启线路优化时按设置改写播放地址（规则见 route.js），开启测速时把测速用的地址交给 SW；
//   - 记录起播耗时和卡顿，包括没等到恢复就离开的卡顿和没能起播；
//   - 报告站内切换视频（只改地址栏、不重新加载页面），由 SW 开始新会话。
// 事件以 JSON 字符串经 DOM 事件交给 bridge.js，设置也由 bridge.js 这样传进来（跨 world 只传原始值最稳妥）。
(() => {
  'use strict';

  const lib = globalThis.__bilicdn;
  try {
    delete globalThis.__bilicdn;
  } catch {}
  const FLAG = Symbol.for('bilicdn.hooked');
  if (!lib || !lib.extractPlayInfo || window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true });

  const EVENT = 'bilicdn:page';
  function emit(type, data) {
    try {
      document.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify({ type, ...data }) }));
    } catch {}
  }

  // ---------------------------------------------------------------- 设置
  // bridge.js 读到扩展设置、测速排名和卡顿证据后传进来：{ on, vod, live, probe, rank, trouble }。
  // 收到之前不改写：fetch 最多等 500ms，首屏数据等到页面读取时，XHR 来不及就不改

  let config = null;
  const waiting = [];
  const ssrFlush = [];
  document.addEventListener('bilicdn:config', (e) => {
    try {
      config = JSON.parse(e.detail);
    } catch {
      return;
    }
    waiting.splice(0).forEach((fn) => fn());
    ssrFlush.forEach((fn) => fn());
  });
  const whenConfig = () => (config ? Promise.resolve() : new Promise((r) => waiting.push(r) && setTimeout(r, 500)));

  // ---------------------------------------------------------------- 播放地址分配

  const API_RE = /\/(playurl|getRoomPlayInfo|playview)\b/i;
  const seen = new WeakSet();
  // 最近的分配。站内切换视频时播放器常常直接用切换前拿到的地址（悬停推荐卡片时的预加载、
  // 自动连播在改地址栏之前发的请求），切换后要按视频标识找出来补记到新会话
  const recent = [];
  // 拿到新的播放地址后开始计时，等待媒体就绪（canplay）和开始播放（playing）
  let armed = null;
  let armedAt = null;
  let readyAt = null;
  // 计时期间页面进过后台：后台标签页里播放器不加载视频，等不到就绪也不能算起播失败
  let armHidden = false;

  function arm(entry) {
    armed = entry;
    armedAt = performance.now();
    readyAt = null;
    armHidden = document.hidden;
  }

  function apiPath(url) {
    try {
      return new URL(url, location.href).pathname;
    } catch {
      return String(url).split('?')[0];
    }
  }

  /** 记录 B 站的原始分配（要在改写之前）。url：接口请求地址；首屏数据没有，属于当前页面。 */
  function report(json, src, api, url) {
    if (!json || typeof json !== 'object' || seen.has(json)) return null;
    seen.add(json);
    let info = null;
    try {
      info = lib.extractPlayInfo(json);
    } catch {}
    if (!info) return null;
    let u = null;
    try {
      u = new URL(url || location.href, location.href);
    } catch {}
    const ids = u ? lib.videoIds(u.href) : [];
    // 悬停推荐卡片时，播放器预加载那个视频（gaia_source=pre-load，自动连播的下一个也是），
    // 卡片上的小窗预览再请求一次（view-card，is_main_page=false）。都不是当前页面的视频：
    // 不作为当前分配，也不计起播（预览小窗的 playing 会被误当成起播）
    const gs = u ? u.searchParams.get('gaia_source') || '' : '';
    const pre = gs === 'pre-load' || gs === 'view-card' || (!!u && u.searchParams.get('is_main_page') === 'false');
    const ev = { src, api, vid: ids[0] || '', ...(gs ? { gs } : {}), ...(pre ? { pre: 1 } : {}), ...info };
    emit('asg', { ...ev, path: location.pathname });
    let target = null;
    try {
      target = lib.probeTargets(json);
    } catch {}
    const entry = { ids, ev, target, route: null, started: false };
    recent.push(entry);
    if (recent.length > 30) recent.shift();
    if (!pre) arm(entry);
    return entry;
  }

  /** 收到设置后：交出测速用的地址，按设置改写（原地修改）。返回是否改写了。预加载的也改，点进去时播放器直接用。 */
  function apply(json, entry) {
    if (!config) return false;
    // 测速和复测（线路优化开着时，见 sw.js verifySoon）都要用
    if ((config.probe || config.on) && entry.target && !entry.ev.pre) emit('target', entry.target);
    let rw = null;
    try {
      rw = lib.rewritePlayInfo(json, config);
    } catch {}
    if (!rw) return false;
    entry.route = rw;
    emit('route', { ...rw, vid: entry.ev.vid, ...(entry.ev.pre ? { pre: 1 } : {}) });
    return true;
  }

  function rebuild(res, json) {
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    const out = new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers });
    try {
      Object.defineProperty(out, 'url', { value: res.url });
    } catch {}
    return out;
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function fetch(input) {
      const promise = origFetch.apply(this, arguments);
      let url = null;
      try {
        url = typeof input === 'string' ? input : (input && input.url) || String(input);
      } catch {}
      if (!url || !API_RE.test(url)) return promise;
      if (config && !config.on) {
        // 不改写时不耽误页面拿响应：另开一条链读副本（先于页面代码注册回调，clone 时 body 尚未被读取）
        promise
          .then((res) => res.clone().json())
          .then((json) => {
            const entry = report(json, 'fetch', apiPath(url), url);
            if (entry) apply(json, entry);
          })
          .catch(() => {});
        return promise;
      }
      return promise.then(async (res) => {
        try {
          const json = await res.clone().json();
          const entry = report(json, 'fetch', apiPath(url), url);
          await whenConfig();
          if (entry && apply(json, entry)) return rebuild(res, json);
        } catch {}
        return res;
      });
    };
  }

  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  const getText = Object.getOwnPropertyDescriptor(XHR, 'responseText').get;
  const getResponse = Object.getOwnPropertyDescriptor(XHR, 'response').get;
  const xhrUrl = new WeakMap();
  XHR.open = function open(method, url) {
    try {
      xhrUrl.set(this, String(url));
    } catch {}
    return origOpen.apply(this, arguments);
  };
  XHR.send = function send() {
    const url = xhrUrl.get(this);
    if (url && API_RE.test(url)) watchXhr(this, url);
    return origSend.apply(this, arguments);
  };

  /**
   * 播放接口的 XHR：载入后记录分配，需要改写时页面读到的是改写后的内容。
   * 在实例上覆盖 responseText / response，不管页面先读还是我们的 load 回调先跑，都只处理一次
   */
  function watchXhr(xhr, url) {
    let out; // undefined：还没处理；null：不用改；否则是改写后的 { json, text }
    const settle = () => {
      if (out !== undefined || xhr.readyState !== 4) return out;
      out = null;
      try {
        const t = xhr.responseType;
        const json = t === 'json' ? getResponse.call(xhr) : !t || t === 'text' ? JSON.parse(getText.call(xhr)) : null;
        const entry = report(json, 'xhr', apiPath(url), url);
        if (entry && apply(json, entry)) out = { json, text: t === 'json' ? null : JSON.stringify(json) };
      } catch {}
      return out;
    };
    try {
      Object.defineProperty(xhr, 'responseText', {
        configurable: true,
        get() {
          const o = settle();
          return o && o.text !== null ? o.text : getText.call(xhr);
        },
      });
      Object.defineProperty(xhr, 'response', {
        configurable: true,
        get() {
          const o = settle();
          return !o ? getResponse.call(xhr) : o.text === null ? o.json : o.text;
        },
      });
    } catch {}
    xhr.addEventListener('load', settle);
  }

  // 首屏数据：点播 __playinfo__（内联在页面开头；实测没登录但带着 B 站 cookie 时也有，全新配置第一次打开时没有）、直播 __NEPTUNE_IS_MY_WAIFU__。
  // 赋值时页面脚本还没读，可以原地改写；设置还没到就等页面第一次读取时再改，读过之后不再改：
  // 实测播放器读的时候就把地址拿走了，之后改了也照样请求原来的节点（见 docs/ssr-rewrite-race-2026-10-20.md）。
  // 设置要等 bridge.js 读完存储才到，平时只比页面读取早几十毫秒（实测 48~114 ms），浏览器忙的时候会晚到，这一页就没改写
  // （实测导出里能改写的首屏漏了 2 次）。所以点播页第一次读时设置还没到、线路优化又可能开着（bridge.js 记在 localStorage 的提示），
  // 就先不交出首屏数据：返回 undefined，播放器像页面里没有首屏数据时那样自己请求播放地址，这个请求按到时已经到了的真实设置改写。
  // 实测播放器会这样退回去，照常播放，起播慢约 0.4~1.4 秒。提示过期只影响交不交，不会按过期的设置改写。
  // 直播的 __NEPTUNE_IS_MY_WAIFU__ 里还有直播间信息，不这样做
  const HINT = 'bilicdn:route';
  const routeHint = () => {
    try {
      return localStorage.getItem(HINT) === '1';
    } catch {
      return false;
    }
  };
  function trapGlobal(name, holdable) {
    let value;
    let pending = null;
    let held = false; // 这份首屏数据没交给页面（之后再读也不给，免得播放器前后拿到两份）
    const flush = () => {
      if (!pending || !config) return;
      const p = pending;
      pending = null;
      apply(p.v, p.entry);
    };
    const take = (v) => {
      value = v;
      pending = null;
      held = false;
      const entry = report(v, 'ssr', name);
      if (entry) pending = { v, entry };
      flush();
    };
    ssrFlush.push(flush);
    if (window[name] !== undefined) take(window[name]);
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() {
          flush();
          if (pending && holdable && routeHint()) {
            held = true;
            emit('hold', { vid: pending.entry.ev.vid });
          }
          pending = null;
          return held ? undefined : value;
        },
        set: take,
      });
    } catch {}
  }
  trapGlobal('__playinfo__', lib.pageType(location.href) === 'video');
  trapGlobal('__NEPTUNE_IS_MY_WAIFU__', false);

  // 页面自己解析的 JSON，改不了，只记录
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return;
      try {
        report(JSON.parse(el.textContent), 'ssr', '__NEXT_DATA__');
      } catch {}
    },
    { once: true },
  );

  // ---------------------------------------------------------------- 站内切换页面
  // 点推荐视频、自动连播、切分 P 都只改地址栏，不重新加载页面。

  let pageKey = lib.pageKey(location.href);
  function onNavigate() {
    const key = lib.pageKey(location.href);
    if (key === pageKey) return;
    pageKey = key;
    emit('nav', {});
    const ids = lib.videoIds(location.href);
    const entry = ids.length ? recent.findLast((e) => e.ids.some((id) => ids.includes(id))) : undefined;
    if (!entry) return;
    emit('asg', { ...entry.ev, path: location.pathname, carry: 1 });
    // 预加载时已经改写过，新会话也要知道用的是哪条线路；测速改测这个视频
    if (entry.route) emit('route', { ...entry.route, vid: entry.ev.vid, carry: 1 });
    if (config && (config.probe || config.on) && entry.target) emit('target', entry.target);
    // 切换前已在计时的沿用原起点；预加载的地址从切换时开始计时
    if (!entry.started && !(armed === entry && armedAt !== null)) arm(entry);
  }

  // navigate 在地址改变之前触发，这时把旧页面没结束的卡顿、没能起播的等待记下来，才会记到旧会话。
  // 要去的正是正在等的视频（自动连播先请求、后改地址栏）时，起播接着计时
  function beforeNavigate(e) {
    const dest = e.destination;
    if (lib.pageKey(dest.url) === pageKey) return;
    const ids = lib.videoIds(dest.url);
    endPending(dest.sameDocument ? 'switch' : 'leave', !(armed && armed.ids.some((id) => ids.includes(id))));
  }
  if (window.navigation) {
    window.navigation.addEventListener('navigate', beforeNavigate);
    window.navigation.addEventListener('currententrychange', onNavigate);
  }

  // ---------------------------------------------------------------- 起播与卡顿

  // 只看主播放器的视频。推荐卡片上的预览小窗也是 video：悬停卡片时卡片里放一个静音的小播放器。实测视频页右侧推荐卡片
  // （.video-page-card-small）里的是完整的 bpx 播放器（.v-recommend-inline-player，带控制栏，videoHeight 640，和主视频一样），
  // 搜索页卡片（.bili-video-card）里的是 .v-inline-live-player，按尺寸、有没有控制栏都分不出来，只能按它在卡片里认。
  // 不分的话：主视频还没就绪时预览先放起来，起播就记成了预览的，主视频开始播放反而不记；预览缓冲一下也记成卡顿，算到当前页面的节点上；
  // 放过的预览还会挡住「没能起播」。每次事件时按所在位置判断，主播放器换了 video 元素、换了源都照样认。player.js 按同样的规则找主视频
  const PREVIEW = '[class*="inline-player"], [class*="inline-live-player"], .video-page-card-small, .bili-video-card';
  const isVideo = (t) => t instanceof HTMLVideoElement && !t.closest(PREVIEW);
  const mainVideos = () => [...document.querySelectorAll('video')].filter(isVideo);

  const states = new WeakMap();
  function stateOf(v) {
    let s = states.get(v);
    // played：当前源是否已开始播放过；首次播放前的缓冲属于起播，不算卡顿
    // wake：这次缓冲是切回前台后恢复画面引起的（见下面的 visibilitychange）
    if (!s) states.set(v, (s = { since: null, seek: false, wake: false, playAt: null, played: false }));
    return s;
  }
  // 正在卡顿的 video：卡着就离开页面时，要在离开前把卡顿记下来
  const stalling = new Set();

  /** cut：没等到恢复播放就结束；end：结束原因，switch 换源或站内切换 / leave 离开页面 / hidden 切到后台，用户暂停时不带。 */
  function endStall(v, s, t, cut, end) {
    if (s.since === null) return;
    const ms = Math.round(t - s.since);
    s.since = null;
    stalling.delete(v);
    if (ms >= 50) emit('stall', { ms, seek: s.seek, vh: v.videoHeight, cut, ...(end ? { end } : {}), ...(s.wake ? { wake: 1 } : {}) });
    s.wake = false;
  }

  // 页面在后台时浏览器 / 播放器停掉画面，只放声音、不再取视频分片，video 会一直报 waiting 到播完，并不是卡顿
  // （实测自动连播挂在后台时，每个视频开播十几秒后都“卡”了一两分钟，把好节点都判成了卡过）。所以：
  // 后台时不开始计卡顿；卡着切到后台就在那一刻结束（end: hidden）；切回前台后 WAKE_MS 内开始的缓冲是在恢复画面，
  // 标 wake，照样记下但不算节点的问题。计时期间进过后台的起播（armHidden）同理，标 hid
  const WAKE_MS = 5000;
  let shownAt = -Infinity;
  document.addEventListener('visibilitychange', () => {
    const t = performance.now();
    if (document.hidden) {
      armHidden = true;
      for (const v of [...stalling]) endStall(v, stateOf(v), t, true, 'hidden');
      return;
    }
    shownAt = t;
    // 后台时的 waiting 没有计，回到前台时还在等的，从现在开始计
    for (const v of mainVideos()) {
      const s = stateOf(v);
      if (!s.played || s.since !== null || v.paused || v.ended || v.readyState >= 3) continue;
      Object.assign(s, { since: t, seek: v.seeking, wake: true });
      stalling.add(v);
    }
  });

  // 一直卡着、一直没能起播就离开（刷新、关页面、换视频）的，事后没有机会再记，离开前记下。
  // 起播失败只看媒体一直没就绪（canplay），被自动播放拦截的页面会就绪，不受影响。
  // 页面上的视频还在放拿到地址之前的源（中途又请求了一次播放地址、播放器没有换源）也不算：换源会触发 emptied
  const START_FAIL_MS = 3000;
  function endPending(end, withStart) {
    const t = performance.now();
    // 已经从页面上移除的 video（如卡片预览小窗）不算
    for (const v of [...stalling]) v.isConnected ? endStall(v, stateOf(v), t, true, end) : stalling.delete(v);
    const oldSource = mainVideos().some((v) => stateOf(v).played);
    if (withStart && armedAt !== null && readyAt === null && !armHidden && !oldSource && t - armedAt >= START_FAIL_MS) {
      emit('start', { ms: Math.round(t - armedAt), cp: null, pm: null, vh: 0, fail: 1 });
      armedAt = null;
    }
  }
  window.addEventListener('pagehide', () => endPending('leave', true));

  window.addEventListener('play', (e) => isVideo(e.target) && (stateOf(e.target).playAt = performance.now()), true);
  window.addEventListener(
    'canplay',
    (e) => {
      if (isVideo(e.target) && armedAt !== null && readyAt === null) readyAt = performance.now();
    },
    true,
  );

  window.addEventListener(
    'waiting',
    (e) => {
      const v = e.target;
      if (!isVideo(v) || document.hidden) return;
      const s = stateOf(v);
      if (s.since === null && s.played) {
        s.since = performance.now();
        s.seek = v.seeking;
        s.wake = s.since - shownAt < WAKE_MS;
        stalling.add(v);
      }
    },
    true,
  );

  window.addEventListener(
    'playing',
    (e) => {
      const v = e.target;
      if (!isVideo(v)) return;
      const t = performance.now();
      const s = stateOf(v);
      // 只有一个源的第一次播放才算起播。这个源已经播过（暂停后继续、卡顿后恢复），说明拿到地址后播放器没有换源
      // （中途又请求了一次播放地址之类），这次计时作废：实测不作废会把暂停的时间算成起播慢
      if (armedAt !== null && !s.played) {
        // cp：地址→媒体就绪，主要受 CDN 影响，不受自动播放拦截影响（播放器会预加载）
        // ms：地址→开始播放；pm：调用 play()→开始播放
        emit('start', {
          ms: Math.round(t - armedAt),
          cp: readyAt === null ? null : Math.round(readyAt - armedAt),
          pm: s.playAt === null ? null : Math.round(t - s.playAt),
          vh: v.videoHeight,
          ...(armHidden ? { hid: 1 } : {}),
        });
        armed.started = true;
      }
      armedAt = null;
      endStall(v, s, t, false);
      s.played = true;
    },
    true,
  );

  // 卡顿中用户暂停：记到暂停为止并标记 cut。
  // 换源后重新等待首次播放；换源前已经卡了 1 秒以上的（多半是卡住后换了视频或清晰度）记下来，
  // 更短的是换源本身引起的缓冲，丢弃
  window.addEventListener('pause', (e) => isVideo(e.target) && endStall(e.target, stateOf(e.target), performance.now(), true), true);
  window.addEventListener(
    'emptied',
    (e) => {
      const v = e.target;
      if (!isVideo(v)) return;
      const s = stateOf(v);
      const t = performance.now();
      if (s.since !== null && t - s.since >= 1000) endStall(v, s, t, true, 'switch');
      s.since = null;
      stalling.delete(v);
      s.played = false;
    },
    true,
  );
})();
