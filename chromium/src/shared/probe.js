// SPDX-License-Identifier: GPL-3.0-or-later
// 自动测速：测速得分和排名，什么时候测、测哪几个（缓冲、退避、间隔、复测），网络档案，同一台服务器的几个镜像名，以及测速候选和取数范围。
// 只有 service worker 和扩展页面（popup、统计页）用，不注入页面：页面里改写播放地址、取测速地址只要 route.js（见 manifest 的 MAIN world 脚本）。
// 经典脚本，service worker（importScripts）、扩展页面和 Node 测试共用；浏览器里要在 cdn.js、route.js 之后加载。
(function (root) {
  'use strict';

  const node = typeof module === 'object' && module.exports;
  const cdn = node ? require('./cdn.js') : root.__bilicdn;
  // 测速结果的键、切换门槛、HLS 跟不跟得上的判断和页面改写共用，在 route.js
  const route = node ? require('./route.js') : root.__bilicdn;
  const { SWITCH_MARGIN, isUpos, swapHost, lineKey, cqOf, knownHlsSlow } = route;

  // 已知的 UPOS 镜像（与 tools/cdn_probe.py 一致），能不能用、快不快以测速为准
  const UPOS_MIRRORS = [
    'upos-sz-mirrorcosov.bilivideo.com',
    'upos-sz-mirroraliov.bilivideo.com',
    'upos-sz-mirrorcos.bilivideo.com',
    'upos-sz-mirrorcosb.bilivideo.com',
    'upos-sz-mirrorcoso1.bilivideo.com',
    'upos-sz-mirrorali.bilivideo.com',
    'upos-sz-mirroralib.bilivideo.com',
    'upos-sz-mirrorhw.bilivideo.com',
    'upos-sz-mirrorhwo1.bilivideo.com',
    'upos-sz-mirror08c.bilivideo.com',
    'upos-sz-mirror08h.bilivideo.com',
    'upos-sz-mirror08ct.bilivideo.com',
    'upos-sz-mirrorbos.bilivideo.com',
  ];

  // ---------------------------------------------------------------- 同一台服务器

  // 同一台服务器的几个镜像名：实测 08c / 08h / 08ct / hwo1 / hw 解析到同一组中国移动地址（同一时刻常常是同一个 IP），
  // 背后是同一个缓存集群（via 头相同，一个名字没命中，换个名字马上就命中）。问题按 host 名分开记的话，一个名字卡过，
  // 「自动」就换到另一个名字，等于没换：实测 3 分钟里在 08h → 08ct → 08c → hw 之间轮换，四次起播都慢（5.6~12.3 秒）。
  // 所以 SW 记下各点播 host 近 24 小时连到的服务器网段（IPv4 取前三段：实测同一网段的 .130 和 .133 两个地址共用缓存），
  // 连到过同一网段的 host 算同一台服务器，问题证据一起记（见 sw.js addTrouble）
  const SAME_SERVER = { keep: 24 * 3600e3, touch: 10 * 60e3 };

  /** 服务器地址所在的网段：IPv4 前三段，IPv6 前三组；不是 IP 时为空。 */
  function netOf(ip) {
    const s = String(ip || '').toLowerCase();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.split('.').slice(0, 3).join('.');
    return /^[0-9a-f:]+$/.test(s) && s.includes(':') ? s.split(':').slice(0, 3).join(':') : '';
  }

  /**
   * 记下 host 连到的服务器网段（原地修改）。seen：{ host: { 网段: 最近一次的时间 } }。
   * 返回要不要存：新网段，或者离上次记下超过 10 分钟（每个请求都存太频繁）。
   */
  function noteServer(seen, host, ip, t = Date.now()) {
    const net = netOf(ip);
    if (!host || !net) return false;
    const e = (seen[host] ||= {});
    const fresh = e[net] > t - SAME_SERVER.touch;
    e[net] = Math.max(e[net] || 0, t);
    return !fresh;
  }

  /** 去掉 24 小时前的网段（原地修改并返回）。 */
  function pruneServers(seen, now = Date.now()) {
    for (const [h, nets] of Object.entries(seen)) {
      for (const [net, t] of Object.entries(nets)) if (!(t > now - SAME_SERVER.keep)) delete nets[net];
      if (!Object.keys(nets).length) delete seen[h];
    }
    return seen;
  }

  /**
   * 同一台服务器的 host：近 24 小时连到过同一网段的归为一组，可以传递（a、b 共用一个网段，b、c 共用另一个，三个是一组）。
   * 返回 { host: [组里所有 host，按名字排序] }，只列出有同伴的。
   */
  function sameServer(seen, now = Date.now()) {
    const parent = {};
    const find = (h) => (parent[h] === h ? h : (parent[h] = find(parent[h])));
    const first = {}; // 网段 → 第一个连到它的 host
    for (const [h, nets] of Object.entries(seen || {})) {
      for (const [net, t] of Object.entries(nets)) {
        if (!(t > now - SAME_SERVER.keep)) continue;
        parent[h] ??= h;
        if (first[net]) parent[find(h)] = find(first[net]);
        else first[net] = h;
      }
    }
    const groups = {};
    for (const h of Object.keys(parent)) (groups[find(h)] ||= []).push(h);
    const out = {};
    for (const hs of Object.values(groups)) if (hs.length > 1) for (const h of hs.sort()) out[h] = hs;
    return out;
  }

  // ---------------------------------------------------------------- 测速得分

  const VOD_CHUNK = 1024 * 1024; // 点播播放器一次取 1 MB 左右

  /**
   * 测速得分（Mbps，越高越好）：按播放器实际取数据的方式估算能持续下载的速率。
   * 点播和 HLS 一个分片一个分片地取，每次都要等首字节：大小 ÷（首字节时间 + 大小 ÷ 吞吐）；
   * FLV 是一条长连接，只看吞吐。失败记 0 分。
   */
  function probeScore(p) {
    if (!p || p.e || !(p.st >= 200 && p.st < 300) || !(p.mbps > 0) || p.tt == null) return 0;
    if (p.k === 'live-flv') return round2(p.mbps);
    const mbit = ((p.seg || VOD_CHUNK) * 8) / 1e6;
    return round2(mbit / (p.tt / 1000 + mbit / p.mbps));
  }

  const round2 = (v) => Math.round(v * 100) / 100;

  /**
   * HLS 播放列表：master 返回第一个子列表地址；媒体列表返回最新一个完整分片的地址和时长（秒）。
   * B 站直播的 fmp4 列表里夹着 0.17 秒之类的短分片，测它算出的码率从 0.2 到 11 Mbps 乱跳，
   * 所以取时长不短于列表里最长分片九成的最后一个分片。
   */
  function parseM3u8(text, base) {
    const lines = String(text).split(/\r?\n/).map((l) => l.trim());
    const abs = (u) => new URL(u, base).href;
    if (!lines.some((l) => l && !l.startsWith('#'))) return null;
    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) return { playlist: abs(lines.find((l) => l && !l.startsWith('#'))) };
    const segs = [];
    let dur = null;
    for (const l of lines) {
      const m = /^#EXTINF:([\d.]+)/.exec(l);
      if (m) dur = Number(m[1]);
      else if (l && !l.startsWith('#')) {
        segs.push({ uri: l, dur });
        dur = null;
      }
    }
    const full = 0.9 * Math.max(0, ...segs.map((s) => s.dur || 0));
    const seg = segs.findLast((s) => (s.dur || 0) >= full);
    return { segment: abs(seg.uri), dur: seg.dur };
  }

  // ---------------------------------------------------------------- 测速时机

  // 测速不和播放抢带宽（参考 stabruriss/bilibili-accelerator）：点播在暂停、或者前方缓冲 15 秒以上时才测；
  // 直播的缓冲本来就只有一两秒，没在转圈、缓冲 1 秒以上就测
  const PROBE_GATE = { vodBuf: 15, liveBuf: 1 };

  /**
   * 现在能不能测速：能测返回 null，否则返回原因：stall 播放器在转圈 / buffer 前方缓冲不够。
   * ps 为播放器状态（见 player.js）；读不到（页面脚本没运行、没有视频）时照常测。点播快放完时缓冲到结尾就算够。
   */
  function probeGate(ps) {
    if (!ps || ps.paused) return null;
    if (ps.rs < 3) return 'stall';
    const need = ps.dur == null ? PROBE_GATE.liveBuf : Math.min(PROBE_GATE.vodBuf, Math.max(ps.dur - ps.pos - 0.5, 0));
    return ps.buf < need ? 'buffer' : null;
  }

  // ---------------------------------------------------------------- 测速退避

  // 每轮挑最久没测的几个测，不管上次测得多好多差：实测 3 小时里 14 个镜像每个都测了 80 多次（共 528 MB），
  // 次次只有 1~2 Mbps、永远选不上的几个占了约 160 MB，常超时的每次还要等满 8 秒。
  // 所以点播的节点测得明显差——这次失败、或者得分不到最好的一半——就隔得越来越久再测：2、4、8、最多 16 分钟，
  // 测好了就恢复（参考 stabruriss/bilibili-accelerator：失败的结果缓存得短、只重测失败的节点）。
  // B 站分配的主节点不退避：「自动」要拿它的得分比较。备用节点（如 akam）和换上去的镜像一样退避：
  // 0.6.7 实测 akam 186 次里失败 61 次，每次白等 8 秒
  const BACKOFF = { first: 2 * 60e3, max: 16 * 60e3, ratio: 0.5 };

  /**
   * 一轮测速后更新退避状态（原地修改并返回 wait）：wait 为 { 键: { n 连续测得差的次数, until 之前不再测 } }。
   * probed：这一轮测过的 [{ key, h }]；own：不退避的 host（点播为 B 站分配的主节点，直播为全部线路）；
   * rank：这一轮算出的排名（点播得分为最近几次的中位数）；log：测速记录，看这次成没成功。
   */
  function updateBackoff(wait, probed, own, rank, log, now = Date.now()) {
    const scores = (rank && rank.vod) || {};
    const best = Math.max(0, ...Object.values(scores));
    const just = new Set(probed.map((c) => c.key));
    for (const { key, h } of probed) {
      if (own.has(h)) continue;
      const last = (log[key] || []).at(-1);
      if (last && last.ok && scores[key] >= best * BACKOFF.ratio) {
        delete wait[key];
        continue;
      }
      const n = ((wait[key] && wait[key].n) || 0) + 1;
      wait[key] = { n, until: now + Math.min(BACKOFF.first * 2 ** (n - 1), BACKOFF.max) };
    }
    // 之前测过、当时还没有更快的来比的（第一轮全是慢的）：现在比得出来了，不到最好一半的也从上次测的时候起暂缓
    for (const [key, xs] of Object.entries(log)) {
      const last = xs[xs.length - 1];
      if (just.has(key) || wait[key] || own.has(last.h) || !(scores[key] < best * BACKOFF.ratio)) continue;
      wait[key] = { n: 1, until: last.t + BACKOFF.first };
    }
    // 早就过了等待时间、又一直没再测到（换了视频）的，不再记着
    for (const [key, w] of Object.entries(wait)) if (w.until < now - 4 * BACKOFF.max) delete wait[key];
    return wait;
  }

  // ---------------------------------------------------------------- 测速间隔

  // 同一个节点要隔一段时间才再测：只暂缓差的、不限间隔的话，空出来的名额会拿去把好的几个每 30 秒测一遍，
  // 流量一点没省（按 3 小时的实测结果模拟：651 MB → 624 MB）；加上 2 分钟的间隔是 308 MB。
  // 0.6.7 实测约 7.6 小时测速、点播测速 765 MB，是点播播放流量的 19%。高分组 5 个镜像（08ct / 08h / hwo1 / hw / 08c）
  // 每 2.5 分钟各测一次，占 60%，可它们之间分不出好坏：按实测结果回放，从中随机选一个，之后 20 分钟的得分和现在的选法一样（12.3）。
  // 所以点播只有排名前 2 的每 2 分钟测一次，其余的每 10 分钟（B 站分配的主节点也是，它进了前 2 才多测）。
  // 本网络档案里从没测好过的（见 bookSlow）退避也不用从 2 分钟起：档案里上次测过之后 30 分钟再测，浏览器重启后也一样。
  // 镜像好坏会变（10-14 凌晨 ali / alib / bos 还是 12~16 Mbps，之后掉到 1~2），所以只拉长间隔，不会不测；测好一次就恢复。
  // 回放模拟：测速流量 757 → 390 MB，选中高分组的比例和之后的得分不变，低分镜像变好后平均约 13 分钟（最多 30 分钟）测到。
  // 直播的线路少，FLV / HLS 都要测才能选协议，照旧每 2 分钟。
  // 点播同一台服务器的几个镜像名（见 sameServer）算一个节点，轮流测其中一个：08c / 08h / 08ct / hwo1 / hw 同一轮的得分相关 0.69，
  // 和同一个名字前后两次（0.65）一样，各测一遍只是同一台服务器测了 5 次。B 站分配的主节点在组里时只测它（「自动」要拿它自己的得分比较）。
  // 「自动」照旧在各名字里选得分最高的：整组约 2 分钟测一次，每个名字约 10 分钟轮到一次，留着自己近 30 分钟的得分；learnServer 也能从测速请求接着记下各名字的服务器。
  // 不测固定的一个代表：停播 30 分钟以上记录清空后，整组只凭它一两次结果，单次 3 Mbps 上下的情况不少，一次测差就输给 akam / aliov 偶尔一次好的、
  // 掉到 10 分钟间隔，回放里选中高分组的比例从 86% 掉到 76%。所以一组测速记录不到 3 次时按 2 分钟测、不退避。
  // 回放模拟（同 0.6.8 的数据）：测速流量 391 → 233 MB（这 5 个名字 518 → 207 次），选中高分组的比例 86% → 88%；
  // 所选节点之后 20 分钟的得分：拿到地址时 12.2 → 12.5，每 30 秒评估一次的口径 12.4 → 12.0（每个名字测得少了，组里挑哪个名字略差）
  const CADENCE = { top: 2, every: 2 * 60e3, other: 10 * 60e3, rest: 30 * 60e3, min: 3 };

  /**
   * 这一轮要测的节点：到了测速间隔、不在暂缓中的，最久没测的先测，最多 n 个。
   * cands：[{ key, h }]；lastT(key)：上次测的时间；scores：目前的排名（键 → 得分）；wait：退避状态（见 updateBackoff）；
   * keep：不暂缓的 host（点播为 B 站分配的主节点，直播为全部线路）；slow：本网络档案里从没测好过的（见 bookSlow）；
   * vod：点播才按排名分间隔、看档案、按服务器分组。
   * same：同一台服务器的点播 host（见 sameServer），一组算一个节点：组里最近测过的那次算整组上次测的时间，组里有名字进了前 2 整组就按前 2，
   * 轮到时测组里最久没测、不在暂缓中的名字；count：各键近期测了几次，一组合计不到 3 次时按 2 分钟测、不退避（档案里从没测好过的照样暂缓）。
   */
  function probePick(cands, { lastT, scores = {}, wait = {}, keep = new Set(), slow = {}, vod = true, n = 4, same = {}, count = {} }, now = Date.now()) {
    const top = new Set(cands.filter((c) => scores[c.key] > 0).sort((a, b) => scores[b.key] - scores[a.key]).slice(0, CADENCE.top).map((c) => c.key));
    const backoff = (c) => !!wait[c.key] && wait[c.key].until > now;
    const shelved = (c) => vod && slow[c.key] > now - CADENCE.rest;
    const units = [];
    const done = new Set();
    for (const c of cands) {
      if (done.has(c.key)) continue;
      const peers = vod && same[c.h] ? cands.filter((x) => same[c.h].includes(x.h)) : [c];
      for (const x of peers) done.add(x.key);
      const few = peers.length > 1 && peers.reduce((s, x) => s + (count[x.key] || 0), 0) < CADENCE.min;
      const free = peers.filter((x) => keep.has(x.h) || !((!few && backoff(x)) || shelved(x)));
      const pick = peers.find((x) => keep.has(x.h)) || free.reduce((a, x) => (lastT(x.key) < lastT(a.key) ? x : a), free[0]);
      if (!pick) continue;
      const t = Math.max(...peers.map((x) => lastT(x.key)));
      // 还没有得分的（没测过、记录过期）按 2 分钟，测出来再分
      const scored = !few && peers.some((x) => x.key in scores);
      const every = vod && scored && !peers.some((x) => top.has(x.key)) ? CADENCE.other : CADENCE.every;
      if (now - t >= every) units.push({ c: pick, t });
    }
    return units.sort((a, b) => a.t - b.t).slice(0, n).map((u) => u.c);
  }

  /** 暂缓到什么时候（popup 显示）：退避和档案（见 bookSlow）里较晚的那个，不在暂缓中的不列。 */
  function restUntil(wait, slow, keep = new Set(), now = Date.now()) {
    const out = {};
    for (const [key, w] of Object.entries(wait)) if (w.until > now) out[key] = w.until;
    for (const [key, t] of Object.entries(slow)) if (t + CADENCE.rest > now && !keep.has(key)) out[key] = Math.max(out[key] || 0, t + CADENCE.rest);
    return out;
  }

  // ---------------------------------------------------------------- 测速排名

  const median = (arr) => {
    const m = cdn.quantile(arr, 0.5);
    return m === null ? null : round2(m);
  };

  /**
   * 测速排名：每个键（见 route.js lineKey）最近几次得分的中位数（失败记 0），分点播 / 直播给线路优化用；
   * br 为 HLS 测到的直播码率（判断 HLS 跟不跟得上）；detail 给 popup 显示。
   * log：{ 键: [{ t, k, h, c, qn, sc, ok, tt, mbps, br }] }，按时间先后。
   */
  function probeRank(log, now = Date.now()) {
    const rank = { t: now, vod: {}, live: {}, br: {}, detail: {} };
    for (const [key, xs] of Object.entries(log)) {
      if (!xs.length) continue;
      const ok = xs.filter((x) => x.ok);
      const last = xs[xs.length - 1];
      const sc = median(xs.map((x) => x.sc));
      const br = median(ok.map((x) => x.br));
      (last.k === 'vod' ? rank.vod : rank.live)[key] = sc;
      if (br) rank.br[key] = br;
      rank.detail[key] = { h: last.h || key, k: last.k, c: last.c || '', qn: last.qn ?? null, sc, n: xs.length, ok: ok.length, tt: median(ok.map((x) => x.tt)), mbps: median(ok.map((x) => x.mbps)), br, t: last.t };
    }
    return rank;
  }

  // ---------------------------------------------------------------- 网络档案

  // 同一个网络下各节点的测速表现相当稳定（实测 08c / 08h 次次 10 Mbps 以上，cos 系次次 2 Mbps 左右），
  // 每次重启浏览器、换网络再换回来、或者超过 30 分钟没测，都从头测起太浪费，测速关着时「自动」更是什么都没有。
  // 所以按网络（见 cdn.js netKey）长期记下每个节点最近 12 次测速得分（7 天内）。以往的测速不直接拿来换节点：
  // 先复测以往最好的几个（见 verifyPick），测过还好才换（why: known）。换网络时换一份档案，换回来接着用。book：{ v, nets: { 网络: { t, label, lines: { 键: { k, x: [[t, 得分, 码率]] } }, proto } } }
  const BOOK = { keep: 12, maxAge: 7 * 86400e3, min: 3, nets: 6 };

  const netLabel = (n) => `${[n.country, n.province].filter(Boolean).join(' ')} / ${n.isp || ''}`;

  /** 记一次测速到网络档案（原地修改）。key 为 lineKey（见 route.js），k 为 vod / live-flv / live-hls，sc 为得分（失败为 0），br 为 HLS 码率。 */
  function bookAdd(book, net, key, k, sc, br, t, label) {
    if (!net) return;
    const e = (book.nets[net] ||= { t, lines: {} });
    if (label) e.label = label;
    e.t = Math.max(e.t || 0, t);
    const line = (e.lines[key] ||= { k, x: [] });
    line.k = k;
    line.x.push(br > 0 ? [t, sc, br] : [t, sc]);
    if (line.x.length > BOOK.keep) line.x.splice(0, line.x.length - BOOK.keep);
  }

  /** 去掉 7 天前的测速，网络只留最近用过的 6 个（原地修改并返回）。 */
  function bookPrune(book, now = Date.now()) {
    for (const [net, e] of Object.entries(book.nets)) {
      for (const [key, line] of Object.entries(e.lines || {})) {
        line.x = line.x.filter((x) => x[0] > now - BOOK.maxAge);
        if (!line.x.length) delete e.lines[key];
      }
      if (!Object.keys(e.lines || {}).length && !(e.proto && e.proto.length)) delete book.nets[net];
    }
    for (const [net] of Object.entries(book.nets).sort((a, b) => b[1].t - a[1].t).slice(BOOK.nets)) delete book.nets[net];
    return book;
  }

  /**
   * 一个网络的以往测速：每个键 7 天内最近几次得分的中位数（至少 3 次才算）。{ vod, live, br, n 次数, hls }。
   * hls：直播 HLS 按「编码 清晰度」（见 route.js cqOf）把各 host 的测速合在一起，每次得分 ÷ 码率的中位数 r 和次数 n（至少 3 次），
   * 开播选协议用（见 route.js knownHlsSlow）。
   */
  function bookKnown(entry, now = Date.now()) {
    const out = { vod: {}, live: {}, br: {}, n: {}, hls: {} };
    const ratios = {};
    for (const [key, line] of Object.entries((entry && entry.lines) || {})) {
      const xs = line.x.filter((x) => x[0] > now - BOOK.maxAge);
      // 0.4.1 以前的直播测速没记编码和清晰度（键只有 host），用不上
      if (line.k === 'live-hls' && key.includes(' ')) for (const x of xs) if (x[2] > 0) (ratios[key.slice(key.indexOf(' ') + 1)] ||= []).push(x[1] / x[2]);
      if (xs.length < BOOK.min) continue;
      (line.k === 'vod' ? out.vod : out.live)[key] = median(xs.map((x) => x[1]));
      const br = median(xs.map((x) => x[2]).filter((v) => v > 0));
      if (br) out.br[key] = br;
      out.n[key] = xs.length;
    }
    for (const [cq, rs] of Object.entries(ratios)) if (rs.length >= BOOK.min) out.hls[cq] = { r: median(rs), n: rs.length };
    return out;
  }

  /**
   * 本网络档案里从没测好过的点播节点：7 天内至少 3 次、最好的一次都不到档案里最好节点（得分中位数，见 bookKnown）的一半。
   * 只看中位数会误伤：高分组单次得分从 3 到 21 都有，按回放模拟，测差一次就停的话选中高分组的比例会掉下来。
   * 返回 { 键: 档案里上次测的时间 }，测速间隔见 probePick。
   */
  function bookSlow(entry, now = Date.now()) {
    const best = Math.max(0, ...Object.values(bookKnown(entry, now).vod));
    const out = {};
    for (const [key, line] of Object.entries((entry && entry.lines) || {})) {
      const xs = line.k === 'vod' ? line.x.filter((x) => x[0] > now - BOOK.maxAge) : [];
      if (xs.length >= BOOK.min && Math.max(...xs.map((x) => x[1])) < best * BACKOFF.ratio) out[key] = xs[xs.length - 1][0];
    }
    return out;
  }

  // 复测（见 sw.js verifySoon）：页面拿到播放地址时，测以往最好的两个和当前主节点里近 10 分钟没测过的
  const VERIFY = { top: 2, fresh: 10 * 60e3 };

  /**
   * 要复测的节点：以往测得最好的两个（avoid 的不算，如卡过的、PCDN）和当前主节点，近 10 分钟测过的不再测，当前主节点排第一个。
   * 以往最好的也比当前主节点好不了 20% 的，不用换，也就不测。
   * 同一台服务器的几个点播镜像名（same，见 sameServer）算一个：两个按服务器取，和当前主节点同一台的不测，组里 10 分钟内测过哪个名字都算测过。
   * cands：[{ key, h }]；cur：当前主节点的键；scores：以往测速（键 → 得分）；lastT(key)：上次测的时间。
   */
  function verifyPick(cands, cur, scores, avoid, lastT, now = Date.now(), same = {}) {
    const server = (c) => (same[c.h] ? same[c.h][0] : c.key);
    const peers = (c) => (same[c.h] ? cands.filter((x) => same[c.h].includes(x.h)) : [c]);
    const first = cands.find((c) => c.key === cur);
    const top = [];
    for (const c of cands.filter((c) => c.key !== cur && scores[c.key] > 0 && !avoid(c)).sort((a, b) => scores[b.key] - scores[a.key])) {
      if (top.length < VERIFY.top && !(first && server(c) === server(first)) && !top.some((x) => server(x) === server(c))) top.push(c);
    }
    if (!top.length || scores[top[0].key] < (scores[cur] || 0) * SWITCH_MARGIN) return [];
    const fresh = (c) => peers(c).some((x) => now - lastT(x.key) < VERIFY.fresh);
    // 当前主节点只看它自己（「自动」要拿它自己的得分比较）
    return [...(first && now - lastT(first.key) >= VERIFY.fresh ? [first] : []), ...top.filter((c) => !fresh(c))];
  }

  /**
   * 直播的复测：开播按以往测速改用 FLV 之后（见 route.js autoProto 的 known），HLS 就没人测了，档案一直停在「跟不上」。
   * 所以以往测速说这个直播间的 HLS 跟不上、它的 HLS 线路近 10 分钟又都没测过时，复测其中一条（avoid 的不选）：
   * HLS 变快了，档案跟着变，以后开播就不再改用 FLV。
   * cands：[{ key, k, c, qn }]；hk：以往的 HLS 测速（见 bookKnown 的 hls）。返回要复测的线路，不用测时为 null。
   */
  function liveRecheck(cands, hk, avoid, lastT, now = Date.now()) {
    const hls = cands.filter((c) => c.k === 'live-hls');
    if (!knownHlsSlow(hls.map((c) => cqOf(c.c, c.qn)), hk) || hls.some((c) => now - lastT(c.key) < VERIFY.fresh)) return null;
    return hls.find((c) => !avoid(c)) || null;
  }

  /** 从以往的记录建网络档案：每条测速按当时所在的网络（之前最近的 net 记录）记进去。升级到有网络档案的版本时用一次。 */
  function bookFromRecords(records, now = Date.now()) {
    const book = { v: 1, nets: {} };
    let net = null;
    for (const r of records) {
      if (r.ty === 'net') net = cdn.mergeNet(net, r);
      else if (r.ty === 'probe' && net && r.h && r.k) bookAdd(book, cdn.netKey(net), lineKey(r.h, r.c, r.qn), r.k, probeScore(r), r.br, r.t, netLabel(net));
    }
    return bookPrune(book, now);
  }

  // ---------------------------------------------------------------- 测速候选

  // 页面从播放信息里取出测速地址（见 route.js probeTargets）交给 SW，SW 在这里排出候选、定取数范围

  /**
   * 签名地址的过期时间（毫秒）：点播为 deadline，直播为 expires（Unix 秒），没有时为 0。
   * 实测 B 站给的直播地址 1 小时、点播 2 小时有效，过期后还拿它测速，各节点都会失败、记 0 分。
   */
  function urlExpiry(url) {
    let q;
    try {
      q = new URL(url).searchParams;
    } catch {
      return 0;
    }
    const v = Number(q.get('deadline') || q.get('expires'));
    return v > 0 ? v * 1000 : 0;
  }

  /** 点播测速的取数范围：文件够大时随机取中间一段，否则取开头。 */
  function probeRange(size, bytes, rand = Math.random) {
    const room = Math.floor(size * 0.9) - bytes;
    const start = room > bytes ? bytes + Math.floor(rand() * (room - bytes)) : 0;
    return `bytes=${start}-${start + bytes - 1}`;
  }

  /** 点播测速候选：分配里各节点自己的地址，加上把 UPOS 地址换到各镜像。 */
  function vodCandidates(urls) {
    const own = new Map(urls.map((u) => [cdn.hostOf(u), u]));
    const tpl = urls.find((u) => isUpos(cdn.hostOf(u)));
    if (tpl) for (const h of UPOS_MIRRORS) if (!own.has(h)) own.set(h, swapHost(tpl, h));
    return [...own].map(([h, url]) => ({ h, k: 'vod', url }));
  }

  const api = { UPOS_MIRRORS, PROBE_GATE, BACKOFF, CADENCE, BOOK, VERIFY, SAME_SERVER, probeGate, updateBackoff, probePick, restUntil, verifyPick, liveRecheck, netLabel, bookAdd, bookPrune, bookKnown, bookSlow, bookFromRecords, netOf, noteServer, pruneServers, sameServer, probeScore, parseM3u8, probeRank, urlExpiry, probeRange, vodCandidates };
  if (node) module.exports = api;
  else root.__bilicdn = Object.assign(root.__bilicdn || {}, api);
})(globalThis);
