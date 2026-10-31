// SPDX-License-Identifier: AGPL-3.0-or-later
// 扩展页面共用的格式化与渲染小工具。
const Fmt = (() => {
  'use strict';

  const { UI_LANG, AUTO_ZH, L, isZh, setLang, pageLang, CLASS_LABELS, PAGE_LABELS, quantile } = globalThis.__bilicdn;
  // 页面的文案在加载时按这个语言生成，换语言要重新加载（见 followLang）
  const ZH = isZh();

  // 数字、时间的格式：中文按 zh-CN；英文按浏览器的英文地区（en-GB 日在前、en-US 月在前），别的语言的浏览器按 en-US
  function localeOf(lang) {
    if (ZH) return 'zh-CN';
    const tag = String(lang).replace(/_/g, '-');
    try {
      if (/^en(?:-|$)/i.test(tag) && Intl.NumberFormat.supportedLocalesOf(tag).length) return tag;
    } catch {}
    return 'en-US';
  }
  const LOCALE = localeOf(UI_LANG);

  /**
   * 页面里写死的文案换成英文（中文界面不动）：data-en 换文字，data-en-title / -placeholder / -aria-label 换对应的属性；
   * 长段落中英文各写一份，data-lang="zh" / "en"，留下当前语言的那份（英文那份默认 hidden）。
   * 带 data-en 的元素里只能有文字，有子元素的把文字单独包一层 span。
   */
  function localize(doc) {
    doc.documentElement.lang = ZH ? 'zh-CN' : 'en';
    for (const el of doc.querySelectorAll(`[data-lang="${ZH ? 'en' : 'zh'}"]`)) el.remove();
    if (ZH) return;
    for (const el of doc.querySelectorAll('[data-lang="en"]')) el.hidden = false;
    for (const el of doc.querySelectorAll('[data-en]')) el.textContent = el.dataset.en;
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      for (const el of doc.querySelectorAll(`[data-en-${attr}]`)) el.setAttribute(attr, el.getAttribute(`data-en-${attr}`));
    }
  }
  if (typeof document === 'object') localize(document);

  /**
   * 页面按 localStorage 里记的语言打开（见 cdn.js pageLang），算数的是设置里的 lang：读到的不一样（在另一个页面换过、
   * localStorage 被清了）就照设置换；之后设置里的语言变了（点了切换按钮，或者在另一个页面点的）也换。显示的语言变了就重新加载页面。
   * 记不进 localStorage 时不重新加载，不然加载完又是旧语言，一直重新加载
   */
  function followLang(settings) {
    const apply = (s) => {
      const pref = (s && s.lang) || 'auto';
      if (setLang(pref) && pageLang() === pref) location.reload();
    };
    apply(settings);
    chrome.storage.onChanged.addListener((changes, area) => area === 'local' && changes.settings && apply(changes.settings.newValue));
  }

  /**
   * 切换语言的按钮：中文界面显示「EN」，英文界面显示「中文」，点了换成另一种。按钮上写的是另一种语言自己的名字，
   * 说明两种语言都写（看不懂当前语言的人也要找得到），这两行英文里有中文是故意的（标了「不翻译」，i18n.test.js 不查）。
   * 换回浏览器本来的语言记成 auto（跟浏览器），以后浏览器换了语言照样跟着换。save 为写设置的函数（参数是要改的项）
   */
  function langButton(el, save) {
    el.textContent = L('EN', '中文'); // 不翻译
    el.lang = L('en', 'zh-CN');
    const label = L('切换到英文（Switch to English）', 'Switch to Chinese (切换到中文)'); // 不翻译
    el.title = label;
    el.setAttribute('aria-label', label);
    el.addEventListener('click', () => {
      const next = ZH ? 'en' : 'zh';
      return save({ lang: (next === 'zh') === AUTO_ZH ? 'auto' : next });
    });
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  const median = (arr) => quantile(arr, 0.5);

  const num = (v, digits = 0) => (v == null ? '–' : Number(v).toLocaleString(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: digits }));

  function bytes(b) {
    if (!b) return '–';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (b >= 1024 && i < units.length - 1) {
      b /= 1024;
      i += 1;
    }
    return `${b.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function ms(v) {
    if (v == null) return '–';
    return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
  }

  const time = (t) => (t ? new Date(t).toLocaleString(LOCALE, { hour12: false }) : '–');
  /** 只要时刻（如 14:05:09），窄空间里用；没有时间时为空。 */
  const timeOfDay = (t) => (t ? new Date(t).toLocaleTimeString(LOCALE, { hour12: false }) : '');

  const chip = (cls) => `<span class="chip" data-cls="${esc(cls)}">${esc(CLASS_LABELS[cls] || cls)}</span>`;
  const dot = (cls) => `<span class="dot" data-cls="${esc(cls)}" title="${esc(CLASS_LABELS[cls] || cls)}"></span>`;
  /**
   * 只有一部分请求是 PCDN 的节点（带 os=mcdn 参数，见 cdn.js nodeClass）：类型后面另加一个「PCDN 几/几」的标签，
   * line 为 true 时另起一行（popup 的表格窄，标签放不下）。全是（已经归为 PCDN）或全不是时为空。
   * cls 为 nodeClass 的结果，pcdn / n 为 PCDN 请求数 / 请求数
   */
  function pcdnPart(cls, pcdn, n, line = false) {
    if (cls === 'pcdn' || !(pcdn > 0)) return '';
    const title = esc(L(`${n} 个里 ${pcdn} 个带 os=mcdn 参数，按 PCDN 算`, `${pcdn} of ${n} carry os=mcdn, counted as PCDN`));
    const text = `PCDN ${esc(pcdn)}/${esc(n)}`;
    return line ? `<div class="sub warn-text" title="${title}">${L('含', 'incl.')} ${text}</div>` : ` <span class="chip" data-cls="pcdn" title="${title}">${text}</span>`;
  }

  /** 窄空间里显示的 host：去掉公共后缀，完整 host 放在 title 里。 */
  const shortHost = (h) => String(h).replace(/\.bilivideo\.(com|cn)/, '').replace(/\.akamaized\.net$/, '.akamai');
  // www.bilibili.com/video/BVxx → /video/BVxx；live.bilibili.com/123 → live/123
  const shortPath = (p) => String(p).replace(/^www\.bilibili\.com/, '').replace(/^live\.bilibili\.com/, 'live');
  const page = (p) => PAGE_LABELS[p] || p || '–';
  const LEVELS = { 1: L('少量卡顿', 'Few stalls'), 2: L('较多卡顿', 'Many stalls'), 3: L('无法播放', "Won't play") };
  const level = (lv) => LEVELS[lv] || '–';
  const problem = (lv, issue) => issue === 'sync' ? L('音画不同步', 'A/V out of sync') : level(lv);

  const net = (n) => (n ? [n.country, n.province, n.city].filter(Boolean).join(' ') + (n.isp ? ` / ${n.isp}` : '') : L('未知', 'Unknown'));

  /** 播放位置 / 时长：秒 → 1:05、1:02:03。 */
  function clock(sec) {
    if (sec == null) return '–';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
    return `${h ? `${h}:` : ''}${m}:${String(s % 60).padStart(2, '0')}`;
  }

  // 手动标记时按播放器状态判断的原因（见 analyze.js markCause）
  const CAUSES = { net: L('缓冲不足', 'Low buffer'), drop: L('掉帧', 'Dropped frames'), ok: L('缓冲充足', 'Buffer OK') };
  const cause = (c) => CAUSES[c] || '–';

  /** 点播的卡顿点链接：B 站地址加 t=秒 会从那里开始放。直播没有。 */
  function seekUrl(path, ps) {
    if (!ps || ps.dur == null) return `https://${path}`;
    return `https://${path}${path.includes('?') ? '&' : '?'}t=${Math.floor(ps.pos)}`;
  }

  // 线路改写的原因
  const WHYS = {
    set: L('按设置', 'per settings'),
    known: L('按本网络以往测速', "per this network's past speed tests"),
    probe: L('按测速', 'per speed test'),
    pcdn: L('避开 PCDN', 'avoiding PCDN'),
    trouble: L('避开卡顿节点', 'avoiding stalling node'),
  };
  const why = (w) => WHYS[w] || '';
  // 只排了备用地址的改写（route 记录的 bk，见 route.js rewriteVod）
  const BACKUP_ONLY = L('主地址不变，调整备用顺序', 'main URL kept, backups reordered');

  // 直播清晰度（current_qn）
  const QN = { 30000: L('杜比', 'Dolby'), 20000: '4K', 10000: L('原画', 'Source'), 400: L('蓝光', 'Blu-ray'), 250: L('超清', 'Super HD'), 150: L('高清', 'HD'), 80: L('流畅', 'Smooth') };
  const qn = (v) => QN[v] || `qn ${v}`;

  return { ZH, L, LOCALE, followLang, langButton, esc, median, quantile, num, bytes, ms, time, timeOfDay, chip, dot, pcdnPart, shortHost, shortPath, page, level, problem, net, clock, cause, seekUrl, why, BACKUP_ONLY, qn };
})();
