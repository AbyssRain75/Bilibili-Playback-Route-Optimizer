// SPDX-License-Identifier: AGPL-3.0-or-later
// 记录持久化：缓冲后按块追加写入 chrome.storage.local，避免每次重写全部数据。
// service worker 负责写入；统计页通过 readAll 读取（读之前先让 SW flush）。
// 每次写入都要重写最后一块，而 storage.onChanged 会把这一块的新旧内容发给每个 B 站页面里的内容脚本，
// 所以块不宜大（一条请求记录约 220 字节），也不要写得太勤。手动标记会立即 flush。
// 写入失败保留批次并延迟重试；flush/readAll/clear 会向调用方报告错误。
// 超过保留时长的记录由 SW 调 prune 删掉（见 sw.js maybePrune）：开头整块过期的删 key，meta.first 记下第一块的编号（旧数据没有，为 0）。
const Store = (() => {
  'use strict';

  const CHUNK_SIZE = 100;
  const FLUSH_DELAY = 5000;
  const chunkKey = (i) => `rec:${String(i).padStart(5, '0')}`;
  const chunkKeys = (meta) => Array.from({ length: meta.chunks - (meta.first || 0) }, (_, i) => chunkKey((meta.first || 0) + i));

  // 记录保留时长（天）：统计页可选 7 / 15 / 30 天、2~6 个月（一个月按 30 天算），默认 15 天（用户定的）。
  // 存在 storage 的 retention：{ days, ok }，ok 为可以自动删。新装的（还没有记录）直接可以；升级前已经有记录的，
  // 第一次删之前要用户在统计页确认（用户定的：删掉的找不回来）
  const KEEP_DAYS = [7, 15, 30, 60, 90, 120, 150, 180];
  const KEEP_DEFAULT = 15;
  const DAY = 86400e3;
  const keepDays = (retention) => (retention && KEEP_DAYS.includes(retention.days) ? retention.days : KEEP_DEFAULT);
  const cutoffOf = (days, now = Date.now()) => now - days * DAY;

  /**
   * 过了保留时长要删的记录：t 早于 cutoff 的；但 cutoff 之后还有记录的会话，它的 ses / asg 留着
   * （页面类型、地址和分配记在上面，同 analyze.js selectPeriod 的上下文）。返回判断函数 drop(r)。
   */
  function expired(records, cutoff) {
    const live = new Set();
    for (const r of records) if (r.t >= cutoff && r.sid) live.add(r.sid);
    return (r) => r.t < cutoff && !((r.ty === 'ses' || r.ty === 'asg') && live.has(r.sid));
  }

  let buffer = [];
  let timer = null;
  let queue = Promise.resolve();
  let generation = 0; // clear 之前的写入失败后不能把旧记录放回来

  function scheduleFlush() {
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, FLUSH_DELAY);
    }
  }

  function cancelFlush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function add(rec) {
    buffer.push(rec);
    scheduleFlush();
  }

  function flush() {
    cancelFlush();
    const current = generation;
    const pending = queue.then(() => current === generation && writeBuffer(current));
    // 调用方能得知失败；队列仍可继续，也接住不等待 flush 的调用。
    queue = pending.catch((e) => console.error('[bilicdn] 写入记录失败', e));
    return pending;
  }

  async function writeBuffer(current) {
    if (!buffer.length) return;
    cancelFlush();
    const recs = buffer;
    buffer = [];
    try {
      const local = chrome.storage.local;
      const meta = (await local.get('meta')).meta || { v: 1, since: recs[0].t, last: 0, count: 0, chunks: 0 };

      let idx = meta.chunks - 1;
      let cur = idx >= 0 ? (await local.get(chunkKey(idx)))[chunkKey(idx)] || [] : [];
      // 最后一块已满（包括旧版本按 500 条一块写的）：不用原样重写，直接开新块
      if (idx < 0 || cur.length >= CHUNK_SIZE) {
        idx += 1;
        cur = [];
      }
      const out = {};
      for (const r of recs) {
        if (cur.length >= CHUNK_SIZE) {
          out[chunkKey(idx)] = cur;
          idx += 1;
          cur = [];
        }
        cur.push(r);
      }
      out[chunkKey(idx)] = cur;
      meta.chunks = idx + 1;
      meta.count += recs.length;
      meta.last = recs[recs.length - 1].t;
      out.meta = meta;
      await local.set(out);
    } catch (e) {
      if (current === generation) {
        // 等待 storage 时可能又收到记录，失败批次必须排在它们前面。
        buffer = recs.concat(buffer);
        scheduleFlush();
      }
      throw e;
    }
  }

  async function readAll() {
    await flush();
    const { meta } = await chrome.storage.local.get('meta');
    if (!meta) return { meta: null, records: [] };
    const keys = chunkKeys(meta);
    const data = await chrome.storage.local.get(keys);
    return { meta, records: keys.flatMap((k) => data[k] || []) };
  }

  /**
   * 删掉 cutoff 之前的记录（见 expired），返回删了几条。和写入排在同一个队列里，不会和追加交错。
   * 只动开头的块，遇到一块里没有过期记录就停：整块过期的删 key、meta.first 往后挪，部分过期的重写成剩下的。
   * 记录大体按时间写入；晚写的（req 在请求结束时写、ses 在会话第一条别的记录前面写）可能比前面的早一点，等它们的块排到开头再删。
   * 最后一块正在追加，删空了也留着 key（空数组），写入照旧接在后面。
   */
  function prune(cutoff, now = Date.now()) {
    const pending = queue.then(() => pruneChunks(cutoff, now));
    queue = pending.catch((e) => console.error('[bilicdn] 删除过期记录失败', e));
    return pending;
  }

  async function pruneChunks(cutoff, now) {
    const local = chrome.storage.local;
    const { meta } = await local.get('meta');
    if (!meta) return 0;
    const first = meta.first || 0;
    const keys = chunkKeys(meta);
    const data = await local.get(keys);
    const drop = expired(keys.flatMap((k) => data[k] || []), cutoff);
    const out = {};
    const gone = [];
    let removed = 0;
    let next = first;
    for (let i = first; i < meta.chunks; i++) {
      const chunk = data[chunkKey(i)];
      // 读不到的块（不该有）当作删过了
      if (!chunk) {
        if (next === i && i < meta.chunks - 1) next = i + 1;
        continue;
      }
      // 没有过期记录的块就停；只剩还在进行的会话的 ses / asg 的块不停，后面的照样删
      if (!chunk.some((r) => r.t < cutoff)) break;
      const keep = chunk.filter((r) => !drop(r));
      if (keep.length === chunk.length) continue;
      removed += chunk.length - keep.length;
      if (!keep.length && i < meta.chunks - 1) {
        gone.push(chunkKey(i));
        if (next === i) next = i + 1;
      } else out[chunkKey(i)] = keep;
    }
    let since = Infinity;
    for (const k of keys) for (const r of data[k] || []) if (!drop(r) && r.t < since) since = r.t;
    out.meta = { ...meta, first: next, count: Math.max(0, meta.count - removed), since: Number.isFinite(since) ? since : meta.last, pruned: now };
    // 先写 meta 再删块：删块失败的话，开头那些已经在 first 前面、读不到（清空时一起删），中间的下次清理再删
    await local.set(out);
    if (gone.length) await local.remove(gone);
    return removed;
  }

  function clear() {
    generation += 1;
    buffer = [];
    cancelFlush();
    const pending = queue.then(async () => {
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter((k) => k === 'meta' || k.startsWith('rec:')));
    });
    queue = pending.catch((e) => console.error('[bilicdn] 清空记录失败', e));
    return pending;
  }

  return { CHUNK_SIZE, KEEP_DAYS, KEEP_DEFAULT, keepDays, cutoffOf, expired, add, flush, readAll, prune, clear };
})();

if (typeof module === 'object' && module.exports) module.exports = Store;
