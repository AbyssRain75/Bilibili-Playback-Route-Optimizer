// SPDX-License-Identifier: AGPL-3.0-or-later
// chrome.storage 的一个区域（local / session），后台（vm 里的 sw.js）、客户端页面里的内容脚本和本地界面共用同一份（桌面版开发计划工作项 5）。
// 语义照 Chrome：get(null / 键 / 键数组 / 带默认值的对象)、set、remove、clear、getBytesInUse，读出来的都是副本；
// 值没变的键不算变化（Chrome 的 ValueStore 也是比较新旧值），onChanged 的格式是 { 键: { oldValue, newValue } }。
// 值按 JSON 文本存：Chrome 的存储本来就只收 JSON 能表示的值，存文本也省得每个读的人（vm、页面、界面）各自深拷贝，
// 读的人用自己的 JSON.parse 解出来（vm 里用 vm 自己的，见 runtime.mjs），对象就属于它自己的 realm。
//
// local 存在桌面版的数据目录里，一个键一个文件：记录按 100 条一块分在 rec:00000 这样的键里（见 store.js），
// 几个月的记录有几十 MB，放一个文件的话每 5 秒写一块就要重写全部。写之前先写临时文件再改名，进程中途被杀也不会留下半个文件；
// 改过的键攒一下（DEBOUNCE）再写，退出时 flushSync 写完。session 只在内存里，和 Chrome 一样重启就没了。
import fs from 'node:fs';
import path from 'node:path';

const DEBOUNCE = 1000;

// 键 → 文件名：Windows 的文件名不分大小写、不能有 : * ? " < > |，还有 CON、NUL 这些保留名。
// encodeURIComponent 之后大写字母前加 ^（编码后的文本里不会有 ^），再加前缀 k_，解码时反过来
export function fileOf(key) {
  const enc = encodeURIComponent(key).replace(/[*!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `k_${enc.replace(/[A-Z]/g, (c) => `^${c.toLowerCase()}`)}.json`;
}

export function keyOf(file) {
  const m = /^k_(.*)\.json$/.exec(file);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1].replace(/\^([a-z])/g, (_, c) => c.toUpperCase()));
  } catch {
    return null;
  }
}

/** Chrome 的 get 参数：null / undefined 为全部，字符串为一个键，数组为几个键，对象为键和默认值。返回 [键, 默认值 JSON 或 undefined]。 */
function wanted(keys, data) {
  if (keys === null || keys === undefined) return [...data.keys()].map((k) => [k, undefined]);
  if (typeof keys === 'string') return [[keys, undefined]];
  if (Array.isArray(keys)) return keys.map((k) => [String(k), undefined]);
  if (typeof keys === 'object') return Object.entries(keys).map(([k, v]) => [k, v === undefined ? undefined : JSON.stringify(v)]);
  throw new TypeError('storage.get：参数要是 null、字符串、数组或对象');
}

export class StorageArea {
  /** name：local / session；dir：持久化目录（不给就只放内存）；onChange(changes, name)：有变化时调，changes 里是 JSON 文本。 */
  constructor(name, { dir = null, onChange = null } = {}) {
    this.name = name;
    this.dir = dir;
    this.onChange = onChange;
    this.data = new Map(); // 键 → JSON 文本
    this.dirty = new Set();
    this.timer = null;
    if (dir) this.load();
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const file of fs.readdirSync(this.dir)) {
      const key = keyOf(file);
      if (key === null) continue;
      const text = fs.readFileSync(path.join(this.dir, file), 'utf8');
      try {
        JSON.parse(text);
        this.data.set(key, text);
      } catch {
        // 坏掉的文件（不该出现：都是先写临时文件再改名的）跳过，不让整个存储读不出来
        console.warn(`[storage] 跳过读不了的 ${file}`);
      }
    }
  }

  /** 返回 { 键: JSON 文本 }，缺的键用默认值（有的话）。 */
  getJson(keys) {
    const out = {};
    for (const [k, dflt] of wanted(keys, this.data)) {
      if (this.data.has(k)) out[k] = this.data.get(k);
      else if (dflt !== undefined) out[k] = dflt;
    }
    return out;
  }

  /** 读出来，用 parse 解成对象（默认本 realm 的 JSON.parse）。 */
  get(keys, parse = JSON.parse) {
    const out = {};
    for (const [k, v] of Object.entries(this.getJson(keys))) out[k] = parse(v);
    return out;
  }

  /** items：{ 键: 值 }。值为 undefined 的键 Chrome 忽略（JSON 序列化后没有这一项）。 */
  set(items) {
    if (!items || typeof items !== 'object') throw new TypeError('storage.set：参数要是对象');
    const changes = {};
    for (const [k, v] of Object.entries(items)) {
      const text = JSON.stringify(v);
      if (text === undefined) continue;
      const old = this.data.get(k);
      if (old === text) continue;
      this.data.set(k, text);
      changes[k] = old === undefined ? { newValue: text } : { oldValue: old, newValue: text };
      this.touch(k);
    }
    this.emit(changes);
  }

  remove(keys) {
    const changes = {};
    for (const k of [].concat(keys)) {
      const key = String(k);
      if (!this.data.has(key)) continue;
      changes[key] = { oldValue: this.data.get(key) };
      this.data.delete(key);
      this.touch(key);
    }
    this.emit(changes);
  }

  clear() {
    this.remove([...this.data.keys()]);
  }

  /** 按 Chrome 的算法：键的长度加值的 JSON 长度。 */
  getBytesInUse(keys = null) {
    let n = 0;
    for (const [k] of wanted(keys, this.data)) if (this.data.has(k)) n += k.length + this.data.get(k).length;
    return n;
  }

  emit(changes) {
    if (this.onChange && Object.keys(changes).length) this.onChange(changes, this.name);
  }

  touch(key) {
    if (!this.dir) return;
    this.dirty.add(key);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), DEBOUNCE);
      this.timer.unref?.();
    }
  }

  /** 把改过的键写到磁盘（同步：退出前也能调）。 */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dir) return;
    for (const key of this.dirty) {
      const file = path.join(this.dir, fileOf(key));
      try {
        if (this.data.has(key)) {
          const tmp = `${file}.tmp`;
          fs.writeFileSync(tmp, this.data.get(key));
          fs.renameSync(tmp, file);
        } else {
          fs.rmSync(file, { force: true });
        }
      } catch (e) {
        // 写不进去（磁盘满、被占用）：留着下次再写
        console.warn(`[storage] 写入 ${key} 失败：${e.message}`);
        continue;
      }
      this.dirty.delete(key);
    }
    if (this.dirty.size && !this.timer) {
      this.timer = setTimeout(() => this.flush(), DEBOUNCE * 5);
      this.timer.unref?.();
    }
  }
}

/**
 * 数据目录的锁：同一个数据目录只能有一个桌面版在用（两个进程各写各的会把记录写乱）。
 * 锁文件里是进程号，那个进程已经不在了（上次被强制结束）就接过来。返回解锁函数；被占用时抛出。
 */
export function lockDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'lock');
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (pid && pid !== process.pid && alive(pid)) {
        const err = new Error(`数据目录正被进程 ${pid} 使用：${dir}`);
        err.code = 'LOCKED';
        throw err;
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`锁不上数据目录：${dir}`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
