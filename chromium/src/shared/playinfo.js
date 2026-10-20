// SPDX-License-Identifier: GPL-3.0-or-later
// 从各种播放接口 / 首屏数据里提取 CDN 分配情况。
// 各页面的数据嵌套层级不同（playurl、pgc、__NEPTUNE_IS_MY_WAIFU__、__NEXT_DATA__），
// 所以按数据形状查找，而不是写死路径。线路改写（route.js）也用这里的查找函数，记下的分配和改写的才是同一批轨道和线路。
(function (root) {
  'use strict';

  const cdn = typeof module === 'object' && module.exports ? require('./cdn.js') : root.__bilicdn;
  const hasOwn = Object.prototype.hasOwnProperty;

  /** 深度优先查找第一个持有 key、且 obj[key] 通过 test 的对象。改写直播地址要整体替换 stream 数组，所以要父对象。 */
  function findOwner(obj, key, test, depth) {
    if (!obj || typeof obj !== 'object' || depth < 0) return null;
    if (hasOwn.call(obj, key) && test(obj[key])) return obj;
    for (const k in obj) {
      if (!hasOwn.call(obj, k)) continue;
      const v = obj[k];
      if (v && typeof v === 'object') {
        const found = findOwner(v, key, test, depth - 1);
        if (found) return found;
      }
    }
    return null;
  }

  /** 深度优先查找第一个 key 名匹配且通过 test 的值。 */
  function findKey(obj, key, test, depth) {
    const owner = findOwner(obj, key, test, depth);
    return owner ? owner[key] : undefined;
  }

  // ---------------------------------------------------------------- 点播

  /** 一条轨道的地址：主地址在前，备用地址在后。 */
  function urlsOf(s) {
    const base = s.baseUrl || s.base_url || s.url;
    const backup = s.backupUrl || s.backup_url || [];
    return [base, ...backup].filter((u) => typeof u === 'string' && u);
  }

  /** 点播的各组轨道：[[类型, 轨道数组]]。dash 为 video / audio / dolby / flac，老格式为 durl；都没有时为空数组。 */
  function vodGroups(json) {
    const dash = findKey(json, 'dash', (d) => d && Array.isArray(d.video), 14);
    if (dash) {
      const groups = [
        ['video', dash.video],
        ['audio', dash.audio],
        ['dolby', dash.dolby && dash.dolby.audio],
        ['flac', dash.flac && dash.flac.audio && [dash.flac.audio]],
      ];
      return groups.map(([type, list]) => [type, (Array.isArray(list) ? list : []).filter((s) => s && typeof s === 'object')]);
    }
    const durl = findKey(json, 'durl', (d) => Array.isArray(d) && d.length > 0 && d[0] && d[0].url, 14);
    return durl ? [['durl', durl]] : [];
  }

  /** 点播的全部轨道（改写地址时逐条处理）。 */
  const vodTracks = (json) => vodGroups(json).flatMap(([, list]) => list);

  const urlEntry = (u) => [cdn.hostOf(u), cdn.osOf(u)];

  function extractVod(json) {
    const tracks = [];
    for (const [type, list] of vodGroups(json)) {
      for (const s of list) {
        const urls = urlsOf(s).map(urlEntry);
        tracks.push(type === 'durl' ? { type, id: s.order, urls } : { type, id: s.id, codecs: s.codecs, bw: s.bandwidth, h: s.height, urls });
      }
    }
    if (!tracks.length) return null;
    const q = findKey(json, 'quality', (v) => typeof v === 'number', 8);
    return { kind: 'vod', q: q === undefined ? null : q, tracks };
  }

  // ---------------------------------------------------------------- 直播

  const isStreams = (v) => Array.isArray(v) && v.length > 0 && v[0] && hasOwn.call(v[0], 'protocol_name');

  /** 持有直播 stream 数组的对象，没有时为 null。 */
  const streamHolder = (json) => findOwner(json, 'stream', isStreams, 10);

  /** 直播的每条线路：协议（st）× 格式（f）× 编码（c）。 */
  function* liveLines(streams) {
    for (const st of streams) for (const f of st.format || []) for (const c of f.codec || []) yield { st, f, c };
  }

  function extractLive(json) {
    const holder = streamHolder(json);
    if (!holder) return null;
    const lines = [];
    for (const { st, f, c } of liveLines(holder.stream)) {
      lines.push({
        p: st.protocol_name,
        f: f.format_name,
        c: c.codec_name,
        qn: c.current_qn,
        hosts: (c.url_info || []).map((u) => cdn.hostOf(u.host)),
      });
    }
    return lines.length ? { kind: 'live', lines } : null;
  }

  /** 返回 { kind: 'vod', q, tracks } / { kind: 'live', lines } / null。 */
  function extractPlayInfo(json) {
    if (!json || typeof json !== 'object') return null;
    return extractLive(json) || extractVod(json);
  }

  const api = { findKey, urlsOf, vodTracks, streamHolder, liveLines, extractPlayInfo };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__bilicdn = Object.assign(root.__bilicdn || {}, api);
})(globalThis);
