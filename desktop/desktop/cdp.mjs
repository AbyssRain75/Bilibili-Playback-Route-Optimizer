// SPDX-License-Identifier: AGPL-3.0-or-later
// 最小 CDP 客户端（Node 22+ 自带 WebSocket），tools/e2e.mjs 和桌面版共用（桌面版开发计划工作项 3）。
// 浏览器级连接加 flatten 模式：各页面的命令和事件都走这一条连接，靠 sessionId 分开。

export class CDP {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    this.closed = false;
    // 连接断了（客户端退出、自己另起了进程）：桌面版据此重连或退出（见 client.mjs）
    this.onclose = null;
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error(`无法连接 ${this.url}`));
    });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = m.id && this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
        else p.resolve(m.result);
      } else {
        for (const fn of this.listeners) fn(m);
      }
    };
    // 断开后还在等的命令不会再有回复，都按失败结束，免得调用方一直等
    this.ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`${p.method}: 连接已断开`));
      this.pending.clear();
      if (this.onclose) this.onclose();
    };
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(`${method}: 连接已断开`));
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(fn) {
    this.listeners.push(fn);
  }

  async evaluate(sessionId, expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`evaluate 失败：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }

  close() {
    this.ws?.close();
  }
}
