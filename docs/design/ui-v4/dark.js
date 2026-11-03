// 暮紫（暗色）切换：kit.css 的部分由 dark.css 手工覆盖；
// 各页面 <style> 和行内样式 / SVG 填色里写死的浅色，这里按明度自动映射成同色相的暗色，切回浅色时原样还原
(() => {
  const root = document.documentElement;
  // 不参与映射：主题色块预览、Logo、推荐应用 logo（它们本来就该保持原色）
  const SKIP = '.themes i, .swc, .reco-logo, svg[aria-label="Knowledge Base"], [data-nodark]';
  const HEX = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi, HAS = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i;

  function toHsl(hex) {
    let h = hex.slice(1);
    if (h.length === 3) h = h.replace(/./g, c => c + c);
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    const hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [hh * 60, s, l];
  }
  function toHex(h, s, l) {
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, '0');
    return '#' + f(0) + f(8) + f(4);
  }
  // 浅色底 → 深色底（越白越深，保留色相、压低饱和）；深色字 → 浅色字；中间的强调色略提亮
  // isText：color / 文字 fill，此时浅色（多半是按钮上的白字）保持不变
  // 浅紫底（品牌色的浅色铺底）映射成当前暗色底的色相，不再变成紫调深色；便签等其他色相保留颜色
  const DK_HUE = [35, .08];   // 暖炭底色的色相 / 饱和度
  function map(hex, isText) {
    const [h, s, l] = toHsl(hex);
    const [dh, ds] = DK_HUE;
    const purple = h >= 230 && h <= 300 || s < .12;
    if (l >= .8) return isText ? hex : purple ? toHex(dh, ds, .105 + (1 - l) * .5) : toHex(h, Math.min(s, .3), .115 + (1 - l) * .55);
    if (l <= .4) return toHex(h, Math.min(s, .45), .9 - l * .45);
    return toHex(h, s, Math.min(l + .07, .8));
  }
  const mapCss = css => css.replace(/([\w-]+)\s*:([^;{}]*)/g, (m, prop, val) =>
    HAS.test(val) ? prop + ':' + val.replace(HEX, x => map(x, prop === 'color')) : m);

  const touched = new Set();
  function fix(scope) {
    scope.querySelectorAll('style').forEach(st => {
      if (st.dataset.light == null) st.dataset.light = st.textContent;
      st.textContent = mapCss(st.dataset.light); touched.add(st);
    });
    scope.querySelectorAll('[style],[fill],[stroke]').forEach(el => {
      if (el.closest(SKIP)) return;
      const st = el.getAttribute('style');
      if (st && HAS.test(st)) {
        if (el.dataset.lightStyle == null) el.dataset.lightStyle = st;
        el.setAttribute('style', mapCss(el.dataset.lightStyle)); touched.add(el);
      }
      ['fill', 'stroke'].forEach(a => {
        const key = 'light' + a, src = el.dataset[key] ?? el.getAttribute(a);
        if (!src || !src.startsWith('#')) return;
        el.dataset[key] = src;
        el.setAttribute(a, map(el.dataset[key], a === 'fill' && el.tagName === 'text'));
        touched.add(el);
      });
    });
  }
  function unfix() {
    touched.forEach(el => {
      if (el.tagName === 'STYLE') el.textContent = el.dataset.light;
      if (el.dataset.lightStyle != null) el.setAttribute('style', el.dataset.lightStyle);
      if (el.dataset.lightfill != null) el.setAttribute('fill', el.dataset.lightfill);
      if (el.dataset.lightstroke != null) el.setAttribute('stroke', el.dataset.lightstroke);
    });
  }

  // 页面是按需渲染的：新视图 / 新面板挂上来时再映射一次
  new MutationObserver(ms => {
    if (!root.classList.contains('dark')) return;
    ms.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && fix(n)));
  }).observe(document.body, { childList: true, subtree: true });

  // theme：light（淡紫）/ warm（暖炭）；true / false / 'dark' 兼容旧调用
  function set(theme) {
    if (theme === true || theme === 'dark' || theme === 'graphite' || theme === 'slate') theme = 'warm';
    if (theme === false) theme = 'light';
    const dark = theme !== 'light';
    root.classList.add('theming');
    root.classList.toggle('dark', dark);
    dark ? fix(document.body) : unfix();
    localStorage.setItem('kb-theme', theme);
    // 主题菜单里的勾跟着走
    document.querySelectorAll('#m-theme .mi').forEach(mi => {
      const on = mi.dataset.theme === theme;
      const tick = mi.querySelector('.ok');
      if (on && !tick) mi.insertAdjacentHTML('beforeend', '<svg class="i sm ok"><use href="#tick"/></svg>');
      if (!on && tick && mi.dataset.theme) tick.remove();
    });
    setTimeout(() => root.classList.remove('theming'), 300);
  }
  window.KBTheme = { set, toggle: () => set(!root.classList.contains('dark')) };

  document.addEventListener('click', e => {
    const mi = e.target.closest('#m-theme .mi[data-theme]');
    if (mi) set(mi.dataset.theme);
  });

  const want = new URLSearchParams(location.search).get('theme') || localStorage.getItem('kb-theme');
  if (want && want !== 'light') set(want);
})();
