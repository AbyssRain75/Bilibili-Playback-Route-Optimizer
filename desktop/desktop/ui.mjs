// SPDX-License-Identifier: AGPL-3.0-or-later
// 本地界面（桌面版开发计划工作项 8）：只绑 127.0.0.1 的网页服务，原样提供扩展的 popup、统计页和它们引用的文件，
// 在页面脚本之前插一个 ui-shim.js（不改原文件），界面里的 chrome.* 经 HTTP 交给桌面版，在默认浏览器里打开。
// 安全：地址带每次启动随机的令牌，没有令牌的请求一律拒绝；只认 Host 是 127.0.0.1 / localhost 的（防 DNS 重绑定）；
// 调用接口只收 POST + application/json（别的网站跨域发不了这种请求，要预检，这里不答预检）。
// 端口尽量沿用上次的（存在 lastPort()）：页面的 localStorage 按来源（含端口）分，界面语言、主题的本地记号才留得住。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EXT_ID } from './runtime.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
// 扩展目录里能提供的：页面、脚本、样式、图标。test/ 等不提供
const SERVE = /^(src|icons|_locales)\//;

/**
 * 启动界面服务。extDir：扩展目录；background：runtime.mjs 的后台；storage：{ local, session }；tabs：pages.mjs（可以后设，见 setTabs）；
 * port：想用的端口（被占了就随机）。返回 { url(p), popupUrl, statsUrl, broadcast(changes, area), setTabs, close }。
 */
export async function startUi({ extDir, background, storage, tabs = null, port = 0, log = () => {} }) {
  const token = randomBytes(16).toString('hex');
  const manifest = background.manifest;
  const shim = fs.readFileSync(path.join(import.meta.dirname, 'ui-shim.js'), 'utf8');
  const clients = new Set(); // 事件流
  let pages = tabs;

  const call = async (fn, args) => {
    const [a, b] = args;
    const st = (name) => {
      if (name !== 'local' && name !== 'session') throw new Error(`没有 ${name} 这个存储区域`);
      return storage[name];
    };
    switch (fn) {
      case 'storage.get':
        return st(a).get(b);
      case 'storage.set':
        return void st(a).set(b);
      case 'storage.remove':
        return void st(a).remove(b);
      case 'storage.clear':
        return void st(a).clear();
      case 'storage.getBytesInUse':
        return st(a).getBytesInUse(b);
      case 'runtime.sendMessage': {
        // 扩展自己的页面（popup、统计页）发的：没有 tab，sw.js 据此分出不是页面里的内容脚本
        const r = await background.message(JSON.stringify(a), { url: `chrome-extension://${EXT_ID}/`, origin: `chrome-extension://${EXT_ID}` });
        return r === undefined ? null : JSON.parse(r);
      }
      case 'tabs.query':
        return pages ? pages.query(a || {}) : [];
      case 'tabs.reload':
        if (!pages) throw new Error('客户端还没连上');
        return void (await pages.reload(a));
      default:
        throw new Error(`不支持 ${fn}`);
    }
  };

  const server = http.createServer(async (req, res) => {
    const fail = (code, text) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
    };
    const host = String(req.headers.host || '');
    const addr = server.address();
    if (host !== `127.0.0.1:${addr.port}` && host !== `localhost:${addr.port}`) return fail(403, 'forbidden');
    const u = new URL(req.url, `http://${host}`);
    const prefix = `/${token}/`;
    if (!u.pathname.startsWith(prefix)) return fail(403, 'forbidden');
    const rel = decodeURIComponent(u.pathname.slice(prefix.length));
    try {
      if (rel === '' || rel === 'popup') return redirect(res, `${prefix}${manifest.action.default_popup}`);
      if (rel === 'stats') return redirect(res, `${prefix}${manifest.options_ui.page}`);
      if (rel === '__desktop/call') {
        if (req.method !== 'POST' || !String(req.headers['content-type'] || '').startsWith('application/json')) return fail(405, 'POST application/json only');
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) return fail(403, 'forbidden');
        const body = JSON.parse(await readBody(req));
        let out;
        try {
          out = { value: await call(String(body.fn), Array.isArray(body.args) ? body.args : []) };
        } catch (e) {
          out = { error: String((e && e.message) || e) };
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(out ?? { value: null }));
      }
      if (rel === '__desktop/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': ok\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (rel === '__desktop/ui-shim.js') {
        const pre = `globalThis.__bproDesktop = ${JSON.stringify({ base: prefix, manifest })};\n`;
        res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
        return res.end(pre + shim);
      }
      if (!SERVE.test(rel) || rel.split('/').includes('..')) return fail(404, 'not found');
      const file = path.join(extDir, rel);
      if (!file.startsWith(path.join(extDir, path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(404, 'not found');
      const ext = path.extname(file).toLowerCase();
      let body = fs.readFileSync(file);
      if (ext === '.html') {
        // 垫片要在页面自己的脚本之前：插在 <head> 的最前面
        body = Buffer.from(String(body).replace(/<head>/i, `<head>\n    <script src="${prefix}__desktop/ui-shim.js"></script>`));
      }
      res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    } catch (e) {
      log(`界面请求出错：${e.message}`);
      if (!res.headersSent) fail(500, 'error');
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (port && e.code === 'EADDRINUSE') server.listen(0, '127.0.0.1', resolve);
      else reject(e);
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  const { port: actual } = server.address();
  const base = `http://127.0.0.1:${actual}/${token}/`;
  // 事件流隔一会儿发个注释，免得浏览器或中间的东西当它断了
  const keep = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 25e3);
  keep.unref();

  return {
    port: actual,
    url: (p = '') => base + p,
    popupUrl: base + manifest.action.default_popup,
    statsUrl: base + manifest.options_ui.page,
    setTabs: (t) => {
      pages = t;
    },
    /** storage 有变化：推给打开着的界面（changes 里是 JSON 文本，见 storage.mjs）。 */
    broadcast(changes, area) {
      if (!clients.size) return;
      const c = {};
      for (const [k, v] of Object.entries(changes)) {
        c[k] = {};
        if (v.oldValue !== undefined) c[k].oldValue = JSON.parse(v.oldValue);
        if (v.newValue !== undefined) c[k].newValue = JSON.parse(v.newValue);
      }
      const data = JSON.stringify({ area, changes: c });
      for (const res of clients) res.write(`event: changed\ndata: ${data}\n\n`);
    },
    close() {
      clearInterval(keep);
      for (const c of clients) c.end();
      server.close();
    },
  };
}

function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      // 界面写进存储的最多是设置、保留时长这些，没有大的
      if (n > 8e6) {
        reject(new Error('请求太大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
