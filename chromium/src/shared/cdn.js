// SPDX-License-Identifier: GPL-3.0-or-later
// 共享工具：host 分类、媒体请求识别、页面类型。
// 经典脚本，MAIN world、service worker（importScripts）、扩展页面和 Node 测试共用。
(function (root) {
  'use strict';

  // 界面语言：设置里的 lang（见 DEFAULT_SETTINGS），auto 跟浏览器，zh / en 是在 popup、统计页上点切换按钮选的。
  // 跟浏览器时：浏览器界面是中文（zh、zh-CN、zh-TW 等）显示中文，其他语言都显示英文。
  // 扩展页面、SW 按 chrome.i18n.getUILanguage()，和 manifest 里 __MSG_ 文案（_locales）用的是同一个语言；
  // MAIN world 没有 chrome.i18n，那里也不显示文字，按 navigator.language；Node 测试两样都没有（Node 有 navigator 没有 document），按中文
  function uiLang() {
    try {
      if (root.chrome && root.chrome.i18n && typeof root.chrome.i18n.getUILanguage === 'function') return root.chrome.i18n.getUILanguage() || '';
    } catch {}
    return root.document && root.navigator ? root.navigator.language || '' : 'zh-CN';
  }
  const UI_LANG = uiLang();
  const AUTO_ZH = /^zh(?:[-_]|$)/i.test(UI_LANG);
  const zhOf = (pref) => (pref === 'zh' ? true : pref === 'en' ? false : AUTO_ZH);

  // 扩展页面（popup、统计页）的文案在脚本加载时就定了，等不及异步读设置：选的语言另记一份在扩展页面自己的 localStorage 里，
  // 加载时同步读（读不到按跟浏览器）。只在有 chrome.i18n 又有 document 的地方用：MAIN world 的 localStorage 是 B 站的，SW 没有
  const LANG_KEY = 'bilicdn:lang';
  const pageStore = () => (root.chrome && root.chrome.i18n && root.document ? root.localStorage : null);
  function pageLang() {
    try {
      const store = pageStore();
      return (store && store.getItem(LANG_KEY)) || 'auto';
    } catch {
      return 'auto';
    }
  }
  let zh = zhOf(pageLang());

  /** 按界面语言二选一：L('统计', 'Stats')。中英文写在一起，改了一边顺手改另一边。 */
  const L = (zhText, enText) => (zh ? zhText : enText);
  const isZh = () => zh;
  /**
   * 换成设置里的语言 pref（auto / zh / en），返回显示的语言变了没有。扩展页面顺带记进 localStorage，下次打开直接用；
   * 已经按旧语言生成的文案不会跟着变，扩展页面变了就重新加载（见 ui/format.js followLang），SW 里的文案都是用到时才取
   */
  function setLang(pref) {
    const next = zhOf(pref);
    try {
      const store = pageStore();
      if (store) store.setItem(LANG_KEY, pref || 'auto');
    } catch {}
    const changed = next !== zh;
    zh = next;
    return changed;
  }

  // 用到时才按当前语言取（SW 里换了语言，播放器按钮上的节点类型跟着变）
  const CLASS_LABELS = {
    pcdn: 'PCDN/MCDN',
    akamai: 'Akamai',
    get 'upos-ov'() { return L('UPOS 海外', 'UPOS overseas'); },
    get upos() { return L('UPOS 镜像', 'UPOS mirror'); },
    get 'live-ov'() { return L('直播海外', 'Live overseas'); },
    get 'live-3rd'() { return L('直播第三方', 'Live 3rd-party'); },
    get edge() { return L('自建边缘', 'Bilibili edge'); },
    get other() { return L('其他', 'Other'); },
  };

  function parseUrl(url) {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }

  function hostOf(url) {
    const u = parseUrl(url);
    return u ? u.host : '';
  }

  function osOf(url) {
    const u = parseUrl(url);
    return (u && u.searchParams.get('os')) || '';
  }

  /** 是不是 B 站的页面（bilibili.com 及其子域名）。 */
  function isBiliUrl(href) {
    const u = parseUrl(href);
    return !!u && (u.hostname === 'bilibili.com' || u.hostname.endsWith('.bilibili.com'));
  }

  // 去掉端口、转小写的 host
  const bareHost = (host) => String(host).toLowerCase().replace(/:\d+$/, '');

  // PCDN / MCDN（B 站租用的家庭宽带、P2P 等节点）。识别规则参考 stabruriss/bilibili-accelerator：
  // mcdn 子域、P2P 域名、xy 开头的 IP 式 host、带端口的 host、IP 直连，以及 302 跳转到 PCDN 的 upos-*302* 节点
  const PCDN_SUFFIXES = ['.mcdn.bilivideo.cn', '.mcdn.bilivideo.com', '.szbdyd.com', '.mountaintoys.cn', '.nexusedgeio.com', '.ahdohpiechei.com'];

  function isPcdnHost(host) {
    const raw = String(host).toLowerCase();
    const h = raw.replace(/:\d+$/, '');
    if (h !== raw || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
    if (PCDN_SUFFIXES.some((s) => h.endsWith(s))) return true;
    const first = h.split('.')[0];
    return first.startsWith('upos-') && first.includes('302');
  }

  // 地址里的这个 os 参数说明指向 PCDN（host 看不出来时）
  const PCDN_OS = 'mcdn';

  /** 地址是否指向 PCDN：host 符合上面的规则，或者带 os=mcdn 参数。 */
  function isPcdnUrl(url) {
    const u = parseUrl(url);
    return !!u && (isPcdnHost(u.host) || u.searchParams.get('os') === PCDN_OS);
  }

  /**
   * 一条请求记录是不是走的 PCDN，口径同选线（见 isPcdnUrl）：host 符合规则，或者带 os=mcdn。
   * 按每条请求判断：同一个 host 上带不带 os=mcdn 的请求分开算，不把整个 host 归为 PCDN。
   * req 记录存了 os（h 为 host）；没有 os 的（旧记录、直播长连接结束的 reqend）只按 host 判断。
   */
  const isPcdnReq = (r) => !!r && (isPcdnHost(r.h || '') || r.os === PCDN_OS);

  /**
   * 节点按请求算的类型（统计页的节点表、时间轴，popup 的正在用的节点、实际请求、分配）：pcdn / n 为它的 PCDN 请求数 / 请求数（见 isPcdnReq）。
   * host 本身是 PCDN，或者请求全都是 PCDN 的，算 PCDN；只有一部分是的仍按 host 归类，另外注明几个是（见 format.js pcdnPart）。
   */
  function nodeClass(host, pcdn = 0, n = 0) {
    const cls = classifyHost(host);
    return cls !== 'pcdn' && n > 0 && pcdn >= n ? 'pcdn' : cls;
  }

  /** 把 host 归到一类 CDN，分类只用于展示和统计。 */
  function classifyHost(host) {
    if (isPcdnHost(host)) return 'pcdn';
    const h = bareHost(host);
    if (h.endsWith('.akamaized.net')) return 'akamai';
    if (/^upos-[^.]*ov\./.test(h)) return 'upos-ov';
    if (h.startsWith('upos-')) return 'upos';
    if (/(^|[.-])ov-gotcha/.test(h)) return 'live-ov';
    if (h.includes('gotcha')) return 'live-3rd';
    if (/^cn-[a-z0-9]+-[a-z]+-/.test(h)) return 'edge';
    return 'other';
  }

  // B 站媒体 CDN 的域名。SW 的 webRequest 过滤和测速请求头规则都用这份列表，
  // manifest 的 host_permissions 写不了引用，由测试核对两边一致（见 shared.test.js）
  const CDN_DOMAINS = Object.freeze(['bilivideo.com', 'bilivideo.cn', 'akamaized.net', 'szbdyd.com']);

  /** 只有 B 站的媒体 CDN 才纳入统计（日志、上报等同域请求会被排除）。Akamai 上只认 upos- 开头的。 */
  function isCdnHost(host) {
    const h = bareHost(host);
    if (h.endsWith('.akamaized.net')) return h.startsWith('upos-');
    return CDN_DOMAINS.some((d) => h.endsWith(`.${d}`));
  }

  const MEDIA_EXT = /\.(m4s|flv|m3u8|ts|mp4|m4a)$/i;

  /** 媒体请求类型，如 vod-m4s / live-m3u8；非媒体请求返回 null。 */
  function mediaKind(url) {
    const u = parseUrl(url);
    if (!u || !isCdnHost(u.host)) return null;
    const m = MEDIA_EXT.exec(u.pathname);
    if (!m) return null;
    return (u.pathname.startsWith('/live-') ? 'live-' : 'vod-') + m[1].toLowerCase();
  }

  /** 媒体请求类型对应的线路：点播 vod、直播 FLV flv、直播 HLS（m3u8 / m4s / ts）hls。 */
  function lineOf(kind) {
    if (!kind) return null;
    if (kind === 'live-flv') return 'flv';
    return kind.startsWith('live-') ? 'hls' : 'vod';
  }

  /** 点播分片文件名末尾的轨道号，如 xxx-1-30080.m4s → 30080。 */
  function trackOf(url) {
    const u = parseUrl(url);
    const m = u && /-(\d+)\.m4s$/.exec(u.pathname);
    return m ? Number(m[1]) : null;
  }

  function pageType(href) {
    const u = parseUrl(href);
    if (!u) return 'other';
    if (u.hostname === 'live.bilibili.com') return 'live';
    if (u.hostname === 'player.bilibili.com') return 'embed';
    const p = u.pathname;
    if (p.startsWith('/video/')) return 'video';
    if (p.startsWith('/bangumi/')) return 'pgc';
    if (p.startsWith('/cheese/')) return 'cheese';
    if (p.startsWith('/list/') || p.startsWith('/medialist/')) return 'list';
    if (p.startsWith('/festival/')) return 'festival';
    if (u.hostname === 'www.bilibili.com' && p === '/') return 'home';
    return 'other';
  }

  /**
   * 页面标识：host + 路径（去掉末尾斜杠）+ 决定播放内容的参数（bvid、分 P）。
   * 站内切换视频只改地址栏、不重新加载页面，靠它判断是否换了页面；spm_id_from 等来源参数的变化不算。
   */
  function pageKey(href) {
    const u = parseUrl(href);
    if (!u) return '';
    const q = [];
    const bvid = u.searchParams.get('bvid');
    const p = u.searchParams.get('p');
    if (bvid) q.push(`bvid=${bvid}`);
    if (p && p !== '1') q.push(`p=${p}`);
    return u.host + (u.pathname.replace(/\/+$/, '') || '/') + (q.length ? `?${q.join('&')}` : '');
  }

  /**
   * 地址里的视频标识（BV 号、av 号、ep 号），页面地址和播放接口地址都适用，
   * 用来把切换前拿到的播放地址对应到切换后的页面。
   */
  function videoIds(href) {
    const u = parseUrl(href);
    if (!u) return [];
    const q = u.searchParams;
    const ids = [q.get('bvid'), q.get('avid') && `av${q.get('avid')}`, q.get('ep_id') && `ep${q.get('ep_id')}`];
    const m = /\/(BV[0-9A-Za-z]{10}|av\d+|ep\d+)(\/|$)/.exec(u.pathname);
    if (m) ids.push(m[1]);
    return [...new Set(ids.filter(Boolean))];
  }

  /** 分位数（线性插值），只算数值，没有数值时为 null。q = 0.5 即中位数。 */
  function quantile(arr, q) {
    const a = arr.filter((v) => typeof v === 'number').sort((x, y) => x - y);
    if (!a.length) return null;
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  /**
   * 请求是不是浏览器缓存直接答复的、没去问节点：带 fc，响应头 CACHE_TT_MS 以内就到。这种请求的首字节和速率不是节点的，不算。
   * fc（webRequest 的 fromCache）只说明 Chrome 缓存里有这个文件，不说明数据来自缓存：B 站同一个文件的各段地址相同、只是 Range 不同，
   * 播放器取后面的段时 Chrome 带 If-Range 去节点取，节点回 206、数据走网络；再取已经缓存的段时带 If-Modified-Since 去问，
   * 节点回 304、数据从缓存读。两种都标成 fromCache，都等了节点一个来回。缓存还新鲜（较早上传的视频）时才不问节点，
   * 响应头几毫秒就到；缓存里只有这一段的开头时，响应头也是几毫秒就到，后面从网络取，首字节和速率一样不准。
   * 实测 2026-10-21（Edge 播 3 个视频，245 个带 fc 的请求）：正文走网络的 147 个、304 的 91 个，首字节都约 520 ms（496~988 ms），
   * 是到节点的一个来回；没问节点的 7 个 1~3 ms。两份导出里带 fc、不到 10 ms 的 545 / 60 个，Akamai 走网络最快 15 ms。
   * 0.6.27 以前带 fc 的一律不算，只用了约 5% 的请求
   */
  const CACHE_TT_MS = 10;
  const cacheHit = (rec) => !!rec.fc && rec.tt != null && rec.tt < CACHE_TT_MS;

  /**
   * 请求记录的下载吞吐（Mbps），按响应头到达之后的传输时间计算。
   * 小响应（如约 130KB 的直播分片）常常与响应头几乎同时到齐，算出的吞吐毫无意义，
   * 所以要求至少 512KB 且传输至少 50ms；浏览器缓存直接答复的（见 cacheHit）也不计。
   * 节点回 304、正文从缓存读的，传输只有几毫秒，被 50ms 挡掉。
   */
  function mbpsOf(rec) {
    if (!rec || cacheHit(rec) || !(rec.b >= 512 * 1024) || rec.tt == null || !(rec.d - rec.tt >= 50)) return null;
    return Math.round((rec.b * 8) / (rec.d - rec.tt) / 10) / 100;
  }

  /**
   * 播放器等太久后自己中止的请求（超时）。实测集中在 2 秒整（多半连响应头都没等到，换镜像后常见）、5 秒、10 秒整；
   * 拖动、切清晰度、换视频时的主动中止通常不到 1 秒；直播 FLV 长连接关页面时也是 ERR_ABORTED，不算。
   */
  const TIMEOUT_MS = 1900;
  function isTimeout(rec) {
    return rec.e === 'net::ERR_ABORTED' && rec.k !== 'live-flv' && rec.d >= TIMEOUT_MS;
  }

  /**
   * 超时中止时连响应头都没等到（tt 为空）：多半是换过去的镜像 2 秒内没回应。实测集中在冷内容（新视频的首段、没人看过的片段），
   * 中国晚高峰时镜像回源要经过好几层父缓存，首字节常常超过 2 秒，播放器就改从备用地址取。
   */
  const isHang = (rec) => isTimeout(rec) && rec.tt == null;

  /** 是否算作 CDN 失败。ERR_ABORTED 一般是播放器主动中止，不算，但超时中止算。 */
  function isFailure(rec) {
    return (!!rec.e && rec.e !== 'net::ERR_ABORTED') || rec.st >= 400 || isTimeout(rec);
  }

  // 网络位置：B 站识别的国家 / 地区 / 城市 / ISP。B 站有时会漏返回某些字段（实测 ISP 时有时无），
  // 空字段沿用上一次的值，不算网络变化。国家变了的不沿用（上一次的地区、城市、ISP 都不再适用），地区变了的不沿用城市
  const NET_FIELDS = ['country', 'province', 'city', 'isp'];
  function mergeNet(prev, cur) {
    const out = { ...cur };
    if (!prev) return out;
    const same = (k) => !out[k] || out[k] === prev[k];
    for (const k of NET_FIELDS) {
      if (out[k] || (k !== 'country' && !same('country')) || (k === 'city' && !same('province'))) continue;
      out[k] = prev[k] || '';
    }
    return out;
  }

  /** 位置有没有变（含城市）：变了就更新显示、记一条 net 记录。影响选线的变化见 netMoved。 */
  const netChanged = (prev, cur) => !prev || NET_FIELDS.some((k) => (prev[k] || '') !== (cur[k] || ''));

  // 影响选线的字段，和网络档案的键（见 netKey）一致
  const ROUTE_FIELDS = ['country', 'province', 'isp'];

  /**
   * 换了网络（影响选线）：国家、地区或 ISP 变了，之前的测速排名和卡顿证据不再适用（见 sw.js checkNetwork）。
   * 只变了城市不算：同一条宽带换了 IP，B 站识别的城市常常跟着变，0.6.18 以前这样也会清空排名和卡顿证据。
   * 上一次不知道的字段（B 站漏返回）这次知道了也不算。第一次查到网络时没有可比的，不算。
   */
  const netMoved = (prev, cur) => !!prev && ROUTE_FIELDS.some((k) => !!prev[k] && prev[k] !== (cur[k] || ''));

  /**
   * 网络档案的键（见 probe.js 网络档案）：国家 + 地区 + ISP。城市不算：同一条宽带换了 IP，B 站识别的城市常常跟着变。
   * 不知道 ISP（B 站漏返回）时为空，不记档案。
   */
  const netKey = (n) => (n && n.country && n.isp ? [n.country, n.province || '', n.isp].join('|') : '');

  // 扩展设置的默认值，存储里缺的项按它补（SW 和 popup 共用；bridge.js、player.js 不依赖共享脚本，按同样的默认值判断）。
  // enabled：总开关，关掉就暂停整个扩展（见 sw.js pause）；route：线路优化（改写播放地址）；
  // vodHost / liveProto：点播节点 / 直播线路，auto 为按测速自动选；probe：每 30 秒测速；markButton：播放器控制栏上的标记按钮（见 player.js）；
  // lang：界面语言，auto 跟浏览器，zh / en 固定（见上文 setLang）
  const DEFAULT_SETTINGS = Object.freeze({ enabled: true, route: false, vodHost: 'auto', liveProto: 'auto', probe: false, markButton: true, lang: 'auto' });

  const PAGE_LABELS = {
    get video() { return L('视频', 'Video'); },
    get pgc() { return L('番剧/影视', 'Anime/Movies'); },
    get cheese() { return L('课程', 'Course'); },
    get list() { return L('播放列表', 'Playlist'); },
    get festival() { return L('活动页', 'Event page'); },
    get live() { return L('直播', 'Live'); },
    get embed() { return L('嵌入播放器', 'Embedded player'); },
    get home() { return L('首页', 'Home'); },
    get other() { return L('其他', 'Other'); },
  };

  const api = { UI_LANG, AUTO_ZH, L, isZh, setLang, pageLang, CLASS_LABELS, PAGE_LABELS, CDN_DOMAINS, DEFAULT_SETTINGS, hostOf, osOf, isBiliUrl, isPcdnHost, isPcdnUrl, isPcdnReq, nodeClass, classifyHost, isCdnHost, mediaKind, lineOf, trackOf, pageType, pageKey, videoIds, quantile, cacheHit, mbpsOf, isTimeout, isHang, isFailure, mergeNet, netChanged, netMoved, netKey };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__bilicdn = Object.assign(root.__bilicdn || {}, api);
})(globalThis);
