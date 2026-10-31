// SPDX-License-Identifier: AGPL-3.0-or-later
// 后台运行环境：在 Node 的 vm 里原样跑扩展的 sw.js 和 shared/ 下的共享脚本，给它搭一个 chrome 垫片（桌面版开发计划工作项 5、11）。
// 不拆 sw.js：原样跑才能保证两边行为一样，扩展改了桌面版跟着变。sw.js 用到的 chrome API 见下文各节，
// 扩展以后用到新的，desktop/test/shim.test.mjs 会报出来。
//
// 页面相关的（标签页、发给页面的消息、页面上的媒体请求）由 pages.mjs 提供：它把客户端里每个播放器窗口、直播窗口当成一个标签页，
// 媒体请求由 netmap.mjs 从 CDP 的网络事件换算成 webRequest 的格式，经 dispatchRequest 交给 sw.js。
// 测速请求是 sw.js 自己用 fetch 发的：包装过的 fetch 按 declarativeNetRequest 的会话规则补上 Referer / Origin（CDN 要 B 站的来源，
// 浏览器里扩展用会话规则补，Node 的 fetch 能直接设这两个头），并用 undici 的诊断通道给自己的请求补发 webRequest 事件（tabId -1），
// sw.js 按这些事件取首字节、结束时间和连到的 IP（见 sw.js「测速」一节的 probeTime）。
import dc from 'node:diagnostics_channel';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const EXT_ID = 'bpro-desktop';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}/`;

// ---------------------------------------------------------------- 事件

/** chrome.*.onXxx：addListener / removeListener / hasListener，fire 时依次调（一个出错不影响别的）。 */
export function chromeEvent(log) {
  const fns = [];
  return {
    fns,
    addListener: (fn, ...extra) => fns.push({ fn, extra }),
    removeListener: (fn) => {
      const i = fns.findIndex((x) => x.fn === fn);
      if (i >= 0) fns.splice(i, 1);
    },
    hasListener: (fn) => fns.some((x) => x.fn === fn),
    hasListeners: () => fns.length > 0,
    fire(...args) {
      for (const { fn } of [...fns]) {
        try {
          fn(...args);
        } catch (e) {
          log(`监听出错：${e && e.stack ? e.stack : e}`);
        }
      }
    },
  };
}

// ---------------------------------------------------------------- webRequest 的过滤

// 网址匹配模式（*://*.bilivideo.com/* 这样的）。* 协议匹配 http / https / ws / wss；*.x 匹配 x 本身和它的子域名
export function matchPattern(pattern, url) {
  if (pattern === '<all_urls>') return /^(https?|wss?|file|ftp):/.test(url);
  const m = /^(\*|[a-z-]+):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.exec(pattern);
  if (!m) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1);
  if (m[1] === '*' ? !['http', 'https', 'ws', 'wss'].includes(scheme) : m[1] !== scheme) return false;
  const host = u.hostname;
  if (m[2] !== '*') {
    if (m[2].startsWith('*.')) {
      const base = m[2].slice(2);
      if (host !== base && !host.endsWith(`.${base}`)) return false;
    } else if (host !== m[2]) return false;
  }
  const re = new RegExp(`^${m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(u.pathname + u.search);
}

function matchFilter(filter, d) {
  if (!filter) return true;
  if (filter.urls && !filter.urls.some((p) => matchPattern(p, d.url))) return false;
  if (filter.types && !filter.types.includes(d.type)) return false;
  if (filter.tabId !== undefined && filter.tabId !== d.tabId) return false;
  return true;
}

// ---------------------------------------------------------------- declarativeNetRequest（只做测速要的 modifyHeaders）

function ruleMatches(rule, url, { tabId, initiator }) {
  const c = rule.condition || {};
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const domainIn = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));
  if (c.requestDomains && !domainIn(u.hostname, c.requestDomains)) return false;
  if (c.excludedRequestDomains && domainIn(u.hostname, c.excludedRequestDomains)) return false;
  if (c.tabIds && !c.tabIds.includes(tabId)) return false;
  if (c.initiatorDomains && !domainIn(initiator, c.initiatorDomains)) return false;
  if (c.regexFilter && !new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive === false ? 'i' : '').test(url)) return false;
  if (c.urlFilter && !url.includes(c.urlFilter.replace(/^\|\||\^$/g, ''))) return false;
  return true;
}

/** 按会话规则算出要设的请求头：优先级高的先改，一个头被改过以后优先级低的不再改（同 Chrome）。 */
export function ruleHeaders(rules, url, ctx) {
  const out = new Map(); // 小写头名 → { name, value } 或 null（去掉）
  const sorted = rules.filter((r) => r.action && r.action.type === 'modifyHeaders' && ruleMatches(r, url, ctx)).sort((a, b) => (b.priority || 1) - (a.priority || 1));
  for (const r of sorted) {
    for (const h of r.action.requestHeaders || []) {
      const key = h.header.toLowerCase();
      if (out.has(key)) continue;
      if (h.operation === 'set') out.set(key, { name: h.header, value: h.value });
      else if (h.operation === 'remove') out.set(key, null);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 测速请求的 webRequest 事件

// undici 的诊断通道是全进程的，订阅一次。每个经包装 fetch 发出、还没结束的请求按地址登记在 waiting 里
const waiting = new Map(); // 地址 → [跟踪记录]
const byRequest = new WeakMap(); // undici 的 request → 跟踪记录
let channelsReady = false;

const wallNow = () => performance.timeOrigin + performance.now();

function urlOfRequest(request) {
  try {
    return new URL(request.path, request.origin).href;
  } catch {
    return '';
  }
}

function headersFromRaw(raw) {
  // sendHeaders 给的是原始的请求头文本：第一行是请求行
  return String(raw || '')
    .split('\r\n')
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(':');
      return { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
    });
}

function headersFromList(list) {
  const out = [];
  for (let i = 0; i + 1 < (list || []).length; i += 2) out.push({ name: String(list[i]), value: String(list[i + 1]) });
  return out;
}

// Node 的错误 → Chrome 的 net::ERR_… 写法（sw.js 按它判断换网络、断网，见 sw.js NET_ERRORS）
export function netError(e) {
  if (!e) return 'net::ERR_FAILED';
  if (e.name === 'AbortError') return 'net::ERR_ABORTED';
  const code = e.code || (e.cause && e.cause.code) || '';
  const map = {
    ENOTFOUND: 'net::ERR_NAME_NOT_RESOLVED',
    EAI_AGAIN: 'net::ERR_NAME_NOT_RESOLVED',
    ECONNREFUSED: 'net::ERR_CONNECTION_REFUSED',
    ECONNRESET: 'net::ERR_CONNECTION_RESET',
    ETIMEDOUT: 'net::ERR_TIMED_OUT',
    UND_ERR_CONNECT_TIMEOUT: 'net::ERR_CONNECTION_TIMED_OUT',
    UND_ERR_HEADERS_TIMEOUT: 'net::ERR_TIMED_OUT',
    UND_ERR_SOCKET: 'net::ERR_CONNECTION_CLOSED',
    ENETUNREACH: 'net::ERR_ADDRESS_UNREACHABLE',
    EHOSTUNREACH: 'net::ERR_ADDRESS_UNREACHABLE',
  };
  return map[code] || 'net::ERR_FAILED';
}

function setupChannels() {
  if (channelsReady) return;
  channelsReady = true;
  dc.subscribe('undici:request:create', ({ request }) => {
    const url = urlOfRequest(request);
    const list = waiting.get(url);
    const tr = list && list.find((x) => !x.request);
    if (!tr) return;
    tr.request = request;
    byRequest.set(request, tr);
    tr.url = url;
    tr.emit('onBeforeRequest', { method: request.method || 'GET' });
  });
  dc.subscribe('undici:client:sendHeaders', ({ request, headers, socket }) => {
    const tr = byRequest.get(request);
    if (!tr) return;
    if (socket && socket.remoteAddress) tr.ip = socket.remoteAddress.replace(/^::ffff:/, '');
    tr.emit('onSendHeaders', { requestHeaders: headersFromRaw(headers) });
  });
  dc.subscribe('undici:request:headers', ({ request, response }) => {
    const tr = byRequest.get(request);
    if (!tr) return;
    const responseHeaders = headersFromList(response.headers);
    const statusCode = response.statusCode;
    tr.emit('onHeadersReceived', { statusCode, responseHeaders });
    const loc = responseHeaders.find((h) => h.name.toLowerCase() === 'location');
    if (statusCode >= 300 && statusCode < 400 && loc) {
      // 跳转：undici 自己跟过去，下一个 request 的地址是跳转后的，接着记在这个请求上（同 Chrome，requestId 不变）
      let next = '';
      try {
        next = new URL(loc.value, tr.url).href;
      } catch {}
      tr.emit('onBeforeRedirect', { statusCode, redirectUrl: next, ip: tr.ip, fromCache: false, responseHeaders });
      tr.request = null;
      if (next) tr.retarget(next);
      return;
    }
    tr.status = statusCode;
    tr.emit('onResponseStarted', { statusCode, ip: tr.ip, fromCache: false, responseHeaders });
  });
  dc.subscribe('undici:request:trailers', ({ request }) => {
    const tr = byRequest.get(request);
    if (!tr || !tr.status) return;
    tr.emit('onCompleted', { statusCode: tr.status, ip: tr.ip, fromCache: false });
    tr.done();
  });
  dc.subscribe('undici:request:error', ({ request, error }) => {
    const tr = byRequest.get(request);
    if (!tr) return;
    tr.emit('onErrorOccurred', { error: netError(error), ip: tr.ip, fromCache: false });
    tr.done();
  });
}

let fetchSeq = 0;

/**
 * 包装 fetch：按会话规则补请求头（rules() 返回当前的规则），给自己的请求补发 webRequest 事件（dispatch(事件名, details)）。
 * ua：请求带的 User-Agent（客户端的 UA，没有时用 Node 默认的会被一些接口当成机器人）。
 */
export function wrapFetch({ rules, dispatch, ua = () => '', base = globalThis.fetch }) {
  setupChannels();
  return async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url).href;
    const headers = new Headers(init.headers || {});
    for (const [key, h] of ruleHeaders(rules(), url, { tabId: -1, initiator: EXT_ID })) {
      if (h) headers.set(h.name, h.value);
      else headers.delete(key);
    }
    if (!headers.has('user-agent') && ua()) headers.set('user-agent', ua());
    const opts = { ...init, headers };
    // credentials 在 Node 里没有意义（没有 cookie）；cache 交给 undici 也行，去掉省得以后的版本对某些取值报错
    delete opts.credentials;
    delete opts.cache;
    const requestId = `sw${++fetchSeq}`;
    const tr = {
      url,
      request: null,
      ip: '',
      status: 0,
      emit(event, extra) {
        dispatch(event, { requestId, url: tr.url, method: 'GET', frameId: -1, parentFrameId: -1, tabId: -1, type: 'xmlhttprequest', initiator: EXT_ORIGIN.slice(0, -1), timeStamp: wallNow(), ...extra });
      },
      retarget(next) {
        unlist(tr);
        tr.url = next;
        list(tr);
      },
      done() {
        unlist(tr);
      },
    };
    list(tr);
    try {
      return await base(url, opts);
    } catch (e) {
      // 还没发出去就失败了（地址解析不了等）：诊断通道没有事件，这里补一个出错
      if (!tr.request && waiting.get(tr.url)?.includes(tr)) {
        tr.emit('onErrorOccurred', { error: netError(e), fromCache: false });
        unlist(tr);
      }
      throw e;
    }
  };
}

function list(tr) {
  const xs = waiting.get(tr.url) || [];
  xs.push(tr);
  waiting.set(tr.url, xs);
}

function unlist(tr) {
  const xs = (waiting.get(tr.url) || []).filter((x) => x !== tr);
  if (xs.length) waiting.set(tr.url, xs);
  else waiting.delete(tr.url);
}

// ---------------------------------------------------------------- 后台

/**
 * 启动后台：在 vm 里跑 extDir/src/background/sw.js。
 *   storage：{ local, session } 两个 StorageArea（见 storage.mjs），onChanged 由调用方经 storageChanged 转进来；
 *   tabs：页面那边（pages.mjs）提供 get(tabId)、query(q)、sendMessage(tabId, msgJson, options)、reload(tabId)；
 *   uiLang：界面语言（sw.js 里的 L() 和播放器按钮上的文字按它）；ua()：测速请求的 User-Agent；
 *   onBadge({ text, color, tabId })：扩展图标角标（桌面版显示在控制台标题上）；log(文本)：sw.js 的 console 输出。
 * 返回 { context, ready, dispatchRequest, message, storageChanged, tabRemoved, close }。
 */
export function startBackground({ extDir, storage, tabs, uiLang = 'zh-CN', ua = () => '', onBadge = () => {}, log = () => {}, fetchImpl }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  const bgDir = path.join(extDir, 'src', 'background');
  const say = (prefix) => (...args) => log(`${prefix}${args.map((a) => (typeof a === 'string' ? a : a instanceof Error || (a && a.stack) ? a.stack : safeJson(a))).join(' ')}`);
  const console_ = { log: say(''), info: say(''), debug: () => {}, warn: say('⚠ '), error: say('✘ ') };

  const ev = () => chromeEvent(console_.error);
  const webRequest = {};
  for (const k of ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']) webRequest[k] = ev();
  const storageChangedEv = ev();
  const areaEv = { local: ev(), session: ev() };
  const onMessage = ev();
  const onRemoved = ev();
  const onAlarm = ev();
  const onCommand = ev();
  let sessionRules = [];
  const alarms = new Map(); // 名字 → { alarm, timer }
  let closed = false;

  // vm 里的对象用 vm 自己的 JSON 解出来，属于 vm 的 realm（sw.js 里的 Array.isArray 等跨 realm 也对，但这样最稳）
  let vmJSON = JSON;
  const parse = (text) => vmJSON.parse(text);
  const toVm = (v) => (v === undefined ? undefined : parse(JSON.stringify(v)));

  const area = (a) => ({
    get: async (keys) => a.get(keys, parse),
    set: async (items) => a.set(JSON.parse(JSON.stringify(items))),
    remove: async (keys) => a.remove(keys),
    clear: async () => a.clear(),
    getBytesInUse: async (keys) => a.getBytesInUse(keys),
    onChanged: areaEv[a.name],
  });

  const alarmApi = {
    create(name, info) {
      if (typeof name === 'object') [name, info] = ['', name];
      name = name || '';
      clearAlarm(name);
      const now = Date.now();
      const when = info.when ?? now + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60e3;
      const alarm = { name, scheduledTime: when, ...(info.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}) };
      const entry = { alarm, timer: null };
      const arm = (at) => {
        entry.timer = setTimeout(() => {
          if (closed) return;
          if (alarm.periodInMinutes) {
            alarm.scheduledTime = Date.now() + alarm.periodInMinutes * 60e3;
            arm(alarm.scheduledTime);
          } else alarms.delete(name);
          onAlarm.fire(toVm({ ...alarm }));
        }, Math.max(0, at - Date.now()));
      };
      arm(when);
      alarms.set(name, entry);
      return Promise.resolve();
    },
    get: async (name = '') => (alarms.has(name) ? toVm({ ...alarms.get(name).alarm }) : undefined),
    getAll: async () => toVm([...alarms.values()].map((x) => ({ ...x.alarm }))),
    clear: async (name = '') => clearAlarm(name),
    clearAll: async () => {
      for (const name of [...alarms.keys()]) clearAlarm(name);
      return true;
    },
    onAlarm,
  };
  function clearAlarm(name) {
    const x = alarms.get(name);
    if (!x) return false;
    clearTimeout(x.timer);
    alarms.delete(name);
    return true;
  }

  const badge = { text: '', color: '' };
  const chrome = {
    runtime: {
      id: EXT_ID,
      getURL: (p = '') => EXT_ORIGIN + String(p).replace(/^\//, ''),
      getManifest: () => toVm(manifest),
      onMessage,
      onInstalled: ev(),
      onStartup: ev(),
      lastError: undefined,
    },
    storage: { local: area(storage.local), session: area(storage.session), onChanged: storageChangedEv },
    tabs: {
      TAB_ID_NONE: -1,
      get: async (tabId) => {
        const t = tabs.get(tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}.`);
        return toVm(t);
      },
      query: async (q) => toVm(tabs.query(q || {})),
      sendMessage: async (tabId, msg, options) => {
        const text = await tabs.sendMessage(tabId, JSON.stringify(msg), options || {});
        return text === undefined ? undefined : parse(text);
      },
      reload: async (tabId) => tabs.reload(tabId),
      onRemoved,
      onUpdated: ev(),
      onActivated: ev(),
    },
    alarms: alarmApi,
    webRequest,
    declarativeNetRequest: {
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] } = {}) => {
        sessionRules = sessionRules.filter((r) => !removeRuleIds.includes(r.id));
        for (const r of addRules) {
          if (sessionRules.some((x) => x.id === r.id)) throw new Error(`Rule with id ${r.id} does not have a unique ID.`);
          sessionRules.push(JSON.parse(JSON.stringify(r)));
        }
      },
      getSessionRules: async () => toVm(sessionRules),
    },
    action: {
      setBadgeText: async ({ text, tabId }) => {
        if (tabId === undefined) badge.text = text || '';
        onBadge({ text: text ?? null, tabId, global: badge.text });
      },
      setBadgeBackgroundColor: async ({ color, tabId }) => {
        if (tabId === undefined) badge.color = color;
      },
      setTitle: async () => {},
      setIcon: async () => {},
    },
    commands: { onCommand, getAll: async () => toVm([]) },
    i18n: { getUILanguage: () => uiLang, getMessage: () => '' },
  };

  const context = vm.createContext({
    chrome,
    console: console_,
    fetch: wrapFetch({ rules: () => sessionRules, dispatch: dispatchRequest, ua, base: fetchImpl || globalThis.fetch }),
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    Blob,
    ReadableStream,
    performance,
    structuredClone,
    atob,
    btoa,
    crypto: globalThis.crypto,
    setTimeout: (fn, ms, ...a) => setTimeout(() => !closed && fn(...a), ms),
    clearTimeout,
    setInterval: (fn, ms, ...a) => setInterval(() => !closed && fn(...a), ms),
    clearInterval,
    queueMicrotask,
  });
  vmJSON = vm.runInContext('JSON', context);
  context.self = context;
  context.importScripts = (...names) => {
    for (const name of names) {
      const file = path.resolve(bgDir, name);
      vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
  };
  const swFile = path.join(bgDir, manifest.background.service_worker.split('/').pop());
  vm.runInContext(fs.readFileSync(swFile, 'utf8'), context, { filename: swFile });

  /** 网络事件（webRequest 的格式）交给 sw.js 的监听，按各自的过滤条件筛。 */
  function dispatchRequest(event, details) {
    const e = webRequest[event];
    if (!e || closed) return;
    let d = null;
    for (const { fn, extra } of [...e.fns]) {
      if (!matchFilter(extra[0], details)) continue;
      d ||= toVm(details);
      try {
        fn(d);
      } catch (err) {
        console_.error(`webRequest.${event} 出错`, err);
      }
    }
  }

  /**
   * runtime.onMessage：msgJson 为消息的 JSON 文本，sender 为 { tab, frameId, url, origin }。
   * 返回回复的 JSON 文本，没有回复时为 undefined（同 Chrome：没有监听返回 true 也没有调 sendResponse 就没有回复）。
   */
  function message(msgJson, sender) {
    if (closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let done = false;
      let waiting = false;
      const reply = (v) => {
        if (done) return;
        done = true;
        resolve(v === undefined ? undefined : JSON.stringify(v));
      };
      const msg = parse(msgJson);
      const snd = toVm({ id: EXT_ID, ...sender });
      for (const { fn } of [...onMessage.fns]) {
        try {
          if (fn(msg, snd, reply) === true) waiting = true;
        } catch (e) {
          console_.error('onMessage 出错', e);
        }
      }
      if (!waiting) reply(undefined);
    });
  }

  /** storage 有变化（changes 里是 JSON 文本，见 storage.mjs）：转成 vm 里的对象通知 sw.js。 */
  function storageChanged(changes, areaName) {
    if (closed) return;
    const fire = () => {
      const c = {};
      for (const [k, v] of Object.entries(changes)) {
        c[k] = {};
        if (v.oldValue !== undefined) c[k].oldValue = parse(v.oldValue);
        if (v.newValue !== undefined) c[k].newValue = parse(v.newValue);
      }
      const obj = parse(JSON.stringify(c));
      storageChangedEv.fire(obj, areaName);
      areaEv[areaName]?.fire(obj);
    };
    // 同 Chrome：set 返回以后才通知
    setTimeout(fire, 0);
  }

  return {
    context,
    manifest,
    ready: vm.runInContext('Promise.all([ready, settingsReady])', context),
    dispatchRequest,
    message,
    storageChanged,
    tabRemoved: (tabId) => !closed && onRemoved.fire(tabId, toVm({ windowId: 1, isWindowClosing: false })),
    flush: () => vm.runInContext('Store.flush()', context),
    close() {
      closed = true;
      for (const name of [...alarms.keys()]) clearAlarm(name);
    },
  };
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
