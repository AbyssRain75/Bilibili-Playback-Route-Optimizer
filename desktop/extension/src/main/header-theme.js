// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN world：扩展在已打开的页面上换了主题（content/theme.js 派发 bilicdn:theme），让 B 站顶栏也跟着换。
// B 站顶栏（BiliHeader，Vue 3）头像菜单里的「主题：深色 / 浅色」是顶栏自己的状态：创建时按 cookie 读一次，之后只听它内部的
// 事件总线。扩展从外面换了颜色和 cookie，菜单里还是旧的，这时在菜单里点旧的那一项，B 站以为没变、什么都不做（2026-10-29 用户反馈）。
// 顶栏把这条总线以 emitter 为名 provide 出来，当前主题是 provide 的 theme（生产环境的 Vue 也能从挂载的容器 _vnode 找到组件树）。
// 对它发一次 themeChange，和用户在菜单里点一下一样：B 站自己换样式表、写 cookie，派发 biliThemeChange、global.themeChange 通知评论区等组件。
// 找不到（页面结构变了、直播页等没有这个顶栏）就算了：颜色扩展已经换好，刷新后顶栏按 cookie 读，照样对得上。
// 和 bridge.js 一样不依赖共享脚本，跨 world 只收字符串。
(() => {
  'use strict';

  const EVENT = 'bilicdn:theme';

  /** 组件树里 provide 了 emitter 和 theme 的组件（B 站顶栏），按层往下找，最多看这么多个组件 */
  function headerOf(root) {
    const queue = [root];
    for (let seen = 0; queue.length && seen < 3000; seen++) {
      const inst = queue.shift();
      const p = inst.provides;
      if (p && p.emitter && typeof p.emitter.emit === 'function' && p.theme && typeof p.theme === 'object' && 'value' in p.theme) return p;
      const visit = (vn) => {
        if (!vn || typeof vn !== 'object') return;
        if (vn.component) queue.push(vn.component);
        else if (Array.isArray(vn.children)) vn.children.forEach(visit);
        if (vn.suspense && vn.suspense.activeBranch) visit(vn.suspense.activeBranch);
      };
      visit(inst.subTree);
    }
    return null;
  }

  /**
   * 页面上的 B 站顶栏：先看顶栏自己的容器（搜索、动态等页面是 #bili-header-container，视频页是 #biliMainHeader），
   * 再看别的挂了 Vue 3 应用的容器（首页的顶栏在页面应用 #app 里面）。只在换主题时找一次，不常用
   */
  function header() {
    const roots = [document.getElementById('bili-header-container'), document.getElementById('biliMainHeader'), ...document.querySelectorAll('div[id]')];
    for (const el of new Set(roots)) {
      const root = el && el._vnode && el._vnode.component;
      const p = root && headerOf(root);
      if (p) return p;
    }
    return null;
  }

  document.addEventListener(EVENT, (e) => {
    const theme = e.detail;
    if (theme !== 'light' && theme !== 'dark') return;
    try {
      const p = header();
      if (p && p.theme.value !== theme) p.emitter.emit('themeChange', theme);
    } catch {}
  });
})();
