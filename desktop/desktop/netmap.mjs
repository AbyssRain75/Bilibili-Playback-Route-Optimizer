// SPDX-License-Identifier: AGPL-3.0-or-later
// 客户端页面的网络事件（CDP 的 Network 域）换算成 chrome.webRequest 的事件，交给 sw.js（桌面版开发计划工作项 7）。
// 对照 sw.js「实际媒体请求」一节：sw.js 只读 requestId、timeStamp、url、ip、tabId、statusCode、responseHeaders、requestHeaders、
// redirectUrl、fromCache、error，这里只换算这些。时间都换成和 Date.now() 同一口径的毫秒：CDP 的 timestamp 是单调时钟（秒），
// requestWillBeSent 同时给了 wallTime（墙上时间，秒），两者的差就是换算用的偏移。
//
// 和 Chrome 的 webRequest 对得上的几处：
//   - onSendHeaders 在 Chrome 里是请求头真正发出时，CDP 要等到响应来了才知道（timing.sendStart），所以和 onHeadersReceived 一起补发；
//     没等到响应就失败的，按 requestWillBeSentExtraInfo（请求头真正发出时才有）到达的时间补发，连接都没建起来的不发（Chrome 也不发）。
//     sw.js 的首字节（tt）= onHeadersReceived − onSendHeaders，没等到响应头的 tt 为空、按「无响应」算（见 cdn.js isHang）。
//   - CORS 预检（Preflight / OPTIONS）Chrome 的 webRequest 默认看不到（不带 extraHeaders），这里也不报，免得一个分片记成两个请求。
//   - fromCache：走了磁盘缓存或内存缓存（requestServedFromCache）的。
//   - 跳转：requestId 不变，带 redirectResponse 的 requestWillBeSent 先补上一跳的 onBeforeRedirect，再按新地址发 onBeforeRequest。

// CDP 的资源类型 → webRequest 的 type（fetch() 和 XHR 在 webRequest 里都是 xmlhttprequest）
const TYPES = {
  Document: 'main_frame',
  Stylesheet: 'stylesheet',
  Image: 'image',
  Media: 'media',
  Font: 'font',
  Script: 'script',
  XHR: 'xmlhttprequest',
  Fetch: 'xmlhttprequest',
  EventSource: 'other',
  WebSocket: 'websocket',
  Ping: 'ping',
  CSPViolationReport: 'csp_report',
};
export const typeOf = (cdpType, frame) => (cdpType === 'Document' && frame ? 'sub_frame' : TYPES[cdpType] || 'other');

/** CDP 的请求头对象（一个名字多个值时用换行连在一起）→ webRequest 的 [{ name, value }]。 */
export function headerList(obj) {
  const out = [];
  for (const [name, value] of Object.entries(obj || {})) for (const v of String(value).split('\n')) out.push({ name, value: v });
  return out;
}

const statusLine = (r) => `${r.protocol && /^h(2|3)/.test(r.protocol) ? 'HTTP/2.0' : 'HTTP/1.1'} ${r.status} ${r.statusText || ''}`.trim();

export class NetMap {
  /**
   * emit(事件名, details)：交给 sw.js 的 webRequest 事件；prefix：requestId 的前缀（不同页面的 requestId 会重号）；
   * now()：本地时间（毫秒），只在 CDP 没给时间时用。
   */
  constructor(emit, { prefix = '', now = Date.now } = {}) {
    this.emit = emit;
    this.prefix = prefix;
    this.now = now;
    this.reqs = new Map(); // CDP requestId → 请求状态
    this.early = new Map(); // 比 requestWillBeSent 先到的 ExtraInfo
  }

  /**
   * 处理一个 Network 事件。ctx：{ tabId, frameId(cdpFrameId) → 编号, relevant(): 这个页面要不要记 }。
   * 只有 requestWillBeSent 看 relevant：开始记了的请求，后面的事件都照常换算。
   */
  handle(method, p, ctx) {
    switch (method) {
      case 'Network.requestWillBeSent':
        return this.willBeSent(p, ctx);
      case 'Network.requestWillBeSentExtraInfo': {
        const st = this.reqs.get(p.requestId);
        const info = { headers: p.headers, at: this.now() };
        if (st) Object.assign(st, { sentHeaders: info.headers, sentAt: info.at });
        else if (this.early.size < 500) this.early.set(p.requestId, info);
        return;
      }
      case 'Network.requestServedFromCache': {
        const st = this.reqs.get(p.requestId);
        if (st) st.cached = true;
        return;
      }
      case 'Network.responseReceived':
        return this.response(p);
      case 'Network.loadingFinished':
        return this.finished(p);
      case 'Network.loadingFailed':
        return this.failed(p);
      default:
    }
  }

  base(st, extra) {
    return { requestId: st.id, url: st.url, method: st.method, frameId: st.frameId, parentFrameId: st.parentFrameId, tabId: st.tabId, type: st.type, initiator: st.initiator, ...extra };
  }

  wall(st, sec) {
    return sec * 1000 + st.offset;
  }

  willBeSent(p, ctx) {
    const req = p.request || {};
    const prev = this.reqs.get(p.requestId);
    if (prev && p.redirectResponse) {
      // 上一跳：补上它的响应和跳转（Chrome：onHeadersReceived 3xx → onBeforeRedirect → 新地址的 onBeforeRequest）
      this.responseEvents(prev, p.redirectResponse, p.timestamp, false);
      this.emit('onBeforeRedirect', this.base(prev, { timeStamp: this.wall(prev, p.timestamp), statusCode: p.redirectResponse.status, ip: ipOf(p.redirectResponse), fromCache: !!p.redirectResponse.fromDiskCache, redirectUrl: req.url, responseHeaders: headerList(p.redirectResponse.headers) }));
      this.reqs.delete(p.requestId);
    } else if (prev) {
      this.reqs.delete(p.requestId);
    }
    if (p.type === 'Preflight' || req.method === 'OPTIONS') return;
    if (!/^https?:/.test(req.url || '') || !ctx.relevant()) return;
    const frame = ctx.frameId(p.frameId);
    let initiator;
    try {
      initiator = new URL(p.documentURL).origin;
    } catch {}
    const st = {
      id: `${this.prefix}${p.requestId}`,
      url: req.url,
      method: req.method || 'GET',
      tabId: ctx.tabId,
      frameId: frame,
      parentFrameId: frame === 0 ? -1 : 0,
      type: typeOf(p.type, frame !== 0),
      initiator,
      offset: p.wallTime * 1000 - p.timestamp * 1000,
      t0: p.wallTime * 1000,
      headers: req.headers || {},
      sentHeaders: null,
      sentAt: null,
      cached: false,
      responded: false,
      status: 0,
      ip: '',
    };
    const early = this.early.get(p.requestId);
    if (early) {
      this.early.delete(p.requestId);
      Object.assign(st, { sentHeaders: early.headers, sentAt: early.at });
    }
    this.reqs.set(p.requestId, st);
    this.emit('onBeforeRequest', this.base(st, { timeStamp: st.t0 }));
  }

  /** 响应来了：补发 onSendHeaders，再发 onHeadersReceived；started 时再发 onResponseStarted（跳转的那一跳不发）。 */
  responseEvents(st, r, eventTs, started = true) {
    const tm = r.timing;
    const fromCache = st.cached || !!r.fromDiskCache || !!r.fromPrefetchCache;
    let sendAt = st.t0;
    let headersAt = this.wall(st, eventTs);
    if (tm && tm.requestTime > 0) {
      const at = (ms) => this.wall(st, tm.requestTime) + ms;
      if (tm.sendStart >= 0) sendAt = at(tm.sendStart);
      if (tm.receiveHeadersEnd >= 0) headersAt = at(tm.receiveHeadersEnd);
    }
    st.responded = true;
    st.status = r.status;
    st.ip = ipOf(r);
    st.fromCache = fromCache;
    const requestHeaders = headerList(st.sentHeaders || r.requestHeaders || st.headers);
    const responseHeaders = headerList(r.headers);
    this.emit('onSendHeaders', this.base(st, { timeStamp: sendAt, requestHeaders }));
    this.emit('onHeadersReceived', this.base(st, { timeStamp: headersAt, statusCode: r.status, statusLine: statusLine(r), responseHeaders }));
    if (started) this.emit('onResponseStarted', this.base(st, { timeStamp: headersAt, statusCode: r.status, statusLine: statusLine(r), ip: st.ip, fromCache, responseHeaders }));
  }

  response(p) {
    const st = this.reqs.get(p.requestId);
    if (!st || st.responded) return;
    this.responseEvents(st, p.response || {}, p.timestamp);
  }

  finished(p) {
    const st = this.reqs.get(p.requestId);
    if (!st) return;
    this.reqs.delete(p.requestId);
    // 没有响应就结束了（不该出现）：按出错算
    if (!st.responded) return this.emit('onErrorOccurred', this.base(st, { timeStamp: this.wall(st, p.timestamp), error: 'net::ERR_FAILED', fromCache: st.cached }));
    this.emit('onCompleted', this.base(st, { timeStamp: this.wall(st, p.timestamp), statusCode: st.status, ip: st.ip, fromCache: st.fromCache }));
  }

  failed(p) {
    const st = this.reqs.get(p.requestId);
    if (!st) return;
    this.reqs.delete(p.requestId);
    // 请求头发出去了、没等到响应：补上 onSendHeaders（sw.js 在这里取 Range，判断同一段在几个节点上无响应，见 sw.js localOutage）
    if (!st.responded && st.sentAt !== null) this.emit('onSendHeaders', this.base(st, { timeStamp: st.sentAt, requestHeaders: headerList(st.sentHeaders || st.headers) }));
    const error = p.errorText && p.errorText.startsWith('net::') ? p.errorText : p.canceled ? 'net::ERR_ABORTED' : p.errorText ? `net::${p.errorText}` : 'net::ERR_FAILED';
    this.emit('onErrorOccurred', this.base(st, { timeStamp: this.wall(st, p.timestamp), error, fromCache: !!st.fromCache, ...(st.ip ? { ip: st.ip } : {}) }));
  }

  /** 页面关了、连接断了：还没结束的请求不会再有事件，按中止算（Chrome 关标签页时也是 ERR_ABORTED）。 */
  abortAll() {
    const now = this.now();
    for (const [id, st] of this.reqs) this.failed({ requestId: id, timestamp: (now - st.offset) / 1000, errorText: 'net::ERR_ABORTED', canceled: true });
    this.early.clear();
  }
}

// CDP 的 IPv6 地址带方括号（[2001:db8::1]），webRequest 不带
const ipOf = (r) => String(r.remoteIPAddress || '').replace(/^\[|\]$/g, '');
