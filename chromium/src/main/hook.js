// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN world，document_start 注入：
//   - 捕获播放地址分配：fetch / XHR 的播放接口响应，以及首屏全局变量；
//   - 开启线路优化时按设置改写播放地址（规则见 route.js），开启测速时把测速用的地址交给 SW；
//   - 记录起播耗时和卡顿，包括没等到恢复就离开的卡顿和没能起播；
//   - 报告站内切换视频（只改地址栏、不重新加载页面），由 SW 开始新会话；
//   - 记下扩展看不到的流量：播放器按来源记的字节（B 站的 P2P、PCDN 加载器），WebRTC 数据通道收发的字节；
//   - 设置里关了 B 站 P2P（测试功能，默认不改）时，改播放器读到的 P2P 开关（点播的 fawkes 配置、直播分配里的 p2p_data）。
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
  // bridge.js 读到扩展设置、测速排名、卡顿证据和页面上的表现后传进来：{ on, vod, live, probe, p2p, rank, known, trouble, proto, perf }。
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

  // ---------------------------------------------------------------- 关闭 B 站 P2P（测试功能）
  // 设置 p2p 选了关闭（config.p2p === 'off'；默认 site，什么都不改）：按 B 站播放器自己的开关让它不用 P2P、改走 HTTP（规则见 route.js fawkesNoP2P / liveNoP2P）。
  //   - 点播：拦 Storage.prototype.getItem，播放器从 localStorage 读 fawkes 配置时给它不用 P2P 的。只改读到的，不写回：
  //     B 站保存这份配置时从另一份（bpcfgzip_*）复制，读这一份只看 version（读播放器代码，2026-10-29），关掉开关后刷新就恢复。
  //     播放器第一次读时就缓存了，所以刷新页面才生效
  //   - 直播：改写播放地址分配时（apply）改 p2p_data，和线路优化开没开无关
  // 设置要等 bridge.js 读完存储才到，播放器可能先读：到之前按 bridge.js 记在 localStorage 里的提示（bilicdn:p2p，只在关闭时有）
  const P2P_HINT = 'bilicdn:p2p';
  const p2pOff = () => {
    if (config) return config.p2p === 'off';
    try {
      return localStorage.getItem(P2P_HINT) === '1';
    } catch {
      return false;
    }
  };

  // 这个页面改了哪几种（vod / live），以 p2poff 事件交给 SW 记一条（每个会话每种一条，复盘时分得清 P2P 是关掉的还是本来就没用）。
  // 主视频开始播放以后才交：没有播放的页面不写记录（播放器初始化时就读配置，卡片预览也会）；站内切换后新会话要再交一次
  // （播放器缓存了配置，新视频照样不用 P2P）
  const p2pKinds = new Set();
  const p2pTold = new Set();
  let p2pPlaying = false;
  function tellP2P() {
    if (!p2pPlaying) return;
    for (const kind of p2pKinds) {
      if (p2pTold.has(kind)) continue;
      p2pTold.add(kind);
      emit('p2poff', { kind });
    }
  }
  function noteP2P(kind) {
    p2pKinds.add(kind);
    tellP2P();
  }
  window.addEventListener(
    'playing',
    (e) => {
      if (p2pPlaying || !isVideo(e.target)) return;
      p2pPlaying = true;
      tellP2P();
    },
    true,
  );

  /** 直播的分配按设置去掉 P2P（原地修改），返回改了没有。设置还没到时按提示。 */
  function liveP2P(json) {
    if (!p2pOff()) return false;
    let changed = false;
    try {
      changed = lib.liveNoP2P(json);
    } catch {}
    if (changed) noteP2P('live');
    return changed;
  }

  // 包一层 getItem（Proxy：参数、this、返回值、抛错、name / length、Function.prototype.toString 都和原来一样），
  // 只看这个页面的 localStorage 读 fawkes 配置这一种，别的原样返回。sessionStorage、别的键、设置没说关都不碰
  const FAWKES = 'bilibili_player_dash_fawkes_config';
  try {
    const proto = window.Storage && window.Storage.prototype;
    const nativeGet = proto && proto.getItem;
    let local = null;
    try {
      local = window.localStorage;
    } catch {}
    if (typeof nativeGet === 'function' && local) {
      proto.getItem = new Proxy(nativeGet, {
        apply(target, self, args) {
          const r = Reflect.apply(target, self, args);
          if (args[0] !== FAWKES || self !== local || !p2pOff()) return r;
          try {
            const out = lib.fawkesNoP2P(r);
            if (out !== r) noteP2P('vod');
            return out;
          } catch {
            return r;
          }
        },
      });
    }
  } catch {}

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
    // 不作为当前分配，也不计起播（预览小窗的 playing 会被误当成起播）。
    // B 站 PC 客户端（桌面版）的播放器窗口里，主播放器自己的请求也带 is_main_page=false，另带 from_client=PC_APP（2026-10-31 实测），
    // 不能据此当成预览：不然当前视频的分配、起播、测速地址都没有
    const gs = u ? u.searchParams.get('gaia_source') || '' : '';
    const card = !!u && u.searchParams.get('is_main_page') === 'false' && u.searchParams.get('from_client') !== 'PC_APP';
    const pre = gs === 'pre-load' || gs === 'view-card' || card;
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

  /**
   * 收到设置后：交出测速用的地址，按设置改写（原地修改），关了 B 站 P2P 的去掉直播的 P2P。返回是否改了。
   * 预加载的也改，点进去时播放器直接用。
   */
  function apply(json, entry) {
    if (!config) return false;
    // 测速和复测（线路优化开着时，见 sw.js verifySoon）都要用
    if ((config.probe || config.on) && entry.target && !entry.ev.pre) emit('target', entry.target);
    let rw = null;
    try {
      rw = lib.rewritePlayInfo(json, config);
    } catch {}
    const p2p = liveP2P(json);
    if (!rw) return p2p;
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
      if (config && !config.on && config.p2p !== 'off') {
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
          // 设置还没到、提示说关了 B 站 P2P：直播先只去掉 P2P（播放器读走以后就改不了了），别的照旧不改
          if (pending && !config) liveP2P(pending.v);
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
    // 新会话：关了 P2P 的等新视频开始播放后再交一次
    p2pTold.clear();
    p2pPlaying = false;
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

  // ---------------------------------------------------------------- 扩展看不到的流量
  // 大陆网络下点播、直播的大部分媒体数据走 B 站网页端自己的 P2P（WebRTC 数据通道），点播不走 P2P 时一大半走不在网站权限里的 PCDN，
  // webRequest 都看不到：实测点播 84~87%、直播 61~93% 来自 P2P（见 docs/mainland-p2p-2026-10-29.md）。这里只记下来，
  // 由 SW 记成 src，统计页据此说清扩展看到了几成；不改 B 站的行为。
  //   - 点播：播放器内核自己按来源记了字节（window.player.__core().getCDNInfo(false)：cdn 为 HTTP、nc 为 B 站的 P2P、pdn 为激励 PCDN 加载器等），
  //     实测和抓到的请求差不到 1%。这里只用 false 读：播放器每 5 分钟和关页面时自己用 getCDNInfo(true) 上报并清零（读 B 站播放器代码：
  //     kernelStore.dashKernel.getCDNInfo(!0)，关页面那次在 beforeunload，比这里的 pagehide 早），用 true 读会把它要上报的清掉。
  //     只靠轮询的话，清零前、上次读之后的那段就丢了：1.2.3 在大陆复测，一个约 50 秒的 1080P 会话离开时读到的已经是 0，少算了 69%
  //     （开发计划第 20 项）。所以每个内核第一次见到时给它的 getCDNInfo 包一层（hookCore），播放器清零时拿到清零前的数；
  //     包不上（B 站改了对象）就退回只靠轮询：读到哪一项比这个内核上次读到的小，就是清零过，从 0 算起。
  //   - 直播和上传：直播播放器没有这份计数，cdnInfo 也不含上传。包一层 RTCPeerConnection，记数据通道收、发的字节（含 SDK 自己的消息）。
  // 开始播放（或者有了数据通道）后每 30 秒读一次，页面切到后台、离开、站内切换前也读，这一段的增量以 src 事件交出：
  // 只带有增量的项，都没有就不发；读不到 cdnInfo 就只有 WebRTC 的。后台标签页里定时器会被浏览器放慢，读得少一些，切走时那次照样读
  const SRC = { every: 30e3 };
  const CDN_KEYS = ['cdn', 'nc', 'ncBr', 'pdn', 'p2p', 'mcdn', 'bcache', 'business', 'vcache'];
  // total：算进来的累计；sent：已经交出去的累计；seen：各内核上次读到的值（换了内核时新内核从 0 算起）；hooked：包过 getCDNInfo 的内核
  const cdnAcc = { total: {}, sent: {}, seen: new WeakMap(), hooked: new WeakSet() };
  const rtc = { rx: 0, tx: 0 };
  let srcAt = 0; // 上一段结束的时间（performance.now()，从页面打开算）
  let srcTimer = null;

  /**
   * 播放器内核（点播的 dashKernel，站内切换后播放器重建会换一个）；没有播放器、没有这个接口、抛错时为 null。
   * 网页上播放器挂在 window.player；B 站 PC 客户端（桌面版）的播放器窗口里没有它，同一个对象叫 window.biliPlayer（2026-10-31 实测，
   * 也有 __core()，读法一样）
   */
  function playerCore() {
    try {
      const p = window.player || window.biliPlayer;
      const core = p && typeof p.__core === 'function' ? p.__core() : null;
      return core && typeof core.getCDNInfo === 'function' ? core : null;
    } catch {
      return null;
    }
  }

  /** cdnInfo 里的各项（只要非负数）；不是对象时为 null。 */
  function cdnValues(info) {
    if (!info || typeof info !== 'object') return null;
    const v = {};
    for (const k of CDN_KEYS) {
      const x = Number(info[k]);
      if (Number.isFinite(x) && x >= 0) v[k] = x;
    }
    return v;
  }

  /** 内核 core 读到 v：比这个内核上次读到的多出来的并进累计；哪一项比上次小（清零过、没经过包装），这一份从 0 算起。 */
  function cdnSeen(core, v) {
    const a = cdnAcc;
    const last = a.seen.get(core);
    const fresh = !last || CDN_KEYS.some((k) => (v[k] || 0) < (last[k] || 0));
    for (const k of CDN_KEYS) a.total[k] = (a.total[k] || 0) + (v[k] || 0) - (fresh ? 0 : last[k] || 0);
    a.seen.set(core, v);
  }

  /**
   * 给内核的 getCDNInfo 包一层，每个内核只包一次。播放器用真值调用（上报并清零）时，返回值是清零前的数，当成这一刻读到的并进累计，
   * 再用 false 读一次当作这个内核清零后的起点（万一这次其实没清零，也不会重复算）。用 Proxy 包，参数、this、返回值、抛错、
   * 函数的 name / length 都和原来一样；B 站的方法在原型上，包装只放在这个内核自己身上（不可枚举，和原型上的方法一样）。
   * 冻结了之类包不上的，只靠轮询
   */
  function hookCore(core) {
    if (!core || cdnAcc.hooked.has(core)) return;
    cdnAcc.hooked.add(core);
    try {
      const wrapped = new Proxy(core.getCDNInfo, {
        apply(target, self, args) {
          const r = Reflect.apply(target, self, args);
          if (args[0] && self === core) {
            try {
              const v = cdnValues(r);
              if (v) {
                cdnSeen(core, v);
                const after = cdnValues(Reflect.apply(target, self, [false]));
                if (after) cdnSeen(core, after);
                else cdnAcc.seen.set(core, {});
              }
            } catch {}
          }
          return r;
        },
      });
      const own = Object.getOwnPropertyDescriptor(core, 'getCDNInfo');
      Object.defineProperty(core, 'getCDNInfo', own ? { ...own, value: wrapped } : { value: wrapped, writable: true, configurable: true, enumerable: false });
    } catch {}
  }

  /** 读一次 cdnInfo（只用 false 读），返回上次交出之后的增量（只有大于 0 的项）。播放器清零时并进来的也在这里交出。 */
  function cdnDelta() {
    const core = playerCore();
    if (core) {
      hookCore(core);
      try {
        const v = cdnValues(core.getCDNInfo(false));
        if (v) cdnSeen(core, v);
      } catch {}
    }
    const a = cdnAcc;
    const out = {};
    for (const k of CDN_KEYS) {
      const total = a.total[k] || 0;
      const d = total - (a.sent[k] || 0);
      a.sent[k] = total;
      if (d >= 0.5) out[k] = Math.round(d);
    }
    return out;
  }

  /** 结束一段：交出这段的增量，d 为这段的毫秒数。 */
  function flushSrc() {
    const now = performance.now();
    const out = cdnDelta();
    if (rtc.rx) out.rx = rtc.rx;
    if (rtc.tx) out.tx = rtc.tx;
    rtc.rx = 0;
    rtc.tx = 0;
    const d = Math.round(now - srcAt);
    srcAt = now;
    if (Object.keys(out).length) emit('src', { d, ...out });
  }

  function startSrc() {
    if (!srcTimer) srcTimer = setInterval(flushSrc, SRC.every);
  }

  // 站内切换前（地址还没变，记到旧会话，同 beforeNavigate）、切到后台、离开页面时结束这一段
  if (window.navigation) window.navigation.addEventListener('navigate', (e) => lib.pageKey(e.destination.url) !== pageKey && flushSrc());
  document.addEventListener('visibilitychange', () => document.hidden && flushSrc());
  window.addEventListener('pagehide', flushSrc);
  // 开始播放时就包上内核：放了不到 30 秒就离开的，第一次读在 pagehide，播放器已经在 beforeunload 清零过了
  window.addEventListener(
    'playing',
    (e) => {
      if (!isVideo(e.target)) return;
      startSrc();
      hookCore(playerCore());
    },
    true,
  );

  // 数据通道的字节：字符串按长度，ArrayBuffer / 类型化数组按 byteLength，Blob 按 size
  const sizeOf = (d) => (typeof d === 'string' ? d.length : !d ? 0 : typeof d.byteLength === 'number' ? d.byteLength : typeof d.size === 'number' ? d.size : 0);
  const channels = new WeakSet();
  function watchChannel(ch) {
    if (!ch || channels.has(ch)) return;
    channels.add(ch);
    startSrc();
    try {
      ch.addEventListener('message', (e) => (rtc.rx += sizeOf(e.data)));
    } catch {}
  }

  /**
   * 包一层 RTCPeerConnection：只在旁边记数，接口照常。构造函数换成 Proxy，new、instanceof、原型、静态方法（generateCertificate）、
   * 子类、Function.prototype.toString（Proxy 显示为 native code）都和原来一样，原型的 constructor 指向它。
   * 对方建的数据通道从 datachannel 事件拿，自己建的包 createDataChannel；发出的字节包 RTCDataChannel.prototype.send（发送成功才算）。
   * B 站直播播放器会在干净的 iframe 里再测一次 WebRTC 能不能用（checkP2PSupportBypass），页面里不能用、干净环境里能用就当成用户屏蔽了、
   * 不开 P2P；只是包装、照常能用，不会这样判：实测包装后直播照样建了 48~72 个连接
   */
  function wrapPeerConnection(Native) {
    const proto = Native.prototype;
    if (!proto) return Native;
    const Wrapped = new Proxy(Native, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
        try {
          pc.addEventListener('datachannel', (e) => watchChannel(e.channel));
        } catch {}
        return pc;
      },
    });
    const nativeCreate = proto.createDataChannel;
    if (typeof nativeCreate === 'function') {
      proto.createDataChannel = function createDataChannel(label) {
        const ch = nativeCreate.apply(this, arguments);
        watchChannel(ch);
        return ch;
      };
    }
    try {
      Object.defineProperty(proto, 'constructor', { ...Object.getOwnPropertyDescriptor(proto, 'constructor'), value: Wrapped });
    } catch {}
    return Wrapped;
  }

  try {
    const wrapped = new Map(); // 原来的构造函数 → 包装（Chrome 的 webkitRTCPeerConnection 和 RTCPeerConnection 是同一个）
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
      const Native = window[name];
      if (typeof Native !== 'function') continue;
      if (!wrapped.has(Native)) wrapped.set(Native, wrapPeerConnection(Native));
      window[name] = wrapped.get(Native);
    }
    const DC = window.RTCDataChannel;
    const nativeSend = DC && DC.prototype && DC.prototype.send;
    if (typeof nativeSend === 'function') {
      DC.prototype.send = function send(data) {
        const r = nativeSend.apply(this, arguments);
        rtc.tx += sizeOf(data);
        return r;
      };
    }
  } catch {}
})();
