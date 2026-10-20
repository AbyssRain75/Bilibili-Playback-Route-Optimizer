// SPDX-License-Identifier: GPL-3.0-or-later
// ISOLATED world：读播放器状态，在播放器控制栏上放标记卡顿的按钮。
//   - 手动标记时 SW 向页面要播放器状态（卡顿点）：播放位置、前方缓冲、就绪状态、近 10 秒掉帧，据此判断是网络卡还是画面卡；
//   - 标记按钮：点一下记为“较多卡顿”，悬停显示当前播放状态（缓冲、码率、在用的节点和下载速度）和标记菜单，
//     标记后可以撤销（菜单里点「正常」也是撤销）。可以在 popup 里关掉。
// 和 bridge.js 一样不依赖共享脚本。video 元素的属性在 ISOLATED world 里也能直接读。
(() => {
  'use strict';

  const LIVE = location.hostname === 'live.bilibili.com';

  // 界面语言，同 shared/cdn.js（这里不加载共享脚本）：设置里的 lang 为 auto 时跟浏览器（浏览器界面是中文显示中文，其他语言显示英文），
  // zh / en 是在 popup、统计页上选的。读到设置之前按跟浏览器，按钮这时还没放上去；换了语言菜单里的字跟着换（见 showTexts）
  const AUTO_ZH = /^zh(?:[-_]|$)/i.test(chrome.i18n.getUILanguage());
  const zhOf = (pref) => (pref === 'zh' ? true : pref === 'en' ? false : AUTO_ZH);
  let zh = AUTO_ZH;
  const L = (zhText, enText) => (zh ? zhText : enText);

  // ---------------------------------------------------------------- 播放器状态

  // 控制栏右侧那组按钮：点播的 bpx 播放器（视频、番剧、嵌入播放器），直播播放器（控制栏悬停时才渲染，
  // 先认 .web-player-controller-wrap，渲染出来后再找 .right-area）
  const BARS = [
    { sel: '.bpx-player-control-bottom-right', root: '.bpx-player-control-wrap', kind: 'bpx' },
    { sel: '.web-player-controller-wrap .right-area', root: '.web-player-controller-wrap', kind: 'live' },
  ];

  /**
   * 视频所在播放器的控制栏（往上找几层）：{ roots 控制栏外层（直播页有不止一个）, bar 放按钮的那组（直播没悬停时为 null）, kind }。
   */
  function barOf(v) {
    for (let el = v.parentElement, i = 0; el && i < 8; el = el.parentElement, i++) {
      for (const b of BARS) {
        const roots = [...el.querySelectorAll(b.root)];
        if (roots.length) return { roots, bar: el.querySelector(b.sel), kind: b.kind };
      }
    }
    return null;
  }

  // 推荐卡片上的预览小窗（规则和实测见 hook.js PREVIEW）：视频页右侧卡片里的是完整的 bpx 播放器，也带控制栏，
  // 下面按「正在播放」加分的话，主视频暂停时就选成了它（按实测的页面结构算，主视频暂停、悬停卡片时选中的是预览），状态和标记按钮都对着它
  const PREVIEW = '[class*="inline-player"], [class*="inline-live-player"], .video-page-card-small, .bili-video-card';

  /**
   * 页面上的主视频：推荐卡片的预览小窗不算，优先带控制栏的，其次正在播放的、面积大的。
   * 返回 { v, bar }，没有视频时为 null。
   */
  function mainVideo() {
    const list = [];
    for (const v of document.querySelectorAll('video')) {
      if (!v.isConnected || !v.currentSrc || v.closest(PREVIEW)) continue;
      const r = v.getBoundingClientRect();
      if (r.width > 0) list.push({ v, score: r.width * r.height + (v.paused ? 0 : 1e8) });
    }
    list.sort((a, b) => b.score - a.score);
    for (const { v } of list) {
      const bar = barOf(v);
      if (bar) return { v, bar };
    }
    return list.length ? { v: list[0].v, bar: null } : null;
  }

  // 掉帧：getVideoPlaybackQuality 给的是累计值，每 2 秒记一次，标记时和约 10 秒前比。
  // 码率也一样：webkitVideoDecodedByteCount / webkitAudioDecodedByteCount 是累计解码的字节数（Chromium 有，Firefox 没有）
  const decoded = (v) => (typeof v.webkitVideoDecodedByteCount === 'number' ? v.webkitVideoDecodedByteCount + (v.webkitAudioDecodedByteCount || 0) : null);
  const samples = [];
  function sample() {
    const v = (mainVideo() || {}).v;
    if (!v || document.hidden || typeof v.getVideoPlaybackQuality !== 'function') return;
    const q = v.getVideoPlaybackQuality();
    const b = decoded(v);
    const last = samples[samples.length - 1];
    // 换了 video 元素或者换源（计数归零）就重新开始
    if (last && (last.v !== v || q.totalVideoFrames < last.n || (b !== null && b < last.b))) samples.length = 0;
    samples.push({ v, t: performance.now(), d: q.droppedVideoFrames, n: q.totalVideoFrames, b });
    if (samples.length > 6) samples.shift();
  }
  let sampling = false;
  window.addEventListener(
    'playing',
    (e) => {
      if (sampling || !(e.target instanceof HTMLVideoElement)) return;
      sampling = true;
      setInterval(sample, 2000);
    },
    true,
  );

  function drops(v) {
    if (typeof v.getVideoPlaybackQuality !== 'function') return null;
    const q = v.getVideoPlaybackQuality();
    const now = performance.now();
    const base = samples.find((x) => x.v === v && now - x.t <= 12e3 && q.totalVideoFrames >= x.n);
    return base ? { drop: q.droppedVideoFrames - base.d, frames: q.totalVideoFrames - base.n } : null;
  }

  const r1 = (x) => Math.round(x * 10) / 10;

  /** 近约 10 秒的码率（Mbps）：这段时间解码的音视频字节数 ÷ 时间。浏览器不支持、刚开始播放（不到 1.5 秒的样本）时为 null。 */
  function bitrate(v) {
    const b = decoded(v);
    if (b === null) return null;
    const now = performance.now();
    const base = samples.find((x) => x.v === v && now - x.t <= 12e3 && x.b !== null && b >= x.b);
    return base && now - base.t >= 1500 ? r1(((b - base.b) * 8) / (now - base.t) / 1e3) : null;
  }

  /**
   * 卡顿点：pos 播放位置（秒）、dur 时长（直播为 null）、buf 当前位置往后已缓冲的秒数、rs readyState、
   * paused、vh 画面高度，以及近 10 秒的掉帧 drop / 总帧数 frames（刚开始播放时没有）。
   */
  function playerState() {
    const v = (mainVideo() || {}).v;
    if (!v) return null;
    const t = v.currentTime;
    let buf = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= t + 0.2 && v.buffered.end(i) > t) buf = v.buffered.end(i) - t;
    }
    const dur = LIVE || !Number.isFinite(v.duration) ? null : r1(v.duration);
    return { pos: r1(t), dur, buf: r1(buf), rs: v.readyState, paused: v.paused, vh: v.videoHeight, ...drops(v) };
  }

  // 有视频的 frame 才回复。暂停的晚一点回复：一个标签页里有多个 frame 在放视频时，优先正在播放的那个
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'player') return undefined;
    const ps = playerState();
    if (!ps) return undefined;
    if (!ps.paused) {
      sendResponse(ps);
      return undefined;
    }
    setTimeout(() => sendResponse(ps), 60);
    return true;
  });

  // ---------------------------------------------------------------- 标记按钮

  // 按钮放在主视频所在播放器的控制栏里（见 BARS）；认不出控制栏时浮在视频右上角，鼠标移动时显示。
  // 鼠标移上去弹出一个框：上面是当前的播放状态（每秒刷新），下面是标记菜单
  // 用到时才按当前语言取
  const LEVELS = {
    get 1() { return L('少量卡顿', 'Few stalls'); },
    get 2() { return L('较多卡顿', 'Many stalls'); },
    get 3() { return L('无法播放', "Won't play"); },
  };
  const CAUSES = {
    get net() { return L('缓冲不足', 'Low buffer'); },
    get drop() { return L('掉帧', 'Dropped frames'); },
    get ok() { return L('缓冲充足', 'Buffer OK'); },
  };
  const TONES = { net: 'bad', drop: 'warn', ok: 'ok' };
  const problem = (m) => (m.issue === 'sync' ? L('音画不同步', 'A/V out of sync') : LEVELS[m.lv]);

  const ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 3.5a1 1 0 0 1 1 1V5h12.2a.8.8 0 0 1 .64 1.28L16.5 9.5l2.34 3.22A.8.8 0 0 1 18.2 14H6v6.5a1 1 0 1 1-2 0v-16a1 1 0 0 1 1-1z"/></svg>';

  const CSS = `
    :host { all: initial; position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none;
      width: 36px; height: 22px; vertical-align: middle; color: #fff; cursor: pointer;
      font: 12px/1.5 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
    :host([data-kind='live']) { width: 30px; height: 30px; }
    :host([data-kind='float']) { position: absolute; top: 12px; right: 12px; z-index: 100; width: 32px; height: 32px;
      border-radius: 6px; background: rgba(0, 0, 0, 0.45); opacity: 0; transition: opacity 0.2s; }
    :host([data-kind='float'].awake), :host([data-kind='float']:hover), :host([data-kind='float'].done) { opacity: 1; }
    .icon { display: flex; width: 22px; height: 22px; opacity: 0.8; }
    :host([data-kind='live']) .icon { width: 24px; height: 24px; }
    :host(:hover) .icon { opacity: 1; }
    .icon svg { width: 100%; height: 100%; }
    .pop { position: absolute; left: 0; bottom: 100%; width: max-content; padding-bottom: 10px; display: none; }
    :host([data-kind='float']) .pop { bottom: auto; top: 100%; padding: 8px 0 0; }
    :host(.open:not(.done)) .menu, :host(.done) .tip { display: block; }
    .box { background: rgba(21, 21, 21, 0.9); border-radius: 4px; white-space: nowrap; color: #fff; }
    .menu .box { padding: 4px 0; }
    .status { padding: 4px 12px 6px; margin-bottom: 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.12); cursor: default; }
    .menu.tight .status { display: none; }
    .state { font-weight: 600; }
    .host { display: inline-block; max-width: 170px; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
    .note { max-width: 250px; margin-top: 2px; white-space: normal; font-size: 11px; line-height: 1.4; }
    .head, .muted, .note { color: rgba(255, 255, 255, 0.6); }
    .ok { color: #6dd28f; }
    .warn { color: #ffb84d; }
    .bad { color: #ff6b6e; }
    .head { padding: 2px 12px 4px; cursor: default; }
    .item { padding: 3px 12px; }
    .item:hover { background: rgba(255, 255, 255, 0.12); }
    .item.on { color: #fb7299; font-weight: 600; }
    .item.on[data-normal] { cursor: default; background: none; }
    .tip .box { padding: 6px 10px; display: flex; gap: 10px; }
    .undo { color: #fb7299; }
    .undo:hover { text-decoration: underline; }
  `;

  const host = document.createElement('bilicdn-mark');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style>
    <div class="icon" role="button">${ICON}</div>
    <div class="pop menu"><div class="box">
      <div class="status"></div>
      <div class="head"></div>
      <div class="item" role="button" data-normal></div>
      ${[1, 2, 3].map((lv) => `<div class="item" role="button" data-lv="${lv}"></div>`).join('')}
      <div class="item" role="button" data-issue="sync"></div>
    </div></div>
    <div class="pop tip"><div class="box"><span class="msg"></span><span class="undo" role="button" hidden></span></div></div>`;
  const $menu = root.querySelector('.menu');
  const $tip = root.querySelector('.tip');
  const $status = root.querySelector('.status');
  const $items = [...root.querySelectorAll('.item')];
  const $normal = root.querySelector('[data-normal]');
  const $msg = root.querySelector('.msg');
  const $undo = root.querySelector('.undo');

  /** 按钮和菜单里固定的字，换了语言重新填。 */
  function showTexts() {
    root.querySelector('.icon').setAttribute('aria-label', L('手动问题标注（Bilibili Playback Route Optimizer）', 'Report a problem (Bilibili Playback Route Optimizer)'));
    root.querySelector('.head').textContent = L('手动问题标注', 'Report a problem');
    for (const el of $items) el.textContent = el === $normal ? L('正常', 'Normal') : el.dataset.issue ? problem({ issue: el.dataset.issue }) : LEVELS[el.dataset.lv];
    $undo.textContent = L('撤销', 'Undo');
  }
  showTexts();

  // 不让点击传到播放器（点视频区域会暂停、双击会全屏）
  for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  // 弹出的框默认在按钮正上方居中（宽度固定为内容宽度，挪位置不会改变宽度）。直播的按钮在控制栏最右边，居中的话右半边超出播放器，被播放器外层裁掉（overflow: hidden，
  // 实测「手动问题标注」这一行被切掉一截），所以往里挪：能显示的范围是按钮往上各层里会裁剪的那几层和窗口的交集，左右各留 8px。
  // 全屏的播放器在顶层显示，外面那几层裁不到它，算到全屏的元素为止（实测直播间全屏时外层还是原来的大小，算进去菜单会离按钮老远）。
  // 上面放不下状态一栏（小窗口的播放器）时只留菜单
  const EDGE = 8;
  function visibleArea() {
    const a = { l: 0, t: 0, r: innerWidth, b: innerHeight };
    for (let el = host.parentElement; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const r = el.getBoundingClientRect();
        Object.assign(a, { l: Math.max(a.l, r.left), t: Math.max(a.t, r.top), r: Math.min(a.r, r.right), b: Math.min(a.b, r.bottom) });
      }
      if (el === document.fullscreenElement) break;
    }
    return a;
  }
  function place(pop) {
    if (pop === $menu) pop.classList.remove('tight');
    let r = pop.getBoundingClientRect();
    if (!r.width) return; // 没显示出来
    const a = visibleArea();
    if (pop === $menu && (host.dataset.kind === 'float' ? r.bottom > a.b : r.top < a.t)) {
      pop.classList.add('tight');
      r = pop.getBoundingClientRect();
    }
    const h = host.getBoundingClientRect();
    const left = Math.max(a.l + EDGE, Math.min(h.left + h.width / 2 - r.width / 2, a.r - EDGE - r.width));
    pop.style.left = `${Math.round(left - h.left)}px`;
  }

  let open = false; // 鼠标在按钮或弹出的框上
  let tipTimer = null;
  function tip(text, undo = false) {
    $msg.textContent = text;
    $undo.hidden = !undo;
    host.classList.add('done');
    place($tip);
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      host.classList.remove('done');
      if (open) place($menu);
    }, undo ? 4000 : 2500);
  }

  function clock(sec) {
    const s = Math.floor(sec);
    const hh = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(hh ? 2 : 1, '0');
    return `${hh ? `${hh}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
  }

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      return { ok: false, stale: true }; // 扩展更新后旧页面的上下文失效
    }
  }

  // ---------------------------------------------------------------- 播放状态（悬停时显示）

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  // 同 ui/format.js 的 shortHost（这里不加载扩展页面的脚本）
  const shortHost = (h) => String(h).replace(/\.bilivideo\.(com|cn)/, '').replace(/\.akamaized\.net$/, '.akamai');
  const mbps = (x) => `${x.toFixed(1)} Mbps`;

  /**
   * 状态一栏：现在卡不卡、前方缓冲、码率、本页卡顿、正在用的节点和它的下载速度。
   * br 为码率（见 bitrate）；st 为 SW 给的（见 sw.js playStatus），拿不到时只显示页面这边的。
   * 两个速率口径不同，写在最后一行：下载速度看节点快不快，码率是这路流本身要多少，下载速度比码率高得多才有余量。
   */
  function statusHtml(ps, br, st, stale) {
    if (!ps) return `<div class="state muted">${L('等待播放器', 'Waiting for player')}</div>`;
    let state = [L('播放中', 'Playing'), ''];
    if (ps.paused) state = [L('已暂停', 'Paused'), 'muted'];
    else if (ps.rs < 3) state = [L('卡住了，在等数据', 'Stuck, waiting for data'), 'bad'];
    else if (st && st.cause) state = [`${L('播放中', 'Playing')} · ${CAUSES[st.cause]}`, TONES[st.cause]];
    const lines = [`<div class="state ${state[1]}">${state[0]}</div>`];
    const play = [L(`前方缓冲 ${ps.buf.toFixed(1)} 秒`, `Buffer ahead ${ps.buf.toFixed(1)} s`)];
    if (ps.vh) play.push(`${ps.vh}p`);
    if (ps.frames >= 30) play.push(`${L('掉帧', 'Dropped')} ${r1((ps.drop / ps.frames) * 100)}%`);
    lines.push(`<div>${play.join(' · ')}</div>`);
    const more = [];
    if (br !== null) more.push(`${L('码率', 'Bitrate')} ${mbps(br)}`);
    if (st && st.stall) more.push(L(`本页卡顿 ${st.stall.n} 次`, `${st.stall.n} stall${st.stall.n === 1 ? '' : 's'} on this page`));
    if (st && st.hls !== null) more.push(`<span class="${st.hls >= 0.9 ? 'bad' : ''}">${L('HLS 下载占用', 'HLS download load')} ${Math.round(st.hls * 100)}%</span>`);
    if (more.length) lines.push(`<div>${more.join(' · ')}</div>`);
    const notes = [];
    if (st) {
      for (const n of st.nodes) {
        const facts = [`<span class="${n.cls === 'pcdn' || n.part ? 'warn' : 'muted'}">${esc(n.label)}</span>`];
        if (n.mb !== null) facts.push(`${L('下载', 'Download')} ${mbps(n.mb)}`);
        else if (n.flv) facts.push(L('FLV 长连接', 'FLV stream'));
        if (n.ago >= 10e3) facts.push(L(`${Math.round(n.ago / 1e3)} 秒前`, `${Math.round(n.ago / 1e3)} s ago`));
        if (n.bad) facts.push(`<span class="bad">${L('近期卡过', 'Stalled recently')}</span>`);
        lines.push(`<div>${L('节点', 'Node')} <span class="host" title="${esc(n.h)}">${esc(shortHost(n.h))}</span> · ${facts.join(' · ')}</div>`);
      }
      if (!st.nodes.length) lines.push(`<div class="muted">${L('还没有媒体请求', 'No media requests yet')}</div>`);
      if (st.nodes.some((n) => n.mb !== null)) notes.push(L('下载：该节点最近 5 个请求的下载速度（中位数）', "Download: median download speed of the node's last 5 requests"));
      if (!st.session) notes.push(L('这个页面没有完整的记录，刷新后再看', 'This page is only partly recorded; reload to see more'));
    } else if (stale) {
      notes.push(L('扩展已更新，刷新页面后才有节点和下载速度', 'The extension was updated; reload the page to see nodes and download speed'));
    }
    if (br !== null) notes.push(L('码率：近 10 秒播放的音视频数据量 ÷ 时间', 'Bitrate: audio and video data played in the last 10 s ÷ time'));
    if (notes.length) lines.push(`<div class="note">${notes.join(L('；', '; '))}</div>`);
    return lines.join('');
  }

  // 标记后 1 分钟内算「这次标记」：菜单里高亮它，点「正常」撤销；过了 1 分钟回到「正常」（记录照样留着，popup 里也还能撤销）。
  // 不一直高亮下去：那样卡顿过去以后点「正常」表示好了，会把当时如实记下的标记撤掉。
  // 以 SW 记的本页上一次标记为准（popup、快捷键标的也算；撤销了、换了视频就没有）
  const CURRENT_MS = 60e3;
  let current = null; // { lv, issue, until }
  function setCurrent(m) {
    current = m && m.ago < CURRENT_MS ? { lv: m.lv, issue: m.issue, until: Date.now() + CURRENT_MS - m.ago } : null;
    highlight();
  }
  function highlight() {
    if (current && Date.now() >= current.until) current = null;
    for (const el of $items) {
      const on = !current ? 'normal' in el.dataset : current.issue === 'sync' ? el.dataset.issue === 'sync' : Number(el.dataset.lv) === current.lv;
      el.classList.toggle('on', on);
    }
    $normal.title = current ? L(`撤销刚才的「${problem(current)}」标记`, `Undo the "${problem(current)}" mark just made`) : '';
  }

  let lastSt = null;
  let statusTimer = null;
  let statusSeq = 0; // SW 刚被唤醒时回得慢，前一次的回复晚到就不用了
  async function refresh() {
    const seq = ++statusSeq;
    const main = mainVideo();
    const ps = playerState();
    const br = main && ps && !ps.paused ? bitrate(main.v) : null;
    const st = await send({ type: 'status', ps });
    if (!open || seq !== statusSeq) return;
    lastSt = st && st.ok ? st : null;
    if (lastSt) setCurrent(lastSt.mark);
    else highlight();
    $status.innerHTML = statusHtml(ps, br, lastSt, !!(st && st.stale));
    place($menu);
  }
  function close() {
    open = false;
    host.classList.remove('open');
    clearInterval(statusTimer);
    statusTimer = null;
  }
  // 直播的控制栏移开就销毁，按钮跟着被摘下来，收不到 mouseleave：每次刷新前看一眼鼠标还在不在上面
  host.addEventListener('mouseenter', () => {
    open = true;
    host.classList.add('open');
    highlight();
    $status.innerHTML = statusHtml(playerState(), null, lastSt, false);
    place($menu);
    refresh();
    clearInterval(statusTimer);
    statusTimer = setInterval(() => (host.isConnected && host.matches(':hover') ? refresh() : close()), 1000);
  });
  host.addEventListener('mouseleave', close);

  // ---------------------------------------------------------------- 标记与撤销

  async function mark(lv, issue = null) {
    const ps = playerState();
    const r = await send({ type: 'mark', lv, issue, ps });
    if (!r || !r.ok) return tip(r && r.stale ? L('扩展已更新，刷新页面后再标记', 'The extension was updated; reload the page to mark') : L('标记失败', 'Mark failed'));
    // 后台没有这个页面的会话时记是记了，但撤销不了，不算「这次标记」
    if (r.session) setCurrent({ lv: issue ? null : lv, issue, ago: 0 });
    const parts = [L(`已标记「${problem({ lv, issue })}」`, `Marked "${problem({ lv, issue })}"`)];
    if (ps && ps.dur != null) parts.push(clock(ps.pos));
    if (r.cause) parts.push(CAUSES[r.cause]);
    tip(parts.join(' · '), true);
  }

  async function undo() {
    const was = current;
    const r = await send({ type: 'unmark' });
    if (r && r.ok) setCurrent(null);
    tip(r && r.ok ? L(`已撤销${was ? `「${problem(was)}」` : ''}`, `Undone${was ? ` "${problem(was)}"` : ''}`) : L('没有可撤销的标记', 'No mark to undo'));
  }

  root.querySelector('.icon').addEventListener('click', () => mark(2));
  for (const el of $items) {
    if (el === $normal) el.addEventListener('click', () => current && undo());
    else el.addEventListener('click', () => mark(el.dataset.lv ? Number(el.dataset.lv) : null, el.dataset.issue || null));
  }
  $undo.addEventListener('click', undo);

  /**
   * 按钮放在哪：主视频所在播放器的控制栏（直播的控制栏没悬停时还没渲染，先不放）；
   * 认不出控制栏时浮在视频上，要找一个和视频一样大、有定位的祖先，太小的视频（预览小窗）不放。
   */
  function spotFor({ v, bar }) {
    if (bar) return bar.bar && { el: bar.bar, kind: bar.kind };
    const vr = v.getBoundingClientRect();
    if (vr.width < 320) return null;
    let float = null;
    for (let el = v.parentElement; el && el !== document.body; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (Math.abs(r.width - vr.width) > 4 || Math.abs(r.height - vr.height) > 4) break;
      if (getComputedStyle(el).position !== 'static') float = el;
    }
    return float && { el: float, kind: 'float' };
  }

  // 直播的控制栏在鼠标移上去时才渲染、移开后销毁（按钮跟着没了）：盯住控制栏的外层，渲染出来就放上按钮
  let watched = [];
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      ensure();
    });
  });

  let enabled = false;
  function ensure() {
    if (!enabled) {
      observer.disconnect();
      watched = [];
      return host.remove();
    }
    const main = mainVideo();
    const roots = main && main.bar && main.bar.kind === 'live' ? main.bar.roots : [];
    if (roots.length !== watched.length || roots.some((r, i) => r !== watched[i])) {
      observer.disconnect();
      for (const r of roots) observer.observe(r, { childList: true, subtree: true });
      watched = roots;
    }
    const spot = main && spotFor(main);
    if (!spot || host.parentElement === spot.el) return undefined;
    host.dataset.kind = spot.kind;
    if (spot.kind === 'float') spot.el.append(host);
    else spot.el.prepend(host);
    return undefined;
  }

  // 浮在视频上的按钮鼠标移动时显示；控制栏换了（如切换播放器）时也顺带检查一次
  let moveTimer = null;
  let awakeTimer = null;
  window.addEventListener(
    'mousemove',
    () => {
      if (!enabled) return;
      if (host.dataset.kind === 'float') {
        host.classList.add('awake');
        clearTimeout(awakeTimer);
        awakeTimer = setTimeout(() => host.classList.remove('awake'), 2500);
      }
      if (moveTimer) return;
      moveTimer = setTimeout(() => {
        moveTimer = null;
        ensure();
      }, 150);
    },
    { capture: true, passive: true },
  );
  setInterval(ensure, 1500);

  // 设置里的 markButton（默认开），popup 里可以关掉；总开关关掉（暂停）时也收起来。界面语言也跟着设置
  try {
    const apply = (s) => {
      enabled = !s || (s.enabled !== false && s.markButton !== false);
      const next = zhOf(s ? s.lang || 'auto' : 'auto');
      if (next !== zh) {
        zh = next;
        showTexts();
      }
      ensure();
    };
    chrome.storage.local
      .get('settings')
      .then((r) => apply(r.settings))
      .catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => area === 'local' && changes.settings && apply(changes.settings.newValue));
  } catch {}
})();
