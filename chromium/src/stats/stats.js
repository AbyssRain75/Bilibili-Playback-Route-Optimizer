// SPDX-License-Identifier: AGPL-3.0-or-later
(() => {
  'use strict';

  const { selectPeriod, analyze, timelines, classifyHost, MAIN_SHARE, netKey, bookKnown, buildExport, nodeMap, CLASS_LABELS, SRC } = globalThis.__bilicdn;
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
      tile(
        L('播放会话', 'Playback sessions'),
        num(played),
        `<span title="${esc(L('有媒体请求的播放会话 / 写入记录的全部会话', 'Sessions with media requests / all sessions written to records'))}">${L(`记下的会话 ${num(c.ses || 0)}`, `recorded sessions ${num(c.ses || 0)}`)}</span>`,
      ),
      tile(L('媒体请求', 'Media requests'), num(c.req || 0), `${pcdnShare(a.hosts)}${L('总存储', 'storage')} ${bytes(bytesInUse)}<br>${srcLine(a.src)}`),
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

  // 「扩展看到的比例」的口径（见 analyze.js srcSummary），统计页各处的提示共用
  const SRC_BASIS = L(
    '扩展记到的媒体请求字节 ÷ 媒体数据：点播按播放器自身按来源统计的字节（HTTP、B 站的 P2P、PCDN 加载器），直播按请求字节加 P2P（WebRTC）收到的字节。PCDN 加载器取的也是 HTTP，扩展看得到的已经算在「扩展看到」里，单独列出只说明它取了多少。没有来源记录的会话（旧版本记下的，或者读不到播放器的统计、也没用 P2P 的）不知道，不算进去',
    "Media request bytes the extension recorded ÷ media data: for videos, the bytes the player itself counts by source (HTTP, Bilibili's P2P, the PCDN loader); for live streams, request bytes plus bytes received over P2P (WebRTC). The PCDN loader also fetches over HTTP; whatever of it the extension sees is already counted as seen, and it is listed only to show how much it fetched. Sessions without source data (recorded by older versions, or where the player's counts couldn't be read and P2P wasn't used) are unknown and left out",
  );
  // 上传量：没有上传时写 0（bytes 把 0 显示成「–」，那是没有数据的意思）
  const upload = (b) => (b > 0 ? bytes(b) : '0 B');
  // 只说到「几成」：中文「约 N 成」，英文按 10% 取整
  const tenths = (v) => (v < 0.05 ? L('不到 1 成', 'less than 10%') : L(`约 ${Math.round(v * 10)} 成`, `about ${Math.round(v * 10) * 10}%`));
  // 有几个会话按设置关了 B 站的 P2P（测试功能，见 analyze.js srcSummary 的 off）：这些会话的 P2P 是关掉的，不是这个网络本来就不用
  const offNote = (n) => L(`其中 ${num(n)} 个会话按设置关了 B 站的 P2P（测试功能）。`, ` Bilibili's P2P was turned off in the settings (experimental) for ${num(n)} of these sessions.`);

  /** 「媒体请求」下的一行：扩展看到了多少媒体流量、P2P 占多少、上传了多少，PCDN 加载器取过的才写它；没有来源记录的说不知道。 */
  function srcLine(src) {
    const basis = src.known < src.sessions ? L(`\n按 ${num(src.known)} / ${num(src.sessions)} 个会话算，其余不知道`, `\nBased on ${num(src.known)} of ${num(src.sessions)} sessions; the rest are unknown`) : '';
    if (src.share === null) return `<span title="${esc(SRC_BASIS)}">${L('扩展看到的比例：不知道', 'Share seen by the extension: unknown')}</span>`;
    const pdn = src.pdn > 0 ? L(` · PCDN 加载器 ${pct(src.pdnShare)}`, ` · PCDN loader ${pct(src.pdnShare)}`) : '';
    const off = src.off > 0 ? `\n${offNote(src.off).trim()}` : '';
    return `<span title="${esc(SRC_BASIS + basis + off)}">${L(`扩展看到 ${pct(src.share)} · P2P ${pct(src.p2pShare)}${pdn} · 上传 ${upload(src.tx)}`, `seen ${pct(src.share)} · P2P ${pct(src.p2pShare)}${pdn} · uploaded ${upload(src.tx)}`)}</span>`;
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

  // ---------------------------------------------------------------- 节点分布
  // 按网络汇总（见 shared/nodemap.js），默认选当前网络；「探查」只能在当前网络上点（测的是正在播放的页面，见 sw.js startSurvey）

  let mapData = null;
  let mapKey = null;

  const mapNetLabel = (n) => (n.net ? net(n.net) : L('没识别出的网络', 'Unidentified network'));
  const host = (h) => `<span class="mono" title="${esc(h)}">${esc(shortHost(h))}</span>`;
  // 一串节点：最多列 5 个，其余写「等 N 个」
  function hostList(hs) {
    const shown = hs.slice(0, 5).map(host).join(L('、', ', '));
    return hs.length > 5 ? L(`${shown} 等 ${hs.length} 个`, `${shown} and ${hs.length - 5} more`) : shown;
  }
  const mbps = (v) => `${num(v, 1)} Mbps`;
  // 「自动」要测过几次才换过去，探查的单次结果不算（见 route.js PROBE_MIN）
  const FEW = L('（测速次数还少，结论是初步的：探查每个节点只测一次，要等定时测速再测几次）', ' (few speed tests so far; treat this as preliminary: a survey tests each node only once, so wait for a few more scheduled speed tests)');

  /** 一条结论的文案（code 和参数见 nodemap.js summarize）。 */
  function finding(f, n) {
    const few = f.few ? FEW : '';
    switch (f.code) {
      case 'assign':
        return L(
          `B 站在这个网络主要把「${esc(CLASS_LABELS[f.cls] || f.cls)}」节点当主地址（${pct(f.share)}）${f.host ? `，点播最常分配 ${host(f.host)}（占点播分配的 ${pct(f.hostShare)}）` : ''}。`,
          `On this network Bilibili mostly assigns ${esc(CLASS_LABELS[f.cls] || f.cls)} nodes as the main URL (${pct(f.share)})${f.host ? `; for videos it most often assigns ${host(f.host)} (${pct(f.hostShare)} of assignments)` : ''}.`,
        );
      case 'faster':
        return f.mainSc > 0
          ? L(
              `测速最快的是 ${host(f.host)}（${mbps(f.sc)}），是 B 站常分配的 ${host(f.main)}（${mbps(f.mainSc)}）的 ${num(f.sc / f.mainSc, 1)} 倍：打开线路优化、点播节点选「自动」，测过几次之后会换过去。${few}`,
              `The fastest in speed tests is ${host(f.host)} (${mbps(f.sc)}), ${num(f.sc / f.mainSc, 1)}× the usually assigned ${host(f.main)} (${mbps(f.mainSc)}). With route optimization on and the video node set to "Auto", it switches there after a few tests.${few}`,
            )
          : L(
              `B 站常分配的 ${host(f.main)} 测速没测通，测得最快的是 ${host(f.host)}（${mbps(f.sc)}）：打开线路优化、点播节点选「自动」，测过几次之后会换过去。${few}`,
              `The usually assigned ${host(f.main)} failed its speed tests; the fastest is ${host(f.host)} (${mbps(f.sc)}). With route optimization on and the video node set to "Auto", it switches there after a few tests.${few}`,
            );
      case 'mainPage':
        return L(
          `B 站常分配的 ${host(f.host)} 在页面上首字节 ${num(f.tt)} ms（${num(f.n)} 个请求），离得近、表现好：「自动」不会按测速把它换走。${f.best ? `测速里 ${host(f.best)}（${mbps(f.bestSc)}）比它高，多半是因为测速取的是没缓存的数据，和播放对不上。` : ''}`,
          `The usually assigned ${host(f.host)} answers page requests in ${num(f.tt)} ms (${num(f.n)} requests): it is close and performing well, so "Auto" won't switch away from it based on speed tests.${f.best ? ` ${host(f.best)} (${mbps(f.bestSc)}) scores higher in speed tests, most likely because speed tests fetch uncached data, which doesn't reflect playback.` : ''}`,
        );
      case 'mainBest':
        return L(
          `B 站常分配的 ${host(f.host)}（${mbps(f.sc)}）就是测速最快的，或者和最快的差不到 20%：这个网络里换节点的余地不大。${few}`,
          `The usually assigned ${host(f.host)} (${mbps(f.sc)}) is the fastest in speed tests, or within 20% of it: there is little to gain from switching nodes on this network.${few}`,
        );
      case 'unprobed':
        return L(
          `还没测过 B 站常分配的 ${host(f.host)}，没法比较；目前测得最快的是 ${host(f.best)}（${mbps(f.sc)}）。`,
          `The usually assigned ${host(f.host)} hasn't been speed tested yet, so there is nothing to compare; the fastest so far is ${host(f.best)} (${mbps(f.sc)}).`,
        );
      case 'pcdn':
        return L(
          `PCDN 承担了 ${pct(f.share)} 的请求。${f.lv === 'warn' ? '打开线路优化后 PCDN 排到官方节点后面，点播「自动」会换掉 PCDN 主节点。' : ''}`,
          `PCDN served ${pct(f.share)} of requests.${f.lv === 'warn' ? ' With route optimization on, PCDN is ranked after official nodes and "Auto" replaces a PCDN main node for videos.' : ''}`,
        );
      case 'src': {
        // 扩展看到、P2P、扩展看不到的 HTTP 加起来是全部媒体数据；PCDN 加载器取的也是 HTTP，不是另一块，取过的才另写一句（见 analyze.js srcSummary）
        const parts = [`P2P ${pct(f.p2p)}`];
        if (f.other >= 0.05) parts.push(L(`扩展看不到的 HTTP（如不在网站权限里的 PCDN）${pct(f.other)}`, `HTTP the extension can't see (such as PCDN outside its site access) ${pct(f.other)}`));
        parts.push(`${L('上传', 'uploaded')} ${upload(f.tx)}`);
        const list = parts.join(L('、', ', '));
        const pdn = f.pdn > 0 ? L(`PCDN 加载器取了 ${pct(f.pdn)}，取的也是 HTTP，扩展看得到的已经算在看到的里面。`, ` The PCDN loader fetched ${pct(f.pdn)}; that is HTTP too, and the part the extension can see is already counted as seen.`) : '';
        const basis = f.known < f.sessions ? L(`按 ${num(f.known)} / ${num(f.sessions)} 个会话算，其余没有来源记录，不知道。`, ` Based on ${num(f.known)} of ${num(f.sessions)} sessions; the rest have no source data.`) : '';
        const off = f.off > 0 ? offNote(f.off) : '';
        return f.lv === 'warn'
          ? L(
              `这个网络扩展只看到${tenths(f.share)}媒体流量（${pct(f.share)}；${list}）：统计、卡顿归因和线路优化都只管得到这部分。${pdn}${basis}${off}`,
              `On this network the extension sees only ${tenths(f.share)} of the media traffic (${pct(f.share)}; ${list}): its statistics, stall attribution and route optimization only cover that part.${pdn}${basis}${off}`,
            )
          : L(`扩展看到了 ${pct(f.share)} 的媒体流量（${list}）。${pdn}${basis}${off}`, `The extension sees ${pct(f.share)} of the media traffic (${list}).${pdn}${basis}${off}`);
      }
      case 'stall':
        return L(`${host(f.host)} 卡顿最多：${num(f.n)} 次自动识别的卡顿里它是主要责任节点。`, `${host(f.host)} stalls the most: it was the main responsible node in ${num(f.n)} auto-detected stalls.`);
      case 'hlsSlow':
        return L(
          `以往测速里直播 HLS 跟不上（得分只有码率的 ${num(f.r, 2)} 倍）：线路优化「自动」在这个网络开播就用 FLV。`,
          `Past speed tests show live HLS can't keep up (score only ${num(f.r, 2)}× the bitrate): with route optimization on, "Auto" starts live streams on FLV on this network.`,
        );
      case 'hlsOk':
        return L(`以往测速里直播 HLS 跟得上（得分是码率的 ${num(f.r, 2)} 倍以上）。`, `Past speed tests show live HLS keeps up (score at least ${num(f.r, 2)}× the bitrate).`);
      case 'extra':
        return L(
          `B 站在这个网络分配过内置镜像列表以外的 ${hostList(f.hosts)}：测得好就会和内置镜像一起测速、参与「自动」选择。`,
          `On this network Bilibili assigned ${hostList(f.hosts)}, which are not in the built-in mirror list; if they test well they are speed tested with the built-in mirrors and considered by "Auto".`,
        );
      case 'same':
        return L(
          `${num(f.n)} 组镜像名连到同一台服务器（如 ${hostList(f.hosts)}）：线路优化把它们当一个节点，一个卡过，同组的一起避开。`,
          `${num(f.n)} group(s) of mirror names reach the same server (e.g. ${hostList(f.hosts)}): route optimization treats them as one node, so when one stalls the whole group is avoided.`,
        );
      case 'dead':
        return L(`${num(f.hosts.length)} 个节点在这个网络测不通：${hostList(f.hosts)}。`, `${num(f.hosts.length)} node(s) can't be reached on this network: ${hostList(f.hosts)}.`);
      case 'none':
        return n.key === mapData.cur
          ? L('这个网络还没有测速数据：开着线路优化看视频会慢慢测，也可以点「探查这个网络」马上测一遍。', 'No speed tests on this network yet. Watching with route optimization on tests nodes gradually, or click "Survey this network" to test them all now.')
          : L('这个网络还没有测速数据。', 'No speed tests on this network yet.');
      default:
        return '';
    }
  }

  const bar = (v) => `<span class="share" aria-hidden="true"><i style="width:${Math.round((v || 0) * 100)}%"></i></span>`;

  function classTable(n) {
    if (!n.classes.length) return `<div class="empty">${L('暂无数据', 'No data')}</div>`;
    const base = n.classes.reduce((s, c) => s + c.base, 0);
    const req = n.classes.reduce((s, c) => s + c.req, 0);
    const body = n.classes
      .map((c) => `<tr><td>${chip(c.cls)}</td><td class="num">${bar(base && c.base / base)}${base ? pct(c.base / base) : '–'}</td><td class="num">${bar(req && c.req / req)}${req ? pct(c.req / req) : '–'}</td><td class="num">${bytes(c.bytes)}</td></tr>`)
      .join('');
    return `<table><thead><tr><th>${L('类型', 'Type')}</th><th class="num" title="${L('一次分配里当主地址算一次', 'Counted once per assignment where it is a main URL')}">${L('B 站分配为主地址', 'Assigned as main')}</th><th class="num">${L('请求', 'Requests')}</th><th class="num">${L('流量', 'Data')}</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  // 网段：IPv4 前三段写成 /24，IPv6 前三组写成 /48（见 probe.js netOf）
  const subnetText = (s) => (s.includes(':') ? `${s}::/48` : `${s}.0/24`);

  function groupList(n) {
    if (!n.groups.length) {
      return `<div class="empty">${L('没发现共用服务器的名字（播放和测速记下的 IP 越多越准）。', 'No names sharing a server found (more IPs from playback and speed tests make this more accurate).')}</div>`;
    }
    return `<ul class="groups">${n.groups.map((g, i) => `<li><span class="chip">#${i + 1}</span> ${g.hosts.map(host).join(' / ')} <span class="muted">${esc(g.subnets.map(subnetText).join(', '))}</span></li>`).join('')}</ul>`;
  }

  function mapHostTable(n) {
    if (!n.hosts.length) return `<div class="empty">${L('这个网络在所选范围里还没有节点记录。', 'No nodes recorded on this network in the selected range.')}</div>`;
    const body = n.hosts
      .map(
        (r) => `<tr>
          <td class="host" title="${esc(r.host)}">${esc(r.host)}</td>
          <td>${chip(r.cls)}${pcdnPart(r.cls, r.pcdn, r.n)}</td>
          <td class="mono" title="${esc(r.subnets.join(', '))}">${r.group ? `<span class="chip">#${r.group}</span> ` : ''}${esc(r.subnets.slice(0, 2).map(subnetText).join(', ')) || '–'}${r.subnets.length > 2 ? ' …' : ''}</td>
          <td class="num">${num(r.base)} / ${num(r.backup)}</td>
          <td class="num">${num(r.n)}</td>
          <td class="num ${r.errRate ? 'bad' : ''}">${pct(r.errRate)}</td>
          <td class="num ${r.auto ? 'bad' : ''}">${num(r.auto)}</td>
          <td class="num">${ms(r.ttfbP50)}</td>
          <td class="num">${num(r.mbpsP50, 1)}</td>
          <td class="num" title="${L(`测速首字节 P50 ${ms(r.probeTt)}，其中探查 ${r.surveyed} 次`, `speed test TTFB P50 ${ms(r.probeTt)}, ${r.surveyed} from surveys`)}">${r.probeN ? num(r.probeScore, 1) : '–'}</td>
          <td class="num">${r.probeN ? `${num(r.probeOk)} / ${num(r.probeN)}` : '–'}</td>
        </tr>`,
      )
      .join('');
    return `<table><thead><tr><th>host</th><th>${L('类型', 'Type')}</th><th title="${L('连到的服务器网段，# 为同一台服务器的组', 'Server subnets reached; # marks names on the same server')}">${L('服务器', 'Server')}</th><th class="num">${L('分配 主 / 备', 'Assigned main / backup')}</th><th class="num">${L('请求', 'Requests')}</th><th class="num">${L('失败率', 'Fail rate')}</th><th class="num">${L('自动识别卡顿', 'Auto stalls')}</th><th class="num">TTFB P50</th><th class="num">Mbps P50</th><th class="num">${L('测速', 'Speed test')}</th><th class="num" title="${L('测通 / 测速次数', 'succeeded / speed tests')}">${L('测通 / 次数', 'OK / tests')}</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  // 几个网络并排比：不同地方分到的节点、快慢不一样，这里一眼看出差别
  function compareTable(m) {
    if (m.nets.length < 2) return '';
    const body = m.nets
      .map((n) => {
        const main = n.main ? `${host(n.main)}` : '–';
        const best = n.best ? `${host(n.best.host)} <span class="muted">${num(n.best.sc, 1)}</span>` : '–';
        const name = `${esc(mapNetLabel(n))}${n.key === m.cur ? L('（当前）', ' (current)') : ''}`;
        const seen = n.src.share;
        return `<tr><td><button type="button" class="link" data-net="${esc(n.key)}"${n.key === mapKey ? ' aria-current="true"' : ''}>${name}</button></td><td>${esc(time(n.t1))}</td><td class="num">${num(n.sessions)}</td><td>${main}</td><td>${best}</td><td class="num">${pct(n.pcdnShare)}</td><td class="num${seen !== null && seen < SRC.most ? ' bad' : ''}">${pct(seen)}</td><td class="num">${pct(n.src.p2pShare)}</td><td class="num ${n.incidents ? 'bad' : ''}">${num(n.incidents)}</td></tr>`;
      })
      .join('');
    return `<h3>${L('各网络对比', 'Networks compared')}</h3><div class="scroll"><table><thead><tr><th>${L('网络', 'Network')}</th><th>${L('最后记录', 'Last record')}</th><th class="num">${L('播放会话', 'Sessions')}</th><th>${L('B 站常分配的点播主节点', 'Usual main video node')}</th><th>${L('测速最快（Mbps）', 'Fastest in tests (Mbps)')}</th><th class="num">PCDN</th><th class="num" title="${esc(SRC_BASIS)}">${L('扩展看到', 'Seen')}</th><th class="num">P2P</th><th class="num">${L('自动识别卡顿', 'Auto stalls')}</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function renderMapNet() {
    const n = mapData.nets.find((x) => x.key === mapKey);
    $('map-net').value = mapKey;
    $('map-findings').innerHTML = n.findings.map((f) => `<li data-lv="${esc(f.lv)}">${finding(f, n)}</li>`).join('');
    $('map-classes').innerHTML = classTable(n);
    $('map-groups').innerHTML = groupList(n);
    $('map-hosts').innerHTML = mapHostTable(n);
    $('map-compare').innerHTML = compareTable(mapData);
    syncSurvey();
  }

  function renderMap() {
    mapData = nodeMap(reportData.records, { from: reportSelection.from, cur: reportData.net, book: reportData.netBook });
    if (!mapData.nets.length) {
      $('map-net').innerHTML = '';
      $('map-net').disabled = true;
      for (const id of ['map-findings', 'map-classes', 'map-groups', 'map-compare']) $(id).innerHTML = '';
      $('map-hosts').innerHTML = `<div class="empty">${L('暂无数据，播放视频后刷新查看。', 'No data yet. Play a video, then refresh.')}</div>`;
      syncSurvey();
      return;
    }
    if (!mapData.nets.some((x) => x.key === mapKey)) mapKey = mapData.nets[0].key;
    $('map-net').disabled = false;
    $('map-net').innerHTML = mapData.nets.map((n) => `<option value="${esc(n.key)}">${esc(mapNetLabel(n))}${n.key === mapData.cur ? L('（当前）', ' (current)') : ''}</option>`).join('');
    renderMapNet();
  }

  $('map-net').addEventListener('change', () => {
    mapKey = $('map-net').value;
    renderMapNet();
  });
  $('map-compare').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-net]');
    if (!btn) return;
    mapKey = btn.dataset.net;
    renderMapNet();
  });

  // 探查：点了以后 SW 在后台测，进度在 storage.session 的 survey，测完重新读记录
  let surveyNow = null;
  const SURVEY_END = {
    stop: L('停下了（暂停了扩展、换了网络、清空了数据，或者后台被浏览器回收）', 'stopped (extension paused, network changed, data cleared, or the background was shut down by the browser)'),
    gone: L('停下了：标签页关了，或者播放地址快过期了（刷新页面后可以再探查）', 'stopped: the tab was closed or the playback URL was about to expire (refresh the page, then survey again)'),
    buffer: L('停下了：前方缓冲一直不够（暂停视频时照常测，可以暂停后再点）', 'stopped: the buffer stayed too low (testing works while paused, so pause the video and try again)'),
    stall: L('停下了：播放器一直在缓冲', 'stopped: the player kept buffering'),
  };

  function syncSurvey() {
    const $btn = $('survey');
    const running = !!surveyNow && !surveyNow.end;
    const cur = !!mapData && mapKey === mapData.cur && mapData.cur !== null;
    $btn.disabled = running || !cur || reportData.enabled === false;
    $btn.title = reportData.enabled === false
      ? L('扩展暂停着，打开后才能探查', 'The extension is paused; turn it on to survey')
      : !cur ? L('只能探查当前所在的网络', 'Only the current network can be surveyed') : '';
    $btn.textContent = running ? L('探查中…', 'Surveying…') : L('探查这个网络', 'Survey this network');
  }

  function showSurvey(s, note = '') {
    surveyNow = s || null;
    const $s = $('survey-status');
    if (note) {
      $s.textContent = note;
      $s.hidden = false;
    } else if (!s) {
      $s.hidden = true;
    } else {
      const kind = s.kind === 'live' ? L('直播', 'live') : L('点播', 'video');
      const counts = L(`测了 ${num(s.done)} / ${num(s.total)} 个节点，${num(s.ok)} 个测得通`, `tested ${num(s.done)} / ${num(s.total)} nodes, ${num(s.ok)} reachable`);
      const wait = s.wait ? L(`，${s.wait === 'stall' ? '播放器在缓冲' : '前方缓冲不够'}，等缓冲够了再测`, `; ${s.wait === 'stall' ? 'the player is buffering' : 'the buffer is low'}, waiting until it recovers`) : '';
      $s.textContent = !s.end
        ? L(`正在探查（${kind}）：${counts}${wait}…`, `Surveying (${kind}): ${counts}${wait}…`)
        : s.end === 'done'
          ? L(`探查完成（${time(s.te)}，${kind}）：${counts}。`, `Survey finished (${time(s.te)}, ${kind}): ${counts}.`)
          : L(`探查${SURVEY_END[s.end] || SURVEY_END.stop}，${counts}。`, `Survey ${SURVEY_END[s.end] || SURVEY_END.stop}; ${counts}.`);
      $s.hidden = false;
    }
    if (mapData) syncSurvey();
  }

  // guard 在下文才定义，点的时候再取
  $('survey').addEventListener('click', () => guard(async () => {
    const r = await command('survey');
    if (r && r.ok) return showSurvey(r.state);
    showSurvey(null, r && r.reason === 'off'
      ? L('扩展暂停着，打开后才能探查。', 'The extension is paused; turn it on to survey.')
      : L('没有正在播放的视频或直播间：先打开一个播放起来，再点探查。', 'Nothing is playing: start a video or live room first, then click Survey.'));
  })());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes.survey) return;
    const s = changes.survey.newValue;
    const was = changes.survey.oldValue;
    showSurvey(s);
    // 测完（或停下）了：重新读记录，节点分布里马上有结果
    if (s && s.end && !(was && was.end)) guard(load)();
  });

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
    renderMap();
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
    const [{ records }, bytesInUse, { netBook, statsPeriod, retention, net: curNet, settings }, { survey }] = await Promise.all([
      Store.readAll(),
      chrome.storage.local.getBytesInUse(null),
      chrome.storage.local.get(['netBook', 'statsPeriod', 'retention', 'net', 'settings']),
      chrome.storage.session.get('survey').catch(() => ({})),
    ]);
    if (!reportData) currentPeriod = Object.hasOwn(PERIODS, statsPeriod) ? statsPeriod : 'all';
    // net：当前网络（节点分布默认选它，只有它能探查）；enabled：总开关，缺的按开着（同 cdn.js DEFAULT_SETTINGS）
    reportData = { records, bytesInUse, netBook, retention, net: curNet || null, enabled: !settings || settings.enabled !== false };
    // 正在探查的、或者 30 分钟内探查过的，显示进度 / 结果
    if (!surveyNow && survey && (!survey.end || survey.te > Date.now() - 30 * 60e3)) surveyNow = survey;
    renderReport();
    renderKeep();
    showSurvey(surveyNow);
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
