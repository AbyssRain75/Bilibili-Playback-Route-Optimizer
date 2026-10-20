// SPDX-License-Identifier: GPL-3.0-or-later
// Service worker：汇总页面事件（分配、起播、卡顿、线路切换）和 webRequest 观察到的实际媒体请求，
// 写入持久记录，维护各标签页的实时概况供 popup 显示；开启测速时定时测各节点；
// 记下各节点近期出过的问题（卡顿证据），线路优化的“自动”模式据此避开。
importScripts('../shared/cdn.js', '../shared/store.js', '../shared/analyze.js', '../shared/route.js', '../shared/probe.js');

const { L, setLang, CDN_DOMAINS, CLASS_LABELS, DEFAULT_SETTINGS, isBiliUrl, hostOf, isCdnHost, mediaKind, lineOf, trackOf, cacheHit, mbpsOf, isFailure, isHang, pageType, pageKey, mergeNet, netChanged, netMoved, netKey, isPcdnHost, isPcdnUrl, isPcdnReq, nodeClass, quantile } = globalThis.__bilicdn;
const { blameHosts, blameHung, incidentOf, hlsLoad, HLS_LOAD, markCause, blamesNode, probeScore, parseM3u8, probeRange, vodCandidates, urlExpiry, lineKey, probeRank, probeGate, updateBackoff, probePick, restUntil, verifyPick, liveRecheck } = globalThis.__bilicdn;
const { TROUBLE, PROTO_TROUBLE, troubleOf, isBad, noteServer, pruneServers, sameServer, netLabel, bookAdd, bookPrune, bookKnown, bookSlow, bookFromRecords } = globalThis.__bilicdn;

// ---------------------------------------------------------------- 状态
// 各部分共用的内存状态都放在这里。SW 随时会被回收：要留住的存进 storage，重启时由 ready（和下文的 settingsReady）读回。

let settings = { ...DEFAULT_SETTINGS }; // 扩展设置（见下文「设置」）
let tabs = {}; // 各标签页的会话（见 newSession），存在 storage.session
let trouble = []; // 各节点近期出过的问题（卡顿证据，见 addTrouble）
let protoTrouble = []; // 直播协议的卡顿证据（见 addProtoTrouble）
let book = null; // 网络档案（见 probe.js），升级后第一次启动时从以往的测速记录建（见 bookReady）
let curNet = ''; // 当前网络的档案键（见 cdn.js netKey）
let curLabel = '';
// 网络检查（见 checkNetwork）：netAt 为上次查的时间（查成功、失败都算），netDue 为下次该查的时间（见 netRecheck）。
// 不存：SW 重启时按存下的 net.t 算
let netAt = 0;
let netDue = 0;
let probeState = null; // 最近一轮测速的情况，popup 显示用（见 noteProbe）
let verifyWait = {}; // 等着复测的标签页（缓冲不够时先不测，见 verifySoon），存在 storage.session
let servers = {}; // 点播 host 连到的服务器网段，判断哪些镜像名是同一台服务器（见 learnServer）
const pending = new Map(); // 进行中的媒体请求：requestId → 请求概况（见 onBeforeRequest），直播长连接另存一份（见 saveStreams）
// 测速（见 runProbe）：probing 为进行中的一轮。清空、换网络、暂停时 probeEpoch 加一，进行中的那一轮作废；
// probeReset 为清空 / 换网络时的清理，新一轮等它完成（见 resetMeasurements）；probeController 用来中止正在测的请求
let probing = null;
let probeEpoch = 0;
let probeReset = Promise.resolve();
let probeController = null;
// 网络档案上次存下的时间，和上次写出的本网络以往测速（见 saveBook、knownNow）
let bookSavedAt = 0;
let knownJson = '';

// 会话、进行中的直播长连接和卡顿证据都要先读回来，再接着用、接着追加
const ready = Promise.all([
  chrome.storage.session.get(['tabs', 'streams', 'probeState', 'verifyWait']).then((r) => {
    tabs = r.tabs || {};
    restoreStreams(r.streams);
    probeState = r.probeState || null;
    verifyWait = r.verifyWait || {};
  }),
  chrome.storage.local.get(['trouble', 'protoTrouble', 'netBook', 'net', 'servers']).then((r) => {
    trouble = r.trouble || [];
    protoTrouble = r.protoTrouble || [];
    servers = r.servers || {};
    book = r.netBook || null;
    curNet = netKey(r.net);
    curLabel = r.net ? netLabel(r.net) : '';
    netAt = r.net ? r.net.t : 0;
    netDue = netAt + NET_CHECK.every;
  }),
]);

/** 合并写入：第一次调用后 ms 毫秒执行一次 fn，期间再调用不重复排；cancel 取消还没执行的那次。 */
function batched(ms, fn) {
  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
  schedule.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return schedule;
}

/** 会话、标记的 id：时间加 4 位随机字符。 */
const newId = (t) => t.toString(36) + Math.random().toString(36).slice(2, 6);

// ---------------------------------------------------------------- 设置
// 各项和默认值见 cdn.js DEFAULT_SETTINGS。页面里的 hook.js 经 bridge.js 直接读这些设置。
// enabled：总开关（默认开）。关掉就是暂停整个扩展：不记录页面事件和媒体请求、不改写播放地址、不测速也不复测、不能标记，
// 播放器上的标记按钮也收起来（见 player.js）；其他设置原样保留，打开后照旧

const settingsReady = chrome.storage.local.get('settings').then((r) => {
  settings = { ...DEFAULT_SETTINGS, ...r.settings };
  setLang(settings.lang);
  syncProbe();
  showPaused();
});
// 会话和设置都读回来了：记录、标记之前要知道是不是暂停着
const loaded = Promise.all([ready, settingsReady]);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const was = settings;
  settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
  // 换了界面语言：暂停时图标上的字跟着换（播放器按钮上的文字是用到时才取，见 playStatus）
  const relabel = setLang(settings.lang);
  if (settings.enabled !== was.enabled || relabel) showPaused();
  if (settings.enabled !== was.enabled && !settings.enabled) pause();
  const probeOn = settings.enabled && settings.probe;
  if (probeOn === (was.enabled && was.probe)) return;
  syncProbe();
  if (probeOn) runProbe();
});

// 暂停时图标上显示「关」（英文界面为 OFF）
function showPaused() {
  chrome.action.setBadgeBackgroundColor({ color: '#9499a0' }).catch(() => {});
  chrome.action.setBadgeText({ text: settings.enabled ? '' : L('关', 'OFF') }).catch(() => {});
}

// 刚暂停：正在测的这一轮作废（同清空时，见 resetMeasurements），丢掉各标签页的会话和进行中的请求。
// 暂停期间页面没有报到、请求也没记，打开后已打开的页面要刷新才有完整的会话（popup 会提示刷新）
function pause() {
  probeEpoch += 1;
  probeController?.abort();
  ready.then(() => {
    tabs = {};
    saveTabs();
    dropVerify();
    pending.clear();
    saveStreams();
  });
}

// ---------------------------------------------------------------- 标签页会话
// 存在 storage.session 里，SW 被回收后重启可以恢复（见 ready），进行中的直播长连接（见 saveStreams）也是。

const saveTabs = batched(1000, () => chrome.storage.session.set({ tabs }).catch(() => {}));

/** 只接受 B 站页面；返回页面类型和页面标识（见 pageKey）。 */
function fromHref(href) {
  return isBiliUrl(href) ? { page: pageType(href), path: pageKey(href) } : null;
}

// 扩展版本记在每条 ses 上（不记在 req 上，那样记录量太大）：升级后第一条 ses 起就能分出前后两段。
// 以前导出的记录不带版本，跨版本对比只能按提交时间猜（见 docs/field-review-2026-10-20.md）
const VERSION = chrome.runtime.getManifest().version;

// via：hello = 页面脚本正常报到；nav = 站内切换视频（地址变了但页面没重新加载）；
// req = 页面脚本没运行，由媒体请求兜底建立（抓不到分配和卡顿）。
// 会话给每个 B 站页面都建（popup、复测、站内切换的判断都靠它），但 ses 记录推迟到这个会话第一次写别的记录（见 record）
// 或发出媒体请求（见 onBeforeRequest）时才写，t 仍是会话开始的时间。0.6.23 以前建会话时就写：bridge.js 在所有 B 站页面
// 一加载就报到，个人空间、动态、专栏、账号设置这些没有播放的页面也各记一条 ses（带页面路径），记录里就有了整个 B 站的浏览路径，
// 访问自己的空间还会留下自己的 UID。还没写的会话带 noSes，跟着 tabs 存进 storage.session，SW 重启后不会重写也不会漏写
function newSession(tabId, page, path, via = 'hello') {
  const t = Date.now();
  const s = {
    sid: newId(t),
    t,
    via,
    page,
    path,
    noSes: 1,
    asg: null,
    hosts: {},
    stall: { n: 0, ms: 0 },
    start: null,
    recent: [], // 最近完成的媒体请求 {h, a 发出, t 完成, k, f 失败}，卡顿、标记时用来确定“当时在用的节点”（见 hostsDuring）
    boot: { t, start: null }, // 起播阶段 {t 起点, vid 视频, start 开始播放的时间}，页面打开、站内切换时开始（见 inBoot）
    pre: null, // 预加载、卡片预览拿到地址后的一小段时间 {from, to}（见 inBoot）
    marks: 0,
    lastMark: null,
    lastStall: null, // 最近一次卡顿（不含拖动）{t, ms}，判断手动标记的原因用
  };
  tabs[tabId] = s;
  saveTabs();
  netRecheck();
  return s;
}

/** 补写会话 s 的 ses 记录（还没写过的话，见 newSession）。 */
function writeSes(s) {
  if (!s || !s.noSes) return;
  delete s.noSes;
  Store.add({ ty: 'ses', t: s.t, sid: s.sid, pg: s.page, path: s.path, ...(s.via === 'hello' ? {} : { via: s.via }), ver: VERSION });
  saveTabs();
}

/** 写一条挂在会话 s 上的记录，s 的 ses 先补上；s 为空（如没有会话时的手动标记）时直接写。 */
function record(s, rec) {
  writeSes(s);
  Store.add(rec);
  maybePrune().catch((e) => console.warn('[bilicdn] 删除过期记录失败', e));
}

// ---------------------------------------------------------------- 记录保留
// 超过保留时长的记录（统计页设置，见 store.js KEEP_DAYS）在 SW 启动、写记录、统计页打开时顺带删掉。
// 删一次要读一遍全部记录，所以有过期的也最多 6 小时删一次（meta.pruned）；同一个 SW 里 10 分钟才看一次存储。
// 升级前已经有记录的，用户在统计页确认之前不删（retention.ok，见 store.js）
const PRUNE = { every: 6 * 3600e3, check: 10 * 60e3 };
let pruneCheckAt = 0;

/** force：统计页刚改了保留时长或确认了删除，马上删。返回删了几条。 */
async function maybePrune(force = false) {
  const now = Date.now();
  if (!force && now < pruneCheckAt) return 0;
  pruneCheckAt = now + PRUNE.check;
  const { retention, meta } = await chrome.storage.local.get(['retention', 'meta']);
  // 还没有记录（新装、清空过）：没有要保护的旧记录，以后过期的直接删
  if (!meta) {
    if (!retention || !retention.ok) await chrome.storage.local.set({ retention: { days: Store.keepDays(retention), ok: true } });
    return 0;
  }
  if (!retention || !retention.ok) return 0;
  const cutoff = Store.cutoffOf(Store.keepDays(retention), now);
  if (!force && (meta.since >= cutoff || meta.pruned > now - PRUNE.every)) return 0;
  return Store.prune(cutoff, now);
}

loaded.then(() => maybePrune()).catch((e) => console.warn('[bilicdn] 删除过期记录失败', e));

// 有媒体请求但页面没报到（安装扩展前打开的页面、页面脚本出错等）时，按标签页 URL 兜底建会话。
// 查标签页期间的请求共用同一次查询（不会建出好几个会话）；非 B 站标签页的否定结果缓存 30 秒，避免每个请求都查一次。
// 建好的会话不缓存：它已经在 tabs 里，暂停（见 pause）清掉 tabs 之后再拿出来的话，请求会记到已经丢掉的旧会话上
const ensuring = new Map();
function ensureSession(tabId) {
  if (tabs[tabId]) return Promise.resolve(tabs[tabId]);
  let p = ensuring.get(tabId);
  if (!p) {
    p = chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tabs[tabId]) return tabs[tabId];
        const info = tab && fromHref(tab.url);
        return info ? newSession(tabId, info.page, info.path, 'req') : null;
      })
      .catch(() => null);
    ensuring.set(tabId, p);
    p.then((s) => (s ? ensuring.delete(tabId) : setTimeout(() => ensuring.delete(tabId), 30e3)));
  }
  return p;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => {
    delete tabs[tabId];
    saveTabs();
    if (verifyWait[tabId]) dropVerify(tabId);
  });
});

// ---------------------------------------------------------------- 页面事件
// 事件来自页面主世界，按不可信输入处理：只取已知字段并限制长度。

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

// vid：视频标识；gs：接口的 gaia_source 参数；pre：预加载或卡片预览的别的视频；
// carry：站内切换后补记的切换前分配（与原记录重复）
function cleanAsg(ev) {
  const base = { src: str(ev.src, 20), api: str(ev.api), path: str(ev.path) };
  const vid = str(ev.vid, 20);
  const gs = str(ev.gs, 20);
  if (vid) base.vid = vid;
  if (gs) base.gs = gs;
  if (ev.pre) base.pre = 1;
  if (ev.carry) base.carry = 1;
  if (ev.kind === 'vod') {
    const tracks = list(ev.tracks, 64).map((tr) => ({
      type: str(tr && tr.type, 10),
      id: num(tr && tr.id),
      codecs: str(tr && tr.codecs, 40),
      bw: num(tr && tr.bw),
      h: num(tr && tr.h),
      urls: list(tr && tr.urls, 8).map((u) => [str(u && u[0], 100), str(u && u[1], 20)]),
    }));
    return tracks.length ? { ...base, kind: 'vod', q: num(ev.q), tracks } : null;
  }
  if (ev.kind === 'live') {
    const lines = list(ev.lines, 64).map((l) => ({
      p: str(l && l.p, 20),
      f: str(l && l.f, 10),
      c: str(l && l.c, 10),
      qn: num(l && l.qn),
      hosts: list(l && l.hosts, 8).map((h) => str(h, 100)),
    }));
    return lines.length ? { ...base, kind: 'live', lines } : null;
  }
  return null;
}

// popup「分配到的节点」用的概况。点播地址带 os 参数，带 os=mcdn 的算 PCDN（pc，口径同实际请求，见 cdn.js nodeClass）；
// 直播的分配只记了 host，按 host 算
function summarizeAsg(a) {
  const hosts = {};
  const mark = (h, role, os) => {
    if (!h) return;
    const e = hosts[h] || (hosts[h] = { cls: '', base: 0, backup: 0, pc: 0 });
    e[role] += 1;
    if (isPcdnReq({ h, os })) e.pc += 1;
  };
  const sum = { t: Date.now(), src: a.src, api: a.api, kind: a.kind, pre: !!a.pre, hosts };
  if (a.kind === 'vod') {
    for (const tr of a.tracks) tr.urls.forEach(([h, os], i) => mark(h, i === 0 ? 'base' : 'backup', os));
    sum.q = a.q;
    sum.video = a.tracks.filter((tr) => tr.type === 'video').length;
    sum.audio = a.tracks.length - sum.video;
  } else {
    for (const l of a.lines) l.hosts.forEach((h, i) => mark(h, i === 0 ? 'base' : 'backup'));
    sum.lines = [...new Set(a.lines.map((l) => `${l.f}/${l.c}`))];
    sum.qn = a.lines.length ? a.lines[0].qn : null;
  }
  for (const [h, e] of Object.entries(hosts)) e.cls = nodeClass(h, e.pc, e.base + e.backup);
  return sum;
}

function onHello(tabId, frameId, msg) {
  const info = fromHref(msg.href);
  if (tabId === undefined || !info) return;
  const cur = tabs[tabId];
  if (frameId === 0 || !cur || cur.via === 'req') newSession(tabId, info.page, info.path);
}

/** 一组签名地址里最早的过期时间（毫秒），都没有时为 0。 */
function expiryOf(urls) {
  const xs = urls.map(urlExpiry).filter((x) => x > 0);
  return xs.length ? Math.min(...xs) : 0;
}

// 测速用的地址：只接受 B 站 CDN 上的 https 地址（页面可以伪造事件，SW 不能替它去请求任意地址）。
// exp：地址过期时间，过期后不再拿它测速（见 probeSession）
function cleanTarget(ev) {
  const url = (v) => {
    const x = str(v, 2000);
    try {
      const u = new URL(x);
      return u.protocol === 'https:' && isCdnHost(u.host) ? x : null;
    } catch {
      return null;
    }
  };
  if (ev.kind === 'vod') {
    const urls = list(ev.urls, 8).map(url).filter(Boolean);
    const size = num(ev.size);
    return urls.length ? { kind: 'vod', t: Date.now(), exp: expiryOf(urls), urls, ...(size > 0 ? { size } : {}) } : null;
  }
  if (ev.kind === 'live') {
    const lines = list(ev.lines, 8)
      .map((l) => ({ url: url(l && l.url), k: l && l.k === 'live-flv' ? 'live-flv' : 'live-hls', fmt: str(l && l.fmt, 10), c: str(l && l.c, 10), qn: num(l && l.qn) }))
      .filter((l) => l.url)
      .map((l) => ({ ...l, h: hostOf(l.url) }));
    return lines.length ? { kind: 'live', t: Date.now(), exp: expiryOf(lines.map((l) => l.url)), lines } : null;
  }
  return null;
}

// 各类页面事件。s：所属会话；page：发出事件的 frame 的页面类型（iframe 可能和顶层不同）；t：收到的时间
const PAGE_EVENTS = {
  target(ev, { tabId, s }) {
    const tg = cleanTarget(ev);
    if (!tg) return;
    s.target = tg;
    settingsReady.then(() => settings.route && verifySoon(tabId));
  },

  // 线路优化改写了播放地址：from → to 为主节点 / 直播 host 的变化，proto 为只保留的直播协议；
  // why：set 按设置 / known 按本网络以往测速（网络档案）/ probe 按测速 / pcdn 避开 PCDN / trouble 避开近期出过问题的节点；
  // bk：主节点 / 第一个 host 没变，只排了备用地址（没有 from / to），why 为被挪到后面的地址的原因（见 route.js rewriteVod）；
  // pre：预加载的视频；carry：站内切换后补记的（与原记录重复）
  route(ev, { s, page, t }) {
    const rec = { ty: 'route', t, sid: s.sid, pg: page, kind: ev.kind === 'live' ? 'live' : 'vod' };
    const from = str(ev.from, 100);
    const to = str(ev.to, 100);
    const vid = str(ev.vid, 20);
    if (from) rec.from = from;
    if (to) rec.to = to;
    if (ev.proto === 'flv' || ev.proto === 'hls') rec.proto = ev.proto;
    if (ev.bk && !to && !rec.proto) rec.bk = 1;
    if (['set', 'known', 'probe', 'pcdn', 'trouble'].includes(ev.why)) rec.why = ev.why;
    if (vid) rec.vid = vid;
    if (ev.pre) rec.pre = 1;
    if (ev.carry) rec.carry = 1;
    record(s, rec);
    if (!ev.pre || ev.carry) s.route = { kind: rec.kind, from: rec.from, to: rec.to, proto: rec.proto, bk: rec.bk, why: rec.why, t };
    // 这个页面换过去的点播节点（含预加载、卡片预览）：它们没等到响应头就超时时记得重些（见 errWeight）
    if (rec.kind === 'vod' && rec.to) s.routed = [...new Set([...(s.routed || []), rec.to])].slice(-8);
  },

  // 首屏数据赶在设置之前被页面读走，hook.js 先没交出去，播放器会自己请求播放地址（见 hook.js trapGlobal）。记一条，复盘时看多不多
  hold(ev, { s, page, t }) {
    const rec = { ty: 'hold', t, sid: s.sid, pg: page };
    const vid = str(ev.vid, 20);
    if (vid) rec.vid = vid;
    record(s, rec);
  },

  asg(ev, { s, page, t }) {
    const a = cleanAsg(ev);
    if (!a) return;
    record(s, { ty: 'asg', t, sid: s.sid, pg: page, ...a });
    if (!a.pre || a.carry) {
      s.asg = summarizeAsg(a);
      bootOn(s, a.vid, t);
    } else preOn(s, t);
  },

  // hosts：卡顿期间及之前 10 秒在用的节点，用来把卡顿对应到节点（拖动引起的不需要）
  stall(ev, { tabId, s, page, t }) {
    const ms = num(ev.ms);
    if (ms === null) return;
    const rec = { ty: 'stall', t, sid: s.sid, pg: page, ms, seek: !!ev.seek, cut: !!ev.cut, vh: num(ev.vh) };
    if (ev.end === 'switch' || ev.end === 'leave' || ev.end === 'hidden') rec.end = ev.end;
    if (ev.wake) rec.wake = 1; // 切回前台后恢复画面的缓冲（见 hook.js），不算节点的问题
    if (!ev.seek) rec.hosts = hostsDuring(tabId, s, t - ms - 10e3, t, true);
    record(s, rec);
    if (!ev.seek) {
      s.stall.n += 1;
      s.stall.ms += ms;
      s.lastStall = { t, ms };
    }
    if (incidentOf(rec)) {
      addTrouble(rec.hosts, TROUBLE_W.stall, 'stall');
      addProtoTrouble(s, rec.hosts, TROUBLE_W.stall, 'stall');
    }
  },

  // fail：等了 ms 毫秒媒体仍没就绪就离开了；hosts：起播期间在用的节点
  start(ev, { tabId, s, page, t }) {
    const ms = num(ev.ms);
    if (ms === null) return;
    const cp = num(ev.cp);
    const rec = { ty: 'start', t, sid: s.sid, pg: page, ms, cp, pm: num(ev.pm), vh: num(ev.vh), hosts: hostsDuring(tabId, s, t - ms, t, true) };
    if (ev.fail) rec.fail = 1;
    if (ev.hid) rec.hid = 1; // 计时期间页面进过后台，起播慢不算节点的问题
    record(s, rec);
    if (!ev.fail) s.start = cp ?? ms;
    if (s.boot && s.boot.start == null) s.boot.start = t;
    const inc = incidentOf(rec);
    if (inc) addTrouble(rec.hosts, TROUBLE_W[inc], inc);
  },
};

function onPage(tabId, frameId, href, ev) {
  const info = fromHref(href);
  if (tabId === undefined || !ev || !info) return;
  let s = tabs[tabId];
  if (!s || s.via === 'req') s = newSession(tabId, info.page, info.path);
  // 顶层页面站内切换了视频：开始新会话。iframe 的地址本来就和顶层不同，不能据此判断
  else if (frameId === 0 && s.path !== info.path) s = newSession(tabId, info.page, info.path, 'nav');
  // nav 只用来开始新会话（上面已经处理）。type 来自页面，只认自己的处理函数（不能取到原型上的属性）
  if (!Object.hasOwn(PAGE_EVENTS, ev.type)) return;
  PAGE_EVENTS[ev.type](ev, { tabId, s, page: info.page, t: Date.now() });
  saveTabs();
}

// ---------------------------------------------------------------- 网络位置
// 以 B 站识别的“国家/地区 + ISP”作为网络环境标识（见 cdn.js netKey），位置变了（含城市）写一条 net 记录。不保存 IP。
// 什么时候查（见 netRecheck）：新建会话、有媒体请求、测速时，距上次查过了 every 就查。0.6.18 以前只在新建会话时查、20 分钟内不再查，
// 一直停在一个直播间里换了网络发现不了：直播 FLV 是一条长连接，几个小时都不建新会话，也没有别的请求。
// 换网络、断网时进行中的请求会以 NET_ERRORS 里的错误结束（直播 FLV 长连接也是），这时过 soon 就查（距上次查至少 retry，见 netSoon）。
// 查失败（断网、接口出错、超时、没给国家）时原来的网络照用，retry 后再查

const NET_CHECK = { every: 10 * 60e3, retry: 60e3, soon: 5e3, timeout: 10e3 };
// 本地网络变了或断了。Chrome 在网络切换时让进行中的请求以 ERR_NETWORK_CHANGED 结束
const NET_ERRORS = new Set(['net::ERR_NETWORK_CHANGED', 'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_ADDRESS_UNREACHABLE']);

let netChecking = null; // 进行中的检查，含换网络后的清理
let netDeciding = null; // 进行中的检查查到结果、判断完换没换网络为止，不含清理（测速记下结果前等它，见 runProbe）
let netTimer = null;

/** 到时候了（见 netDue）就查一次网络；暂停时不查。返回进行中的检查。 */
function netRecheck() {
  if (!settings.enabled || netChecking || Date.now() < netDue) return netChecking;
  return checkNetwork();
}

/** 媒体请求因为本地网络出错（见 NET_ERRORS）：过 NET_CHECK.soon 查一次，距上次查至少 NET_CHECK.retry。 */
function netSoon() {
  const now = Date.now();
  netDue = Math.min(netDue, Math.max(now + NET_CHECK.soon, netAt + NET_CHECK.retry));
  clearTimeout(netTimer);
  netTimer = setTimeout(netRecheck, netDue - now);
}

/** 问 B 站当前的网络位置。接口出错、超时、没给国家（限流时 data 为空）时抛出。 */
async function fetchZone() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), NET_CHECK.timeout);
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/zone', { credentials: 'omit', signal: ctl.signal });
    const z = ((await res.json()) || {}).data || {};
    if (!z.country) throw new Error('没有返回国家');
    return z;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查一次网络位置。位置变了（含城市）更新显示、记一条 net 记录；国家、地区或 ISP 变了（见 cdn.js netMoved）才算换了网络：
 * 之前的测速排名和卡顿证据都不再适用，正在测的一轮作废（见 resetMeasurements），换一份网络档案。
 * 直播协议的卡顿证据跟着网络档案走：存进旧网络的，换回来时接着用。只变了城市的排名、卡顿证据照用（同一个网络的档案键不变）
 */
function checkNetwork() {
  if (netChecking) return netChecking;
  let decide;
  netDeciding = new Promise((r) => (decide = r));
  netChecking = (async () => {
    await ready;
    netAt = Date.now();
    netDue = netAt + NET_CHECK.retry; // 查失败时过一会儿再查
    const z = await fetchZone();
    // 查的时候暂停了：暂停时不查网络位置，这次的结果不用
    if (!settings.enabled) return;
    const { net } = await chrome.storage.local.get('net');
    const cur = mergeNet(net, { t: Date.now(), country: z.country || '', province: z.province || '', city: z.city || '', isp: z.isp || '' });
    netDue = Date.now() + NET_CHECK.every;
    const changed = netChanged(net, cur);
    await chrome.storage.local.set({ net: cur });
    if (!changed) return;
    Store.add({ ty: 'net', ...cur });
    const prev = curNet;
    curNet = netKey(cur);
    curLabel = netLabel(cur);
    if (netMoved(net, cur)) {
      if (book && prev && book.nets[prev]) book.nets[prev].proto = protoTrouble.filter((x) => x.t > Date.now() - PROTO_TROUBLE.keep);
      // probeEpoch 马上加一：等着这次结果的测速（见 runProbe）不再记下，清理要等那一轮结束，所以先放行
      const reset = resetMeasurements();
      decide();
      await reset;
      const back = book && curNet && book.nets[curNet] && book.nets[curNet].proto;
      if (back && back.length) {
        protoTrouble = back.filter((x) => x.t > Date.now() - PROTO_TROUBLE.keep);
        saveTrouble();
      }
      saveBook();
    }
    publishKnown();
  })()
    .catch((e) => console.warn('[bilicdn] 获取网络位置失败', e))
    .finally(() => {
      decide();
      netChecking = null;
      netDeciding = null;
    });
  return netChecking;
}

// ---------------------------------------------------------------- 实际媒体请求
// webRequest 能看到 Worker 里发出的请求，比页面内 hook 更全。监听器必须在顶层同步注册。

const FILTER = {
  urls: CDN_DOMAINS.map((d) => `*://*.${d}/*`),
  types: ['xmlhttprequest', 'media', 'other'],
};

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : undefined;
}

function bodyBytes(p) {
  const n = Number(p.len);
  if (Number.isFinite(n) && n > 0) return n;
  const m = /bytes (\d+)-(\d+)/.exec(p.cr || '');
  return m ? Number(m[2]) - Number(m[1]) + 1 : null;
}

const SAMPLES = 40;
function pushSample(arr, v) {
  arr.push(v);
  if (arr.length > SAMPLES) arr.shift();
}

// popup「实际请求」用的各节点概况。pc：其中 PCDN 请求的个数（见 cdn.js isPcdnReq），popup 据此按 nodeClass 算类型。
// 0.6.19 以前按 host 记了 cls、没有 pc
function hostSummary(s, host) {
  return s.hosts[host] || (s.hosts[host] = { ip: '', n: 0, pc: 0, err: 0, b: 0, tt: [], mb: [], k: [] });
}

function addHostSample(s, rec) {
  const h = hostSummary(s, rec.h);
  h.n += 1;
  if (isPcdnReq(rec)) h.pc = (h.pc || 0) + 1;
  if (isFailure(rec)) h.err += 1;
  if (rec.ip) h.ip = rec.ip;
  if (rec.b) h.b += rec.b;
  if (rec.tt !== null && !cacheHit(rec)) pushSample(h.tt, rec.tt);
  const mb = mbpsOf(rec);
  if (mb !== null) pushSample(h.mb, mb);
  if (!h.k.includes(rec.k)) h.k.push(rec.k);
}

const RECENT = { keep: 70e3, max: 200 };

// 请求失败记进卡顿证据之前先筛一下（见 countsAsTrouble）：一个节点出问题时失败常常一下子来一串（各轨道、播放器重试），
// 同一节点 merge 内的只记一次；近 window 内这个节点请求了 minN 次以上、失败不到 okRate 的，偶尔失败一次不算。
// 点播同一台服务器的几个镜像名算一个节点（见 serverOf）
const ERR = { merge: 10e3, window: 60e3, minN: 10, okRate: 0.1 };
const errAt = new Map(); // 线路|host → 上次记进卡顿证据的时间

/** 和 h 是同一台服务器的点播 host（含 h 自己，按名字排序，见 probe.js sameServer）；直播只有它自己。 */
const serverOf = (p, h) => (p === 'vod' && sameServer(servers)[h]) || [h];

function countsAsTrouble(s, rec) {
  const now = Date.now();
  const line = lineOf(rec.k);
  const peers = serverOf(line, rec.h);
  const mine = (s.recent || []).filter((x) => peers.includes(x.h) && x.t > now - ERR.window);
  if (mine.length >= ERR.minN && mine.filter((x) => x.f).length / mine.length < ERR.okRate) return false;
  const key = `${line}|${peers[0]}`;
  if (now - (errAt.get(key) || 0) < ERR.merge) return false;
  errAt.set(key, now);
  return true;
}

/**
 * 请求失败的权重。换过去的镜像在起播阶段（见 inBoot）没等到响应头就超时（见 cdn.js isHang）记得重，一次就算卡过：
 * 播放器之后每取一段都先试它，每段再等 2 秒（实测起播因此拖到 5.6~12.3 秒），测速又看不出来（测的是随机中段、取近几次的中位数）。
 * 播放中途的记 1：缓冲够，备用节点接上就不卡。0.6.9~0.6.14 不分阶段一律记 2，以为播放中途的偶发无响应会被「失败不到 10% 不算」滤掉，
 * 可稳态播放约每分钟 12 个请求，第二次无响应时失败率就过了 10%：实测 10-19 19:23 hw 播放到第 12 分钟无响应 3 次，
 * cosov 次次接上、没有卡，同一台服务器的镜像名却一起避开 30 分钟，下一个视频只能留在 cosov，起播 7.4 秒。
 * B 站分配的节点照常记 1：镜像出问题时退回的就是它，超时一次就判为卡过、把它也换掉不值得。
 */
function errWeight(s, rec) {
  return isHang(rec) && (s.routed || []).includes(rec.h) && inBoot(s, rec.t) ? TROUBLE_W.hang : TROUBLE_W.err;
}

// 起播阶段（见 inBoot）：拿到播放地址起，到开始播放后 after 毫秒为止；预加载、卡片预览拿到地址后 pre 毫秒内也算（取的是那个视频开头几段）。
// 开始播放后还要算一会儿：实测 10-15 05:04:38 换过去的 08h 在起播后 4.3 秒无响应，按播放中途记 1 的话，
// 一分钟后的下一个视频不会避开它（实际在 08h 上起播 7.4 秒）。lead：媒体请求可能比同一时刻的页面事件先到 SW
const BOOT = { after: 10e3, pre: 10e3, lead: 1000 };

/**
 * 拿到当前视频的播放地址（不是预加载、卡片预览的，见 PAGE_EVENTS.asg）：开始起播阶段。
 * 还没开始播放的沿用原起点（首屏数据之后播放器常常再取一次地址；站内切换时会话一建好就开始了）。
 * 同一个视频已经开始播放过、又拿到一份地址的，是播放器中途重新取地址（实测 10-19 22:32:33），不算起播。
 */
function bootOn(s, vid, t) {
  const b = s.boot;
  if (b && b.start == null) {
    if (vid) b.vid = vid;
  } else if (!b || !vid || b.vid !== vid) {
    s.boot = { t, ...(vid ? { vid } : {}), start: null };
  }
}

/** 预加载、卡片预览拿到了播放地址：之后 BOOT.pre 内的请求多半是那个视频的开头几段，也算起播阶段；接连几次的连成一段。 */
function preOn(s, t) {
  const p = s.pre;
  s.pre = { from: p && t - BOOT.lead <= p.to ? p.from : t - BOOT.lead, to: t + BOOT.pre };
}

/**
 * 请求是不是在起播阶段发出的（t 为发出的时间）：拿到地址到开始播放后 BOOT.after，或预加载、卡片预览拿到地址后 BOOT.pre。
 * 开始播放以页面报来的为准（见 hook.js 的 start）：页面在后台时播放器不取片，切回前台才起播，后台待多久都对得上；
 * 用预加载的地址起播的，站内切换时新会话就开始了。都存在会话里，SW 被回收后重启照样接着判断。
 */
function inBoot(s, t) {
  const b = s.boot;
  if (b && t >= b.t - BOOT.lead && (b.start == null || t < b.start + BOOT.after)) return true;
  return !!s.pre && t >= s.pre.from && t < s.pre.to;
}

// 本地网络中断（见 localOutage）：同一段 window 内接连在两台以上不同服务器上无响应
const LOCAL = { window: 30e3 };

/** 同一段：同一个文件（地址里的文件名）的同一 Range，播放器换节点重试时不变。 */
function segOf(p, rec) {
  const file = String(p.url || '').split(/[?#]/)[0].split('/').pop();
  return file ? `${file}|${rec.r || ''}` : '';
}

/**
 * 同一段接连在两台以上不同服务器（点播按 serverOf 分组）上没等到响应头：多半是本地网络断了，不是节点的问题。
 * 这一段的失败都不记，之前为它记下的无响应也撤掉；只在一台服务器上无响应、另一台接上的照常记。
 * 实测 10-19 22:32 同一段依次在 hw、cosov、akam 上等了 2~4 秒没有响应头，播放器重新取地址后马上正常，三个节点却都记了问题，
 * 9 分钟后中国移动整组和 cosov 都算卡过。
 */
function localOutage(s, seg) {
  const since = Date.now() - LOCAL.window;
  const hung = (s.recent || []).filter((x) => x.hang && x.seg === seg && x.t > since);
  if (new Set(hung.map((x) => serverOf(lineOf(x.k), x.h)[0])).size < 2) return false;
  const refs = new Set(hung.map((x) => x.ref).filter(Boolean));
  if (refs.size) {
    trouble = trouble.filter((x) => !refs.has(x.ref));
    saveTrouble();
  }
  return true;
}

/** 请求失败记进卡顿证据（见 countsAsTrouble、errWeight）。无响应的那条带上 ref，同一段后来在别的服务器上也无响应时撤掉（见 localOutage）。 */
function noteFailure(s, rec, seg, entry) {
  if (seg && localOutage(s, seg)) return;
  if (!countsAsTrouble(s, rec)) return;
  const hang = isHang(rec);
  const ref = hang && entry ? newId(Date.now()) : '';
  addTrouble([{ h: rec.h, p: lineOf(rec.k) }], errWeight(s, rec), hang ? 'hang' : 'err', ref);
  if (ref) entry.ref = ref;
}

// 点播 host 连到的服务器网段（见 probe.js noteServer），页面的请求和测速请求都记：测速隔几分钟就把各镜像测一遍，同一台服务器的几个名字很快就对上了；
// 对上以后几个名字轮流测（见 probe.js probePick），每个名字隔几分钟还会轮到，连到哪里照样一直在更新。
// B 站分配的主节点在组里时只测它，其他名字 24 小时没连过就掉出组，单独测一次再归组。
// 最多 5 秒存一次
const saveServers = batched(5000, () => chrome.storage.local.set({ servers: pruneServers(servers) }).catch(() => {}));
function learnServer(d) {
  if (!d.ip || lineOf(mediaKind(d.url)) !== 'vod') return;
  const h = hostOf(d.url);
  loaded.then(() => {
    if (settings.enabled && noteServer(servers, h, d.ip)) saveServers();
  });
}

/**
 * 直播 HLS 跟不跟得上：每取完一个分片，算近 30 秒分片下载的占用（见 analyze.js hlsLoad），popup 显示；
 * 占用到 90% 以上算一次“跟不上”，记进协议级证据（每 30 秒最多一次），够了「自动」下次就改用 FLV。
 */
function checkHlsLoad(s, rec) {
  const end = rec.t + (rec.d || 0);
  const v = hlsLoad(s.recent || [], end);
  if (v === null) return;
  s.hls = { t: end, v };
  if (v < HLS_LOAD.busy || end - (s.busyAt || 0) < HLS_LOAD.window) return;
  s.busyAt = end;
  addProtoTrouble(s, [{ h: rec.h, p: 'hls', w: 1 }], 1, 'busy');
}

/**
 * 记录挂到发出请求时的会话上（必要时兜底建会话），并更新 popup 用的实时概况。
 * 请求期间页面换了视频的（切换时被中止的旧分片等），只记到原会话，不计入新会话的概况。
 */
function commit(p, rec) {
  loaded.then(async () => {
    if (!settings.enabled) return;
    // 正在播放：到时候了就复查网络；请求因为本地网络出错（换网络、断网）时过几秒就查（见 netRecheck）
    if (rec.e && NET_ERRORS.has(rec.e)) netSoon();
    netRecheck();
    const s = await ensureSession(p.tab);
    rec.sid = p.sid || (s ? s.sid : null);
    // 记到原会话的（请求期间换了视频），原会话的 ses 在请求发出时已经写了（见 onBeforeRequest）
    record(s && rec.sid === s.sid ? s : null, rec);
    if (!s || rec.sid !== s.sid) return;
    const seg = rec.ty === 'req' && isFailure(rec) ? segOf(p, rec) : '';
    let entry = null;
    if (rec.ty === 'req') {
      addHostSample(s, rec);
      // 留够标记卡顿要看的 60 秒（直播 HLS 一秒两个请求）
      const recent = s.recent || (s.recent = []);
      const end = rec.t + (rec.d || 0);
      // hang：没等到响应头就超时，起播、卡顿的责任据此判断（见 hostsDuring）；seg：是哪一段，判断本地网络中断用（见 localOutage）；
      // pc：走的是 PCDN（见 cdn.js isPcdnReq），popup、播放器上的按钮显示正在用的节点是不是 PCDN 时用
      entry = { h: rec.h, a: rec.t, t: end, k: rec.k, ...(isFailure(rec) ? { f: 1 } : {}), ...(isHang(rec) ? { hang: 1, seg } : {}), ...(isPcdnReq(rec) ? { pc: 1 } : {}) };
      recent.push(entry);
      while (recent.length > RECENT.max || recent[0].t < end - RECENT.keep) recent.shift();
    } else if (isFailure(rec)) {
      hostSummary(s, rec.h).err += 1;
    }
    if (isFailure(rec)) noteFailure(s, rec, seg, entry);
    if (rec.ty === 'req' && lineOf(rec.k) === 'hls') checkHlsLoad(s, rec);
    saveTabs();
  });
}

function baseRec(p, d) {
  const u = new URL(p.url);
  const sent = p.ts ?? p.t0;
  const rec = {
    ty: 'req',
    t: Math.round(p.t0),
    sid: null,
    h: u.host,
    ip: d.ip || '',
    os: u.searchParams.get('os') || '',
    k: p.kind,
    trk: trackOf(p.url),
    st: d.statusCode || p.st || 0,
    fc: d.fromCache ? 1 : 0,
    tt: p.th ? Math.round(p.th - sent) : null,
    d: Math.round(d.timeStamp - sent),
    b: bodyBytes(p),
  };
  if (p.range) rec.r = p.range.replace(/^bytes=/, '');
  return rec;
}

// 直播 FLV 是持续数小时的长连接：响应开始时就记一条 req（open=1，含 TTFB），
// 结束时再记一条 reqend（时长、断开原因）。否则要等连接结束才有记录，期间 SW 被回收就会丢失。
chrome.webRequest.onResponseStarted.addListener((d) => {
  learnServer(d);
  const p = pending.get(d.requestId);
  if (!p || p.kind !== 'live-flv') return;
  p.open = true;
  saveStreams();
  commit(p, { ...baseRec(p, d), d: null, b: null, open: 1 });
}, FILTER);

// 长连接连上之后就没有 webRequest 事件了，SW 闲置 30 秒会被回收，pending 跟着清空：之后卡顿、标记找不到在用的节点，
// 测速以为页面没在播放，连接结束时也记不了 reqend。所以进行中的长连接存进 storage.session，SW 重启时读回。
// requestId 在整个浏览器里有效，读回后结束事件照样对得上
let streamsBack = false;
function restoreStreams(streams) {
  for (const [id, p] of Object.entries(streams || {})) if (!pending.has(id)) pending.set(id, p);
  streamsBack = true;
}

function saveStreams() {
  ready.then(() => {
    const streams = {};
    for (const [id, p] of pending) if (p.open) streams[id] = p;
    return chrome.storage.session.set({ streams });
  }).catch(() => {});
}

function finish(d, error, redirect) {
  const p = pending.get(d.requestId);
  if (!p) {
    // SW 正是被这个事件唤醒的：存起来的长连接还没读回，读回后再找一次
    if (!streamsBack) ready.then(() => pending.has(d.requestId) && finish(d, error, redirect));
    return;
  }
  pending.delete(d.requestId);
  if (p.open) {
    saveStreams();
    const rec = { ty: 'reqend', t: Math.round(d.timeStamp), sid: null, h: new URL(p.url).host, k: p.kind, st: d.statusCode || p.st || 0, d: Math.round(d.timeStamp - (p.ts ?? p.t0)) };
    if (error) rec.e = error;
    commit(p, rec);
    return;
  }
  const rec = baseRec(p, d);
  if (error) rec.e = error;
  if (redirect) rec.rd = redirect;
  commit(p, rec);
}

chrome.webRequest.onBeforeRequest.addListener((d) => {
  // 暂停时不跟踪（SW 刚启动、设置还没读回时照样跟踪，提交时再看，见 commit）
  if (d.tabId < 0 || !settings.enabled) return;
  const kind = mediaKind(d.url);
  if (!kind) return;
  const s = tabs[d.tabId];
  // 页面在请求媒体，这时就写会话的 ses（见 newSession）：req 要等请求结束才写，这期间站内切换了视频的话，
  // 原会话已经不在 tabs 里，到时候补不上
  writeSes(s);
  // SW 刚启动、会话还没从 storage.session 读回时 sid 为空，提交时再按标签页查
  pending.set(d.requestId, { t0: d.timeStamp, url: d.url, tab: d.tabId, kind, sid: s ? s.sid : null });
}, FILTER);

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    probeTime(d, 'ts');
    const p = pending.get(d.requestId);
    if (!p) return;
    p.ts = d.timeStamp;
    p.range = header(d.requestHeaders, 'range');
  },
  FILTER,
  ['requestHeaders'],
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    probeTime(d, 'th');
    const p = pending.get(d.requestId);
    if (!p) return;
    p.th = d.timeStamp;
    p.st = d.statusCode;
    p.len = header(d.responseHeaders, 'content-length');
    p.cr = header(d.responseHeaders, 'content-range');
  },
  FILTER,
  ['responseHeaders'],
);

chrome.webRequest.onBeforeRedirect.addListener((d) => finish(d, null, hostOf(d.redirectUrl)), FILTER);
chrome.webRequest.onCompleted.addListener((d) => (probeTime(d, 'te'), finish(d, null)), FILTER);
chrome.webRequest.onErrorOccurred.addListener((d) => (probeTime(d, 'te'), finish(d, d.error)), FILTER);

// ---------------------------------------------------------------- 测速
// 开启后每 30 秒测一轮（chrome.alarms 最短 30 秒），只在有 B 站页面正在播放（2 分钟内有媒体请求）时测。
// 测的是当前视频 / 直播间的真实地址：点播测分配里的节点和各 UPOS 镜像，直播测 B 站给的各条线路（各编码、当前清晰度）。
// 每轮挑到了测速间隔的、最久没测的 4 个依次测，每个最多下载 512 KB（点播随机取文件中间的一段，开头那段多半已在 CDN 边缘缓存）。
// 点播排名前 2 的每 2 分钟测一次，其余每 10 分钟，直播的每 2 分钟（见 probe.js probePick）。
// 点播同一台服务器的几个镜像名（见 learnServer）算一个节点，轮流测其中一个；B 站分配的主节点在组里时只测它。
// 测速不和播放抢带宽：每测一个之前看一眼播放器，缓冲不够（见 probe.js probeGate）就跳过这一轮 / 停下。
// 点播除了 B 站分配的主节点，测得明显差就暂缓，隔 2~16 分钟再测（见 probe.js updateBackoff）；
// 本网络档案里从没测好过的，档案里上次测过之后 30 分钟再测（见 probe.js bookSlow）。
// 测速请求不属于任何标签页，不计入页面的请求统计。
// 最近几次的得分（见 probeScore）写进 rank，线路优化的“自动”模式据此选节点；直播按编码和清晰度分开记，
// 换了清晰度后要等新清晰度测过才按测速判断。

// expMargin：测速地址离过期不到这么久就不再用（一轮最多测 4 × 8 秒）
// maxAge：测速记录保留多久，要长过最长的暂缓（档案里从没测好过的 30 分钟，见 probe.js CADENCE），暂缓的节点才不会从排名里消失。
const PROBE = { alarm: 'probe', perRound: 4, bytes: 512 * 1024, timeout: 8000, keep: 6, maxAge: 32 * 60e3, expMargin: 60e3 };

// 清空或换网络时，使整轮测速失效，并等已经发出的 storage 写入结束后再删除。
// 新一轮等清理完成再开始，旧轮次持有的历史快照不能恢复排名。
function resetMeasurements(clearRecords = false) {
  probeEpoch += 1;
  probeController?.abort();
  // 等着复测的是旧网络 / 清空前的，不再测（见 verifyValid）
  dropVerify();
  const active = probing;
  const reset = probeReset.then(async () => {
    await active;
    if (clearRecords) {
      await Store.clear();
      book = { v: 1, nets: {} };
      knownJson = '';
      await chrome.storage.local.remove('known');
      await saveBook();
    }
    trouble = [];
    saveTrouble.cancel();
    protoTrouble = [];
    probeState = null;
    // 换了网络，镜像解析到的服务器也可能变了，重新记
    servers = {};
    await chrome.storage.local.remove(clearRecords ? ['net', 'rank', 'trouble', 'protoTrouble', 'servers'] : ['rank', 'trouble', 'protoTrouble', 'servers']);
    await chrome.storage.session.remove(['probeLog', 'probeWait', 'probeState']);
  });
  probeReset = reset.catch(() => {});
  return reset;
}

// 已有闹钟就不重建：同名闹钟重建会重新计时，SW 每次被唤醒都建一遍的话，下一轮测速会一再推迟
function syncProbe() {
  if (!settings.enabled || !settings.probe) return chrome.alarms.clear(PROBE.alarm);
  return chrome.alarms.get(PROBE.alarm).then((a) => a || chrome.alarms.create(PROBE.alarm, { periodInMinutes: 0.5 }));
}
chrome.alarms.onAlarm.addListener((a) => a.name === PROBE.alarm && runProbe());

// 测速请求由扩展自己发出，没有 B 站页面的 Referer / Origin，CDN 会返回 403。用会话规则补上，
// 只作用于本扩展发出、不属于任何标签页的请求，页面自己的请求不受影响
function installProbeHeaders() {
  const headers = (site) => [
    { header: 'Referer', operation: 'set', value: `${site}/` },
    { header: 'Origin', operation: 'set', value: site },
  ];
  const condition = {
    tabIds: [chrome.tabs.TAB_ID_NONE],
    initiatorDomains: [chrome.runtime.id],
    requestDomains: [...CDN_DOMAINS],
  };
  chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: [1, 2],
      addRules: [
        { id: 1, priority: 1, action: { type: 'modifyHeaders', requestHeaders: headers('https://www.bilibili.com') }, condition },
        { id: 2, priority: 2, action: { type: 'modifyHeaders', requestHeaders: headers('https://live.bilibili.com') }, condition: { ...condition, regexFilter: '^https://[^/]+/live-' } },
      ],
    })
    .catch((e) => console.warn('[bilicdn] 安装测速请求头规则失败', e));
}
installProbeHeaders();

/** 测速地址是否已过期（或快过期）。看直播超过 1 小时、点播超过 2 小时没刷新就会这样，要等页面拿到新地址。 */
const targetExpired = (tg, now = Date.now()) => tg.exp > 0 && tg.exp - now < PROBE.expMargin;

/** 正在播放、有可用测速地址的会话；有多个时取最近有媒体请求的。 */
function probeSession() {
  const now = Date.now();
  let best = null;
  for (const [id, s] of Object.entries(tabs)) {
    if (!s.target || targetExpired(s.target, now)) continue;
    const tabId = Number(id);
    const recent = s.recent || [];
    const streaming = [...pending.values()].some((p) => p.tab === tabId && p.th);
    const last = streaming ? now : recent.length ? recent[recent.length - 1].t : 0;
    if (last > now - 120e3 && (!best || last > best.last)) best = { tabId, s, last };
  }
  return best;
}

// 测速请求的网络层时间（webRequest 时间戳）。fetch 在 SW 里拿到响应头的时间不准：
// 实测响应头常常要等正文差不多到齐才交过来，按 JS 计时会把首字节时间算大、吞吐算成几百 Mbps
const probeNet = new Map(); // url → { ts, th, te }
function probeTime(d, key) {
  const x = d.tabId < 0 && probeNet.get(d.url);
  if (x && !(key in x)) x[key] = d.timeStamp;
}

// 和 webRequest 时间戳同一口径的当前时间（毫秒，带小数）
const wallNow = () => performance.timeOrigin + performance.now();

/**
 * 取一个地址，返回状态、首字节时间（tt）、读到的字节数（b）和吞吐（mbps）。
 * maxBytes 为 0 时读成文本（播放列表）；maxMs 限制读流的时长（FLV 是不会结束的直播流）。
 */
async function timedFetch(url, init, { maxBytes = 0, maxMs = Infinity } = {}) {
  const net = {};
  probeNet.set(url, net);
  const t0 = wallNow();
  try {
    const res = await fetch(url, init);
    const th = wallNow();
    const out = { st: res.status, ok: res.ok, url: res.url || url, len: Number(res.headers.get('content-length')) || 0, b: 0 };
    if (res.ok && !maxBytes) {
      out.text = await res.text();
    } else if (res.ok && res.body) {
      const reader = res.body.getReader();
      while (out.b < maxBytes && wallNow() - th < maxMs) {
        const { done, value } = await reader.read();
        if (done) break;
        out.b += value.length;
      }
      reader.cancel().catch(() => {});
    }
    const tend = wallNow();
    if (!net.te) await new Promise((r) => setTimeout(r, 30));
    const h = net.th ?? th;
    out.tt = Math.round(h - (net.ts ?? t0));
    // 正文常常和响应头几乎同时到齐（边缘节点回源慢、本地传得快），传输时间至少按 4ms 算，吞吐封顶约 1000 Mbps
    if (out.b) out.mbps = Math.round((out.b * 8) / Math.max(Math.min(net.te ?? tend, tend) - h, 4) / 10) / 100;
    return out;
  } finally {
    probeNet.delete(url);
  }
}

/**
 * 测一个地址：点播取文件中的一段 512 KB（见 probeRange）；FLV 读最多 3 秒 / 512 KB 后断开；
 * HLS 先取播放列表（pt），再取最新分片的前 512 KB，记下分片大小（seg）、时长（dur）和码率（br）。
 */
async function probeOne(c) {
  const rec = { ty: 'probe', t: Date.now(), sid: null, h: c.h, k: c.k, st: 0, tt: null, d: null, b: 0, mbps: null };
  const ctl = new AbortController();
  probeController = ctl;
  const timer = setTimeout(() => ctl.abort(), PROBE.timeout);
  const opts = { credentials: 'omit', cache: 'no-store', signal: ctl.signal };
  const t0 = performance.now();
  try {
    let url = c.url;
    if (c.k === 'live-hls') {
      // master 列表下钻一层
      for (let i = 0; i < 2; i++) {
        const pl = await timedFetch(url, opts);
        if (i === 0) rec.pt = pl.tt;
        rec.st = pl.st;
        if (!pl.ok) throw new Error(`HTTP ${pl.st}`);
        const m = parseM3u8(pl.text, pl.url);
        if (!m) throw new Error('播放列表为空');
        if (m.segment) {
          url = m.segment;
          if (m.dur) rec.dur = m.dur;
          break;
        }
        url = m.playlist;
      }
    }
    const init = c.k === 'vod' ? { ...opts, headers: { Range: c.range } } : opts;
    const r = await timedFetch(url, init, { maxBytes: PROBE.bytes, maxMs: c.k === 'live-flv' ? 3000 : Infinity });
    Object.assign(rec, { st: r.st, tt: r.tt, b: r.b, mbps: r.mbps ?? null });
    if (c.k === 'live-hls' && r.ok) {
      rec.seg = r.len || r.b;
      if (rec.dur) rec.br = Math.round((rec.seg * 8) / rec.dur / 1e4) / 100;
    }
  } catch (e) {
    rec.e = e.name === 'AbortError' ? 'timeout' : String(e.message || e).slice(0, 60);
  } finally {
    clearTimeout(timer);
    ctl.abort();
    if (probeController === ctl) probeController = null;
  }
  rec.d = Math.round(performance.now() - t0);
  return rec;
}

/** 记下这一轮测的是哪个标签页、测了几个、因为什么没测完（skip：stall 播放器在转圈 / buffer 缓冲不够），popup 据此提示。 */
function noteProbe(tab, n, skip) {
  probeState = { t: Date.now(), tab, n, ...(skip ? { skip } : {}) };
  chrome.storage.session.set({ probeState }).catch(() => {});
}

// ---------------------------------------------------------------- 网络档案
// 每次测速都记进当前网络的档案（见 probe.js bookAdd），算出的「本网络以往测速」写进 known，页面里改写时没有新测速就用它。
// 档案比较大，每轮都写的话会经 storage.onChanged 发给每个 B 站页面，所以最多 2 分钟存一次（SW 被回收时最多丢 2 分钟的测速）

const BOOK_SAVE_MS = 2 * 60e3;

function saveBook() {
  if (!book) return Promise.resolve();
  bookSavedAt = Date.now();
  bookPrune(book);
  return chrome.storage.local.set({ netBook: book }).catch(() => {});
}

/** 当前网络的以往测速，有变化时才写（返回要写的对象，没变化时为 null）。 */
function knownNow() {
  const k = { net: curNet, label: curLabel, ...bookKnown(book && curNet ? book.nets[curNet] : null) };
  const json = JSON.stringify(k);
  if (json === knownJson) return null;
  knownJson = json;
  return { ...k, t: Date.now() };
}

function publishKnown() {
  const known = knownNow();
  if (known) chrome.storage.local.set({ known }).catch(() => {});
}

// 升级到有网络档案的版本后第一次启动：用以往的测速记录（按当时所在的网络）建档案，同一网络下马上就有可用的结果
const bookReady = ready
  .then(async () => {
    if (!book) {
      const { records } = await Store.readAll();
      book = bookFromRecords(records);
      await saveBook();
    }
    publishKnown();
  })
  .catch((e) => {
    console.warn('[bilicdn] 建立网络档案失败', e);
    book ||= { v: 1, nets: {} };
  });

// ---------------------------------------------------------------- 复测
// 「自动」用本网络以往测得好的节点之前先测一下（以往的测速只用来挑要测哪几个，见 probe.js verifyPick、route.js pickVod）：
// 页面拿到播放地址、线路优化开着时，马上测以往最好的两个和当前主节点里近 10 分钟没测过的，测速开关关着也测。
// 改写在拿到地址的那一刻就完成了，等不了测速，所以这次测的结果用在之后的视频（自动连播、站内切换、刷新）上。正在测速时等它测完。
// 直播开播按以往测速改用了 FLV 时，顺带复测一条 HLS，档案才会跟着更新（见 probe.js liveRecheck）
// 复测和定时测速一样不和播放抢带宽（见 probe.js probeGate）：拿到地址时多半正在起播、缓冲还是 0，先记下来，
// 每 5 秒看一次缓冲，够了再测；测完一个缓冲掉下去了就停下，剩下的接着等。以前复测不看缓冲，起播期间照样发测速请求。
// 读不到播放器状态时定时测速照常测（页面脚本可能没运行），复测不行：拿到地址时页面上多半还没有视频，读不到是因为还没开始加载
// （e2e 实测拿到地址后 0.1 秒就测了，播放器状态为空）。所以复测读不到时也等，20 秒后还读不到再照常测。
// 记下来的任务绑定会话、测速地址和网络：换了视频（新的测速地址）、换了网络、地址快过期、关了标签页、超过 10 分钟就不测了。
// 存在 storage.session 里，SW 被回收后接着等

const VERIFY_WAIT = { every: 5e3, blind: 20e3, max: 10 * 60e3 };
let verifyTimer = null;

const saveVerify = () => chrome.storage.session.set({ verifyWait }).catch(() => {});

/** 不再等着复测：给了标签页只去掉它的，否则全部去掉。 */
function dropVerify(tabId) {
  if (tabId == null) verifyWait = {};
  else delete verifyWait[tabId];
  saveVerify();
}

function verifySoon(tabId) {
  const s = tabs[tabId];
  if (!s || !s.target) return;
  verifyWait[tabId] = { sid: s.sid, tt: s.target.t, net: curNet, at: Date.now() };
  saveVerify();
  drainVerify();
}

/** 依次复测等着的标签页（正在测速时等它测完）；缓冲不够、没测完的留着，5 秒后再看。 */
function drainVerify() {
  clearTimeout(verifyTimer);
  verifyTimer = null;
  Promise.resolve(probing)
    .then(async () => {
      for (const id of Object.keys(verifyWait)) await runProbe(false, Number(id));
    })
    .catch(() => {})
    .finally(() => {
      if (Object.keys(verifyWait).length && !verifyTimer) verifyTimer = setTimeout(drainVerify, VERIFY_WAIT.every);
    });
}
// SW 重启后接着等
loaded.then(() => Object.keys(verifyWait).length && drainVerify());

/** 等着的复测还能不能做：还是这个标签页最新的那个，会话、测速地址、网络都没变，地址没快过期，没超过 10 分钟。 */
function verifyValid(tabId, task, now = Date.now()) {
  const s = tabs[tabId];
  return !!task && verifyWait[tabId] === task && now - task.at < VERIFY_WAIT.max && task.net === curNet && !!s && s.sid === task.sid && !!s.target && s.target.t === task.tt && !targetExpired(s.target, now);
}

/** 测速候选：点播为分配里的节点加上各 UPOS 镜像，这一轮各节点取同一段（结果才能比较）；直播为 B 站给的各条线路。key 见 route.js lineKey。 */
function probeCands(tg) {
  if (tg.kind !== 'vod') return tg.lines.map((c) => ({ ...c, key: lineKey(c.h, c.c, c.qn) }));
  const range = probeRange(tg.size || 0, PROBE.bytes);
  return vodCandidates(tg.urls).map((c) => ({ ...c, range, key: lineKey(c.h, c.c, c.qn) }));
}

/**
 * 这一轮测哪几个。log：测速记录；wait：退避状态；keep：不暂缓的 host；entry：当前网络的档案（见 probe.js 网络档案）。
 * 复测（verify）：以往测得好的和当前主节点（见 probe.js verifyPick），直播再看要不要复测一条 HLS（见 liveRecheck）；
 * 定时测速：到了测速间隔、不在暂缓中的，最久没测的先测（见 probe.js probePick）。
 */
function pickProbes(tg, cands, { verify, log, wait, keep, entry }) {
  const now = Date.now();
  const vod = tg.kind === 'vod';
  const lastT = (key) => (log[key] ? log[key][log[key].length - 1].t : 0);
  // 点播同一台服务器的几个镜像名算一个节点，轮流测（见 probe.js probePick / verifyPick）
  const same = vod ? sameServer(servers, now) : {};
  if (!verify) {
    const count = Object.fromEntries(Object.entries(log).map(([key, xs]) => [key, xs.length]));
    return probePick(cands, { lastT, scores: probeRank(log, now).vod, count, wait, keep, slow: vod ? bookSlow(entry, now) : {}, vod, same, n: PROBE.perRound }, now);
  }
  const kn = bookKnown(entry);
  const w = troubleOf(trouble);
  const avoid = (c) => (vod ? isBad(w.vod, c.h) || isPcdnHost(c.h) : isBad(w[lineOf(c.k)], c.h));
  const picked = verifyPick(cands, vod ? hostOf(tg.urls[0]) : cands[0].key, vod ? kn.vod : kn.live, avoid, lastT, now, same);
  // 指定了直播线路时用不上以往的 HLS 测速，不用复测
  const again = !vod && settings.liveProto === 'auto' ? liveRecheck(cands, kn.hls, avoid, lastT, now) : null;
  if (again && !picked.includes(again)) picked.push(again);
  return picked;
}

/** 记下一次测速（s 为测的是哪个会话的地址）：写进记录、测速记录 log（算排名用，每个键留最近 PROBE.keep 次）和测速时所在网络的档案。 */
function addProbe(log, c, rec, s, net) {
  rec.sid = s.sid;
  if (c.c) rec.c = c.c;
  if (c.qn != null) rec.qn = c.qn;
  record(s, rec);
  const ok = !rec.e && rec.st >= 200 && rec.st < 300;
  const sc = probeScore(rec);
  const xs = (log[c.key] ||= []);
  xs.push({ t: rec.t, k: rec.k, h: c.h, c: c.c || '', qn: c.qn ?? null, sc, ok, tt: rec.tt, mbps: rec.mbps, br: rec.br ?? null });
  if (xs.length > PROBE.keep) xs.shift();
  // 测的时候换了网络（见 checkNetwork）就不记进档案
  if (book && net && net === curNet) bookAdd(book, net, c.key, rec.k, sc, rec.br, rec.t, curLabel);
}

// 测速记录按 lineKey 分开（点播按 host；直播按 host + 编码 + 清晰度），排名见 probe.js probeRank。
// force：不看播放器缓冲（端到端测试用）；verifyTab：复测这个标签页等着的任务（见 verifySoon），只要线路优化开着，不看测速开关。
// 复测缓冲不够、或者测到一半缓冲掉下去了，任务留着待会儿再测；别的情况（测完了、不用测、任务失效）都去掉
function runProbe(force = false, verifyTab = null) {
  if (probing) return probing;
  const epoch = probeEpoch;
  const verify = verifyTab != null;
  const task = verify ? verifyWait[verifyTab] : null;
  if (verify && !task) return Promise.resolve(null);
  let later = false; // 复测：留着待会儿再测
  probing = (async () => {
    await Promise.all([ready, settingsReady, probeReset, bookReady]);
    if (epoch !== probeEpoch || !settings.enabled || !(verify ? settings.route : settings.probe)) return null;
    if (verify && !verifyValid(verifyTab, task)) return null;
    // 到时候了就复查网络（直播 FLV 播放时没有别的请求，测速闹钟是少数会叫醒 SW 的事件），记下测速前等它查完（见下文）
    netRecheck();
    const net = curNet;
    const cur = verify ? { tabId: verifyTab, s: tabs[verifyTab] } : probeSession();
    if (!cur) return null;
    const gate = async () => {
      if (force) return null;
      const ps = await askPlayer(cur.tabId);
      // 复测读不到播放器状态：多半是视频还没开始加载，先等（见 verifySoon）
      return !ps && verify && Date.now() - task.at < VERIFY_WAIT.blind ? 'stall' : probeGate(ps);
    };
    const skip = await gate();
    if (skip) {
      // 复测在起播时常常要等一会儿，不当成「已暂停测速」提示
      if (verify) later = true;
      else noteProbe(cur.tabId, 0, skip);
      return null;
    }
    const tg = cur.s.target;
    const cands = probeCands(tg);
    const { probeLog: log = {}, probeWait: wait = {} } = await chrome.storage.session.get(['probeLog', 'probeWait']);
    if (epoch !== probeEpoch) return null;
    // 不暂缓的：点播为 B 站分配的主节点（「自动」要拿它比较），直播为全部线路（都是 B 站给的）
    const vod = tg.kind === 'vod';
    const keep = new Set(vod ? [hostOf(tg.urls[0])] : cands.map((c) => c.h));
    // 档案要用的时候再取：这一轮测完，当前网络的档案可能才建起来
    const bookEntry = () => (book && net ? book.nets[net] : null);
    const picked = pickProbes(tg, cands, { verify, log, wait, keep, entry: bookEntry() });
    if (verify && !picked.length) return null;
    const probed = [];
    let stopped = null;
    for (const c of picked) {
      // 测完一个、缓冲掉下去了就停下，测过的照样记；复测剩下的留着，缓冲恢复后接着测（测过的 10 分钟内不再挑）
      if (probed.length && (stopped = await gate())) {
        later = verify;
        break;
      }
      // 测的时候换了视频（新的测速地址）：不再拿旧地址测
      if (verify && !verifyValid(verifyTab, task)) break;
      const rec = await probeOne(c);
      probed.push(c);
      // 记下之前确认网络归属：正在查网络的等它查完，换了网络（probeEpoch 变了）就不记，免得新网络的测速记进旧网络的排名和档案
      if (netDeciding) await netDeciding;
      if (epoch !== probeEpoch) return null;
      addProbe(log, c, rec, cur.s, net);
    }
    for (const key of Object.keys(log)) {
      log[key] = log[key].filter((x) => x.t > Date.now() - PROBE.maxAge);
      if (!log[key].length) delete log[key];
    }
    const rank = probeRank(log);
    updateBackoff(wait, probed, keep, rank, log);
    // popup 显示哪些节点在暂缓、什么时候再测
    rank.wait = restUntil(wait, vod ? bookSlow(bookEntry()) : {}, keep);
    await chrome.storage.session.set({ probeLog: log, probeWait: wait });
    if (epoch !== probeEpoch) return null;
    const known = knownNow();
    await chrome.storage.local.set({ rank, ...(known ? { known } : {}) });
    if (Date.now() - bookSavedAt >= BOOK_SAVE_MS) saveBook();
    noteProbe(cur.tabId, probed.length, stopped);
    return rank;
  })()
    .catch((e) => console.warn('[bilicdn] 测速失败', e))
    .finally(() => {
      probing = null;
      // 测的时候又拿到了新地址（verifySoon 换了任务）的，留着新的
      if (verify && !later && verifyWait[verifyTab] === task) dropVerify(verifyTab);
    });
  return probing;
}

// ---------------------------------------------------------------- 手动问题标注
// lv：1 少量卡顿 / 2 较多卡顿 / 3 无法播放；issue=sync 为音画不同步，不分程度。撤销追加一条 unmark。

const MARK_WINDOW = 60e3;

function flashBadge(tabId, text) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#fb7299' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  // null：回到全局的（暂停时的「关」，见 showPaused）
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: null }).catch(() => {}), 2500);
}

/**
 * from ~ to 这段时间里在用的节点：这段时间里完成的请求，加上仍在进行中的请求（act=1，如直播 FLV 长连接、卡住的请求）。
 * 每个节点带上责任比例 w（按请求在途时间分，见 analyze.js blameHosts），卡顿证据按它记权重；p 为线路（vod / flv / hls）。
 * hung：起播、卡顿时用，期间有请求没等到响应头就超时的，责任全算给超时的节点，接手的备用节点不分（见 analyze.js blameHung）。
 */
function hostsDuring(tabId, s, from, to, hung = false) {
  const reqs = s ? [...(s.recent || [])] : [];
  for (const p of pending.values()) if (p.tab === tabId) reqs.push({ h: hostOf(p.url), a: p.t0, k: p.kind, act: 1 });
  const hosts = blameHosts(reqs, from, to);
  return hung ? blameHung(hosts, reqs, from, to) : hosts;
}

/** 播放器状态（player.js 回复）：只取已知字段。 */
function cleanPs(v) {
  if (!v || typeof v !== 'object') return null;
  const pos = num(v.pos);
  if (pos === null) return null;
  const ps = { pos, dur: num(v.dur), buf: num(v.buf) ?? 0, rs: num(v.rs) ?? 0, paused: v.paused ? 1 : 0, vh: num(v.vh) };
  const frames = num(v.frames);
  if (frames !== null) Object.assign(ps, { drop: num(v.drop) ?? 0, frames });
  return ps;
}

/** 向页面要播放器状态；页面没有视频、页面脚本没运行或 0.4 秒内没回复时为 null。 */
function askPlayer(tabId) {
  const ask = chrome.tabs.sendMessage(tabId, { type: 'player' }).then(cleanPs, () => null);
  return Promise.race([ask, new Promise((r) => setTimeout(() => r(null), 400))]);
}

/**
 * 记一次手动标记。via：popup / key 快捷键 / page 播放器上的按钮；issue=sync 单独记录音画不同步。
 * ps 为播放器状态（卡顿点：播放位置、前方缓冲、掉帧），没传时向页面要；据此和最近一次卡顿判断卡的原因（cause）。
 * 归咎于节点的标记（见 blamesNode）按程度记进卡顿证据。返回 bad：标记后算作出过问题的节点。
 */
async function addMark(tabId, url, lv, via, note, ps, issue = null) {
  if (!isBiliUrl(url)) return { ok: false, reason: 'not-bilibili' };

  issue = issue === 'sync' ? 'sync' : null;
  if (issue) lv = null;
  if (ps === undefined) ps = await askPlayer(tabId);
  const s = tabs[tabId];
  const t = Date.now();
  const hosts = hostsDuring(tabId, s, t - MARK_WINDOW, t);
  const ls = s && s.lastStall ? { ago: t - s.lastStall.t, ms: s.lastStall.ms } : null;
  const cause = issue ? null : markCause(ps, ls);
  const id = newId(t);
  const rec = { ty: 'mark', t, id, sid: s ? s.sid : null, pg: pageType(url), path: pageKey(url), lv, via, hosts };
  if (issue) rec.issue = issue;
  if (ps) rec.ps = ps;
  if (ls && ls.ago < 120e3) rec.ls = ls;
  if (cause) rec.cause = cause;
  if (note) rec.note = note;
  record(s, rec);
  Store.flush().catch(() => {}); // 失败时 Store 已打日志并会重试
  if (blamesNode(rec)) {
    addTrouble(hosts, lv, 'mark', id);
    addProtoTrouble(s, hosts, lv, 'mark', id);
  }
  if (s) {
    s.marks = (s.marks || 0) + 1;
    s.lastMark = { id, t, lv, ...(issue ? { issue } : {}) };
    saveTabs();
  }
  flashBadge(tabId, '✓');
  const w = troubleOf(trouble);
  const bad = issue ? [] : hosts.filter((x) => x.p && isBad(w[x.p], x.h)).map((x) => x.h);
  return { ok: true, id, hosts, session: !!s, ps, cause, issue, bad };
}

function undoMark(tabId) {
  const s = tabs[tabId];
  if (!s || !s.lastMark) return { ok: false };
  const ref = s.lastMark.id;
  record(s, { ty: 'unmark', t: Date.now(), ref, sid: s.sid });
  Store.flush().catch(() => {});
  trouble = trouble.filter((x) => x.ref !== ref);
  protoTrouble = protoTrouble.filter((x) => x.ref !== ref);
  saveTrouble();
  s.marks = Math.max(0, (s.marks || 0) - 1);
  s.lastMark = null;
  saveTabs();
  return { ok: true };
}

/**
 * 鼠标移到播放器上的标记按钮时显示的实时状态（见 player.js），ps 为页面带来的播放器状态。
 * cause：现在卡不卡（同 popup，只看播放器状态，见 analyze.js markCause）；stall：本页（本会话）自动识别的卡顿；
 * nodes：正在用的节点，传输中的请求和近 10 秒完成的请求（同 popup 的「正在用的节点」），都没有时（点播缓冲够了会停一阵）
 * 给最近完成的那个，ago 为多久前；mb 为这个节点最近 5 个请求的下载速度中位数（Mbps，口径同 popup「实际请求」，
 * 见 cdn.js mbpsOf，不到 512 KB 的请求不算），直播 FLV 是一条长连接，没有；bad 为近期卡过（「自动」会避开）。
 * mark：本页上一次标记（撤销后为 null），ago 为多久前，菜单据此高亮。只传原始值，给的是这个标签页自己的数据。
 */
function playStatus(tabId, ps) {
  const s = tabs[tabId];
  const now = Date.now();
  const seen = new Map();
  // 是不是 PCDN 按这些请求算（见 cdn.js nodeClass）：n 个里 pc 个是
  const add = (h, k, ago, pc) => {
    const x = seen.get(h) || seen.set(h, { k, ago, n: 0, pc: 0 }).get(h);
    x.n += 1;
    if (pc) x.pc += 1;
  };
  for (const p of pending.values()) if (p.tab === tabId && p.th) add(hostOf(p.url), p.kind, 0, isPcdnUrl(p.url));
  for (const r of [...((s && s.recent) || [])].reverse()) {
    if (r.t > now - 10e3 || !seen.size) add(r.h, r.k, Math.max(0, now - r.t), r.pc);
  }
  const w = troubleOf(trouble);
  const nodes = [...seen].slice(0, 3).map(([h, x]) => {
    const p = lineOf(x.k);
    const mb = (s && s.hosts[h] && s.hosts[h].mb.slice(-5)) || [];
    const cls = nodeClass(h, x.pc, x.n);
    // 一部分请求是 PCDN（part）：标签上注明
    const part = cls !== 'pcdn' && x.pc > 0 ? 1 : 0;
    return { h, cls, part, label: `${CLASS_LABELS[cls] || cls}${part ? L(' · 部分 PCDN', ' · partly PCDN') : ''}`, p, ago: x.ago, mb: mb.length ? quantile(mb, 0.5) : null, flv: x.k === 'live-flv' ? 1 : 0, bad: p && isBad(w[p], h) ? 1 : 0 };
  });
  const m = s && s.lastMark;
  return {
    ok: true,
    session: !!s,
    cause: ps && !ps.paused ? markCause(ps, null) : null,
    stall: s ? { n: s.stall.n, ms: s.stall.ms } : null,
    hls: s && s.hls && s.hls.t > now - 15e3 ? s.hls.v : null,
    nodes,
    mark: m ? { lv: m.lv ?? null, issue: m.issue || null, ago: now - m.t } : null,
  };
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'mark-lag' || !tab) return;
  loaded
    .then(() => (settings.enabled ? addMark(tab.id, tab.url || '', 2, 'key', '') : { ok: false, reason: 'off' }))
    .then((r) => r.ok || flashBadge(tab.id, '×'));
});

// ---------------------------------------------------------------- 卡顿证据
// 各节点近 30 分钟里出过的问题：自动判定的卡顿、起播慢 / 没能起播、请求失败，以及手动标记（权重为程度 1~3，撤销时去掉）。
// 卡顿、起播、标记的权重按各节点的责任比例分（见 hostsDuring），主要责任节点拿满，其他的按比例少记。
// 每条 { t, h, p: 线路, w: 权重, why, ref: 标记 id, as }，存在 storage.local，页面经 bridge.js 读取，
// 线路优化的“自动”模式据此避开出过问题的节点（见 route.js troubleOf）。换了网络就清空（见 checkNetwork）。
// 点播同一台服务器的几个镜像名一起记（as 为出问题的那个名字，见 serverOf），「自动」不会在它们之间轮换。

// hang：换过去的镜像在起播阶段没等到响应头就超时（见 errWeight）
const TROUBLE_W = { stall: 1, slow: 1, fail: 2, err: 1, hang: 2 };

function addTrouble(hosts, w, why, ref) {
  const t = Date.now();
  const add = new Map(); // 线路|host → 这一次要记的，同一个节点只记最重的一条（同权重时记它自己的，不记同服务器带来的）
  for (const x of hosts || []) {
    const wx = Math.round(w * (x.w ?? 1) * 100) / 100;
    if (!x.h || !x.p || wx < 0.1) continue;
    for (const h of serverOf(x.p, x.h)) {
      const key = `${x.p}|${h}`;
      const prev = add.get(key);
      if (prev && (prev.w > wx || (prev.w === wx && !prev.as))) continue;
      add.set(key, { t, h, p: x.p, w: wx, why, ...(ref ? { ref } : {}), ...(h !== x.h ? { as: x.h } : {}) });
    }
  }
  trouble.push(...add.values());
  if (add.size) saveTrouble();
}

// 合并写入：一个节点挂掉时失败会一下子来很多条，每次写入都会让所有 B 站页面重新收一次设置
const saveTrouble = batched(500, () => {
  const now = Date.now();
  trouble = trouble.filter((x) => x.t > now - TROUBLE.keep).slice(-300);
  protoTrouble = protoTrouble.filter((x) => x.t > now - PROTO_TROUBLE.keep).slice(-200);
  chrome.storage.local.set({ trouble, protoTrouble }).catch(() => {});
});

// 直播协议的卡顿证据：HLS 在一种清晰度上跟不上，换个直播间、换个 host 一样跟不上，所以除了按节点记，
// 还按“协议 + 清晰度”记一份 { t, p: flv / hls, qn, w, why, ref }，保留 12 小时（见 route.js PROTO_TROUBLE）。
// 来源：直播的卡顿、手动标记（记在主要责任节点的协议上）和 HLS 下载占满（见 checkHlsLoad）。换了网络就清空
function addProtoTrouble(s, hosts, w, why, ref) {
  const main = (hosts || []).find((x) => x.p === 'flv' || x.p === 'hls');
  if (!main || !s || !s.asg || s.asg.kind !== 'live') return;
  protoTrouble.push({ t: Date.now(), p: main.p, qn: s.asg.qn ?? null, w, why, ...(ref ? { ref } : {}) });
  saveTrouble();
}

// ---------------------------------------------------------------- 消息

async function handle(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : undefined;
  // 来自页面里的内容脚本（不是 popup、统计页这些扩展自己的页面）
  const fromPage = !!sender.tab && !String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  switch (msg && msg.type) {
    case 'hello':
      if (settings.enabled) onHello(tabId, sender.frameId, msg);
      return null;
    case 'page':
      if (settings.enabled) onPage(tabId, sender.frameId, msg.href, msg.ev);
      return null;
    case 'tab': {
      // 仍在传输中的请求（如直播 FLV 长连接）在完成前不会进记录，单独列出
      const active = [...pending.values()]
        .filter((p) => p.tab === msg.tabId && p.th)
        .map((p) => ({ h: hostOf(p.url), k: p.kind, since: p.t0, ...(isPcdnUrl(p.url) ? { pc: 1 } : {}) }));
      // 测速地址带签名，popup 不需要
      const s = tabs[msg.tabId];
      const player = s ? await askPlayer(msg.tabId) : null;
      // probe：最近一轮测速测的正是这个标签页时才给（没测完的原因是这个页面的缓冲）
      const probe = probeState && probeState.tab === msg.tabId ? probeState : null;
      return { session: s ? { ...s, target: s.target ? { kind: s.target.kind, expired: targetExpired(s.target) } : null } : null, active, player, probe };
    }
    case 'probe': {
      if (!settings.enabled || !settings.probe) return { ok: false, reason: 'off' };
      const rank = await runProbe();
      return rank ? { ok: true, rank } : { ok: false, reason: 'idle' };
    }
    case 'mark': {
      if (!settings.enabled) return { ok: false, reason: 'off' };
      const lv = [1, 2, 3].includes(msg.lv) ? msg.lv : 2;
      const issue = msg.issue === 'sync' ? 'sync' : null;
      // 播放器上的标记按钮（player.js）：标签页取发送方，播放器状态随消息带来
      if (fromPage) return addMark(tabId, sender.tab.url || '', lv, 'page', '', cleanPs(msg.ps), issue);
      return addMark(msg.tabId, str(msg.url, 500), lv, 'popup', str(msg.note, 100).trim(), undefined, issue);
    }
    case 'unmark':
      return undoMark(fromPage ? tabId : msg.tabId);
    case 'status':
      // 只给页面里的标记按钮用：查的是发送方自己的标签页
      if (!fromPage) return null;
      if (!settings.enabled) return { ok: false, reason: 'off' };
      return playStatus(tabId, cleanPs(msg.ps));
    case 'flush':
      await Store.flush();
      await maybePrune();
      return true;
    case 'retention':
      // 统计页改了保留时长，或者确认了第一次删除（要删记录的，统计页先问过用户）
      if (fromPage || !Store.KEEP_DAYS.includes(msg.days)) return null;
      await chrome.storage.local.set({ retention: { days: msg.days, ok: true } });
      return { removed: await maybePrune(true) };
    case 'clear':
      await resetMeasurements(true);
      return true;
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  loaded
    .then(() => handle(msg, sender))
    .then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
