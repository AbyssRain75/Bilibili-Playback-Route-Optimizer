// SPDX-License-Identifier: GPL-3.0-or-later
(() => {
  'use strict';

  const { L, esc, median, num, bytes, ms, time, timeOfDay, chip, dot, pcdnPart, shortHost, shortPath, page, problem, net, clock, cause, why, BACKUP_ONLY, qn } = Fmt;
  const { DEFAULT_SETTINGS, isBiliUrl, classifyHost, nodeClass, lineOf, UPOS_MIRRORS, TROUBLE, PROTO_TROUBLE, HLS_LOAD, HLS_KNOWN_HEADROOM, RANK_MAX_AGE, troubleOf, isBad, markCause } = globalThis.__bilicdn;
  const $main = document.getElementById('main');
  const $footer = document.getElementById('footer');

  document.getElementById('open-stats').addEventListener('click', () => chrome.runtime.openOptionsPage());

  const $error = document.getElementById('error');
  function showError(e, source = 'action') {
    $error.textContent = L(
      `操作未完成：${e.message || e}。请重试；扩展刚更新时请刷新 B 站页面。`,
      `Action failed: ${e.message || e}. Please try again; if the extension was just updated, reload the Bilibili page.`,
    );
    $error.hidden = false;
    $error.dataset.source = source;
  }
  const onAction = (el, event, fn) => el.addEventListener(event, () => Promise.resolve().then(fn).catch(showError));
  const rendered = new WeakMap();
  function setHtml(el, html) {
    if (rendered.get(el) === html) return;
    el.innerHTML = html;
    rendered.set(el, html);
  }

  /**
   * 正在用的节点（传输中的请求和近 10 秒完成的请求）及其状况：测速得分、近期出过的问题、是不是 PCDN。
   * 是不是 PCDN 按这些请求算（见 cdn.js nodeClass）：n 个请求里 pc 个是，全是的算 PCDN，一部分是的注明。
   * avoid：线路优化的“自动”下次会避开它（点播指定了节点时不避开；直播的 host 排序不受线路设置影响）。
   */
  function nodesOf(s, active, { rank, trouble, known }) {
    const seen = new Map();
    const since = Date.now() - 10e3;
    for (const x of [...active, ...(s.recent || []).filter((r) => r.t > since).reverse()]) {
      const e = seen.get(x.h) || seen.set(x.h, { h: x.h, p: lineOf(x.k), n: 0, pc: 0 }).get(x.h);
      e.n += 1;
      if (x.pc) e.pc += 1;
    }
    const w = troubleOf(trouble);
    const detail = Object.values((rank && rank.detail) || {});
    return [...seen.values()].map((n) => {
      const sc = detail.filter((d) => d.h === n.h && d.sc != null).map((d) => d.sc);
      const old = known && known.vod ? known.vod[n.h] : undefined;
      const weight = (n.p && w[n.p][n.h]) || 0;
      const avoid = !!n.p && isBad(w[n.p], n.h) && (n.p !== 'vod' || settings.vodHost === 'auto');
      return { ...n, cls: nodeClass(n.h, n.pc, n.n), sc: sc.length ? Math.max(...sc) : null, old: old ?? null, weight, avoid };
    });
  }

  function nodeRow(n) {
    const facts = [];
    if (n.cls === 'pcdn') facts.push('<span class="warn-text">PCDN</span>');
    else if (n.pc) facts.push(`<span class="warn-text" title="${L(`${n.n} 个请求里 ${n.pc} 个带 os=mcdn 参数，按 PCDN 算`, `${n.pc} of ${n.n} requests carry os=mcdn, counted as PCDN`)}">${L('部分请求是 PCDN', 'Partly PCDN')}</span>`);
    if (n.sc != null) facts.push(n.sc > 0 ? `${L('测速', 'Tested')} ${num(n.sc, 1)} Mbps` : `<span class="bad">${L('测速失败', 'Speed test failed')}</span>`);
    else if (n.old != null) facts.push(`<span title="${L('本网络以往的测速（网络档案）', "This network's past speed tests (network profile)")}">${L('以往测速', 'Past test')} ${num(n.old, 1)} Mbps</span>`);
    if (n.weight >= TROUBLE.bad) facts.push(`<span class="bad">${L('近期卡过', 'Stalled recently')}${n.avoid && settings.route ? L('，下次避开', ', avoided next time') : ''}</span>`);
    else if (n.weight > 0) facts.push(`<span class="warn-text">${L('出过问题', 'Had problems')}</span>`);
    else facts.push(`<span class="ok">${L('正常', 'OK')}</span>`);
    return `<li><span class="host" title="${esc(n.h)}">${dot(n.cls)}${esc(shortHost(n.h))}</span><span class="node-facts">${facts.join(' · ')}</span></li>`;
  }

  function pageCard(s, ps, active, store) {
    const warn =
      s.via === 'req'
        ? `<div class="warn">${L('页面记录不完整，请刷新 B 站页面。', 'This page is only partly recorded. Please reload the Bilibili page.')}</div>`
        : '';
    const diagnosis = ps && !ps.paused ? markCause(ps, null) : null;
    const status = !ps ? L('等待播放器', 'Waiting for player') : ps.paused ? L('已暂停', 'Paused') : cause(diagnosis);
    const tone = diagnosis === 'net' ? 'bad' : diagnosis === 'drop' ? 'warn-text' : diagnosis === 'ok' ? 'ok' : 'muted';
    const hint = diagnosis === 'drop' ? L('可尝试降低画质或检查硬件解码。', 'Try a lower quality or check hardware decoding.') : '';
    const nodes = nodesOf(s, active, store);
    const avoid = settings.route ? nodes.filter((n) => n.avoid) : [];
    const banner = avoid.length
      ? `<div class="banner"><span>${esc(avoid.map((n) => shortHost(n.h)).join(L('、', ', ')))} ${L('近期卡顿', 'stalled recently')}</span><button class="primary" data-act="reload">${L('刷新换节点', 'Reload for a new node')}</button></div>`
      : '';
    const drop = ps && ps.frames >= 30 ? `${num((ps.drop / ps.frames) * 100, 1)}%` : '–';
    return `<section class="card overview">
      <div class="overview-head"><h2>${L('当前播放', 'Now playing')} · ${esc(page(s.page))}</h2><span class="status ${tone}">${status}</span></div>${warn}
      <div class="meta-line path muted" title="${esc(s.path)}">${esc(shortPath(s.path))}${s.via === 'nav' ? L(' · 站内切换', ' · switched in page') : ''}</div>${routeLine(s.route)}
      <div class="metrics">
        <div><span>${L('前方缓冲', 'Buffer ahead')}</span><b>${ps ? `${num(ps.buf, 1)}<small> s</small>` : '–'}</b></div>
        <div title="${L('近约 10 秒的掉帧比例；不足 30 帧时不判断', 'Share of frames dropped in the last ~10 s; not judged under 30 frames')}"><span>${L('近期掉帧', 'Dropped frames')}</span><b>${drop}</b></div>
        <div title="${L(`本会话累计 ${ms(s.stall.ms)}`, `${ms(s.stall.ms)} in total this session`)}"><span>${L('会话卡顿', 'Session stalls')}</span><b class="${s.stall.n ? 'bad' : ''}">${num(s.stall.n)}${L('<small> 次</small>', '')}</b></div>
      </div>
      <div class="playback-meta muted">${ps && ps.vh ? `${esc(ps.vh)}p · ` : ''}${L('起播', 'Startup')} ${ms(s.start)} · ${L(`${esc(timeOfDay(s.t))} 开始`, `started ${esc(timeOfDay(s.t))}`)}${hlsLoadText(s.hls)}</div>
      ${hint ? `<div class="diagnosis ${tone}">${hint}</div>` : ''}
      <div class="nodes"><div class="nodes-head muted">${L('正在用的节点', 'Nodes in use')}</div>${nodes.length ? `<ul>${nodes.map(nodeRow).join('')}</ul>` : `<div class="muted">${L('等待媒体请求', 'Waiting for media requests')}</div>`}</div>
      ${banner}
    </section>`;
  }

  /** 直播 HLS 近 30 秒分片下载的占用（见 analyze.js hlsLoad），只显示 15 秒内算过的。占满了就没有余量，会卡。 */
  function hlsLoadText(h) {
    if (!h || !(h.t > Date.now() - 15e3)) return '';
    const full = h.v >= HLS_LOAD.busy;
    const title = L(
      `近 30 秒取 HLS 分片的时间占比，${num(HLS_LOAD.busy * 100)}% 以上就跟不上了，容易卡`,
      `Share of the last 30 s spent fetching HLS segments; at ${num(HLS_LOAD.busy * 100)}% or more it can't keep up and tends to stall`,
    );
    return ` · <span class="${full ? 'bad' : ''}" title="${title}">${L('HLS 下载占用', 'HLS download load')} ${num(h.v * 100)}%${full ? L('，跟不上', ", can't keep up") : ''}</span>`;
  }

  /** 线路优化对当前页面做了什么。 */
  function routeLine(r) {
    if (!r) return '';
    const parts = [];
    if (r.proto) parts.push(L(`只用 ${r.proto.toUpperCase()}`, `${r.proto.toUpperCase()} only`));
    if (r.to) parts.push(`${esc(shortHost(r.from || '?'))} → <b>${esc(shortHost(r.to))}</b>`);
    if (r.bk) parts.push(BACKUP_ONLY);
    return `<div class="meta-line route">${L('线路优化', 'Route optimization')}${r.why ? L(`（${why(r.why)}）`, ` (${why(r.why)})`) : ''}${L('：', ': ')}${parts.join(' · ')}</div>`;
  }

  function asgCard(a) {
    if (!a) return `<section class="card"><h2>${L('分配到的节点', 'Assigned nodes')}</h2><div class="empty">${L('尚未捕获到播放地址', 'No playback URL captured yet')}</div></section>`;
    const detail =
      a.kind === 'vod'
        ? L(`清晰度 ${a.q ?? '–'} · 视频轨 ${a.video} · 音频轨 ${a.audio}`, `quality ${a.q ?? '–'} · video tracks ${a.video} · audio tracks ${a.audio}`)
        : `qn ${a.qn ?? '–'} · ${a.lines.map(esc).join(L('、', ', '))}`;
    const rows = Object.entries(a.hosts)
      .sort((x, y) => y[1].base - x[1].base || y[1].backup - x[1].backup)
      .map(([h, e]) => `<tr><td class="host" title="${esc(h)}">${esc(h)}</td><td>${chip(e.cls)}${pcdnPart(e.cls, e.pc || 0, e.base + e.backup, true)}</td><td class="num">${e.base}</td><td class="num">${e.backup}</td></tr>`)
      .join('');
    return `<section class="card">
      <h2>${L('分配到的节点', 'Assigned nodes')}</h2>
      <div class="meta-line muted">${a.pre ? L('切换前预加载 · ', 'preloaded before switch · ') : ''}${esc(a.src)} ${esc(a.api)} · ${detail}</div>
      <table><thead><tr><th>host</th><th class="cls">${L('类型', 'Type')}</th><th class="num" title="${L('主地址', 'Main URLs')}">${L('主', 'Main')}</th><th class="num" title="${L('备用地址', 'Backup URLs')}">${L('备', 'Bak')}</th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
  }

  function reqCard(hosts, active) {
    const entries = Object.entries(hosts).sort((x, y) => y[1].n - x[1].n);
    // 直播 FLV 长连接即使已记过一条请求，也单独显示传输中的时长
    const streaming = active.filter((a) => a.k === 'live-flv' || !hosts[a.h]);
    if (!entries.length && !streaming.length) {
      return `<section class="card"><h2>${L('实际请求', 'Actual requests')}</h2><div class="empty">${L('还没有媒体请求', 'No media requests yet')}</div></section>`;
    }
    // 类型按请求算（见 cdn.js nodeClass），一部分请求是 PCDN 的在 host 下面注明
    const rows = entries
      .map(([h, e]) => {
        const cls = nodeClass(h, e.pc || 0, e.n);
        return `<tr>
          <td class="host" title="${esc(h)}&#10;${esc(e.ip)}">${dot(cls)}${esc(shortHost(h))}${pcdnPart(cls, e.pc || 0, e.n, true)}</td>
          <td class="num">${e.n}</td>
          <td class="num ${e.err ? 'bad' : ''}">${e.err}</td>
          <td class="num">${ms(median(e.tt))}</td>
          <td class="num">${num(median(e.mb), 1)}</td>
          <td class="num">${bytes(e.b)}</td>
        </tr>`;
      })
      .join('');
    const live = streaming
      .map(
        (a) => `<tr><td class="host" title="${esc(a.h)}">${dot(nodeClass(a.h, a.pc ? 1 : 0, 1))}${esc(shortHost(a.h))}</td>
          <td colspan="5" class="muted">${esc(a.k)} ${L('传输中', 'streaming')} · ${ms(Date.now() - a.since)}</td></tr>`,
      )
      .join('');
    return `<section class="card">
      <h2>${L('实际请求', 'Actual requests')}</h2>
      <table><thead><tr><th>host</th><th class="num">${L('请求', 'Reqs')}</th><th class="num">${L('失败', 'Fails')}</th><th class="num wide">TTFB</th><th class="num">Mbps</th><th class="num wide">${L('流量', 'Data')}</th></tr></thead>
      <tbody>${rows}${live}</tbody></table>
    </section>`;
  }

  // ---------------------------------------------------------------- 标记卡顿

  const $markText = document.getElementById('mark-text');
  const $undo = document.getElementById('undo');
  const $reload = document.getElementById('reload');
  const $note = document.getElementById('note');
  const $markButtons = [...document.querySelectorAll('.mark-buttons button')];
  let markTarget = null;
  let feedbackUntil = 0; // 标记后的提示显示几秒，期间不被定时刷新覆盖

  function renderMarkStatus(s, tab) {
    // 标签页未提供 URL 时，用后台已有的 B 站会话识别标记目标。
    const url = tab && (tab.url || (s && s.path ? `https://${s.path}` : ''));
    markTarget = tab && Number.isInteger(tab.id) && isBiliUrl(url) ? { id: tab.id, url } : null;
    // 暂停时不能标记（SW 也不记）
    const paused = !settings.enabled;
    for (const btn of $markButtons) btn.disabled = !markTarget || paused;
    $note.disabled = !markTarget || paused;
    if (!paused && Date.now() < feedbackUntil) return;
    const n = s ? s.marks || 0 : 0;
    $markText.textContent = paused
      ? L('已暂停，不能标注', "Paused, can't mark")
      : !markTarget
        ? L('请打开 B 站视频或直播间', 'Open a Bilibili video or live room')
        : s
          ? L(`本页已标记 ${n} 次`, `Marked ${n} time${n === 1 ? '' : 's'} on this page`)
          : L('暂无会话，请刷新页面', 'No session yet, please reload the page');
    $undo.hidden = paused || !(markTarget && s && s.lastMark);
    $reload.hidden = true;
  }

  function showFeedback(text, holdMs = 4000) {
    $markText.textContent = text;
    feedbackUntil = Date.now() + holdMs;
  }

  /**
   * 标记结果：卡顿点（播放位置）、判断的原因、当时在用的节点；
   * 标记后有节点算作出过问题、线路优化的“自动”模式下次会避开时，提示刷新。
   */
  function markFeedback(lv, issue, r) {
    const parts = [L(`已标记「${problem(lv, issue)}」`, `Marked "${problem(lv, issue)}"`)];
    if (r.ps && r.ps.dur != null) parts.push(clock(r.ps.pos));
    if (r.cause === 'drop' && r.ps && r.ps.frames) parts.push(`${L('掉帧', 'Dropped frames')} ${num((r.ps.drop / r.ps.frames) * 100, 0)}%`);
    else if (r.cause) parts.push(r.ps ? `${cause(r.cause)} ${num(r.ps.buf, 1)} s` : cause(r.cause));
    if (!r.hosts.length) parts.push(L('暂无媒体请求', 'No media requests yet'));
    // 点播指定了节点时不会避开；直播的 host 排序不受线路设置影响
    const line = (h) => (r.hosts.find((x) => x.h === h) || {}).p;
    const avoid = (r.bad || []).filter((h) => line(h) !== 'vod' || settings.vodHost === 'auto');
    if (avoid.length && !settings.route) parts.push(L('开启线路优化可避开问题节点', 'Turn on route optimization to avoid problem nodes'));
    showFeedback(parts.join(' · '), avoid.length && settings.route ? 10000 : 5000);
    $reload.hidden = !(avoid.length && settings.route);
  }

  async function setupMark(refresh) {
    for (const btn of $markButtons) {
      onAction(btn, 'click', async () => {
        if (!markTarget) return;
        const lv = btn.dataset.lv ? Number(btn.dataset.lv) : null;
        const issue = btn.dataset.issue || null;
        const r = await chrome.runtime.sendMessage({ type: 'mark', tabId: markTarget.id, url: markTarget.url, lv, issue, note: $note.value });
        if (!r || !r.ok) return showFeedback(L('标记失败', 'Mark failed'));
        $note.value = '';
        markFeedback(lv, issue, r);
        $undo.hidden = false;
        refresh();
      });
    }
    onAction($undo, 'click', async () => {
      if (!markTarget) return;
      const r = await chrome.runtime.sendMessage({ type: 'unmark', tabId: markTarget.id });
      showFeedback(r && r.ok ? L('已撤销上一次标记', 'Last mark undone') : L('没有可撤销的标记', 'No mark to undo'));
      $undo.hidden = true;
      $reload.hidden = true;
      refresh();
    });
    $reload.addEventListener('click', () => {
      if (!markTarget) return;
      chrome.tabs.reload(markTarget.id);
      window.close();
    });
    // 快捷键信息读取失败也不影响标记操作。
    try {
      const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'mark-lag');
      const $shortcut = document.getElementById('shortcut');
      $shortcut.textContent = cmd && cmd.shortcut ? cmd.shortcut : '';
      $shortcut.title = L('标记为较多卡顿', 'Mark as "Many stalls"');
    } catch {}
  }

  // ---------------------------------------------------------------- 线路优化与测速设置

  const $route = document.getElementById('opt-route');
  const $vod = document.getElementById('opt-vod');
  const $live = document.getElementById('opt-live');
  const $probe = document.getElementById('opt-probe');
  const $button = document.getElementById('opt-button');
  const $enabled = document.getElementById('opt-enabled');
  const $hint = document.getElementById('settings-hint');
  const $mode = document.getElementById('mode');
  // 各项和默认值见 cdn.js DEFAULT_SETTINGS
  let settings = { ...DEFAULT_SETTINGS };

  for (const h of [...UPOS_MIRRORS, 'upos-hz-mirrorakam.akamaized.net']) $vod.add(new Option(shortHost(h), h));

  function showSettings() {
    const paused = !settings.enabled;
    $enabled.checked = settings.enabled;
    $route.checked = settings.route;
    $vod.value = settings.vodHost;
    $live.value = settings.liveProto;
    $probe.checked = settings.probe;
    $button.checked = settings.markButton;
    $route.disabled = $probe.disabled = $button.disabled = paused;
    $vod.disabled = $live.disabled = paused || !settings.route;
    $hint.textContent = paused ? L('暂停中', 'Paused') : L('下次加载生效', 'Applies on next load');
    $mode.textContent = paused ? L('已暂停', 'Paused') : settings.route ? L('线路优化', 'Route optimization') : L('观察模式', 'Observe mode');
    $mode.classList.toggle('on', !paused && settings.route);
    $mode.classList.toggle('paused', paused);
  }

  async function setupSettings(refresh) {
    settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get('settings')).settings };
    // 界面语言以设置为准，和打开时用的不一样就重新加载（见 ui/format.js followLang）
    Fmt.followLang(settings);
    if (![...$vod.options].some((option) => option.value === settings.vodHost)) $vod.add(new Option(shortHost(settings.vodHost), settings.vodHost));
    showSettings();
    let saving = Promise.resolve();
    const save = (patch) => {
      saving = saving.then(async () => {
        const previous = settings;
        settings = { ...settings, ...patch };
        showSettings();
        try {
          await chrome.storage.local.set({ settings });
          $error.hidden = true;
        } catch (e) {
          settings = previous;
          showSettings();
          throw e;
        }
      }).catch(showError);
      return saving;
    };
    // 暂停 / 恢复马上重绘当前播放和标记区，不等定时刷新
    $enabled.addEventListener('change', () => save({ enabled: $enabled.checked }).then(refresh));
    $route.addEventListener('change', () => save({ route: $route.checked }));
    $vod.addEventListener('change', () => save({ vodHost: $vod.value }));
    $live.addEventListener('change', () => save({ liveProto: $live.value }));
    $probe.addEventListener('change', () => save({ probe: $probe.checked }));
    $button.addEventListener('change', () => save({ markButton: $button.checked }));
    // 存下后 followLang 收到设置变了，重新加载换语言
    Fmt.langButton(document.getElementById('lang'), save);
  }

  const KIND = { vod: L('点播', 'VOD'), 'live-flv': 'FLV', 'live-hls': 'HLS' };
  const LINE = { vod: L('点播', 'VOD'), flv: 'FLV', hls: 'HLS' };
  const PROBLEM = {
    stall: L('卡顿', 'stall'),
    slow: L('起播慢', 'slow start'),
    fail: L('没能起播', 'failed start'),
    err: L('请求失败', 'failed request'),
    hang: L('无响应', 'no response'),
    mark: L('标记', 'marked'),
    busy: L('跟不上', "can't keep up"),
  };

  /**
   * 近 keep 毫秒的卡顿证据按 keyOf 分组，按合计权重从大到小：{ h, p, qn, w 合计权重, n 各原因的次数, as 同一台服务器带来的名字 }。
   */
  function groupTrouble(list, keep, keyOf) {
    const since = Date.now() - keep;
    const rows = new Map();
    for (const x of list || []) {
      if (!(x.t > since)) continue;
      const key = keyOf(x);
      const e = rows.get(key) || { h: x.h, p: x.p, qn: x.qn, w: 0, n: {}, as: new Set() };
      e.w += x.w;
      e.n[x.why] = (e.n[x.why] || 0) + 1;
      if (x.as) e.as.add(x.as);
      rows.set(key, e);
    }
    return [...rows.values()].sort((a, b) => b.w - a.w);
  }

  /** 一组证据里各种问题的次数，如「卡顿 2 · 标记 1」。 */
  const problems = (e) => Object.entries(e.n).map(([k, n]) => `${PROBLEM[k] || k} ${n}`).join(' · ');

  /** 直播协议的卡顿证据（近 12 小时，按协议 + 清晰度，见 sw.js addProtoTrouble），合计到 PROTO_TROUBLE.bad 的「自动」会改用另一种协议。 */
  const protoRows = (list) => groupTrouble(list, PROTO_TROUBLE.keep, (x) => `${x.p}|${x.qn}`);

  function protoTable(list) {
    const rows = protoRows(list);
    if (!rows.length) return '';
    const body = rows
      .map((e) => {
        const bad = e.w >= PROTO_TROUBLE.bad;
        const what = problems(e);
        return `<tr>
          <td>${LINE[e.p] || esc(e.p)}${e.qn != null ? ` · ${esc(qn(e.qn))}` : ''}</td>
          <td class="what">${esc(what)}</td>
          <td class="${bad ? 'bad' : 'muted'}">${bad ? L('改用另一种', 'Switch') : L('观察', 'Watch')}</td>
        </tr>`;
      })
      .join('');
    return `<div class="meta-line muted">${L('直播协议 · 近 12 小时', 'Live protocols · last 12 hours')}</div>
      <table class="proto"><thead><tr><th>${L('协议 · 清晰度', 'Protocol · quality')}</th><th>${L('问题', 'Problems')}</th><th class="state wide-state">${L('状态', 'State')}</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  /**
   * 近 30 分钟出过问题的节点（卡顿证据，见 sw.js）。权重到 TROUBLE.bad 的，线路优化的“自动”模式会避开。
   * 同一台服务器的其他镜像名带来的（as）注明来自哪个名字。
   */
  function troubleTable(list) {
    const rows = groupTrouble(list, TROUBLE.keep, (x) => `${x.p}|${x.h}`);
    if (!rows.length) return `<div class="empty">${L('近 30 分钟无问题节点', 'No problem nodes in the last 30 minutes')}</div>`;
    const body = rows
      .map((e) => {
        const avoid = e.w >= TROUBLE.bad;
        // 列窄，镜像名只留后缀（upos-sz-mirror08h → 08h）
        const same = e.as.size ? ` · ${L('同服务器', 'same server')} ${[...e.as].map((h) => shortHost(h).replace(/^upos-sz-mirror/, '')).join(L('、', ', '))}` : '';
        const what = problems(e) + same;
        return `<tr>
          <td class="host" title="${esc(e.h)}">${dot(classifyHost(e.h))}${esc(shortHost(e.h))}</td>
          <td>${LINE[e.p] || esc(e.p)}</td>
          <td class="what" title="${esc(what)}">${esc(what)}</td>
          <td class="${avoid ? 'bad' : 'muted'}">${avoid ? L('避开', 'Avoid') : L('观察', 'Watch')}</td>
        </tr>`;
      })
      .join('');
    return `<div class="meta-line muted">${L('节点问题 · 近 30 分钟', 'Node problems · last 30 minutes')}</div>
      <table><thead><tr><th>host</th><th class="kind">${L('线路', 'Line')}</th><th>${L('问题', 'Problems')}</th><th class="state">${L('状态', 'State')}</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  /**
   * 本网络以往测速（网络档案，见 probe.js bookKnown）：点播最好的几个节点，「自动」先复测它们，测过还好才换；
   * 直播 HLS 按编码和清晰度汇总的得分 ÷ 码率，不到 HLS_KNOWN_HEADROOM 的「自动」开播就用 FLV。
   */
  function knownLine(known) {
    const rows = Object.entries((known && known.vod) || {}).sort((a, b) => b[1] - a[1]);
    const top = rows.slice(0, 5).map(([h, sc]) => `${esc(shortHost(h))} ${num(sc, 1)}`).join(' · ');
    const vod = rows.length
      ? `<div class="meta-line muted known" title="${esc(known.label || '')}${L('：每个节点 7 天内最近几次测速的中位数', ": each node's median of its latest speed tests within 7 days")}">${L(`历史测速 · ${rows.length} 个节点（Mbps）`, `Past speed tests · ${rows.length} node${rows.length === 1 ? '' : 's'} (Mbps)`)}<br>${top}${rows.length > 5 ? ' …' : ''}</div>`
      : '';
    const hls = Object.entries((known && known.hls) || {}).map(([cq, x]) => {
      const [c, q] = cq.split(' ');
      const name = [q && qn(Number(q)), c].filter(Boolean).join(' ');
      return `${esc(name)} ${num(x.r, 2)}${L(' 倍', '×')}${x.r < HLS_KNOWN_HEADROOM ? L(' · 建议 FLV', ' · FLV advised') : ''}`;
    });
    const live = hls.length
      ? `<div class="meta-line muted known" title="${esc(known.label || '')}${L(`：各 host 7 天内的 HLS 测速合在一起，每次得分 ÷ 码率的中位数；不到 ${HLS_KNOWN_HEADROOM} 倍算跟不上`, `: HLS speed tests of all hosts within 7 days, median of score ÷ bitrate; under ${HLS_KNOWN_HEADROOM}× can't keep up`)}">${L('HLS 历史余量', 'Past HLS headroom')}<br>${hls.join(' · ')}</div>`
      : '';
    return vod + live;
  }

  /**
   * 测速结果：最近几次的中位数，直播按编码和清晰度分行（见 route.js lineKey）。
   * HLS 的得分低于码率说明一个分片一个分片地取跟不上。s 为当前页的会话，测速地址过期时提示刷新。
   */
  function probeTable(rank, s, probe, known) {
    if (!settings.enabled || !settings.probe) return `<div class="empty">${settings.enabled ? L('自动测速已关闭', 'Auto speed test is off') : L('已暂停', 'Paused')}</div>${knownLine(known)}`;
    const skipped = probeSkipped(probe)
      ? `<div class="meta-line warn-text">${probe.skip === 'stall' ? L('播放缓冲中', 'Player is buffering') : L('缓冲不足', 'Low buffer')}${L('，已暂停测速', ', speed test paused')}${probe.n ? L(` · 本轮已测 ${probe.n} 个节点`, ` · ${probe.n} node${probe.n === 1 ? '' : 's'} tested this round`) : ''}</div>`
      : '';
    const expired =
      s && s.target && s.target.expired
        ? `<div class="meta-line bad">${L('测速地址已过期，请刷新页面。', 'The speed test URL has expired, please reload the page.')}</div>`
        : skipped;
    const wait = (rank && rank.wait) || {};
    const restUntil = (key) => (wait[key] > Date.now() ? wait[key] : 0);
    const rows = Object.entries((rank && rank.detail) || {}).map(([key, d]) => ({ ...d, key })).sort(
      (a, b) => a.k.localeCompare(b.k) || (b.qn || 0) - (a.qn || 0) || String(a.c).localeCompare(String(b.c)) || b.sc - a.sc,
    );
    if (!rows.length) return (expired || `<div class="empty">${L('等待测速结果', 'Waiting for speed test results')}</div>`) + knownLine(known);
    const body = rows
      .map((d) => {
        const slow = d.br && d.sc < d.br;
        const h = d.h || '';
        const line = [d.c, d.qn != null && qn(d.qn)].filter(Boolean).join(' ');
        return `<tr>
          <td class="host" title="${esc(h)}">${dot(classifyHost(h))}${esc(shortHost(h))}</td>
          <td class="line">${KIND[d.k] || esc(d.k)}${line ? `<div class="sub muted">${esc(line)}</div>` : ''}${restUntil(d.key) ? `<div class="sub muted" title="${L('测得差（失败、不到最好的一半，或本网络以往从没测好过），隔一段时间再测', 'Tested poorly (failed, under half the best, or never good on this network); retested after a while')}">${L(`${esc(timeOfDay(restUntil(d.key)).slice(0, 5))} 再测`, `retest ${esc(timeOfDay(restUntil(d.key)).slice(0, 5))}`)}</div>` : ''}</td>
          <td class="num ${d.sc ? (slow ? 'bad' : '') : 'bad'}" title="${L('按播放器取数据的方式估算能持续下载的速率', 'Sustainable download rate, estimated the way the player fetches data')}">${d.sc ? num(d.sc, 1) : L('失败', 'Failed')}</td>
          <td class="num">${d.br ? num(d.br, 1) : '–'}</td>
          <td class="num">${ms(d.tt)}</td>
          <td class="num">${d.ok}/${d.n}</td>
        </tr>`;
      })
      .join('');
    const restN = rows.filter((d) => restUntil(d.key)).length;
    return `${expired}<div class="meta-line muted">${L(`${esc(timeOfDay(rank.t))} 更新`, `Updated ${esc(timeOfDay(rank.t))}`)} · Mbps${restN ? L(` · ${restN} 个节点暂缓复测`, ` · ${restN} node${restN === 1 ? '' : 's'} on hold`) : ''}</div>
      <table><thead><tr><th>host</th><th class="kindq">${L('类型', 'Type')}</th><th class="num">${L('速率', 'Rate')}</th><th class="num">${L('码率', 'Bitrate')}</th><th class="num wide">TTFB</th><th class="num">${L('成功', 'OK')}</th></tr></thead><tbody>${body}</tbody></table>${knownLine(known)}`;
  }

  /** 最近一轮测速因为缓冲不够没测完（只看 2 分钟内的，再早的已经过时）。 */
  const probeSkipped = (probe) => !!(probe && probe.skip && probe.t > Date.now() - 120e3);

  function probeState(rank, s, probe, known) {
    const hasKnown = !!(known && known.vod && Object.keys(known.vod).length);
    if (!settings.enabled) return L('已暂停', 'Paused');
    if (!settings.probe) return hasKnown ? L('已关闭 · 按以往记录', 'Off · using past results') : L('已关闭', 'Off');
    if (s && s.target && s.target.expired) return L('地址过期 · 需刷新', 'URL expired · reload');
    if (probeSkipped(probe)) return probe.skip === 'stall' ? L('播放在缓冲 · 暂停测速', 'Buffering · paused') : L('等缓冲充足再测', 'Waiting for buffer');
    if (rank && rank.t && rank.t > Date.now() - RANK_MAX_AGE) return L(`更新于 ${timeOfDay(rank.t)}`, `Updated ${timeOfDay(rank.t)}`);
    return hasKnown ? L('按以往记录', 'Using past results') : L('等待播放', 'Waiting for playback');
  }

  // ---------------------------------------------------------------- 主流程

  function render(res, store, tab) {
    const { meta, net: n, rank, trouble, protoTrouble, known } = store;
    const s = res && res.session;
    const probe = res && res.probe;
    setHtml(document.getElementById('trouble'), troubleTable(trouble) + protoTable(protoTrouble));
    setHtml(document.getElementById('probe'), probeTable(rank, s, probe, known));
    // 同一台服务器的几个镜像名算一条（as 为出问题的那个名字）
    const problemCount = new Set((trouble || []).filter((x) => x.t > Date.now() - TROUBLE.keep).map((x) => `${x.p}|${x.as || x.h}`)).size;
    const protoBad = protoRows(protoTrouble).filter((e) => e.w >= PROTO_TROUBLE.bad).map((e) => LINE[e.p] || e.p);
    document.getElementById('trouble-count').textContent =
      [
        problemCount ? L(`${problemCount} 条线路`, `${problemCount} route${problemCount === 1 ? '' : 's'}`) : '',
        protoBad.length ? L(`避开直播 ${protoBad.join('、')}`, `avoiding live ${protoBad.join(', ')}`) : '',
      ].filter(Boolean).join(' · ') || L('暂无', 'None');
    document.getElementById('probe-state').textContent = probeState(rank, s, probe, known);
    $footer.innerHTML = `<span>${L(`已记录 ${num(meta ? meta.count : 0)} 条`, `${num(meta ? meta.count : 0)} records`)}</span><span title="${esc(net(n))}">${esc(net(n))}</span>`;
    renderMarkStatus(s, tab);
    if (!settings.enabled) {
      setHtml($main, `<section class="card empty"><b>${L('已暂停', 'Paused')}</b><span>${L('不记录、不改写播放地址、不测速。重新启用后，已打开的 B 站页面请刷新。', 'Not recording, rewriting playback URLs or running speed tests. After turning it back on, reload any open Bilibili pages.')}</span></section>`);
      setHtml(document.getElementById('connections'), `<div class="empty">${L('已暂停', 'Paused')}</div>`);
      return;
    }
    if (!s) {
      setHtml($main, `<section class="card empty"><b>${L('暂无播放', 'Nothing playing')}</b><span>${L('打开 B 站视频或直播间，已打开的页面请刷新。', 'Open a Bilibili video or live room; reload pages that were already open.')}</span></section>`);
      setHtml(document.getElementById('connections'), `<div class="empty">${L('播放视频或进入直播间后显示节点。', 'Nodes show up once a video or live room plays.')}</div>`);
      return;
    }
    setHtml($main, pageCard(s, res.player, res.active || [], store));
    setHtml(document.getElementById('connections'), asgCard(s.asg) + reqCard(s.hosts, res.active || []));
  }

  async function main() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const [res, store] = await Promise.all([
          chrome.runtime.sendMessage({ type: 'tab', tabId: tab && tab.id }),
          chrome.storage.local.get(['meta', 'net', 'rank', 'known', 'trouble', 'protoTrouble']),
        ]);
        if (res && res.error) throw new Error(res.error);
        render(res, store, tab);
        if ($error.dataset.source === 'refresh') $error.hidden = true;
      } catch (e) {
        showError(new Error(L(`暂无法更新，以下可能是上次数据。${e.message}`, `Can't update right now; the data below may be stale. ${e.message}`)), 'refresh');
      } finally {
        refreshing = false;
      }
    };
    await setupSettings(refresh);
    await setupMark(refresh);
    // 当前播放卡片里的“刷新换节点”：卡片随定时刷新重绘，用事件委托
    $main.addEventListener('click', (e) => {
      if (!tab || !e.target.closest('[data-act="reload"]')) return;
      chrome.tabs.reload(tab.id);
      window.close();
    });
    await refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 1500);
  }

  main().catch((e) => {
    $main.innerHTML = `<section class="card bad">${L('加载失败：', 'Failed to load: ')}${esc(e.message)}</section>`;
  });
})();
