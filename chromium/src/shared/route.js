// SPDX-License-Identifier: AGPL-3.0-or-later
// 线路切换（M2）：按设置、测速结果和近期卡顿改写播放地址，以及改写要用的卡顿证据汇总、测速结果的键和取测速地址。
// 点播：同一个地址可以换到其他 UPOS 镜像（路径和签名通用），也可以把分配里的备用节点提到前面；
// 直播：换 host 会 403 / 404，只能在 B 站给的线路之间选：只保留 FLV 或 HLS，并按测速排列同一线路的 host。
// “自动”模式避开近期出过问题（卡顿、起播慢、请求失败、手动标记）的节点（见 troubleOf），PCDN 排在官方节点后面；
// 点播主节点在页面上表现好（首字节低、没失败，见 perfGood）就不按测速换走，测速只测过一两次的节点也不换过去（见 PROBE_MIN）。
// 原来的地址都留作备用，换过去的节点不可用时播放器会自己退回。
// 另有「关闭 B 站 P2P」（测试功能，默认不改）用的两处改写：点播的 fawkes 配置、直播分配里的 p2p_data（见文件末尾）。
// 测速本身（得分和排名、测速时机、复测、网络档案、同一台服务器分组）只有 SW 和扩展页面用，在 probe.js，不注入页面。
// 经典脚本，MAIN world（hook.js）、service worker、扩展页面和 Node 测试共用。
(function (root) {
  'use strict';

  const node = typeof module === 'object' && module.exports;
  const cdn = node ? require('./cdn.js') : root.__bilicdn;
  // 播放信息的结构查找在 playinfo.js，只在改写、取测速地址时用到（SW 和扩展页面不加载它），所以用到时再取。
  // 要先拿住共享对象：hook.js 加载后会删掉这个全局变量
  const shared = node ? require('./playinfo.js') : root.__bilicdn;
  const later = (name) => (...args) => shared[name](...args);
  const findKey = later('findKey');
  const urlsOf = later('urlsOf');
  const vodTracks = later('vodTracks');
  const streamHolder = later('streamHolder');
  const liveLines = later('liveLines');

  /** 地址可以互换的 UPOS 镜像（Akamai 的签名参数不同，PCDN 带端口，都不能换）。 */
  const isUpos = (h) => /^upos-[a-z0-9-]+\.bilivideo\.com$/.test(h);

  // 自动选择时，新节点的得分至少要比当前节点高这么多才切换，避免来回切
  const SWITCH_MARGIN = 1.2;
  // 测速排名超过这么久没更新就不再用（关了测速、或者换了网络还没测）
  const RANK_MAX_AGE = 30 * 60e3;
  // 按测速换过去的点播节点，近 30 分钟里至少要测过这么多次（定时测速和复测，探查的不算，见 probe.js probeRank 的 n）。
  // 单次测速很不稳：实测有一处探查时 estghw 测了一次 26.2 分，「自动」就把播放时首字节 16 ms 的 cosov 换了过去。
  // 网络档案里有 3 次以上（见 probe.js bookKnown 的 n）、近 30 分钟又复测过的也算：以往测过多次，这次复测确认还好
  // 页面上用过、表现好的（见 perfGood）也算：页面上几十个真实请求比几次测速可靠
  const PROBE_MIN = 3;

  // ---------------------------------------------------------------- 近期卡顿

  // 卡顿证据：SW 把每次出问题时在用的节点记一条 { t, h, p: 线路 vod / flv / hls, w: 权重 }。
  // 近 30 分钟内权重合计到 2 就算“出过问题”：一次较多卡顿的手动标记、两次卡顿、一次没能起播等
  const TROUBLE = { keep: 30 * 60e3, bad: 2 };

  /** 近期各节点出问题的权重，按线路分开：{ vod: { host: w }, flv: {...}, hls: {...} }。 */
  function troubleOf(list, now = Date.now()) {
    const out = { vod: {}, flv: {}, hls: {} };
    for (const x of Array.isArray(list) ? list : []) {
      if (!x || !out[x.p] || !(x.t > now - TROUBLE.keep) || !(x.w > 0)) continue;
      out[x.p][x.h] = (out[x.p][x.h] || 0) + x.w;
    }
    return out;
  }

  const isBad = (weights, h) => ((weights && weights[h]) || 0) >= TROUBLE.bad;

  // 直播协议的卡顿证据：SW 还按“协议 + 清晰度”记一份 { t, p: flv / hls, qn, w }（卡顿、标记、HLS 下载占满），保留 12 小时。
  // HLS 在一种清晰度上跟不上码率时，换个直播间、换个 host 一样跟不上（实测 HLS 原画的直播间个个都卡，FLV 原画不卡），
  // 按 host 记、30 分钟过期的话，每进一个新直播间都要重新卡上好几分钟才会换。合计到 3 就改用另一种协议（见 autoProto）
  const PROTO_TROUBLE = { keep: 12 * 3600e3, bad: 3 };

  /** 某个清晰度上两种协议近 12 小时的卡顿权重：{ flv, hls }。 */
  function protoTroubleOf(list, qn, now = Date.now()) {
    const out = { flv: 0, hls: 0 };
    for (const x of Array.isArray(list) ? list : []) {
      if (x && x.p in out && x.qn === qn && x.t > now - PROTO_TROUBLE.keep && x.w > 0) out[x.p] += x.w;
    }
    return out;
  }

  // ---------------------------------------------------------------- 页面上的表现

  // 测速和播放测的不是一回事：测速为了避开边缘缓存，取文件中间随机一段冷数据、一次 512 KB；播放顺序取热数据，请求中位数只有几十 KB。
  // 2026-10-29 在四个地区的测试服务器上用真实浏览器实测（见 docs/field-playback-2026-10-29.md）：一处 B 站分配的 cosov 播放时首字节 16 ms，
  // 测速只有 25.7 分，「自动」按测速换到 estghw 后 21 个请求 9 个失败、起播 1.8 → 7.8 秒；另一处 B 站分配的本地自建边缘播放时 22~27 ms，测速 15.5 分，排在一串镜像后面。
  // 所以 SW 按 host 记下页面实际请求的首字节和成败（见 sw.js notePerf），存在 storage.local 的 perf，页面改写时看（见 pickVod）：
  // 近 30 分钟至少 5 个请求、首字节中位数不超过 60 ms、失败不到 10% 的，算「页面上表现好」：离得近、命中缓存的边缘节点，按测速换不出更好的。
  // 还有一处 cosov 播放时 93 ms，不算，照样按测速换到 Akamai（换过去 14 ms、起播 1.1~1.4 → 0.5~0.6 秒）。
  // 吞吐不看：实测的请求大多不到 512 KB，算不出；真跟不上会卡，卡顿证据照样会把它换掉（见 troubleOf）。
  // 每个 host 留最近 40 个请求 [t, 首字节 ms（没等到响应头为 null）, 失败为 1]
  const PERF = { keep: 30 * 60e3, max: 40, min: 5, tt: 60, err: 0.1 };

  /**
   * 一条请求记录（见 sw.js baseRec）在页面表现里记成 [t, tt, f]：只记点播、不是 PCDN、不是浏览器缓存直接答复的（见 cdn.js cacheHit）；
   * 没等到响应头、也不算失败的（用户拖动时中止之类）不记。不记的返回 null。
   */
  function perfEntry(r) {
    if (!r || r.ty !== 'req' || cdn.lineOf(r.k) !== 'vod' || cdn.isPcdnReq(r) || cdn.cacheHit(r)) return null;
    const f = cdn.isFailure(r) ? 1 : 0;
    return f || r.tt != null ? [r.t, r.tt ?? null, f] : null;
  }

  /**
   * 近 30 分钟（keep）各点播 host 在页面上的表现：{ host: { n 请求数, tt 首字节中位数（ms）, f 失败数 } }。log：{ host: [[t, tt, f]] }（见 perfEntry）。
   * 统计页的节点分布按整个统计范围算（keep 为 Infinity）。
   */
  function perfOf(log, now = Date.now(), keep = PERF.keep) {
    const out = {};
    for (const [h, xs] of Object.entries(log && typeof log === 'object' ? log : {})) {
      const recent = Array.isArray(xs) ? xs.filter((x) => Array.isArray(x) && x[0] > now - keep) : [];
      if (!recent.length) continue;
      const tt = cdn.quantile(recent.map((x) => x[1]), 0.5);
      out[h] = { n: recent.length, tt: tt === null ? null : Math.round(tt), f: recent.filter((x) => x[2]).length };
    }
    return out;
  }

  const perfSeen = (p) => !!p && p.n >= PERF.min;

  /** 页面上表现好（见 PERF）。p 为 perfOf 里的一项。 */
  const perfGood = (p) => perfSeen(p) && p.tt != null && p.tt <= PERF.tt && p.f < p.n * PERF.err;

  /**
   * 页面上 p 比 than 差：p 的请求够数，失败到 10%，或者首字节中位数比 than 慢 20% 以上（than 也要够数）。
   * 测速说好、换过去页面上却不好的（实测换到 estghw 后近一半请求失败），不再按测速换过去。
   */
  const perfWorse = (p, than) => perfSeen(p) && (p.f >= p.n * PERF.err || (perfSeen(than) && p.tt != null && than.tt != null && p.tt > than.tt * SWITCH_MARGIN));

  // ---------------------------------------------------------------- 测速结果的键

  // 页面里改写时按它们查测速得分，SW 记测速、建网络档案也用（见 probe.js）
  /**
   * 测速记录的键：点播为 host；直播为 host + 编码 + 清晰度（qn）。
   * 同一个直播 host 上 avc / hevc、原画 / 超清的码率差好几倍，混在一起算得分和码率会乱跳，换了清晰度也会拿别的清晰度的结果来判断
   */
  const lineKey = (h, codec, qn) => (codec || qn ? `${h} ${codec || ''} ${qn ?? ''}` : h);

  /** 测速记录键里「编码 清晰度」那一段（见 lineKey）。 */
  const cqOf = (codec, qn) => `${codec || ''} ${qn ?? ''}`;

  // ---------------------------------------------------------------- 点播

  function setUrls(s, [base, ...backup]) {
    for (const k of ['baseUrl', 'base_url', 'url']) if (typeof s[k] === 'string') s[k] = base;
    for (const k of ['backupUrl', 'backup_url']) if (k in s) s[k] = backup;
    if (!('backupUrl' in s) && !('backup_url' in s)) s[s.url ? 'backup_url' : 'backupUrl'] = backup;
  }

  function swapHost(url, host) {
    const u = new URL(url);
    u.host = host;
    return u.href;
  }

  /** 分配里出现的 host，按当主地址的次数排在前面；第一个就是 B 站分配的主节点。 */
  function vodHosts(tracks) {
    const count = new Map();
    for (const s of tracks) urlsOf(s).forEach((u, i) => {
      const h = cdn.hostOf(u);
      count.set(h, (count.get(h) || 0) + (i === 0 ? 1000 : 1));
    });
    return [...count].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  }

  /**
   * 选点播目标节点，返回 { to, why }，不需要换时返回 null。why：set 指定的节点；
   * trouble 当前主节点近期出过问题、pcdn 当前主节点是 PCDN：换到页面上表现好的（首字节最低的），没有就换到测速最好的、没出过问题的官方节点，
   * 再没有就按分配顺序换到下一个；probe 测速得分比当前主节点高 20% 以上。
   * 当前主节点在页面上表现好（见 perfGood）就不按测速换。按测速换过去的节点要有近 30 分钟的测速，而且测过几次或者页面上表现好（见 PROBE_MIN；
   * 以往的测速只用来挑要复测的节点，见 probe.js verifyPick，探查的单次结果只用来挑候选），页面上用过、比当前主节点差的不选（见 perfWorse）；
   * 当前主节点只有以往测速时拿它比较，记为 known。“自动”不会选中出过问题的节点和 PCDN，没有可换的就不换。
   * pcdn：分配里指向 PCDN 的 host（见 cdn.isPcdnUrl，有的看 os=mcdn 参数才认得出）。
   */
  function pickVod(own, cfg, pcdn = new Set()) {
    const cur = own[0];
    const canSwap = own.some(isUpos);
    const usable = (h) => own.includes(h) || (canSwap && isUpos(h));
    if (cfg.vod && cfg.vod !== 'auto') return cfg.vod !== cur && usable(cfg.vod) ? { to: cfg.vod, why: 'set' } : null;
    const scores = (cfg.rank && cfg.rank.vod) || {};
    const bad = (cfg.bad && cfg.bad.vod) || {};
    const perf = cfg.perf || {};
    const isPcdn = (h) => pcdn.has(h) || cdn.isPcdnHost(h);
    const ok = (h) => usable(h) && !isBad(bad, h) && !isPcdn(h);
    const old = (h) => !!(cfg.old && cfg.old.vod(h)); // 只有以往测速、近期没测过的
    // 测过几次了；页面上用过、表现好的也算：几十个真实请求比几次测速可靠（实测一处 Akamai 只测过一次，页面上 38 个请求首字节 20 ms，主节点 97 ms）
    const sure = (h) => !!(cfg.sure && cfg.sure.vod(h)) || perfGood(perf[h]);
    // 测速最好的：than 为比较的主节点，页面上比它差的不选；出过问题、PCDN 的主节点不比首字节，只看失败
    const bestOf = (than) => {
      let best = null;
      for (const [h, sc] of Object.entries(scores)) if (ok(h) && !old(h) && sure(h) && sc > 0 && !perfWorse(perf[h], than) && (best === null || sc > scores[best])) best = h;
      return best;
    };
    const why = isBad(bad, cur) ? 'trouble' : isPcdn(cur) ? 'pcdn' : null;
    if (why) {
      const good = Object.keys(perf).filter((h) => ok(h) && perfGood(perf[h])).sort((a, b) => perf[a].tt - perf[b].tt);
      const to = good[0] || bestOf(null) || own.find(ok);
      return to ? { to, why } : null;
    }
    if (perfGood(perf[cur])) return null; // 页面上表现好，测速再高也不换
    if (!(cur in scores)) return null; // 当前节点还没测过，不知道换了会不会更好
    const best = bestOf(perf[cur]);
    return best && best !== cur && scores[best] >= scores[cur] * SWITCH_MARGIN ? { to: best, why: old(cur) ? 'known' : 'probe' } : null;
  }

  // 备用地址的档次（见 rewriteVod / rewriteLive）：0 官方 / 1 PCDN / 2 近期出过问题，排序时小的在前。
  // 只排了备用地址时，原因按被挪到后面的地址里最重的一档记；直播同一档里按得分排的记为按测速
  const TIER_WHY = ['probe', 'pcdn', 'trouble'];

  /** 排序时被挪到后面的地址里最重的一档：后面有更靠前档次的才算被挪。没有时为 0。 */
  const demoted = (list, tier) => Math.max(0, ...list.map((u, i) => (list.slice(i + 1).some((v) => tier(v) < tier(u)) ? tier(u) : 0)));

  const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  /**
   * 改写点播地址（原地修改）：目标节点放到每条轨道的第一个，原来的地址留作备用。
   * 备用地址按原顺序，但 PCDN 排到官方节点后面、近期出过问题的节点排到最后：换过去的节点出错时播放器按顺序退回，
   * 换到镜像时原来是 [镜像, 刚避开的原主节点, 其他备用]，第一个退回的就是刚避开的节点。
   * 不换主节点（没有更好的，或者指定的就是主节点）时备用地址也照样排：B 站分配的 [官方主节点, PCDN, 官方备用]
   * 原样留着的话，主节点出错时播放器先退回 PCDN。这种只排了备用地址的记 bk（没有 from / to，不算换了主节点）。
   */
  function rewriteVod(json, cfg) {
    const tracks = vodTracks(json);
    if (!tracks.length) return null;
    const own = vodHosts(tracks);
    const pcdn = new Set(tracks.flatMap(urlsOf).filter(cdn.isPcdnUrl).map(cdn.hostOf));
    const pick = pickVod(own, cfg, pcdn);
    const to = pick && pick.to;
    const bad = (cfg.bad && cfg.bad.vod) || {};
    const tier = (u) => (isBad(bad, cdn.hostOf(u)) ? 2 : cdn.isPcdnUrl(u) ? 1 : 0);
    let n = 0;
    let moved = 0; // 换了主地址的轨道数
    let order = 0; // 只排了备用地址的轨道里被挪到后面的最重的一档
    for (const s of tracks) {
      const urls = urlsOf(s);
      if (!urls.length) continue;
      let first = to ? urls.find((u) => cdn.hostOf(u) === to) : urls[0];
      // 换镜像的模板优先用不是 PCDN 的 UPOS 地址
      const tpl = urls.find((u) => isUpos(cdn.hostOf(u)) && !cdn.isPcdnUrl(u)) || urls.find((u) => isUpos(cdn.hostOf(u)));
      if (!first && isUpos(to) && tpl) first = swapHost(tpl, to);
      // 这条轨道换不到目标节点（目标不是 UPOS、轨道里也没有它）：主地址不动，备用照样排
      first ||= urls[0];
      const rest = urls.filter((u) => u !== first);
      const next = [first, ...[...rest].sort((a, b) => tier(a) - tier(b))];
      if (sameOrder(next, urls)) continue;
      if (first !== urls[0]) moved += 1;
      else order = Math.max(order, demoted(rest, tier));
      setUrls(s, next);
      n += 1;
    }
    if (!n) return null;
    return moved ? { kind: 'vod', from: own[0], to, n, why: pick.why } : { kind: 'vod', bk: 1, n, why: TIER_WHY[order] };
  }

  // ---------------------------------------------------------------- 直播

  // 网页播放器能放的直播格式：FLV 和 HLS 的 fmp4。实测只给 HLS 的 ts 时播放器拉不到流，最后放一段占位视频
  const PLAYABLE = { flv: { p: 'http_stream', f: 'flv' }, hls: { p: 'http_hls', f: 'fmp4' } };
  const protoOf = (st, f) => Object.keys(PLAYABLE).find((k) => PLAYABLE[k].p === st.protocol_name && PLAYABLE[k].f === f.format_name);

  // HLS 的可持续速率至少要有码率的这么多倍才算跟得上。直播缓冲只有一两秒，首字节时间一波动就卡：
  // 实测原画得分在码率的 1.0~1.2 倍之间时照样频繁卡顿（之前按 1.1 倍判断，「自动」留在了 HLS）
  const HLS_HEADROOM = 1.3;

  // 开播按以往测速选协议时，HLS 的得分至少要有码率的这么多倍才算跟得上，比按近期测速判断（HLS_HEADROOM）严：
  // 单次测速很不稳（同一时段得分 ÷ 码率从 0.3 到 8 都有），实测 03:15 那 5 分钟 HLS 每分钟卡 9~15 次，测速的中位数却有码率的 1.33 倍；
  // 选错成 FLV 只是起播可能慢一点，选错成 HLS 就一直卡
  const HLS_KNOWN_HEADROOM = 1.5;

  /**
   * 本网络以往的测速说这个直播间的 HLS 跟不上：HLS 线路涉及的每种「编码 清晰度」，以往测过的都不到码率的 1.5 倍。
   * 各 host 合在一起看：HLS 慢在取每个新分片都要等很久，不在 host（实测 207 / 207b 解析到同一个 IP，各直播间一样慢）。
   * 同一清晰度不同直播间的码率不一样（原画实测 6~10 Mbps），码率低的直播间可能其实跟得上；只往 FLV 那边用，选错代价小。
   * cqs：这个直播间 HLS 线路的 cqOf；hk：以往的 HLS 测速（见 probe.js bookKnown 的 hls）。
   */
  function knownHlsSlow(cqs, hk) {
    const past = [...new Set(cqs)].map((cq) => hk && hk[cq]).filter(Boolean);
    return past.length > 0 && past.every((x) => x.r < HLS_KNOWN_HEADROOM);
  }

  /**
   * 自动模式选协议，返回 { proto, why }，不用换时返回 null：
   * - trouble：近期一种协议的 host 全都出过问题，另一种还有没出过问题的 host，改用另一种；
   *   协议级证据：近 12 小时里一种协议在这个清晰度上卡顿权重到 3、另一种没有，也改用另一种（见 PROTO_TROUBLE）；
   * - probe：HLS 一个分片一个分片地取，测速得出的可持续速率跟不上码率时改用 FLV（一条长连接，只等一次首字节）。
   *   只用同一编码、同一清晰度的测速结果；测过的 HLS 线路（各编码）都跟不上才换。
   * - known：近期没有证据时，本网络以往的测速说这个直播间的 HLS 跟不上（见 knownHlsSlow），开播就用 FLV。
   *   只往 FLV 那边用：以往说跟得上，不会因此从 FLV 换回 HLS。
   * 不直接比较两者的得分：FLV 测的是直播流，读的速度受码率限制，口径不同。
   * pw：这个清晰度上两种协议的卡顿权重（见 protoTroubleOf）；hk：以往的 HLS 测速（见 probe.js bookKnown 的 hls）。
   */
  function autoProto(streams, rank, bad, pw = { flv: 0, hls: 0 }, hk = {}) {
    const scores = rank.live || {};
    const br = rank.br || {};
    const hosts = { flv: [], hls: [] };
    const hlsKeys = [];
    const cqs = [];
    for (const { st, f, c } of liveLines(streams)) {
      const k = protoOf(st, f);
      if (k === 'hls') cqs.push(cqOf(c.codec_name, c.current_qn));
      for (const u of k ? c.url_info || [] : []) {
        hosts[k].push(cdn.hostOf(u.host));
        if (k === 'hls') hlsKeys.push(lineKey(cdn.hostOf(u.host), c.codec_name, c.current_qn));
      }
    }
    const allBad = (k) => hosts[k].length > 0 && hosts[k].every((h) => isBad(bad[k], h));
    const usable = (k) => hosts[k].length > 0 && !allBad(k);
    const measured = hlsKeys.filter((key) => scores[key] != null && br[key] > 0);
    const hlsSlow = measured.length > 0 && measured.every((key) => scores[key] < br[key] * HLS_HEADROOM);
    const protoBad = (k) => pw[k] >= PROTO_TROUBLE.bad;
    if (usable('flv') && allBad('hls')) return { proto: 'flv', why: 'trouble' };
    if (usable('hls') && allBad('flv') && !hlsSlow) return { proto: 'hls', why: 'trouble' };
    if (usable('flv') && hosts.hls.length && protoBad('hls') && !protoBad('flv')) return { proto: 'flv', why: 'trouble' };
    if (usable('hls') && hosts.flv.length && protoBad('flv') && !protoBad('hls') && !hlsSlow) return { proto: 'hls', why: 'trouble' };
    if (usable('flv') && hlsSlow) return { proto: 'flv', why: 'probe' };
    return usable('flv') && hosts.hls.length && knownHlsSlow(cqs, hk) ? { proto: 'flv', why: 'known' } : null;
  }

  /** 直播当前的清晰度（各条线路的 current_qn 相同）。 */
  function liveQn(streams) {
    for (const { c } of liveLines(streams)) if (c.current_qn != null) return c.current_qn;
    return null;
  }

  /** 只保留一种能放的格式。B 站没给这种格式时不改（不能把能放的都删掉）。 */
  function keepOnly(holder, k) {
    const { p, f } = PLAYABLE[k];
    const kept = [];
    for (const st of holder.stream) {
      if (st.protocol_name !== p) continue;
      const format = (st.format || []).filter((x) => x.format_name === f);
      if (format.length) kept.push({ ...st, format });
    }
    if (!kept.length || JSON.stringify(kept) === JSON.stringify(holder.stream)) return false;
    holder.stream = kept;
    return true;
  }

  // 改写原因的轻重：一次改写里既换了协议又排了 host 时，记最重的那个
  const WHY = { set: 0, known: 1, probe: 2, pcdn: 3, trouble: 4 };

  /**
   * 改写直播地址（原地修改）：只保留选中的格式；同一线路里 PCDN 排到官方 host 后面、近期出过问题的 host 排到最后，
   * 都测过速时同一档里按得分排列。host 的排列不受直播线路设置影响（指定了 FLV / HLS 也排）。
   * 第一个 host 不变时后面的照样排；没换协议、各线路第一个 host 都没变的，记 bk（只排了备用 host，见 rewriteVod）。
   */
  function rewriteLive(json, cfg) {
    const holder = streamHolder(json);
    if (!holder) return null;
    const rank = cfg.rank || {};
    const scores = rank.live || {};
    const bad = cfg.bad || {};
    const out = { kind: 'live' };
    const why = (w) => (!out.why || WHY[w] > WHY[out.why]) && (out.why = w);
    const pw = protoTroubleOf(cfg.proto, liveQn(holder.stream), cfg.now);
    const hk = (cfg.known && cfg.known.hls) || {};
    const pick = PLAYABLE[cfg.live] ? { proto: cfg.live, why: 'set' } : cfg.live === 'auto' || !cfg.live ? autoProto(holder.stream, rank, bad, pw, hk) : null;
    if (pick && keepOnly(holder, pick.proto)) {
      out.proto = pick.proto;
      why(pick.why);
    }
    let order = -1; // 只排了备用 host 的线路里被挪到后面的最重的一档
    for (const { st, f, c } of liveLines(holder.stream)) {
      const ui = c.url_info || [];
      const k = protoOf(st, f);
      const hurt = (u) => (k && isBad(bad[k], cdn.hostOf(u.host)) ? 1 : 0);
      const pcdn = (u) => cdn.isPcdnHost(cdn.hostOf(u.host)) || /[?&]os=mcdn(&|$)/.test(u.extra || '');
      const tier = (u) => (hurt(u) ? 2 : pcdn(u) ? 1 : 0);
      const keyOf = (u) => lineKey(cdn.hostOf(u.host), c.codec_name, c.current_qn);
      const score = (u) => scores[keyOf(u)];
      const measured = ui.every((u) => score(u) != null);
      if (ui.length < 2 || !(measured || ui.some(tier))) continue;
      const sorted = [...ui].sort((a, b) => tier(a) - tier(b) || (measured ? score(b) - score(a) : 0));
      if (sameOrder(sorted, ui)) continue;
      c.url_info = sorted;
      if (sorted[0] === ui[0]) {
        order = Math.max(order, demoted(ui, tier));
        continue;
      }
      out.from = cdn.hostOf(ui[0].host);
      out.to = cdn.hostOf(sorted[0].host);
      why(hurt(ui[0]) ? 'trouble' : tier(ui[0]) > tier(sorted[0]) ? 'pcdn' : 'probe');
    }
    if (out.proto || out.to) return out;
    return order >= 0 ? { kind: 'live', bk: 1, why: TIER_WHY[order] } : null;
  }

  /**
   * 按设置改写一份播放信息（原地修改）。返回改了什么，没改返回 null。
   * cfg：{ on, vod, live, rank, known, trouble, proto, perf }（见 bridge.js）；过期的测速排名不用。
   * 网络档案里本网络以往的测速（known，见 probe.js bookKnown）：点播只给当前主节点作比较用，换过去的节点要有近期的测速（见 pickVod）；
   * 直播用它判断 HLS 跟不跟得上，跟不上开播就用 FLV（见 autoProto）。
   * 测过几次：rank.n 为近 30 分钟各点播节点的测速次数（探查的不算），known.n 为网络档案里的次数（见 PROBE_MIN）。
   * perf：页面实际请求的表现（见 perfOf），点播「自动」用。
   */
  function rewritePlayInfo(json, cfg, now = Date.now()) {
    if (!cfg || !cfg.on || !json || typeof json !== 'object') return null;
    const fresh = cfg.rank && cfg.rank.t > now - RANK_MAX_AGE ? cfg.rank : {};
    const known = cfg.known || {};
    const merge = (k) => ({ ...(known[k] || {}), ...(fresh[k] || {}) });
    const rank = { vod: merge('vod'), live: fresh.live || {}, br: fresh.br || {} };
    const old = (h) => !(fresh.vod && h in fresh.vod) && !!known.vod && h in known.vod;
    const times = (h) => (fresh.n && fresh.n[h]) || 0;
    const sure = (h) => times(h) >= PROBE_MIN || (times(h) >= 1 && ((known.n && known.n[h]) || 0) >= PROBE_MIN);
    const c = { ...cfg, rank, old: { vod: old }, sure: { vod: sure }, bad: troubleOf(cfg.trouble, now), perf: perfOf(cfg.perf, now), now };
    return streamHolder(json) ? rewriteLive(json, c) : rewriteVod(json, c);
  }

  // ---------------------------------------------------------------- 测速目标

  /**
   * 从播放信息里取测速用的地址（要在改写之前取）。
   * 点播：一条视频轨在各节点上的地址；直播：每条线路每个 host 的地址，带编码 c 和清晰度 qn（测速结果按它们分开记）。
   * 地址带签名，只在内存里用，不写进记录。
   */
  function probeTargets(json) {
    const holder = streamHolder(json);
    if (holder) {
      const lines = [];
      for (const { st, f, c } of liveLines(holder.stream)) {
        const k = protoOf(st, f); // 播放器放不了的格式（HLS ts）不测
        for (const u of k ? c.url_info || [] : []) {
          if (lines.length >= 8) break;
          lines.push({ h: cdn.hostOf(u.host), k: k === 'flv' ? 'live-flv' : 'live-hls', fmt: f.format_name, c: c.codec_name, qn: c.current_qn, url: u.host + c.base_url + u.extra });
        }
      }
      return lines.length ? { kind: 'live', lines } : null;
    }
    const tracks = vodTracks(json);
    const track = tracks.find((s) => urlsOf(s).length > 1) || tracks[0];
    const urls = track ? urlsOf(track) : [];
    if (!urls.length) return null;
    // size：按码率和时长估算的文件大小，测速时随机取文件中间的一段（开头那段多半已经缓存在 CDN 边缘，测出来偏快）
    const dur = findKey(json, 'duration', (v) => typeof v === 'number' && v > 0, 14);
    const size = track.bandwidth > 0 && dur ? Math.floor((track.bandwidth * dur) / 8) : 0;
    return { kind: 'vod', urls, ...(size ? { size } : {}) };
  }

  // ---------------------------------------------------------------- 关闭 B 站 P2P（测试功能）
  // 设置 p2p 选「关闭」（'off'，默认 'site' 不改）时用，hook.js 调。大陆网络下 B 站网页播放器的大部分点播、直播数据走它自己的 P2P
  // （WebRTC 数据通道），扩展看不到，还占上传和磁盘（见 docs/mainland-p2p-2026-10-29.md）。这里只按 B 站播放器自己的开关让它改走 HTTP，
  // 不删 WebRTC 接口（直播播放器会报「Browser not supported」再退回 HTTP，影响面太大）。B 站改了配置名、格式，这里就不起作用，等于不改。

  // 点播：播放器从 localStorage 的 bilibili_player_dash_fawkes_config 读配置（JSON，键是 dash_config.nc_disable 这种带点的平铺写法，
  // 值是 base64），第一次读时缓存。Math.random() 不小于 nc_disable 才用 B 站的 P2P（NC），不小于 rp_disable 才用 P2P 上传（捐献），
  // p2p_disable 管老的第三方 P2P；B 站下发的都是 0.001，即 99.9% 的页面用。改成 2 就都不用：2026-10-29 在大陆实测，
  // 三个都改成 2 后点播 P2P 0 字节、全部走 HTTP，首帧没变慢。本机网络读的 2026-10-29 的配置也是这三个键、这种写法
  const FAWKES_NO_P2P = ['dash_config.nc_disable', 'dash_config.rp_disable', 'dash_config.p2p_disable'];
  const FAWKES_TWO = 'Mg=='; // base64 的 "2"

  /**
   * 播放器读到的 fawkes 配置（localStorage 里的原文，没有时为 null）改成不用 P2P 的，返回给播放器的原文。
   * 没有配置（全新的浏览器配置第一次打开）时也给一份只有这三项的：播放器按自己的默认值（nc_disable 为 0，总用 P2P）补齐别的项。
   * 不是 JSON 对象（B 站改了格式）就原样返回
   */
  function fawkesNoP2P(raw) {
    let cfg = {};
    if (raw != null) {
      try {
        cfg = JSON.parse(raw);
      } catch {
        return raw;
      }
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return raw;
      if (FAWKES_NO_P2P.every((k) => cfg[k] === FAWKES_TWO)) return raw;
    }
    const out = { ...cfg };
    for (const k of FAWKES_NO_P2P) out[k] = FAWKES_TWO;
    return JSON.stringify(out);
  }

  /**
   * 直播：播放器按分配里的 p2p_data.p2p_type 选（1 = HLS 加 P2P，-1 = HLS 不用 P2P，0 = 不用 B 站的 HLS 播放器），只有 HLS 用 P2P。
   * P2P 的类型（大于 0）改成 -1、p2p 改成 false（原地修改），和页面地址参数 wpdP2PType=-1 一样：2026-10-29 在大陆实测，
   * 设成 -1 后没有 WebRTC 连接，全部走 HTTP，上传 47 → 1 MB，起播没变慢。0 和 -1 不改：0 不走 P2P，改成 -1 会换播放方式。返回改了没有
   */
  function liveNoP2P(json) {
    const holder = streamHolder(json);
    const d = holder && holder.p2p_data;
    if (!d || typeof d !== 'object') return false;
    let changed = false;
    if (typeof d.p2p_type === 'number' && d.p2p_type > 0) {
      d.p2p_type = -1;
      changed = true;
    }
    if (d.p2p === true) {
      d.p2p = false;
      changed = true;
    }
    return changed;
  }

  const api = { SWITCH_MARGIN, RANK_MAX_AGE, PROBE_MIN, TROUBLE, PROTO_TROUBLE, PERF, HLS_HEADROOM, HLS_KNOWN_HEADROOM, knownHlsSlow, cqOf, troubleOf, protoTroubleOf, isBad, perfEntry, perfOf, perfGood, perfWorse, isUpos, swapHost, lineKey, rewritePlayInfo, rewriteVod, rewriteLive, probeTargets, FAWKES_NO_P2P, fawkesNoP2P, liveNoP2P };
  if (node) module.exports = api;
  else root.__bilicdn = Object.assign(root.__bilicdn || {}, api);
})(globalThis);
