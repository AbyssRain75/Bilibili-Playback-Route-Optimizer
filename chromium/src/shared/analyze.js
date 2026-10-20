// SPDX-License-Identifier: GPL-3.0-or-later
// 对持久记录做汇总统计（统计页使用，也方便之后离线分析导出的数据）。
(function (root) {
  'use strict';

  const node = typeof module === 'object' && module.exports;
  const cdn = node ? require('./cdn.js') : root.__bilicdn;
  // 浏览器里 probe.js 也挂在同一个共享对象上，用到时再取
  const probe = node ? require('./probe.js') : cdn;
  const { quantile } = cdn;

  /**
   * from ~ to 这段时间里在用的节点，以及该怪谁：按各节点请求的“在途时间”（发出到完成，还没完成的算到 to）
   * 落在这段时间里的长度分责任。卡顿时播放器在等的是没下完的请求，慢的节点在途时间长；
   * 视频、音频走不同节点时，没问题的那个只分到一小部分，不会跟着被判为卡过。
   * reqs：[{ h, a: 发出时间, t: 完成时间, k, act }]，act 为还在进行中的请求（如直播 FLV 长连接）；没有 a 的旧数据按瞬时请求算。
   * 返回 [{ h, n, p, act, w }]，按 w 降序：n 为这段时间里完成的请求数；p 为线路（vod / flv / hls，见 lineOf），卡顿证据按线路分开记；
   * w 为责任占最大者的比例（0~1，最大的为 1）。都没有在途时间时按请求数分。
   */
  function blameHosts(reqs, from, to) {
    const by = new Map();
    for (const r of reqs) {
      const end = r.act ? to : r.t;
      const start = Math.min(r.a ?? end, end);
      if (end < from || start > to) continue;
      const e = by.get(r.h) || { h: r.h, n: 0, busy: 0 };
      if (!r.act) e.n += 1;
      else e.act = 1;
      e.busy += Math.min(end, to) - Math.max(start, from);
      if (r.k) e.p = cdn.lineOf(r.k);
      by.set(r.h, e);
    }
    const list = [...by.values()];
    const key = list.some((e) => e.busy > 0) ? 'busy' : 'n';
    const max = Math.max(0, ...list.map((e) => e[key]));
    return list
      .map(({ busy, ...e }) => ({ ...e, w: max > 0 ? Math.round(((key === 'busy' ? busy : e.n) / max) * 100) / 100 : 1 }))
      .sort((a, b) => b.w - a.w || b.n - a.n);
  }

  /**
   * 起播慢、卡顿期间有请求没等到响应头就超时（reqs 里 hang=1，见 cdn.js isHang）：换过去的镜像 2 秒没回应，
   * 播放器改从备用地址取。这时等待来自超时的节点，责任全算给它（w 为 1）；接手的备用节点只是来救场，不分责任（w 为 0，仍列出）。
   * 按在途时间分的话，救场的节点也要分一部分：实测三次镜像挂起导致的起播慢，B 站分配的 cosov 分到 0.39 / 0.15 / 0.74，被判为卡过。
   * 窗口里没有超时的照常返回 hosts（见 blameHosts）。
   */
  function blameHung(hosts, reqs, from, to) {
    const hung = new Set(reqs.filter((r) => r.hang && r.t >= from && (r.a ?? r.t) <= to).map((r) => r.h));
    if (!hung.size) return hosts;
    return hosts.map((x) => ({ ...x, w: hung.has(x.h) ? 1 : 0 })).sort((a, b) => b.w - a.w || b.n - a.n);
  }

  // 统计页的「自动判定」「被标记」只算主要责任节点：责任不少于最大者的一半（旧记录没有 w，都算）
  const MAIN_SHARE = 0.5;
  const mainHosts = (hosts) => (hosts || []).filter((x) => (x.w ?? 1) >= MAIN_SHARE);

  // 自动判定为卡顿的事件：不是拖动引起的、1 秒以上的缓冲；起播（地址→媒体就绪）超过 5 秒；没能起播
  const AUTO = { stallMs: 1000, startMs: 5000 };

  /**
   * 返回 'stall' / 'slow' / 'fail'，不算卡顿时返回 null。
   * 切回前台后恢复画面的缓冲（wake）、计时期间进过后台的起播（hid）不算：那是浏览器在后台停了画面，不是节点的问题（见 hook.js）。
   */
  function incidentOf(r) {
    if (r.ty === 'stall') return !r.seek && !r.wake && r.ms >= AUTO.stallMs ? 'stall' : null;
    if (r.ty !== 'start') return null;
    if (r.fail) return 'fail';
    return !r.hid && (r.cp ?? r.ms) >= AUTO.startMs ? 'slow' : null;
  }

  // 直播 HLS 跟不跟得上：播放器一个分片一个分片地取，近 30 秒里分片请求“在途”的时间占满了就没有余量，稍有波动就卡。
  // 实测 30 秒窗口里占用 90% 以上的，八九成当时或紧接着就卡了 1 秒以上；85% 以下几乎不卡
  const HLS_LOAD = { window: 30e3, min: 15, busy: 0.9 };
  const isSeg = (x) => (x.k === 'live-m4s' || x.k === 'live-ts') && x.a != null;

  /**
   * to 之前 30 秒里 HLS 分片请求的占用比例（各请求在途时间的并集 ÷ 30 秒）。
   * recent：[{ a 发出, t 完成, k }]。分片太少、或者 HLS 播放还不到一个窗口时为 null。
   */
  function hlsLoad(recent, to) {
    const from = to - HLS_LOAD.window;
    const segs = recent.filter((x) => isSeg(x) && x.t > from && x.a < to);
    if (segs.length < HLS_LOAD.min || !recent.some((x) => isSeg(x) && x.a <= from + 2e3)) return null;
    const iv = segs.map((x) => [Math.max(x.a, from), Math.min(x.t, to)]).sort((x, y) => x[0] - y[0]);
    let busy = 0;
    let [s, e] = iv[0];
    for (const [a, b] of iv.slice(1)) {
      if (a > e) {
        busy += e - s;
        [s, e] = [a, b];
      } else e = Math.max(e, b);
    }
    busy += e - s;
    return Math.round((busy / HLS_LOAD.window) * 100) / 100;
  }

  // 手动标记时按播放器状态判断卡的原因（见 markCause）。缓冲低于 lowBuf 秒算见底（直播本来就只缓冲一两秒，用 lowBufLive）；
  // 标记前 stallWithin 内卡过 stallMs 以上也算网络；近 10 秒掉帧超过 dropRatio 算掉帧
  const MARK = { lowBuf: 2, lowBufLive: 0.5, stallWithin: 30e3, stallMs: 500, dropRatio: 0.05, minFrames: 30 };

  /**
   * 手动标记时卡的原因：net 缓冲不足（网络 / 节点）；drop 缓冲充足但在掉帧（解码 / 渲染，与节点无关）；
   * ok 缓冲充足、没掉帧、最近也没卡过（多半已经恢复，或者不是播放的问题）；读不到播放器状态时为 null。
   * ps：播放器状态 { pos, dur（直播为 null）, buf, rs, paused, drop, frames }；ls：标记前最近一次卡顿 { ago, ms }。
   */
  function markCause(ps, ls) {
    if (ls && ls.ago <= MARK.stallWithin && ls.ms >= MARK.stallMs) return 'net';
    if (!ps) return null;
    const live = ps.dur == null;
    const low = live ? MARK.lowBufLive : MARK.lowBuf;
    const nearEnd = !live && ps.dur - ps.pos <= low;
    if ((!ps.paused && ps.rs < 3) || (ps.buf < low && !nearEnd)) return 'net';
    if (ps.frames >= MARK.minFrames && ps.drop / ps.frames >= MARK.dropRatio) return 'drop';
    return 'ok';
  }

  /** 手动标记是否归咎于当时在用的节点：音画不同步、掉帧、或者缓冲充足的不算。 */
  const blamesNode = (m) => m.issue !== 'sync' && m.cause !== 'drop' && m.cause !== 'ok';

  /** 按本地日历筛选报告记录；之前的会话和分配只用作上下文，不计入本期记录。 */
  function selectPeriod(records, period = 'all', now = Date.now()) {
    if (period !== 'day' && period !== 'week') return { period: 'all', from: null, to: now, records, context: [] };
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (period === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    const from = start.getTime();
    const selected = records.filter((r) => r.t >= from && r.t <= now);
    const sids = new Set(selected.map((r) => r.sid).filter(Boolean));
    const before = new Map();
    for (const r of records) if (r.t < from && sids.has(r.sid) && (r.ty === 'ses' || r.ty === 'asg')) {
      const key = `${r.sid}:${r.ty}`;
      if (!before.has(key) || before.get(key).t < r.t) before.set(key, r);
    }
    return { period, from, to: now, records: selected, context: [...before.values()] };
  }

  function analyze(records, { context = [] } = {}) {
    const counts = {};
    const nets = [];
    const sessions = new Map();
    const hosts = new Map();
    const stalls = [];
    const starts = [];
    const marks = [];
    const unmarked = new Set();
    const auto = { stall: 0, slow: 0, fail: 0 };
    let since = Infinity;
    let last = 0;

    const sessionOf = (sid, pg) => {
      if (!sid) return null;
      let s = sessions.get(sid);
      if (!s) sessions.set(sid, (s = { pg: null, asg: 0, req: 0 }));
      if (pg && !s.pg) s.pg = pg;
      return s;
    };
    const hostOf = (h) => {
      let e = hosts.get(h);
      if (!e) {
        hosts.set(h, (e = { host: h, n: 0, pcdn: 0, err: 0, b: 0, tt: [], mb: [], kinds: new Set(), ips: new Set(), base: 0, backup: 0, marked: 0, auto: 0, to: 0, probe: { n: 0, ok: 0, sc: [], tt: [] } }));
      }
      return e;
    };

    for (const r of context) {
      const s = sessionOf(r.sid, r.pg);
      if (s && r.ty === 'ses' && r.via === 'req') s.noScript = true;
      if (s && r.ty === 'asg') s.asg += 1;
    }

    for (const r of records) {
      counts[r.ty] = (counts[r.ty] || 0) + 1;
      if (r.t < since) since = r.t;
      if (r.t > last) last = r.t;

      if (r.ty === 'ses') {
        const s = sessionOf(r.sid, r.pg);
        if (s && r.via === 'req') s.noScript = true;
      } else if (r.ty === 'net') {
        // 旧版本把 B 站漏返回的空字段当成了网络变化，这里合并掉
        const cur = cdn.mergeNet(nets.at(-1), r);
        if (cdn.netChanged(nets.at(-1), cur)) nets.push(cur);
      } else if (r.ty === 'asg') {
        const s = sessionOf(r.sid, r.pg);
        if (s) s.asg += 1;
        // 站内切换后补记的分配（carry）与切换前的原记录重复，只算会话捕获，不再计入节点统计。
        // 每次分配里，一个 host 只要在某条轨道上当主地址就算一次“主”
        if (!r.carry) {
          const groups = r.kind === 'vod' ? (r.tracks || []).map((tr) => tr.urls.map((u) => u[0])) : (r.lines || []).map((l) => l.hosts);
          const base = new Set();
          const backup = new Set();
          for (const hs of groups) hs.forEach((h, i) => h && (i === 0 ? base : backup).add(h));
          base.forEach((h) => (hostOf(h).base += 1));
          backup.forEach((h) => !base.has(h) && (hostOf(h).backup += 1));
        }
      } else if (r.ty === 'req') {
        const s = sessionOf(r.sid);
        if (s) s.req += 1;
        const e = hostOf(r.h);
        e.n += 1;
        // PCDN 按每条请求算（见 cdn.js isPcdnReq）：同一个 host 上只有带 os=mcdn 的那些算
        if (cdn.isPcdnReq(r)) e.pcdn += 1;
        if (cdn.isFailure(r)) e.err += 1;
        if (cdn.isTimeout(r)) e.to += 1;
        if (r.b) e.b += r.b;
        // 带 fc 的多半也走了网络，只有浏览器缓存直接答复的不算（见 cdn.js cacheHit）
        if (r.tt != null && !cdn.cacheHit(r)) e.tt.push(r.tt);
        const mb = cdn.mbpsOf(r);
        if (mb != null) e.mb.push(mb);
        e.kinds.add(r.k);
        if (r.ip) e.ips.add(r.ip);
      } else if (r.ty === 'probe') {
        // 自动测速：得分见 probe.probeScore，失败记 0 分
        const p = hostOf(r.h).probe;
        const sc = probe.probeScore(r);
        p.n += 1;
        p.sc.push(sc);
        if (sc > 0) {
          p.ok += 1;
          p.tt.push(r.tt);
        }
      } else if (r.ty === 'reqend') {
        // 直播长连接结束：异常断开计入该节点的失败
        if (cdn.isFailure(r)) hostOf(r.h).err += 1;
      } else if (r.ty === 'stall' || r.ty === 'start') {
        sessionOf(r.sid, r.pg);
        (r.ty === 'stall' ? stalls : starts).push(r);
        // 自动判定的卡顿记在当时的主要责任节点上（与手动标记的“被标记”对应，见 blameHosts）
        const inc = incidentOf(r);
        if (inc) {
          auto[inc] += 1;
          for (const h of new Set(mainHosts(r.hosts).map((x) => x.h))) hostOf(h).auto += 1;
        }
      } else if (r.ty === 'mark') {
        marks.push(r);
      } else if (r.ty === 'unmark') {
        unmarked.add(r.ref);
      }
    }

    const markRows = marks.filter((m) => !unmarked.has(m.id)).sort((a, b) => b.t - a.t);
    for (const m of markRows) if (blamesNode(m)) for (const x of mainHosts(m.hosts)) hostOf(x.h).marked += 1;
    counts.mark = markRows.length;

    const hostRows = [...hosts.values()]
      .map((e) => ({
        host: e.host,
        // 请求全是 PCDN 的归为 PCDN，只有一部分是的按 host 归类、pcdn 注明几个是（见 cdn.js nodeClass）
        cls: cdn.nodeClass(e.host, e.pcdn, e.n),
        pcdn: e.pcdn,
        base: e.base,
        backup: e.backup,
        marked: e.marked,
        auto: e.auto,
        n: e.n,
        err: e.err,
        timeouts: e.to,
        errRate: e.n ? e.err / e.n : null,
        ttfbP50: quantile(e.tt, 0.5),
        ttfbP90: quantile(e.tt, 0.9),
        mbpsP50: quantile(e.mb, 0.5),
        mbpsSamples: e.mb.length,
        bytes: e.b,
        kinds: [...e.kinds].sort(),
        ips: [...e.ips],
        probeN: e.probe.n,
        probeOk: e.probe.ok,
        probeScore: quantile(e.probe.sc, 0.5),
        probeTt: quantile(e.probe.tt, 0.5),
      }))
      .sort((a, b) => b.n - a.n || b.base - a.base);

    const pages = new Map();
    const pageOf = (pg) => {
      const key = pg || 'other';
      let p = pages.get(key);
      if (!p) pages.set(key, (p = { page: key, sessions: 0, stalls: [], starts: [], startFail: 0 }));
      return p;
    };
    for (const s of sessions.values()) if (s.req) pageOf(s.pg).sessions += 1;
    for (const r of stalls) if (!r.seek) pageOf(r.pg).stalls.push(r.ms);
    // 起播优先用 cp（地址→媒体就绪），旧记录没有 cp 时退回 ms；没能起播的单独计数
    for (const r of starts) {
      if (r.fail) pageOf(r.pg).startFail += 1;
      else pageOf(r.pg).starts.push(r.cp ?? r.ms);
    }
    const pageRows = [...pages.values()]
      .map((p) => ({
        page: p.page,
        sessions: p.sessions,
        stalls: p.stalls.length,
        stallMs: p.stalls.reduce((a, b) => a + b, 0),
        stallP50: quantile(p.stalls, 0.5),
        startN: p.starts.length,
        startP50: quantile(p.starts, 0.5),
        startFail: p.startFail,
      }))
      .sort((a, b) => b.sessions - a.sessions);

    // 捕获率只看页面脚本正常运行的会话；脚本没运行的会话单独计数，用于发现注入问题
    const playedAll = [...sessions.values()].filter((s) => s.req > 0);
    const played = playedAll.filter((s) => !s.noScript);
    return {
      range: records.length ? { since, last } : null,
      counts,
      nets,
      hosts: hostRows,
      pages: pageRows,
      auto,
      marks: markRows.map((m) => ({ t: m.t, sid: m.sid, pg: m.pg, path: m.path, lv: m.lv, issue: m.issue || null, via: m.via, note: m.note || '', hosts: m.hosts || [], ps: m.ps || null, cause: m.cause || null })),
      coverage: {
        played: played.length,
        withAsg: played.filter((s) => s.asg > 0).length,
        noScript: playedAll.length - played.length,
        orphanReq: records.filter((r) => r.ty === 'req' && !r.sid).length,
      },
    };
  }

  // ---------------------------------------------------------------- 会话时间轴

  const TL = { bins: 200, hosts: 4 };

  /**
   * 统计页的会话时间轴，按开始时间倒序，最多 limit 个；total 为符合条件的会话数。
   * 每个会话：各节点的请求按时间分成 TL.bins 段（0 没有请求、1 有请求、2 有失败），请求最多的 TL.hosts 个节点各占一行；
   * 以及卡顿（不含拖动）、起播、手动标记（不含撤销的）和线路改写。
   * issues 为 true 时只要有自动判定的卡顿（见 incidentOf）或手动标记的会话。
   */
  function timelines(records, { limit = 20, issues = true, context = [], from = null, to = null } = {}) {
    const sessions = new Map();
    const unmarked = new Set();
    const get = (sid) => {
      let s = sessions.get(sid);
      if (!s) sessions.set(sid, (s = { sid, t0: Infinity, t1: 0, pg: null, path: '', via: '', reqs: [], flv: new Map(), stalls: [], starts: [], marks: [], routes: [] }));
      return s;
    };
    for (const r of context) if (r.ty === 'ses') {
      const s = get(r.sid);
      s.pg = r.pg;
      s.path = r.path || '';
      s.via = r.via || '';
    }
    for (const r of records) {
      if (r.ty === 'unmark') unmarked.add(r.ref);
      if (!r.sid || r.ty === 'probe' || r.ty === 'unmark') continue;
      const s = get(r.sid);
      const at = (t) => {
        if (t < s.t0) s.t0 = t;
        if (t > s.t1) s.t1 = t;
      };
      at(r.t);
      if (r.ty === 'ses') {
        s.t0 = r.t;
        s.pg = r.pg;
        s.path = r.path || '';
        s.via = r.via || '';
      } else if (r.ty === 'req') {
        // 直播 FLV 长连接开始时记一条，结束时间等 reqend
        const q = { h: r.h, a: r.t, b: r.d == null ? null : r.t + r.d, fail: cdn.isFailure(r), pc: cdn.isPcdnReq(r) };
        s.reqs.push(q);
        if (q.b === null) s.flv.set(r.h, q);
        else at(q.b);
      } else if (r.ty === 'reqend') {
        const q = s.flv.get(r.h);
        if (q) {
          q.b = r.t;
          q.fail = cdn.isFailure(r);
          s.flv.delete(r.h);
        }
      } else if (r.ty === 'stall') {
        if (!r.seek) {
          const a = from === null ? r.t - r.ms : Math.max(r.t - r.ms, from);
          at(a);
          s.stalls.push({ a, b: r.t, ms: r.ms, cut: !!r.cut, end: r.end || '', wake: !!r.wake, inc: incidentOf(r) === 'stall' });
        }
      } else if (r.ty === 'start') {
        s.starts.push({ t: r.t, ms: r.cp ?? r.ms, fail: !!r.fail, inc: incidentOf(r) });
      } else if (r.ty === 'mark') {
        s.marks.push({ id: r.id, t: r.t, lv: r.lv, issue: r.issue || null, via: r.via, note: r.note || '', cause: r.cause || null, ps: r.ps || null });
        if (!s.path) s.path = r.path || '';
        if (!s.pg) s.pg = r.pg;
      } else if (r.ty === 'route') {
        if (!r.pre || r.carry) s.routes.push({ t: r.t, kind: r.kind, from: r.from || '', to: r.to || '', proto: r.proto || '', bk: !!r.bk, why: r.why || '' });
      }
    }

    const out = [];
    for (const s of sessions.values()) {
      s.marks = s.marks.filter((m) => !unmarked.has(m.id));
      const counts = {
        stall: s.stalls.filter((x) => x.inc).length,
        slow: s.starts.filter((x) => x.inc === 'slow').length,
        fail: s.starts.filter((x) => x.inc === 'fail').length,
        mark: s.marks.length,
      };
      const any = counts.stall + counts.slow + counts.fail + counts.mark > 0;
      if (!(issues ? any : any || s.reqs.length)) continue;
      if (from !== null) s.t0 = Math.max(s.t0, from);
      if (to !== null) s.t1 = Math.min(s.t1, to);
      out.push({ ...s, counts });
    }
    out.sort((a, b) => b.t0 - a.t0);

    const rows = out.slice(0, limit).map((s) => {
      const span = Math.max(s.t1 - s.t0, 1000);
      const bin = (t) => Math.min(TL.bins - 1, Math.max(0, Math.floor(((t - s.t0) / span) * TL.bins)));
      const hosts = new Map();
      for (const q of s.reqs) {
        let e = hosts.get(q.h);
        if (!e) hosts.set(q.h, (e = { h: q.h, n: 0, pcdn: 0, err: 0, bins: new Array(TL.bins).fill(0) }));
        e.n += 1;
        if (q.pc) e.pcdn += 1;
        const i1 = bin(q.b ?? s.t1);
        for (let i = bin(q.a); i <= i1; i++) e.bins[i] = Math.max(e.bins[i], 1);
        if (q.fail) {
          e.err += 1;
          e.bins[i1] = 2;
        }
      }
      for (const e of hosts.values()) e.cls = cdn.nodeClass(e.h, e.pcdn, e.n);
      const list = [...hosts.values()].sort((a, b) => b.n - a.n);
      const { reqs, flv, ...rest } = s;
      return { ...rest, hosts: list.slice(0, TL.hosts), moreHosts: Math.max(0, list.length - TL.hosts) };
    });
    return { total: out.length, rows };
  }

  const api = { AUTO, MARK, TL, MAIN_SHARE, HLS_LOAD, blameHosts, blameHung, mainHosts, incidentOf, hlsLoad, markCause, blamesNode, selectPeriod, analyze, timelines };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__bilicdn = Object.assign(root.__bilicdn || {}, api);
})(globalThis);
