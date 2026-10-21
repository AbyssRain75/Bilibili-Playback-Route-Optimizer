// SPDX-License-Identifier: AGPL-3.0-or-later
// 统计页的导出：按范围选记录、组装导出文件，以及「普通导出」的脱敏。经典脚本，扩展页面和 Node 测试共用。
//
// 脱敏的范围是用户定的（2026-10-21）：导出多半是贴到 issue 里分析问题的，分析节点要用的都留着——
// CDN / PCDN 的 host 和 IP、B 站识别的国家和 ISP 原样保留；出过问题的会话（有没撤销的手动标记，或者自动识别出卡顿、
// 起播慢、没能起播，见 analyze.js incidentOf）也原样保留，包括页面地址、视频标识和标记备注，分析时要对得上是哪个视频。
// 换掉的只有：其他会话的页面地址（ses / mark / asg 的 path）和视频标识（asg / route / hold 的 vid），网络位置的地区和城市，
// 以及这些会话里的标记备注（没撤销的标记本身就算出了问题，所以只可能是撤销了的）。
// 换成编号而不是删掉：同一个值换成同一个编号（跨会话，records 和 context 之间也一样），「是不是同一个视频」
// 「只变了城市还是换了网络」（见 cdn.js netChanged / netMoved / netKey）在脱敏后照样看得出来。
(function (root) {
  'use strict';

  const node = typeof module === 'object' && module.exports;
  const { incidentOf, selectPeriod } = node ? require('./analyze.js') : root.__bilicdn;

  // 导出格式的版本。privacy（0.6.24）是新加的一项，原有各项的含义没变，版本不变
  const FORMAT_VERSION = 1;

  /**
   * 页面地址拆成 host、编号用的键和分 P 号。ses / mark 的 path 是 cdn.js pageKey（host + 路径 + bvid / p），
   * asg 的 path 是 location.pathname（没有 host，可能带末尾斜杠）：键都取路径（去掉末尾斜杠）加 bvid，同一个页面的键相同。
   */
  function splitPage(path) {
    const s = String(path);
    const at = s.indexOf('/');
    const host = at < 0 ? s : s.slice(0, at);
    const rest = at < 0 ? '/' : s.slice(at);
    const qi = rest.indexOf('?');
    const q = new URLSearchParams(qi < 0 ? '' : rest.slice(qi + 1));
    const bvid = q.get('bvid');
    const key = ((qi < 0 ? rest : rest.slice(0, qi)).replace(/\/+$/, '') || '/') + (bvid ? `?bvid=${bvid}` : '');
    return { host, key, part: q.get('p') };
  }

  /** 同一个值给同一个编号，按第一次出现的顺序从 1 起。 */
  function numbering(prefix) {
    const seen = new Map();
    return (v) => {
      if (!seen.has(v)) seen.set(v, `${prefix}${seen.size + 1}`);
      return seen.get(v);
    };
  }

  /**
   * 普通导出的脱敏，返回新的 { records, context }，不改原记录。
   * records 为导出范围里的记录，context 为范围之前开始的会话的 ses / asg（见 analyze.js selectPeriod），两边用同一套编号。
   */
  function redactRecords(records, context = []) {
    const all = [...context, ...records];
    const unmarked = new Set(all.filter((r) => r.ty === 'unmark').map((r) => r.ref));
    const marked = (r) => r.ty === 'mark' && !unmarked.has(r.id);
    const bad = new Set(all.filter((r) => r.sid && (marked(r) || incidentOf(r))).map((r) => r.sid));
    // 没挂在会话上的标记（标记时没有会话）按它自己算
    const kept = (r) => marked(r) || (!!r.sid && bad.has(r.sid));
    // 出过问题的页面和视频按值保留：同一个视频在别的会话里也不换，免得一处是原值、一处是编号。
    // 预加载、卡片预览的分配和改写（pre）是别的视频，不算；carry 是站内切换后补记的当前视频，算
    const keepPage = new Set();
    const keepVid = new Set();
    for (const r of all) {
      if (!kept(r)) continue;
      if (r.path) keepPage.add(splitPage(r.path).key);
      if (r.vid && (!r.pre || r.carry)) keepVid.add(r.vid);
    }
    const page = numbering('page-');
    const vid = numbering('v-');
    const province = numbering('地区');
    const city = numbering('城市');
    const one = (r) => {
      const out = { ...r };
      if (typeof r.path === 'string' && r.path) {
        const p = splitPage(r.path);
        // 分 P 号不是个人信息，留着能分出同一个视频的不同分 P
        if (!keepPage.has(p.key)) out.path = `${p.host}/${page(p.key)}${p.part ? `?p=${p.part}` : ''}`;
      }
      if (r.vid && !keepVid.has(r.vid)) out.vid = vid(r.vid);
      if (r.ty === 'mark' && r.note && !kept(r)) delete out.note;
      if (r.ty === 'net') {
        if (r.province) out.province = province(r.province);
        if (r.city) out.city = city(r.city);
      }
      return out;
    };
    const ctx = context.map(one);
    return { records: records.map(one), context: ctx };
  }

  /**
   * 组装导出文件。all：Store.readAll() 的 { meta, records }；period：day / week / all（见 analyze.js selectPeriod）；
   * full：完整信息导出（原样），否则脱敏（见 redactRecords）。返回 { name: 文件名, payload }，两处都标明是哪一种。
   */
  function buildExport(all, { period = 'all', full = false, now = Date.now(), extVersion = '' } = {}) {
    const sel = selectPeriod(all.records, period, now);
    let since = Infinity;
    let last = 0;
    for (const r of sel.records) {
      if (r.t < since) since = r.t;
      if (r.t > last) last = r.t;
    }
    const meta = sel.period === 'all' ? all.meta : sel.records.length ? { v: all.meta?.v || 1, count: sel.records.length, since, last } : null;
    const privacy = full ? 'full' : 'redacted';
    const data = full ? sel : redactRecords(sel.records, sel.context);
    // version 是导出格式的版本；extVersion 是导出时的扩展版本，各段记录由哪个版本记下看 ses 的 ver（旧记录没有）
    const payload = { format: 'bilicdn-records', version: FORMAT_VERSION, privacy, extVersion, exportedAt: new Date(now).toISOString(), period: sel.period, from: sel.from, to: sel.to, meta, records: data.records, context: data.context };
    const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return { name: `bpro-${sel.period}-${privacy}-${stamp}.json`, payload };
  }

  const api = { splitPage, redactRecords, buildExport };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__bilicdn = Object.assign(root.__bilicdn || {}, api);
})(globalThis);
