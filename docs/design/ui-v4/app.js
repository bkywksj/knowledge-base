// 原型路由：每个页面登记一次，切换时按需渲染（只渲染一次，保留交互状态）
// view 字段：panel = 侧栏面板 id（null 表示无面板，主区占满）；rail = 高亮哪个活动栏入口；
// tabs = 是否显示笔记工作区标签栏（与现状一致：只在笔记 / 日记 / 白板出现）
window.I = (id, c = '') => `<svg class="i ${c}"><use href="#${id}"/></svg>`;

// L08「K · 书页负形」：淡紫渐变圆角方块 + 白色折角书页 + 用渐变挖出的 K
let __lg = 0;
window.LOGO = (size = 24) => {
  const g = 'kbl' + (++__lg);
  return `<svg width="${size}" height="${size}" viewBox="6 6 108 108" style="flex:none;display:block" aria-label="Knowledge Base"><defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B9A8F7"/><stop offset="1" stop-color="#7C63DC"/></linearGradient></defs><rect x="6" y="6" width="108" height="108" rx="28" fill="url(#${g})"/><path d="M40 28h28l16 16v44a6 6 0 0 1-6 6H40a6 6 0 0 1-6-6V34a6 6 0 0 1 6-6z" fill="#fff"/><path d="M68 28v10a6 6 0 0 0 6 6h10" fill="#E4DBFD"/><path d="M48 46v38M50 66l17-18M54 62l14 22" stroke="url(#${g})" stroke-width="6.5" stroke-linecap="round" fill="none"/></svg>`;
};

window.KB = (() => {
  const views = {}, panels = {}, made = {};
  const $ = s => document.querySelector(s);

  function add(id, def) { views[id] = def; }
  function panel(id, html) { panels[id] = html; }

  function ensure(kind, id, html, host) {
    const key = kind + ':' + id;
    if (!made[key]) {
      const el = document.createElement(kind === 'v' ? 'section' : 'div');
      el.className = kind === 'v' ? 'view' : 'pv';
      el.dataset.id = id;
      el.style.display = 'none';
      if (kind === 'p') { el.style.flexDirection = 'column'; el.style.minHeight = '0'; el.style.flex = '1'; }
      el.innerHTML = typeof html === 'function' ? html() : html;
      host.appendChild(el);
      made[key] = el;
      if (kind === 'v' && views[id].init) views[id].init(el);
      if (kind === 'v') bindTocSpy(el);
    }
    return made[key];
  }

  // 正文滚动时，右侧大纲高亮当前所在的小节
  function bindTocSpy(el) {
    const sc = el.querySelector('.scroll'), links = [...el.querySelectorAll('.toc a')], hs = [...el.querySelectorAll('.prose h2')];
    if (!sc || !links.length || !hs.length) return;
    sc.addEventListener('scroll', () => {
      const top = sc.getBoundingClientRect().top + 90;
      let idx = 0;
      hs.forEach((h, i) => { if (h.getBoundingClientRect().top <= top) idx = i; });
      links.forEach((a, i) => a.classList.toggle('on', i === Math.min(idx, links.length - 1)));
    });
  }
  // 打开哪篇笔记，左侧文件树就高亮哪一行（标签页与树保持一致）
  const TREE_SEL = { editor: 'Rust 所有权', whiteboard: '架构草图' };

  function go(id) {
    const v = views[id];
    if (!v) return;
    const win = $('#win');
    // 主区
    const el = ensure('v', id, v.main, $('#sheet'));
    document.querySelectorAll('#sheet > .view').forEach(x => x.style.display = x === el ? 'flex' : 'none');
    // 侧栏
    win.classList.toggle('nopanel', !v.panel);
    if (v.panel) {
      const p = ensure('p', v.panel, panels[v.panel], $('#side'));
      document.querySelectorAll('#side > .pv').forEach(x => x.style.display = x === p ? 'flex' : 'none');
      if (TREE_SEL[id]) p.querySelectorAll('.row').forEach(r => r.classList.toggle('on', (r.querySelector('.lb') || {}).textContent === TREE_SEL[id]));
    }
    // 活动栏 / 标签栏 / 标题
    const rail = v.rail || id;
    document.querySelectorAll('#rail .ra').forEach(b => b.classList.toggle('on', b.dataset.go === rail));
    $('#tabs').style.display = v.tabs ? 'flex' : 'none';
    $('#tbTitle').style.display = v.tabs ? 'none' : 'flex';
    $('#tbTitle').innerHTML = v.tabs ? '' : (v.title || '');
    document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('on', t.dataset.go === id));
    closeMenu();
  }

  // ─── 下拉菜单 ───
  let openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.classList.remove('open'); openMenu = null; } }
  function showMenu(btn, id) {
    const m = document.getElementById(id);
    if (!m) return;
    if (openMenu === m) { closeMenu(); return; }
    closeMenu();
    m.classList.add('open');
    const r = btn.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
    let x = r.left; if (x + mw > innerWidth - 8) x = r.right - mw;
    let y = r.bottom + 6; if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
    m.style.left = x + 'px'; m.style.top = y + 'px';
    openMenu = m;
  }

  // ─── 事件委托：所有页面共用的交互 ───
  document.addEventListener('click', e => {
    const t = e.target;
    const menuBtn = t.closest('[data-menu]');
    if (menuBtn) { e.stopPropagation(); showMenu(menuBtn, menuBtn.dataset.menu); return; }
    if (!t.closest('.menu')) closeMenu();

    const goBtn = t.closest('[data-go]');
    if (goBtn && !t.closest('.x')) { go(goBtn.dataset.go); return; }

    const segBtn = t.closest('.seg button, .pills:not(.multi) button, [data-group] > *');
    if (segBtn && !segBtn.hasAttribute('data-menu')) {
      [...segBtn.parentElement.children].forEach(x => x.classList.remove('on'));
      segBtn.classList.add('on');
    }
    const tog = t.closest('[data-toggle], .sw, .fb.ft');
    if (tog) tog.classList.toggle('on');
    const ck = t.closest('.ck');
    if (ck) { if (ck.parentElement.matches('li, .td, .row, .li, .tk')) ck.parentElement.classList.toggle('done'); else ck.classList.toggle('on'); }
    const row = t.closest('.side .row, .tree .row');
    if (row && !ck) {
      const next = row.nextElementSibling;
      if (next && next.classList.contains('kids')) row.classList.toggle('shut');
      else { row.closest('.side-scroll, .tree').querySelectorAll('.row.on').forEach(x => x.classList.remove('on')); row.classList.add('on'); }
    }
    const toc = t.closest('.toc a');
    if (toc) { toc.parentElement.querySelectorAll('a').forEach(a => a.classList.remove('on')); toc.classList.add('on'); }
    const rail = t.closest('[data-rail]');
    if (rail) { const g = rail.closest('.view').querySelector('.edgrid'); g && g.classList.toggle('norail'); rail.classList.toggle('on'); }
  });
  document.addEventListener('contextmenu', e => {
    const host = e.target.closest('[data-ctx]');
    if (!host) return;
    e.preventDefault();
    const m = document.getElementById(host.dataset.ctx);
    closeMenu(); m.classList.add('open');
    m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + 'px';
    openMenu = m;
  });

  function start(id) {
    // 更新徽标三态预览：发现新版本 → 后台下载中 → 下载完成待重启
    const V='<s>v1.64.0</s><svg class="i xs"><use href="#arrr"/></svg><b class="nv">v1.65.0</b>';
    const updStates=[[V,"发现新版本 v1.64.0 → v1.65.0，点击查看更新内容"],[V+"<em class=\"pc\">· 42%</em>","正在后台下载 v1.64.0 → v1.65.0（42%）"],[V+"<em class=\"pc\">· 重启生效</em>","新版本 v1.64.0 → v1.65.0 已下载完成，点击重启秒装"]];
    const upd=document.getElementById("upd");
    upd.addEventListener("click",()=>{const n=(+upd.dataset.s+1)%3;upd.dataset.s=n;upd.querySelector(".ut").innerHTML=updStates[n][0];upd.title=updStates[n][1];});
    document.getElementById('tbLogo').innerHTML = LOGO(24);
    document.getElementById('panelBtn').addEventListener('click', () => document.getElementById('win').classList.toggle('nopanel'));
    go(location.hash.slice(1) || id);
  }
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));

  return { add, panel, go, start };
})();
