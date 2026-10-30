// SPDX-License-Identifier: AGPL-3.0-or-later
// ISOLATED world：按设置里的 theme 把 B 站网页换成浅色或深色（popup 里选，默认「不改」，见 cdn.js DEFAULT_SETTINGS）。
// 用的是 B 站自己的深色主题（头像菜单 → 主题，登录后才有，标着「内测」），扩展只替它切换，不自己写配色。
// 2026-10-29 实测各页面靠的东西不一样，下面几样都要换：
//   - <html> 的 bili_dark 类：首页、动态页的颜色变量按它切换；
//   - id 为 __css-map__ 的主题样式表（…/light.css ↔ dark.css，带 _all 的同理）：视频、搜索、空间、热门、番剧、直播等页面的
//     颜色变量在里面，只加 bili_dark 不变色。没登录时页面上也有这个样式表（浅色的）；
//   - 直播（live.bilibili.com）另看 <html> 的 lab-style 属性里有没有 dark（见下文 labStyle），
//     只换样式表的话导航栏是深底深字。
// 再把记主题的 cookie theme_style（.bilibili.com，B 站自己也存 365 天）改成一样的：登录后 B 站的服务端按它选样式表，
// 页面脚本、评论区按它显示，头像菜单里的「主题」也对得上。B 站没登录时一律浅色，扩展不管登没登录都按设置换。
// 只换页面颜色、不碰播放，所以不受总开关（暂停）影响。和 bridge.js 一样不依赖共享脚本。
(() => {
  'use strict';

  const LIVE = location.hostname === 'live.bilibili.com';
  const COOKIE = 'theme_style';
  const system = matchMedia('(prefers-color-scheme: dark)');

  // 设置要等读完扩展存储才到，比页面开始渲染晚，先按上次的设置换，免得先闪一下浅色：
  // 记在页面的 localStorage 里（同 bridge.js 的 bilicdn:route），各个子域名各记一份，头一次打开的子域名还会闪一次
  const HINT = 'bilicdn:theme';

  const modeOf = (s) => (s ? s.theme || 'site' : 'site');

  /** 设置对应的主题：light / dark；「不改」（site）为 null。跟随系统的按现在的系统颜色 */
  function themeOf(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    if (mode === 'system') return system.matches ? 'dark' : 'light';
    return null;
  }

  function cookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? m[1] : '';
  }

  /** B 站自己会显示的主题（同 B 站的 bili-theme）：登录了（有 DedeUserID）按 cookie，没登录一律浅色 */
  const siteTheme = () => (cookie('DedeUserID') && cookie(COOKIE) === 'dark' ? 'dark' : 'light');

  // 主题样式表，和 B 站的深色滤镜（一段 <style>，浅色时整段注释掉，写法同 B 站的 bili-theme）。实测各页面都没有滤镜，
  // 照 B 站的写法一起换，免得哪个页面有、颜色变量换了滤镜还是旧的。返回改没改
  function sheets(theme) {
    let changed = false;
    const link = document.getElementById('__css-map__');
    if (link) {
      const href = link.getAttribute('href') || '';
      const next = href.replace(/\/(?:light|dark)(_all)?\.css/, `/${theme}$1.css`);
      if (next !== href) {
        link.setAttribute('href', next);
        changed = true;
      }
    }
    const filter = document.getElementById('__css-map-filter__');
    if (filter) {
      const css = filter.textContent.trim();
      const off = css.startsWith('/*');
      if (theme === 'light' && !off) filter.textContent = `/*${css}*/`;
      else if (theme === 'dark' && off) filter.textContent = css.replace(/^[/*]+|[*/]+$/g, '');
      else return changed;
      changed = true;
    }
    return changed;
  }

  // 直播页的 lab-style 是开着的「直播实验室」功能，逗号分隔（如 dark,pictureInPicture），里面有 dark 就按深色显示。
  // 直播页自己的脚本读它时不判断有没有这个属性（没有就报错），所以浅色时留个空值，不删
  function labStyle(lab, dark) {
    const list = lab.split(',').filter((x) => x && x !== 'dark');
    if (dark) list.push('dark');
    return list.join(',');
  }

  /** 换成 theme，返回改没改。都是没变就不动，免得惊动页面里盯着 <html> 的脚本 */
  function paint(theme) {
    const html = document.documentElement;
    if (!html) return false;
    let changed = false;
    const dark = theme === 'dark';
    if (html.classList.contains('bili_dark') !== dark) {
      html.classList.toggle('bili_dark', dark);
      changed = true;
    }
    if (LIVE) {
      const lab = html.getAttribute('lab-style') || '';
      if (lab.split(',').includes('dark') !== dark) {
        html.setAttribute('lab-style', labStyle(lab, dark));
        changed = true;
      }
      // 直播页自己切换时也设 color-scheme（滚动条、表单控件跟着变）
      if (html.style.colorScheme !== theme) {
        html.style.colorScheme = theme;
        changed = true;
      }
    }
    return sheets(theme) || changed;
  }

  // 换了主题以后一直盯着，被改了就再换过来：主题样式表在页面的 HTML 里，比这个脚本晚出来（不能等它先按浅色画出来），
  // 动态页的还是加载完由脚本插进来的；B 站自己的脚本也会改回去（没登录时它按浅色算，直播页加载完按「直播实验室」的设置
  // 重写 lab-style，实测换过去的深色只剩一半）。页面解析完之前盯整个文档，之后只盯 <html> 的属性和 <head>；「不改」时不盯。
  // 万一页面里也有脚本盯着、改回去没完没了，换回来超过 20 次就不管了，免得两边来回改卡住页面
  let shown = null;
  let watch = null;
  let fixes = 0;
  function observe() {
    if (!watch) return;
    watch.disconnect();
    const html = document.documentElement;
    if (html) watch.observe(html, { attributes: true, attributeFilter: ['class', 'lab-style'] });
    if (document.readyState === 'loading') watch.observe(document, { childList: true, subtree: true });
    else if (document.head) watch.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    if (shown) paint(shown);
  }
  function guard() {
    if (watch || fixes > 20) return;
    watch = new MutationObserver(() => {
      if (shown && paint(shown) && ++fixes > 20) unguard();
    });
    observe();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true });
  }
  function unguard() {
    if (watch) watch.disconnect();
    watch = null;
  }

  function show(theme) {
    shown = theme;
    paint(theme);
    guard();
  }

  function remember(theme) {
    if (cookie(COOKIE) === theme) return;
    const expires = new Date(Date.now() + 365 * 864e5).toUTCString();
    document.cookie = `${COOKIE}=${theme}; path=/; domain=.bilibili.com; expires=${expires}`;
  }

  function hint(mode) {
    try {
      const v = mode === 'site' ? null : mode;
      if (localStorage.getItem(HINT) === v) return;
      if (v) localStorage.setItem(HINT, v);
      else localStorage.removeItem(HINT);
    } catch {}
  }

  // 已打开的页面上换了主题，让 B 站顶栏也跟着换（头像菜单里显示的主题是它自己的状态，见 main/header-theme.js）。
  // 跨 world 只传字符串。在写 cookie 之前发：顶栏按 B 站自己的流程换，cookie 由它写、biliThemeChange 由它派发
  // （这时 cookie 已经和设置一样，下面的 biliThemeChange 监听不会当成在头像菜单里换的）
  const EVENT = 'bilicdn:theme';
  function tell(theme) {
    document.dispatchEvent(new CustomEvent(EVENT, { detail: theme }));
  }

  let mode = 'site';
  let started = false;
  /**
   * 按设置换（读到设置、设置变了、系统颜色变了时）。改成「不改」时，这个页面换过的就换回 B 站自己会显示的。
   * 页面上显示的主题（扩展换过的，没换过就是 B 站自己的）变了才通知顶栏；第一次读到设置时不通知：刚打开，顶栏还没建好，建的时候按 cookie 读
   */
  function apply(next) {
    mode = next;
    hint(mode);
    const was = shown || siteTheme();
    const first = !started;
    started = true;
    const theme = themeOf(mode);
    if (theme) {
      show(theme);
      if (!first && was !== theme) tell(theme);
      remember(theme);
    } else if (shown) {
      unguard();
      shown = null;
      const site = siteTheme();
      paint(site);
      if (!first && was !== site) tell(site);
    }
  }

  // 先按上次的设置换。cookie 等读到真正的设置再写：提示可能过期了（在别的子域名上改成了「不改」）
  try {
    const early = themeOf(localStorage.getItem(HINT));
    if (early) show(early);
  } catch {}

  system.addEventListener('change', () => mode === 'system' && apply(mode));

  // 在 B 站头像菜单里换了主题（B 站改完 cookie 在 document 上派发 biliThemeChange），设置跟着改成同样的，
  // 不然下次打开页面又按扩展的设置换回去。事件的 detail 是页面里的对象，ISOLATED world 读不到，看 cookie。
  // 扩展自己写 cookie 不派发这个事件。马上按 B 站换过的显示，不然上面盯着的又把 B 站刚换的改回去
  document.addEventListener('biliThemeChange', () => {
    const now = cookie(COOKIE);
    const theme = themeOf(mode);
    if (!theme || theme === now || (now !== 'light' && now !== 'dark')) return;
    mode = now;
    show(now);
    chrome.storage.local
      .get('settings')
      .then((r) => chrome.storage.local.set({ settings: { ...r.settings, theme: now } }))
      .catch(() => {});
  });

  try {
    chrome.storage.local
      .get('settings')
      .then((r) => apply(modeOf(r.settings)))
      .catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => area === 'local' && changes.settings && apply(modeOf(changes.settings.newValue)));
  } catch {}
})();
