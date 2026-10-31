// SPDX-License-Identifier: AGPL-3.0-or-later
// 节点分布（统计页「节点分布」）：按网络汇总 B 站在这个网络分配了哪些节点、实际请求走了哪些、各节点连到哪台服务器（网段）、
// 表现怎样，再归纳出几条结论。不同地方访问 B 站，分到的节点和各节点的快慢完全不同：2026-10-29 同一个视频在三个地区实测，
// 一处 B 站把 cosov 当主节点，它连到当地的节点，八百多 Mbps；一处把 Akamai 当主节点，Akamai 只有 21 Mbps，备用的 cosov 一千多；
// 还有一处 cosov 14 Mbps，国内镜像 0.5~6 Mbps。同一个名字在不同地方连到的服务器也不同（见 docs/node-distribution-2026-10-29.md）。
// 所以按网络（cdn.js netKey：国家 + 地区 + ISP）分开算，一个网络的结论不套到另一个网络上。
// 经典脚本，统计页和 Node 测试共用；浏览器里要在 cdn.js、route.js、probe.js、analyze.js 之后加载。
(function (root) {
  'use strict';

  const node = typeof module === 'object' && module.exports;
  const cdn = node ? require('./cdn.js') : root.__bilicdn;
  // 浏览器里这几个也挂在同一个共享对象上
  const route = node ? require('./route.js') : cdn;
  const probe = node ? require('./probe.js') : cdn;
  const an = node ? require('./analyze.js') : cdn;
  const { quantile } = cdn;

  // 结论的门槛：PCDN 请求占到 5% 以上才提，20% 以上算多；一个节点测速不到 3 次（换过去的节点不算探查的）时结论标成初步；
  // 卡顿时是主要责任节点 3 次以上才点名。值不值得换和「自动」用同样的依据（见 route.js pickVod）：主节点在页面上表现好（route.js perfGood）就不说换，
  // 页面上用过、比主节点差的（route.js perfWorse）不算更快；比主节点快多少才算值得换，同 route.js SWITCH_MARGIN。
  // 实测有一处测速得出「08ct 比 cosov 快 25%」，cosov 播放时首字节却只有 16 ms（见 docs/field-playback-2026-10-29.md）
  const MAP = { pcdn: 0.05, pcdnMany: 0.2, few: 3, stalls: 3 };

  // 按网络归属的记录：分配、请求、测速，以及卡顿、起播、标记（算到当时在用的节点上），扩展看不到的流量（src），按设置关了 B 站 P2P 的会话（p2poff）
  const WANT = new Set(['asg', 'req', 'reqend', 'probe', 'stall', 'start', 'mark', 'src', 'p2poff']);

  /**
   * 同一台服务器：连到过同一网段（见 probe.js netOf）的 host 归为一组，可以传递（同 probe.js sameServer，这里按整个统计范围算）。
   * 给 hosts 里各节点标上组号 group（从 1 起，只有一个名字的不标），返回两个名字以上的组 [{ hosts, subnets }]，名字多的在前。
   */
  function serverGroups(hosts) {
    const parent = hosts.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const owner = new Map(); // 网段 → 第一个连到它的节点
    hosts.forEach((x, i) => {
      for (const s of x.subnets) {
        if (owner.has(s)) parent[find(i)] = find(owner.get(s));
        else owner.set(s, i);
      }
    });
    const by = new Map();
    hosts.forEach((x, i) => {
      if (!x.subnets.length) return;
      const r = find(i);
      if (!by.has(r)) by.set(r, []);
      by.get(r).push(x);
    });
    const groups = [...by.values()]
      .filter((g) => g.length > 1)
      .map((g) => ({ members: g, hosts: g.map((x) => x.host).sort(), subnets: [...new Set(g.flatMap((x) => x.subnets))].sort() }))
      .sort((a, b) => b.hosts.length - a.hosts.length || a.hosts[0].localeCompare(b.hosts[0]));
    return groups.map(({ members, ...g }, i) => {
      for (const x of members) x.group = i + 1;
      return g;
    });
  }

  /** 一个网络的汇总和结论（见 nodeMap）。 */
  function summarize(e, book, now) {
    const hosts = [...e.hosts.values()].map((x) => ({
      host: x.host,
      // 请求全是 PCDN 的归为 PCDN，只有一部分是的按 host 归类（见 cdn.js nodeClass）
      cls: cdn.nodeClass(x.host, x.pcdn, x.n),
      vod: x.vod,
      pcdn: x.pcdn,
      base: x.base,
      vbase: x.vbase,
      backup: x.backup,
      n: x.n,
      err: x.err,
      timeouts: x.to,
      errRate: x.n ? x.err / x.n : null,
      ttfbP50: quantile(x.tt, 0.5),
      mbpsP50: quantile(x.mb, 0.5),
      mbpsSamples: x.mb.length,
      bytes: x.b,
      probeN: x.pr.n,
      probeOk: x.pr.ok,
      probeScore: quantile(x.pr.sc, 0.5),
      probeTt: quantile(x.pr.tt, 0.5),
      surveyed: x.pr.sv,
      // 页面上的表现，口径同「自动」（见 route.js perfEntry / perfOf），统计范围内的请求都算
      page: route.perfOf({ [x.host]: x.pf }, now, Infinity)[x.host] || null,
      auto: x.auto,
      marked: x.marked,
      subnets: [...x.subnets].sort(),
      group: null,
      builtin: probe.UPOS_MIRRORS.includes(x.host),
    }));
    // 测速快的在前，没测过的按请求数
    hosts.sort((a, b) => (b.probeScore ?? -1) - (a.probeScore ?? -1) || b.n - a.n || b.base - a.base);
    const groups = serverGroups(hosts);
    const classes = [...e.cls.values()].sort((a, b) => b.base - a.base || b.req - a.req);
    const sum = (k) => classes.reduce((s, c) => s + c[k], 0);
    const reqTotal = sum('req');
    const pcdnReq = (e.cls.get('pcdn') || { req: 0 }).req;
    const pcdnShare = reqTotal ? pcdnReq / reqTotal : null;
    const src = an.srcSummary(e.src);

    // 点播才比主节点和最快的节点：直播 FLV 的得分只是吞吐，受码率限制，和 HLS、点播没法比；直播又不能换 host（见 route.js）。
    // 主节点：点播分配里当主地址次数最多的（同样多时取请求多的）
    const main = hosts.filter((x) => x.vbase > 0).reduce((a, x) => (!a || x.vbase > a.vbase || (x.vbase === a.vbase && x.n > a.n) ? x : a), null);
    const fastest = (xs) => xs.filter((x) => x.vod && x.probeOk > 0 && x.cls !== 'pcdn').reduce((a, x) => (!a || x.probeScore > a.probeScore ? x : a), null);
    const best = fastest(hosts);

    const findings = [];
    const baseTotal = sum('base');
    if (baseTotal) {
      const top = classes[0];
      findings.push({ code: 'assign', lv: 'info', cls: top.cls, share: top.base / baseTotal, host: main ? main.host : null, hostShare: main && e.vodAsg ? main.vbase / e.vodAsg : null });
    }
    if (main && route.perfGood(main.page)) {
      // 主节点在页面上表现好：测速再高也不说换（测速取的是冷数据，见 route.js PERF）
      const higher = best && best.host !== main.host && best.probeScore > (main.probeScore || 0);
      findings.push({ code: 'mainPage', lv: 'good', host: main.host, tt: main.page.tt, n: main.page.n, sc: main.probeScore, ...(higher ? { best: best.host, bestSc: best.probeScore } : {}) });
    } else if (main && best) {
      // 页面上用过、比主节点差的不算
      const cand = fastest(hosts.filter((x) => x.host === main.host || !route.perfWorse(x.page, main.page))) || best;
      // 换过去的节点不算探查的次数；它页面上表现好的，算测够了（同 route.js pickVod）
      const candFew = cand.host !== main.host && !route.perfGood(cand.page) && cand.probeN - cand.surveyed < MAP.few;
      const few = candFew || Math.min(cand.probeN, main.probeN) < MAP.few;
      if (main.probeScore == null) findings.push({ code: 'unprobed', lv: 'info', host: main.host, best: best.host, sc: best.probeScore });
      else if (cand.host !== main.host && cand.probeScore > main.probeScore && cand.probeScore >= main.probeScore * route.SWITCH_MARGIN) {
        findings.push({ code: 'faster', lv: 'warn', host: cand.host, sc: cand.probeScore, main: main.host, mainSc: main.probeScore, few });
      } else findings.push({ code: 'mainBest', lv: 'good', host: main.host, sc: main.probeScore, few });
    }
    if (pcdnShare !== null && pcdnShare >= MAP.pcdn) findings.push({ code: 'pcdn', lv: pcdnShare >= MAP.pcdnMany ? 'warn' : 'info', share: pcdnShare });
    // 扩展看到了几成（见 analyze.js srcSummary），没有来源记录的不说。看到的不到一半时，上面的结论都只是这一部分流量的：放在最前面
    if (src.share !== null) {
      const f = { code: 'src', lv: src.share < an.SRC.most ? 'warn' : 'info', share: src.share, p2p: src.p2pShare, pdn: src.pdnShare, other: src.otherShare, tx: src.tx, known: src.known, sessions: src.sessions, off: src.off };
      if (f.lv === 'warn') findings.unshift(f);
      else findings.push(f);
    }
    const stalled = hosts.reduce((a, x) => (x.auto > (a ? a.auto : 0) ? x : a), null);
    if (stalled && stalled.auto >= MAP.stalls) findings.push({ code: 'stall', lv: 'warn', host: stalled.host, n: stalled.auto });
    // 以往的直播 HLS 测速（网络档案，各 host 合在一起按编码和清晰度算，见 probe.js bookKnown）
    const hls = Object.values(probe.bookKnown(book && book.nets ? book.nets[e.key] : null, now).hls);
    if (hls.length) {
      const r = Math.min(...hls.map((x) => x.r));
      findings.push(r < route.HLS_KNOWN_HEADROOM ? { code: 'hlsSlow', lv: 'warn', r } : { code: 'hlsOk', lv: 'good', r });
    }
    // B 站在这个网络分配过、不在内置镜像列表里的 UPOS 镜像名：测得好就加进这个网络的测速候选（见 probe.js bookHosts）
    const extra = hosts.filter((x) => (x.base || x.backup) && route.isUpos(x.host) && !x.builtin).map((x) => x.host);
    if (extra.length) findings.push({ code: 'extra', lv: 'info', hosts: extra });
    if (groups.length) findings.push({ code: 'same', lv: 'info', n: groups.length, hosts: groups[0].hosts });
    // 测过、一次都没测通，页面也没从它取到过数据的
    const dead = hosts.filter((x) => x.probeN > 0 && !x.probeOk && !(x.n > x.err)).map((x) => x.host);
    if (dead.length) findings.push({ code: 'dead', lv: 'info', hosts: dead });
    if (!hosts.some((x) => x.probeN)) findings.push({ code: 'none', lv: 'info' });

    return {
      key: e.key,
      net: e.net,
      t0: e.t0 === Infinity ? null : e.t0,
      t1: e.t1 || null,
      sessions: e.sids.size,
      asg: e.asg,
      probes: hosts.reduce((s, x) => s + x.probeN, 0),
      surveyed: hosts.reduce((s, x) => s + x.surveyed, 0),
      incidents: e.inc,
      pcdnShare,
      src,
      classes,
      hosts,
      groups,
      main: main ? main.host : null,
      best: best ? { host: best.host, sc: best.probeScore } : null,
      findings,
    };
  }

  /**
   * 按网络汇总记录（统计页「节点分布」）。records：全部记录（按写入顺序）；from：只算这个时间以后的（本日、本周），
   * 之前的 net 记录照样用来判断当时在哪个网络；cur：当前网络（storage.local 的 net），这个网络在范围里没有记录也列出来
   * （统计页要在它上面点探查）；book：网络档案（见 probe.js），看以往的直播 HLS 测速。
   * 返回 { cur: 当前网络的键, nets }，当前网络排第一，其余按最后一条记录的时间倒序。每个网络：
   * key（cdn.js netKey，不知道 ISP 的为空）、net（最近一次的位置）、t0 / t1、sessions 播放会话数、asg 分配次数、probes 测速次数（surveyed 其中探查的）、
   * incidents 自动识别的卡顿（见 analyze.js incidentOf）、pcdnShare PCDN 请求占比；src 扩展看到了多少媒体流量（见 analyze.js srcSummary，比例为 null 是不知道）；
   * classes [{ cls, base 当主地址的次数, req 请求数, bytes }]（一次分配里一个节点当主地址算一次）；
   * hosts（字段同 analyze.js 的节点表，另有 subnets 连到的网段、group 同一服务器的组号、builtin 在内置镜像列表里、vod 点播节点、surveyed 探查次数、page 页面上的表现 { n, tt, f }，见 route.js perfOf），测速快的在前；
   * groups 同一服务器的几个名字 [{ hosts, subnets }]；main B 站最常分配的点播主节点；best 测速最快的点播节点 { host, sc }；
   * findings 结论 [{ code, lv: good / warn / info, ...参数 }]，文案在统计页（stats.js）。
   */
  function nodeMap(records, { from = null, cur = null, book = null, now = Date.now() } = {}) {
    const nets = new Map();
    const unmarked = new Set(records.filter((r) => r.ty === 'unmark').map((r) => r.ref));
    const entryOf = (key) => {
      if (!nets.has(key)) nets.set(key, { key, net: null, t0: Infinity, t1: 0, sids: new Set(), hosts: new Map(), cls: new Map(), asg: 0, vodAsg: 0, inc: 0, src: new Map() });
      return nets.get(key);
    };
    const hostOf = (e, h) => {
      if (!e.hosts.has(h)) e.hosts.set(h, { host: h, vod: false, n: 0, pcdn: 0, err: 0, to: 0, b: 0, tt: [], mb: [], base: 0, vbase: 0, backup: 0, auto: 0, marked: 0, subnets: new Set(), pr: { n: 0, ok: 0, sc: [], tt: [], sv: 0 }, pf: [] });
      return e.hosts.get(h);
    };
    const clsOf = (e, cls) => {
      if (!e.cls.has(cls)) e.cls.set(cls, { cls, base: 0, req: 0, bytes: 0 });
      return e.cls.get(cls);
    };
    // PCDN 的地址多是别人家里的宽带，不拿来分组
    const subnet = (x, ip) => {
      const s = probe.netOf(ip);
      if (s && !cdn.isPcdnHost(x.host)) x.subnets.add(s);
    };

    let net = null;
    for (const r of records) {
      if (r.ty === 'net') {
        // 旧版本把 B 站漏返回的空字段当成了网络变化，合并掉（同 analyze.js）
        net = cdn.mergeNet(net, r);
        if (nets.has(cdn.netKey(net))) nets.get(cdn.netKey(net)).net = net;
        continue;
      }
      if (!WANT.has(r.ty) || (from !== null && r.t < from)) continue;
      const e = entryOf(cdn.netKey(net));
      if (net) e.net = net;
      if (r.t < e.t0) e.t0 = r.t;
      if (r.t > e.t1) e.t1 = r.t;
      an.srcAdd(e.src, r);

      if (r.ty === 'src') {
        // 媒体数据全从 P2P 来、没有 HTTP 请求的会话也算播放过
        if (r.sid) e.sids.add(r.sid);
      } else if (r.ty === 'asg') {
        // 站内切换后补记的（carry）和原记录重复，不算（同 analyze.js）
        if (r.carry) continue;
        e.asg += 1;
        const vod = r.kind === 'vod';
        if (vod) e.vodAsg += 1;
        const groups = vod ? (r.tracks || []).map((tr) => (tr.urls || []).map((u) => ({ h: u[0], os: u[1] }))) : (r.lines || []).map((l) => (l.hosts || []).map((h) => ({ h })));
        // 一次分配里，一个 host 在某条轨道上当主地址就算一次“主”；点播带 os=mcdn 的算 PCDN（同 cdn.js isPcdnReq）
        const base = new Map();
        const backup = new Set();
        for (const hs of groups) hs.forEach((x, i) => x.h && (i === 0 ? base.set(x.h, base.get(x.h) || cdn.isPcdnReq(x)) : backup.add(x.h)));
        for (const [h, pc] of base) {
          const x = hostOf(e, h);
          x.base += 1;
          if (vod) {
            x.vbase += 1;
            x.vod = true;
          }
          clsOf(e, pc ? 'pcdn' : cdn.classifyHost(h)).base += 1;
        }
        for (const h of backup) {
          if (base.has(h)) continue;
          const x = hostOf(e, h);
          x.backup += 1;
          if (vod) x.vod = true;
        }
      } else if (r.ty === 'req') {
        if (r.sid) e.sids.add(r.sid);
        const x = hostOf(e, r.h);
        const pc = cdn.isPcdnReq(r);
        x.n += 1;
        if (String(r.k).startsWith('vod-')) x.vod = true;
        if (pc) x.pcdn += 1;
        if (cdn.isFailure(r)) x.err += 1;
        if (cdn.isTimeout(r)) x.to += 1;
        if (r.b) x.b += r.b;
        // 浏览器缓存直接答复的不算（见 cdn.js cacheHit）
        if (r.tt != null && !cdn.cacheHit(r)) x.tt.push(r.tt);
        const mb = cdn.mbpsOf(r);
        if (mb != null) x.mb.push(mb);
        const pe = route.perfEntry(r);
        if (pe) x.pf.push(pe);
        if (r.ip && !pc) subnet(x, r.ip);
        const c = clsOf(e, pc ? 'pcdn' : cdn.classifyHost(r.h));
        c.req += 1;
        c.bytes += r.b || 0;
      } else if (r.ty === 'reqend') {
        // 直播长连接异常断开计入失败（同 analyze.js）
        if (cdn.isFailure(r)) hostOf(e, r.h).err += 1;
      } else if (r.ty === 'probe') {
        const x = hostOf(e, r.h);
        const sc = probe.probeScore(r);
        if (r.k === 'vod') x.vod = true;
        x.pr.n += 1;
        x.pr.sc.push(sc);
        if (sc > 0) {
          x.pr.ok += 1;
          if (r.tt != null) x.pr.tt.push(r.tt);
        }
        if (r.sv) x.pr.sv += 1;
        // 1.2.0 起测速记录带连到的 IP，只测过、没播放过的节点也知道连到哪台服务器
        if (r.ip) subnet(x, r.ip);
      } else if (r.ty === 'stall' || r.ty === 'start') {
        // 自动识别的卡顿记在当时的主要责任节点上（同 analyze.js）
        if (!an.incidentOf(r)) continue;
        e.inc += 1;
        for (const h of new Set(an.mainHosts(r.hosts).map((x) => x.h))) hostOf(e, h).auto += 1;
      } else if (r.ty === 'mark') {
        if (unmarked.has(r.id) || !an.blamesNode(r)) continue;
        for (const x of an.mainHosts(r.hosts)) hostOf(e, x.h).marked += 1;
      }
    }

    const curKey = cur ? cdn.netKey(cur) : net ? cdn.netKey(net) : null;
    if (cur) {
      const e = entryOf(curKey);
      e.net ||= cur;
    }
    const out = [...nets.values()].map((e) => summarize(e, book, now));
    out.sort((a, b) => (b.key === curKey) - (a.key === curKey) || (b.t1 || 0) - (a.t1 || 0));
    return { cur: curKey, nets: out };
  }

  const api = { MAP, nodeMap, serverGroups };
  if (node) module.exports = api;
  else root.__bilicdn = Object.assign(root.__bilicdn || {}, api);
})(globalThis);
