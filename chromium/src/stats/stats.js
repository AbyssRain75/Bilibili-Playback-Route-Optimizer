// SPDX-License-Identifier: AGPL-3.0-or-later
(() => {
  'use strict';

  const { selectPeriod, analyze, timelines, classifyHost, MAIN_SHARE, netKey, bookKnown, buildExport } = globalThis.__bilicdn;
  const { L, esc, num, bytes, ms, time, chip, dot, pcdnPart, shortHost, shortPath, page, level, problem, net, clock, cause, seekUrl, why, BACKUP_ONLY } = Fmt;
  const $ = (id) => document.getElementById(id);
  const PERIODS = { day: L('本日', 'Today'), week: L('本周', 'This week'), all: L('安装以来', 'Since install') };
  const $periods = [...document.querySelectorAll('.report-range button')];
  let currentPeriod = 'all';
  let reportData = null;
  let reportSelection = null;

  const pct = (v) => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);

  function tile(label, value, sub = '') {
    return `<div class="card tile"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  }

  function renderTiles(a, bytesInUse) {
    const c = a.counts;
    const hours = a.range ? (a.range.last - a.range.since) / 3600e3 : 0;
    const stallMs = a.pages.reduce((s, p) => s + p.stallMs, 0);
    const { played, withAsg, noScript, orphanReq } = a.coverage;
    const coverageNote = [
      L(`${num(withAsg)} / ${num(played)} 个播放会话`, `${num(withAsg)} / ${num(played)} playback sessions`),
      noScript ? L(`${num(noScript)} 个会话页面脚本未运行`, `${num(noScript)} sessions without the page script`) : '',
      orphanReq ? L(`${num(orphanReq)} 条请求未归属页面`, `${num(orphanReq)} requests not tied to a page`) : '',
    ].filter(Boolean);
    const byProblem = [
      ...[1, 2, 3].map((lv) => `${level(lv)} ${a.marks.filter((m) => !m.issue && m.lv === lv).length}`),
      `${problem(null, 'sync')} ${a.marks.filter((m) => m.issue === 'sync').length}`,
    ].join(' · ');
    const autoN = a.auto.stall + a.auto.slow + a.auto.fail;
    $('tiles').innerHTML = [
      tile(L('记录时长', 'Time recorded'), `${num(hours, 1)} h`, a.range ? L(`${esc(time(a.range.since))} 起`, `since ${esc(time(a.range.since))}`) : L('暂无数据', 'No data')),
      tile(L('播放会话', 'Playback sessions'), num(played), L(`记下的会话 ${num(c.ses || 0)}`, `recorded sessions ${num(c.ses || 0)}`)),
      tile(L('媒体请求', 'Media requests'), num(c.req || 0), `${pcdnShare(a.hosts)}${L('总存储', 'storage')} ${bytes(bytesInUse)}`),
      tile(L('分配捕获率', 'Assignment capture'), played ? pct(withAsg / played) : '–', coverageNote.map(esc).join('<br>')),
      tile(
        L('自动识别卡顿', 'Auto-detected stalls'),
        num(autoN),
        L(
          `缓冲 ${num(a.auto.stall)} · 起播慢 ${num(a.auto.slow)} · 起播失败 ${num(a.auto.fail)}<br>缓冲合计 ${ms(stallMs)}`,
          `buffering ${num(a.auto.stall)} · slow start ${num(a.auto.slow)} · failed start ${num(a.auto.fail)}<br>buffering total ${ms(stallMs)}`,
        ),
      ),
      tile(L('手动标记', 'Manual marks'), num(a.marks.length), a.marks.length ? byProblem : L('暂无标记', 'No marks')),
    ].join('');
  }

  /**
   * PCDN 承担的请求占比，按每条请求算（见 cdn.js isPcdnReq）：只靠 os=mcdn 认出的也算，同一个 host 上不带的不算。
   * 0.6.19 以前按 host 算，漏了 host 看不出来、只带 os=mcdn 的请求
   */
  function pcdnShare(hosts) {
    const total = hosts.reduce((s, r) => s + r.n, 0);
    const pcdn = hosts.reduce((s, r) => s + r.pcdn, 0);
    return total ? L(`PCDN 占 ${pct(pcdn / total)} · `, `PCDN ${pct(pcdn / total)} · `) : '';
  }

  const VIA = { key: L('快捷键', 'shortcut'), page: L('播放器按钮', 'player button') };

  /** 卡顿点：点播为播放位置（点开从这里放），直播只有缓冲；附标记那一刻的前方缓冲和掉帧。 */
  function pointCell(m) {
    const ps = m.ps;
    if (!ps) return '<span class="muted">–</span>';
    const where = ps.dur != null
      ? `<a href="${esc(seekUrl(m.path, ps))}" target="_blank" rel="noreferrer" title="${L('从这里开始播放', 'Play from here')}">${esc(clock(ps.pos))}</a> <span class="muted">/ ${esc(clock(ps.dur))}</span>`
      : `<span class="muted">${L('直播', 'Live')}</span>`;
    const extra = [`${L('缓冲', 'buffer')} ${num(ps.buf, 1)} s`];
    if (ps.frames) extra.push(`${L('掉帧', 'dropped')} ${num((ps.drop / ps.frames) * 100, 0)}%`);
    if (ps.paused) extra.push(L('暂停中', 'paused'));
    return `${where} <span class="muted">· ${esc(extra.join(' · '))}</span>`;
  }

  function renderMarks(marks) {
    if (!marks.length) {
      $('marks').innerHTML = `<div class="empty">${L('暂无问题标注', 'No problem marks')}</div>`;
      return;
    }
    const body = marks
      .map((m) => {
        const hosts = m.hosts.length
          ? m.hosts
              .map((x) => {
                const minor = (x.w ?? 1) < MAIN_SHARE;
                const share = x.w != null ? `&#10;${L(`责任 ${Math.round(x.w * 100)}%（在途时间最长的为 100%）`, `responsibility ${Math.round(x.w * 100)}% (longest in flight = 100%)`)}` : '';
                return `<span class="mark-host${minor ? ' minor' : ''}" title="${esc(x.h)}${share}">${dot(classifyHost(x.h))}${esc(shortHost(x.h))}${x.act ? L('（传输中）', ' (streaming)') : ` ×${x.n}`}</span>`;
              })
              .join(' ')
          : `<span class="muted">${L('无媒体请求', 'No media requests')}</span>`;
        return `<tr>
          <td>${esc(time(m.t))}</td>
          <td>${esc(page(m.pg))}</td>
          <td class="path"><a href="https://${esc(m.path)}" target="_blank" rel="noreferrer" title="${esc(m.path)}">${esc(shortPath(m.path))}</a></td>
          <td class="lv" data-lv="${m.lv ?? ''}">${esc(problem(m.lv, m.issue))}${VIA[m.via] ? ` <span class="muted">· ${VIA[m.via]}</span>` : ''}</td>
          <td>${pointCell(m)}</td>
          <td class="cause" data-cause="${esc(m.cause || '')}">${esc(cause(m.cause))}</td>
          <td>${esc(m.note) || '<span class="muted">–</span>'}</td>
          <td>${hosts}</td>
        </tr>`;
      })
      .join('');
    const head = [L('时间', 'Time'), L('页面', 'Page'), L('地址', 'URL'), L('问题', 'Problem'), L('播放位置', 'Position'), L('判断', 'Cause'), L('备注', 'Note'), L('当时在用的节点', 'Nodes in use')];
    $('marks').innerHTML = `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  }

  // ---------------------------------------------------------------- 会话时间轴

  const TL_PAGE = 10;
  let tlRecords = [];
  let tlLimit = TL_PAGE;

  const pctOf = (s, t) => Math.min(100, Math.max(0, ((t - s.t0) / Math.max(s.t1 - s.t0, 1000)) * 100));
  const rel = (s, t) => clock((t - s.t0) / 1000);

  /** 时间轴上的一个标记：可聚焦，读屏文字和悬停提示相同（提示用 textContent 显示，这里只做属性转义）。 */
  const mark = (cls, style, tip, attrs = '') => `<span class="${cls}" style="${style}" tabindex="0" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}"${attrs}></span>`;
  // 点状事件：标记、起播、改写线路、请求失败
  const point = (cls, left, tip, attrs = '') => mark(cls, `left:${left.toFixed(2)}%`, tip, attrs);

  function eventLane(s) {
    const out = [];
    for (const x of s.stalls) {
      const a = pctOf(s, x.a);
      const cut = { leave: L('就离开', 'left the page'), switch: L('就换了源', 'switched source'), hidden: L('就切到了后台', 'went to background') }[x.end] || L('，暂停', 'paused');
      const why = x.wake
        ? L('（切回前台后恢复画面，不算节点的问题）', " (restoring the picture after returning to the foreground; not the node's fault)")
        : x.cut
          ? L(`（没等到恢复${cut}）`, ` (${cut} before it recovered)`)
          : '';
      const tip = `${L('卡顿', 'Stall')} ${ms(x.ms)}${why}\n${rel(s, x.a)} – ${rel(s, x.b)}`;
      out.push(mark(`tl-stall${x.inc ? '' : ' minor'}`, `left:${a.toFixed(2)}%;width:${Math.max(pctOf(s, x.b) - a, 0).toFixed(2)}%`, tip));
    }
    for (const x of s.starts) {
      const tip = x.fail ? L(`没能起播：等了 ${ms(x.ms)}`, `Failed to start: waited ${ms(x.ms)}`) : `${L('起播', 'Startup')} ${ms(x.ms)}${x.inc === 'slow' ? L('（慢）', ' (slow)') : ''}`;
      out.push(point(`tl-start${x.inc ? ' bad' : ''}`, pctOf(s, x.t), `${tip}\n${rel(s, x.t)}`));
    }
    for (const x of s.routes) {
      const what = [x.proto && L(`只用 ${x.proto.toUpperCase()}`, `${x.proto.toUpperCase()} only`), x.to && `${shortHost(x.from || '?')} → ${shortHost(x.to)}`, x.bk && BACKUP_ONLY].filter(Boolean).join(' · ');
      out.push(point('tl-route', pctOf(s, x.t), `${L('改写线路', 'Route rewritten')}${x.why ? L(`（${why(x.why)}）`, ` (${why(x.why)})`) : ''}${L('：', ': ')}${what}\n${rel(s, x.t)}`));
    }
    for (const x of s.marks) {
      const lines = [`${L(`手动标记「${problem(x.lv, x.issue)}」`, `Marked "${problem(x.lv, x.issue)}"`)}${VIA[x.via] ? ` · ${VIA[x.via]}` : ''}`];
      if (x.ps) lines.push(`${x.ps.dur != null ? `${L('播放位置', 'Position')} ${clock(x.ps.pos)} · ` : ''}${L('缓冲', 'buffer')} ${num(x.ps.buf, 1)} s`);
      if (x.cause) lines.push(`${L('判断：', 'Cause: ')}${cause(x.cause)}`);
      if (x.note) lines.push(`${L('备注：', 'Note: ')}${x.note}`);
      lines.push(rel(s, x.t));
      out.push(point('tl-mark', pctOf(s, x.t), lines.join('\n'), ` data-lv="${x.lv ?? ''}"`));
    }
    return out.join('');
  }

  /** 一个节点一行：有请求的时间段画成条，失败的位置画红色竖线。 */
  function hostLane(s, e) {
    const n = e.bins.length;
    const span = Math.max(s.t1 - s.t0, 1000);
    const at = (i) => s.t0 + (span * i) / n;
    const out = [];
    for (let i = 0; i < n; ) {
      if (!e.bins[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && e.bins[j + 1]) j++;
      out.push(mark('tl-req', `left:${((i / n) * 100).toFixed(2)}%;width:${(((j - i + 1) / n) * 100).toFixed(2)}%`, `${shortHost(e.h)} ${L('有请求', 'requests')}\n${rel(s, at(i))} – ${rel(s, at(j + 1))}`));
      i = j + 1;
    }
    e.bins.forEach((b, i) => b === 2 && out.push(point('tl-err', ((i + 0.5) / n) * 100, `${shortHost(e.h)} ${L('请求失败', 'request failed')}\n${L(`${rel(s, at(i))} 前后`, `around ${rel(s, at(i))}`)}`)));
    return out.join('');
  }

  function sessionBlock(s) {
    const c = s.counts;
    const facts = [`${L('时长', 'duration')} ${clock((s.t1 - s.t0) / 1000)}`];
    if (c.stall) facts.push(`${L('卡顿', 'stalls')} ${c.stall}`);
    if (c.slow) facts.push(`${L('起播慢', 'slow start')} ${c.slow}`);
    if (c.fail) facts.push(`${L('没能起播', 'failed start')} ${c.fail}`);
    if (c.mark) facts.push(`${L('标记', 'marks')} ${c.mark}`);
    const hosts = s.hosts
      .map(
        (e) => `<div class="tl-label host" title="${esc(e.h)}${e.cls !== 'pcdn' && e.pcdn ? `&#10;${L(`${e.n} 个请求里 ${e.pcdn} 个带 os=mcdn 参数，按 PCDN 算`, `${e.pcdn} of ${e.n} requests carry os=mcdn, counted as PCDN`)}` : ''}">${dot(e.cls)}${esc(shortHost(e.h))}</div>
          <div class="tl-track"><span class="tl-base"></span>${hostLane(s, e)}</div>`,
      )
      .join('');
    const path = s.path ? `<a class="path" href="https://${esc(s.path)}" target="_blank" rel="noreferrer" title="${esc(s.path)}">${esc(shortPath(s.path))}</a>` : '';
    return `<div class="tl-session">
      <div class="tl-head"><b>${esc(time(s.t0))}</b> <span>${esc(page(s.pg))}</span> ${path} <span class="muted">${esc(facts.join(' · '))}</span></div>
      <div class="tl-grid">
        <div class="tl-label muted">${L('事件', 'Events')}</div>
        <div class="tl-track events"><span class="tl-base"></span>${eventLane(s)}</div>
        ${hosts}
        ${s.moreHosts ? `<div class="tl-label muted">${L(`另有 ${s.moreHosts} 个节点`, `${s.moreHosts} more node${s.moreHosts === 1 ? '' : 's'}`)}</div><div></div>` : ''}
        ${s.hosts.length ? '' : `<div class="tl-label muted">${L('节点', 'Nodes')}</div><div class="tl-track muted empty-lane">${L('没有媒体请求记录', 'No media requests recorded')}</div>`}
        <div></div>
        <div class="tl-axis muted"><span>${rel(s, s.t0)}</span><span>${rel(s, (s.t0 + s.t1) / 2)}</span><span>${rel(s, s.t1)}</span></div>
      </div>
    </div>`;
  }

  function renderTimeline() {
    const issues = !$('tl-all').checked;
    const { total, rows } = timelines(tlRecords, { limit: tlLimit, issues, context: reportSelection?.context, from: reportSelection?.from, to: currentPeriod === 'all' ? null : reportSelection?.to });
    $('timeline').innerHTML = rows.length
      ? rows.map(sessionBlock).join('')
      : `<div class="empty">${issues ? L('暂无问题会话', 'No sessions with problems') : L('暂无数据', 'No data')}</div>`;
    $('tl-more').hidden = total <= rows.length;
    $('tl-more').textContent = L(`显示更多（还有 ${total - rows.length} 个）`, `Show more (${total - rows.length} left)`);
  }

  // 悬停 / 键盘聚焦到时间轴上的标记时显示提示
  const $tip = $('tl-tip');
  function showTip(el, x, y) {
    $tip.textContent = el.dataset.tip;
    $tip.hidden = false;
    // 先放到最左边再量宽度：靠右时绝对定位的元素会被挤窄
    $tip.style.left = '0px';
    const box = $tip.offsetParent.getBoundingClientRect();
    const w = $tip.offsetWidth;
    const px = x - box.left;
    const left = px + 12 + w <= box.width ? px + 12 : Math.max(px - 12 - w, 0);
    $tip.style.left = `${left}px`;
    $tip.style.top = `${y - box.top + 16}px`;
  }
  $('timeline').addEventListener('pointermove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY);
    else $tip.hidden = true;
  });
  $('timeline').addEventListener('pointerleave', () => ($tip.hidden = true));
  $('timeline').addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    showTip(el, r.left, r.bottom - 8);
  });
  $('timeline').addEventListener('focusout', () => ($tip.hidden = true));
  $('tl-all').addEventListener('change', () => {
    tlLimit = TL_PAGE;
    renderTimeline();
  });
  $('tl-more').addEventListener('click', () => {
    tlLimit += TL_PAGE;
    renderTimeline();
  });

  // 节点表：搜索、筛选，点表头排序（再点一次反过来）。没有数据的（–）总是排在最后
  const HOST_COLS = [
    { key: 'host', label: 'host', text: true },
    { key: 'cls', label: L('类型', 'Type'), text: true },
    { key: 'base', label: L('分配·主', 'Assigned·main') },
    { key: 'backup', label: L('分配·备', 'Assigned·backup') },
    { key: 'n', label: L('请求', 'Requests') },
    { key: 'errRate', label: L('失败率', 'Fail rate') },
    { key: 'auto', label: L('自动识别卡顿', 'Auto stalls') },
    { key: 'marked', label: L('被标记', 'Marked') },
    { key: 'ttfbP50', label: 'TTFB P50' },
    { key: 'ttfbP90', label: 'TTFB P90' },
    { key: 'mbpsP50', label: 'Mbps P50' },
    { key: 'probeScore', label: L('测速', 'Speed test') },
    { key: 'bytes', label: L('流量', 'Data') },
    { key: 'kinds', label: L('请求类型', 'Request types'), fixed: true },
    { key: 'ips', label: L('IP 数', 'IPs'), fixed: true },
  ];
  let hostRows = [];
  let hostSort = { key: 'n', dir: -1 };

  function sortedHosts(rows) {
    const { key, dir } = hostSort;
    const col = HOST_COLS.find((c) => c.key === key);
    const val = (r) => (key === 'probeScore' && !r.probeN ? null : r[key]);
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null || y == null) return (x == null) - (y == null);
      return (col.text ? String(x).localeCompare(String(y)) : x - y) * dir || b.n - a.n;
    });
  }

  // 筛选 PCDN：归为 PCDN 的，和有一部分请求是 PCDN 的（见 cdn.js nodeClass），同「媒体请求」里 PCDN 占比的口径
  function filterHosts() {
    const query = $('host-search').value.trim().toLowerCase();
    const filter = $('host-filter').value;
    const rows = hostRows.filter(
      (r) => r.host.toLowerCase().includes(query) && (filter === 'problem' ? r.err || r.auto || r.marked : filter === 'probed' ? r.probeN : filter === 'pcdn' ? r.cls === 'pcdn' || r.pcdn > 0 : true),
    );
    $('host-count').textContent = L(`${rows.length} / ${hostRows.length} 个节点`, `${rows.length} / ${hostRows.length} nodes`);
    renderHosts(sortedHosts(rows));
  }
  $('host-search').addEventListener('input', filterHosts);
  $('host-filter').addEventListener('change', filterHosts);
  $('hosts').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sort]');
    if (!btn) return;
    const key = btn.dataset.sort;
    const text = HOST_COLS.find((c) => c.key === key).text;
    hostSort = hostSort.key === key ? { key, dir: -hostSort.dir } : { key, dir: text ? 1 : -1 };
    filterHosts();
    $('hosts').querySelector(`button[data-sort="${key}"]`).focus();
  });

  function hostHead() {
    return HOST_COLS.map((c) => {
      const cls = c.text || c.key === 'kinds' ? '' : ' class="num"';
      if (c.fixed) return `<th${cls}>${esc(c.label)}</th>`;
      const on = hostSort.key === c.key;
      const aria = on ? ` aria-sort="${hostSort.dir > 0 ? 'ascending' : 'descending'}"` : '';
      return `<th${cls}${aria}><button class="sort${on ? ' on' : ''}" data-sort="${c.key}">${esc(c.label)}<i aria-hidden="true">${on ? (hostSort.dir > 0 ? '▲' : '▼') : ''}</i></button></th>`;
    }).join('');
  }

  function renderHosts(rows) {
    if (!rows.length) {
      $('hosts').innerHTML = `<div class="empty">${hostRows.length ? L('没有符合条件的节点，请调整筛选。', 'No nodes match; try another filter.') : L('暂无节点记录，播放视频后刷新查看。', 'No nodes recorded yet. Play a video, then refresh.')}</div>`;
      return;
    }
    const body = rows
      .map(
        (r) => `<tr>
          <td class="host" title="${esc(r.host)}&#10;${esc(r.ips.join(', '))}">${esc(r.host)}</td>
          <td>${chip(r.cls)}${pcdnPart(r.cls, r.pcdn, r.n)}</td>
          <td class="num">${num(r.base)}</td>
          <td class="num">${num(r.backup)}</td>
          <td class="num">${num(r.n)}</td>
          <td class="num ${r.errRate ? 'bad' : ''}" title="${L(`失败 ${r.err} 次，其中超时中止 ${r.timeouts} 次`, `${r.err} failures, ${r.timeouts} of them timeouts`)}">${pct(r.errRate)}</td>
          <td class="num ${r.auto ? 'bad' : ''}">${num(r.auto)}</td>
          <td class="num ${r.marked ? 'bad' : ''}">${num(r.marked)}</td>
          <td class="num">${ms(r.ttfbP50)}</td>
          <td class="num">${ms(r.ttfbP90)}</td>
          <td class="num" title="${L(`${r.mbpsSamples} 个样本`, `${r.mbpsSamples} samples`)}">${num(r.mbpsP50, 1)}</td>
          <td class="num" title="${L(`测速 ${r.probeN} 次，成功 ${r.probeOk} 次，TTFB P50 ${ms(r.probeTt)}`, `${r.probeN} speed tests, ${r.probeOk} succeeded, TTFB P50 ${ms(r.probeTt)}`)}">${r.probeN ? num(r.probeScore, 1) : '–'}</td>
          <td class="num">${bytes(r.bytes)}</td>
          <td class="mono">${esc(r.kinds.join(' '))}</td>
          <td class="num">${r.ips.length}</td>
        </tr>`,
      )
      .join('');
    $('hosts').innerHTML = `<table><thead><tr>${hostHead()}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function renderPages(rows) {
    if (!rows.length) {
      $('pages').innerHTML = `<div class="empty">${L('暂无数据', 'No data')}</div>`;
      return;
    }
    const body = rows
      .map(
        (r) => `<tr><td>${esc(page(r.page))}</td><td class="num">${num(r.sessions)}</td><td class="num">${ms(r.startP50)}</td><td class="num ${r.startFail ? 'bad' : ''}">${num(r.startFail)}</td>
          <td class="num">${num(r.stalls)}</td><td class="num">${ms(r.stallMs)}</td><td class="num">${ms(r.stallP50)}</td></tr>`,
      )
      .join('');
    $('pages').innerHTML = `<table><thead><tr><th>${L('页面', 'Page')}</th><th class="num">${L('播放会话', 'Sessions')}</th><th class="num">${L('起播 P50', 'Startup P50')}</th><th class="num">${L('没能起播', 'Failed starts')}</th>
      <th class="num">${L('卡顿', 'Stalls')}</th><th class="num">${L('卡顿合计', 'Stall total')}</th><th class="num">${L('单次 P50', 'Per stall P50')}</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  /** 网络环境变化，以及每个网络以往测速最好的几个点播节点（网络档案，见 probe.js）。 */
  function renderNets(nets, book) {
    const best = (n) => {
      const vod = bookKnown(book && book.nets[netKey(n)]).vod;
      const top = Object.entries(vod).sort((a, b) => b[1] - a[1]).slice(0, 3);
      return top.length ? `<div class="net-best muted">${L('以往测速最好：', 'Best past speed tests: ')}${top.map(([h, sc]) => `${esc(shortHost(h))} ${num(sc, 1)}`).join(' · ')}</div>` : '';
    };
    // 同一个网络（档案键相同）只在最后一次出现时列出最好的节点
    const lastOf = new Map(nets.map((n, i) => [netKey(n), i]));
    $('nets').innerHTML = nets.length
      ? `<ul class="nets">${nets.map((n, i) => `<li><span class="muted">${esc(time(n.t))}</span> ${esc(net(n))}${lastOf.get(netKey(n)) === i ? best(n) : ''}</li>`).join('')}</ul>`
      : `<div class="empty">${L('暂无数据', 'No data')}</div>`;
  }

  async function command(type, extra = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...extra });
    if (result && result.error) throw new Error(result.error);
    return result;
  }

  function renderReport() {
    if (!reportData) return;
    reportSelection = selectPeriod(reportData.records, currentPeriod);
    const { records, context } = reportSelection;
    const a = analyze(records, { context });
    for (const btn of $periods) {
      btn.disabled = false;
      btn.setAttribute('aria-pressed', String(btn.dataset.period === currentPeriod));
    }
    $('subtitle').textContent = records.length
      ? L(`${num(records.length)} 条记录 · 更新于 ${time(a.range.last)}`, `${num(records.length)} records · updated ${time(a.range.last)}`)
      : L(`${PERIODS[currentPeriod]}暂无记录`, `No records (${PERIODS[currentPeriod]})`);
    renderTiles(a, reportData.bytesInUse);
    hostRows = a.hosts;
    filterHosts();
    renderMarks(a.marks);
    tlRecords = records;
    renderTimeline();
    renderPages(a.pages);
    renderNets(a.nets, reportData.netBook);
  }

  async function load() {
    await command('flush');
    const [{ records }, bytesInUse, { netBook, statsPeriod, retention }] = await Promise.all([Store.readAll(), chrome.storage.local.getBytesInUse(null), chrome.storage.local.get(['netBook', 'statsPeriod', 'retention'])]);
    if (!reportData) currentPeriod = Object.hasOwn(PERIODS, statsPeriod) ? statsPeriod : 'all';
    reportData = { records, bytesInUse, netBook, retention };
    renderReport();
    renderKeep();
  }

  // ---------------------------------------------------------------- 记录保留
  // 保留时长在右上角选（见 store.js KEEP_DAYS），过期的记录由 SW 删。改短了要删记录的先弹窗确认；
  // 升级前已经有记录、还没确认过（retention.ok）的，有过期记录时在页面上方提示，点了删除才删（用户定的：第一次删之前要问）
  const KEEP_LABELS = L(
    { 7: '7 天', 15: '15 天', 30: '30 天', 60: '2 个月', 90: '3 个月', 120: '4 个月', 150: '5 个月', 180: '6 个月' },
    { 7: '7 days', 15: '15 days', 30: '30 days', 60: '2 months', 90: '3 months', 120: '4 months', 150: '5 months', 180: '6 months' },
  );
  const $keep = $('keep');
  const $keepDialog = $('keep-dialog');
  let keepPending = null; // 弹窗里等确认的保留天数
  $keep.innerHTML = Store.KEEP_DAYS.map((d) => `<option value="${d}">${KEEP_LABELS[d]}</option>`).join('');

  /** 只保留 days 天的话要删的记录（口径同 SW，见 store.js expired）：条数和最早的时间。 */
  function expiredOf(days) {
    const records = reportData ? reportData.records : [];
    const drop = Store.expired(records, Store.cutoffOf(days));
    let n = 0;
    let oldest = Infinity;
    for (const r of records) {
      if (!drop(r)) continue;
      n += 1;
      if (r.t < oldest) oldest = r.t;
    }
    return { n, oldest };
  }

  function renderKeep() {
    const retention = reportData.retention;
    const days = Store.keepDays(retention);
    $keep.value = String(days);
    $keep.disabled = false;
    const { n, oldest } = retention && retention.ok ? { n: 0 } : expiredOf(days);
    $('keep-notice').hidden = !n;
    if (!n) return;
    $('keep-notice-text').textContent = L(
      `0.6.25 起记录只保留一段时间（右上角「记录保留」，默认 15 天），超过的自动删除。现在有 ${num(n)} 条超过 ${KEEP_LABELS[days]}的记录（最早 ${time(oldest)}），第一次删除要你确认，确认之前不会删。删掉的找不回来，要留一份就先导出，或者把保留时长改长一些。`,
      `Since 0.6.25, records are kept only for a while ("Keep records" at the top right, 15 days by default) and older ones are deleted automatically. There are ${num(n)} records older than ${KEEP_LABELS[days]} (oldest ${time(oldest)}). The first deletion needs your confirmation; nothing is deleted until you confirm. Deleted records can't be recovered: to keep a copy, export first, or choose a longer period.`,
    );
    $('keep-delete').textContent = L(`删除这 ${num(n)} 条记录`, `Delete these ${num(n)} records`);
  }

  async function applyKeep(days) {
    const { removed } = await command('retention', { days });
    await load();
    if (removed) $('subtitle').textContent += L(` · 删除了 ${num(removed)} 条超过 ${KEEP_LABELS[days]}的记录`, ` · deleted ${num(removed)} records older than ${KEEP_LABELS[days]}`);
  }

  $keep.addEventListener('change', () => {
    // 记录还没读出来时数不出要删几条（选择框读完才可用）
    if (!reportData) return;
    const days = Number($keep.value);
    const { n, oldest } = expiredOf(days);
    if (!n) {
      guard(() => applyKeep(days))();
      return;
    }
    keepPending = days;
    $('keep-title').textContent = L(`改成只保留 ${KEEP_LABELS[days]}？`, `Keep only ${KEEP_LABELS[days]}?`);
    $('keep-text').textContent = L(
      `会删掉 ${num(n)} 条超过 ${KEEP_LABELS[days]}的记录（最早 ${time(oldest)}），删掉的找不回来；要留一份的话先取消，导出后再改。以后超过 ${KEEP_LABELS[days]}的记录会自动删除。`,
      `This deletes ${num(n)} records older than ${KEEP_LABELS[days]} (oldest ${time(oldest)}), and they can't be recovered; to keep a copy, cancel and export first. From now on, records older than ${KEEP_LABELS[days]} are deleted automatically.`,
    );
    $('keep-ok').textContent = L(`删除 ${num(n)} 条记录`, `Delete ${num(n)} records`);
    $keepDialog.showModal();
    // 焦点放在「取消」上：误按回车不会删
    $('keep-cancel').focus();
  });
  $('keep-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const days = keepPending;
    keepPending = null;
    $keepDialog.close();
    guard(() => applyKeep(days))();
  });
  $('keep-cancel').addEventListener('click', () => $keepDialog.close());
  $keepDialog.addEventListener('click', (e) => e.target === $keepDialog && $keepDialog.close());
  // 取消（含 Esc、点遮罩）：选择框回到原来的时长
  $keepDialog.addEventListener('close', () => {
    if (keepPending === null) return;
    keepPending = null;
    renderKeep();
  });
  $('keep-delete').addEventListener('click', () => guard(() => applyKeep(Store.keepDays(reportData.retention)))());
  $('keep-export').addEventListener('click', () => openExport());

  /** full：完整信息导出（原样），否则脱敏（见 redact.js）。 */
  async function exportJson(full) {
    await command('flush');
    const all = await Store.readAll();
    const { name, payload } = buildExport(all, { period: currentPeriod, full, extVersion: chrome.runtime.getManifest().version });
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  // 点「导出」先选普通导出（脱敏，默认）还是完整信息导出；选了完整的，再列一遍里面有哪些个人信息，确认后才导出。
  // showModal 打开的弹窗焦点不出弹窗，Esc 取消（浏览器自带），关掉后焦点回到「导出」按钮
  const $dialog = $('export-dialog');
  const $form = $('export-form');

  function exportStep(confirm) {
    $('export-choose').hidden = confirm;
    $('export-confirm').hidden = !confirm;
    $dialog.setAttribute('aria-labelledby', confirm ? 'export-confirm-title' : 'export-title');
  }

  function openExport() {
    $form.reset(); // 每次都从默认的普通导出开始
    for (const el of document.querySelectorAll('.export-range')) el.textContent = PERIODS[currentPeriod];
    exportStep(false);
    $dialog.showModal();
  }

  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    const full = $form.elements.kind.value === 'full';
    if (full && $('export-confirm').hidden) {
      exportStep(true);
      // 焦点放在「返回」上：连按两次回车不会直接导出完整信息
      $('export-back').focus();
      return;
    }
    $dialog.close();
    guard(() => exportJson(full))();
  });
  $('export-back').addEventListener('click', () => {
    exportStep(false);
    $form.querySelector('input[value="full"]').focus();
  });
  $('export-cancel').addEventListener('click', () => $dialog.close());
  // 点弹窗外面的遮罩也取消（弹窗没有内边距，点在弹窗里面时 target 是里面的元素）
  $dialog.addEventListener('click', (e) => e.target === $dialog && $dialog.close());

  async function clearAll() {
    if (!confirm(L('确定清空所有记录吗？此操作不可撤销，建议先导出。', "Clear all records? This can't be undone; consider exporting first."))) return;
    await command('clear');
    await load();
  }

  const guard = (fn) => () =>
    fn().catch((e) => {
      $('subtitle').textContent = `${L('出错了：', 'Error: ')}${e.message}`;
    });

  for (const btn of $periods) btn.addEventListener('click', guard(async () => {
    currentPeriod = btn.dataset.period;
    tlLimit = TL_PAGE;
    $tip.hidden = true;
    renderReport();
    await chrome.storage.local.set({ statsPeriod: currentPeriod });
  }));

  // 界面语言：以设置里的为准（见 ui/format.js followLang）；切换按钮只改设置里的 lang，其他项在 popup 里改
  chrome.storage.local.get('settings').then(({ settings }) => Fmt.followLang(settings), () => {});
  Fmt.langButton($('lang'), (patch) =>
    guard(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, ...patch } });
    })(),
  );

  $('refresh').addEventListener('click', guard(load));
  $('export').addEventListener('click', openExport);
  $('clear').addEventListener('click', guard(clearAll));
  guard(load)();
})();
