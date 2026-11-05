// ─── 首页精简方案（2026-11-05 用户反馈：入口太多、「今日笔记 / 快速记一笔 / 新建笔记」分不清）───
// 打开 index.html#home-v5 查看；旧版仍是 #home，方便对比。
// 改动：去掉快捷按钮行；随手记一个输入框给两个去处；添加待办并进待办卡；
// 最近 + 置顶合成一张卡；「今日笔记」统一叫「今天的日记」；热力图点日期看当天笔记。
KB.add('home-v5', {
  panel: null, rail: 'home', title: '',
  init(el) {
    // 热力图：悬停在底部显示日期，点击弹出当天笔记
    const grid = el.querySelector('.hm-grid');
    const read = document.createElement('span');
    read.className = 'h5-read';
    read.innerHTML = '近一年写了 <b>9</b> 天 · 悬停看日期，点格子看当天笔记';
    const pop = el.querySelector('.h5-pop');
    const foot = grid.closest('.heat').querySelector('.hm-foot');
    foot.querySelector('span').remove(); // 原来的「近一年写了…」换成可变的读数
    foot.prepend(read);
    const hint = read.innerHTML;
    grid.addEventListener('mouseover', e => {
      const c = e.target.closest('i');
      if (c && c.title) read.innerHTML = `<b>${c.title.replace(' · ', '</b> · ')}${c.dataset.l !== '0' ? ' · 点击查看当天笔记' : ''}`;
    });
    grid.addEventListener('mouseleave', () => { read.innerHTML = hint; });
    grid.addEventListener('click', e => {
      const c = e.target.closest('i');
      if (!c || c.dataset.l === '0') return;
      const r = c.getBoundingClientRect(), host = el.querySelector('.h5-vital').getBoundingClientRect();
      pop.querySelector('.d').textContent = c.title.split(' · ')[0];
      pop.style.left = Math.min(r.left - host.left - 20, host.width - 300) + 'px';
      pop.style.top = (r.bottom - host.top + 8) + 'px';
      pop.style.display = 'block';
      e.stopPropagation();
    });
    el.addEventListener('click', e => { if (!e.target.closest('.h5-pop')) pop.style.display = 'none'; });
    // 笔记卡：最近 / 置顶切换
    el.querySelectorAll('.h5-tabs button').forEach(b => b.addEventListener('click', () => {
      el.querySelectorAll('.h5-tabs button').forEach(x => x.classList.toggle('on', x === b));
      el.querySelectorAll('[data-tab]').forEach(x => { x.style.display = x.dataset.tab === b.dataset.t ? '' : 'none'; });
    }));
  },
  main: () => {
    const hide = `<button class="ib sm hv hide" title="隐藏此卡片">${I('eyeoff', 'sm')}</button>`;
    const mark = n => `<span class="h5-mk" title="见下方改动说明">${n}</span>`;
    const note = (ic, cls, t, tm) => `<div class="nr"><span class="cico ${cls}" style="width:24px;height:24px">${I(ic, 'xs')}</span><span class="tx">${t}</span><time>${tm}</time></div>`;
    return `
    <style>
      .h5{padding:18px 24px 8px}
      .h5 .cols.h5-last{margin-bottom:0}
      .h5-h{display:flex;align-items:flex-end;gap:12px;margin-bottom:10px}
      .h5-h .eb{font-size:12.5px;color:var(--ink3);margin-bottom:4px;letter-spacing:.03em}
      .h5-h h1{font:700 26px/1.3 var(--ff-ui);letter-spacing:-.01em}
      .h5 .cols{margin-bottom:10px}
      .h5 .cols.g12{gap:10px 12px}
      .h5 .r2 > .card{height:240px;display:flex;flex-direction:column}
      .h5 .r2 > .card > .body{flex:1;min-height:0;overflow:auto}
      .h5-mk{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:9px;background:#FF7A45;color:#fff;font:700 11px/1 var(--ff-ui);flex:none}
      .cap textarea{display:block;width:100%;border:0;outline:0;resize:none;background:transparent;padding:0 18px;font-size:14.5px;line-height:1.75;min-height:38px}
      .cap textarea::placeholder{color:var(--ink4)}
      .cap-bar{display:flex;align-items:center;gap:6px;padding:2px 10px 8px 18px;font-size:12px;color:var(--ink4)}
      .cap-bar .btn{height:30px}
      .h5-add{display:flex;align-items:center;gap:8px;margin:0 14px 6px;height:32px;padding:0 4px 0 10px;border-radius:9px;background:var(--raised);box-shadow:0 0 0 .5px var(--hair2),var(--hi);color:var(--ink4);font-size:13px}
      .h5-add span{flex:1}
      .h5-add .dd{width:26px;height:26px;border-radius:6px;display:grid;place-items:center;color:var(--ink4)}
      .h5-add .dd:hover{background:var(--hover);color:var(--accent)}
      .td{display:flex;align-items:center;gap:10px;height:36px;padding:0 10px;border-radius:var(--r-m)}
      .td:hover{background:var(--hover)}
      .td .tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
      .td .due{font-size:12px;color:var(--ink3);min-width:40px;text-align:right}
      .td .due.bad{color:var(--bad);font-weight:600}
      .nr{display:flex;align-items:center;gap:10px;height:36px;padding:0 10px;border-radius:var(--r-m);cursor:default}
      .nr:hover{background:var(--hover)}
      .nr .tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
      .nr time{font-size:12px;color:var(--ink4)}
      .nr .tag{font-size:11px;padding:1px 6px;border-radius:5px;background:#FFF6E6;color:var(--warn)}
      .h5-vital{position:relative;display:grid;grid-template-columns:repeat(5,1fr);row-gap:8px;align-items:end;padding:0 18px 10px}
      .h5-vital > .heat{grid-column:1/-1;padding-top:10px}
      .h5 .card-h{height:42px}
      .h5-vital .hm-grid i{cursor:pointer}
      .h5-vital .hm-grid i[data-l="0"]{cursor:default}
      .h5-read{font-size:12px;color:var(--ink3)}
      .h5-read b{color:var(--ink);font-weight:600}
      .stt b{display:block;font:700 22px/1.2 var(--ff-ui)}
      .stt b small{font-size:12px;font-weight:400;color:var(--ink3);margin-left:2px}
      .stt span{font-size:12px;color:var(--ink3)}
      .h5-pop{display:none;position:absolute;z-index:5;width:290px;padding:10px 8px 8px;border-radius:12px;background:var(--raised);box-shadow:0 10px 30px rgba(60,40,120,.18),0 0 0 .5px var(--hair2)}
      .h5-pop h4{font-size:13px;font-weight:700;padding:0 10px 6px}
      .h5-pop .nr{height:34px}
      .h5-pop .all{display:block;text-align:center;margin-top:4px;padding:6px;border-radius:8px;font-size:12.5px;color:var(--accent)}
      .h5-pop .all:hover{background:var(--accent-soft)}
      .ask-in{height:42px;display:flex;align-items:center;gap:8px;padding:0 5px 0 14px;border-radius:10px;background:var(--grad-soft);box-shadow:inset 0 0 0 .5px var(--accent-line);color:var(--ink4)}
      .ask-in span{flex:1}
      .ask-in .go{width:32px;height:32px;border-radius:8px;background:var(--grad);color:#fff;display:grid;place-items:center;box-shadow:var(--sh-btn)}
      .h5-tip{position:fixed;right:28px;bottom:24px;z-index:20;height:34px;padding:0 14px;border-radius:17px;background:#FF7A45;color:#fff;font-size:12.5px;font-weight:600;box-shadow:0 6px 18px rgba(255,122,69,.35)}
      .h5-note{display:none;position:fixed;right:28px;bottom:68px;z-index:20;width:520px;max-height:70vh;overflow:auto;padding:14px 18px;border-radius:12px;background:#FFF8F2;box-shadow:inset 0 0 0 1px #FFD8BF;font-size:12.5px;line-height:1.85;color:var(--ink2)}
      .h5-note h4{font-size:13px;font-weight:700;margin-bottom:4px;color:#C2410C}
      .h5-note li{display:flex;gap:8px;align-items:baseline}
      .h5-note li .h5-mk{transform:translateY(3px)}
    </style>
    <div class="scroll tinted"><div class="h5">
      <div class="h5-h">
        <div><div class="eb">11 月 5 日 · 星期四</div><h1>下午好，今天写了 <span class="gtext num">620</span> 字</h1></div>
        <span class="sp"></span>
        <div class="inp big" style="width:320px">${I('search', 'sm')}<input placeholder="搜索笔记和待办…"><kbd>Enter</kbd></div>
        <div class="split" style="height:42px;border-radius:11px"><button class="main" style="padding:0 16px">${I('plus', 'sm')}新建笔记</button><button class="more" data-menu="m-new" style="width:32px">${I('cv', 'xs')}</button></div>
        <button class="ib hv" data-toggle title="隐私模式" style="width:42px;height:42px;border-radius:11px">${I('eye')}</button>
      </div>

      <div class="card cap" style="margin-bottom:12px">
        <div class="card-h" style="height:44px"><span class="cico v">${I('pen')}</span><h3>随手记</h3>${mark(1)}<span class="n">先记下来，再决定放哪儿</span><span class="sp"></span>
          <span class="lnk" data-go="daily">${I('cal', 'xs')}今天的日记 · 620 字${I('right', 'xs')}</span></div>
        <textarea placeholder="想到什么先记下来…"></textarea>
        <div class="cap-bar">Ctrl + Enter 记到今天的日记<span class="sp"></span>
          <button class="ib hv" title="语音输入">${I('mic')}</button>
          <button class="btn btn-o" title="单独建一篇笔记，标题取第一行">${I('fileplus', 'sm')}存为新笔记</button>
          <button class="btn btn-p" title="追加到今天的日记末尾">${I('cal', 'sm')}记到今天的日记</button>
        </div>
      </div>

      <div class="cols g12 r2">
        <div class="card" style="grid-column:span 5">
          <div class="card-h"><span class="cico g">${I('check')}</span><h3>待办</h3>${mark(2)}<span class="n num">共 11 条</span><span class="sp"></span>${hide}<span class="lnk" data-go="tasks">全部待办${I('right', 'xs')}</span></div>
          <div class="h5-add">${I('plus', 'sm')}<span>添加待办，回车保存</span><button class="dd" data-menu="m-todo" title="AI 规划待办">${I('sparkle', 'xs')}</button></div>
          <div class="pills" style="padding:0 14px 4px"><button class="bad">逾期<b>2</b></button><button class="on">今日<b>3</b></button><button>即将到期<b>2</b></button><button>无日期<b>4</b></button></div>
          <div class="body" style="padding:0 8px 10px">
            <div class="td"><span class="ck">${I('tick')}</span><span class="tx">复习 Rust 卡片 20 张</span><span class="badge r">紧急</span><span class="due num">21:00</span></div>
            <div class="td"><span class="ck">${I('tick')}</span><span class="tx">把多窗口方案写进路线图</span><span class="badge" title="子任务">${I('sub', 'xs')}1/3</span><span class="due num">23:30</span></div>
            <div class="td done"><span class="ck">${I('tick')}</span><span class="tx">写周复盘</span><span class="due num">22:00</span></div>
          </div>
        </div>
        <div class="card" style="grid-column:span 7">
          <div class="card-h"><span class="cico v">${I('note')}</span>
            <div class="seg h5-tabs"><button class="on" data-t="recent">最近编辑</button><button data-t="pin">${I('pin', 'xs')}置顶 4</button></div>${mark(3)}
            <span class="sp"></span>${hide}<span class="lnk" data-go="notes">全部笔记${I('right', 'xs')}</span></div>
          <div class="body" style="padding:0 8px 10px" data-tab="recent">
            ${note('note', 'v', 'Rust 所有权', '2 分钟前')}
            <div class="nr" data-go="daily"><span class="cico o" style="width:24px;height:24px">${I('cal', 'xs')}</span><span class="tx">2026-11-05 <span class="tag">日记</span></span><time>18 分钟前</time></div>
            ${note('whiteboard', 'b', '架构草图', '1 小时前')}
            ${note('note', 'v', '知识库 v2 路线图', '昨天')}
            ${note('note', 'v', '深入理解计算机系统', '周五')}
          </div>
          <div class="body" style="padding:0 8px 10px;display:none" data-tab="pin">
            ${['学习 Rust（MOC）|2 天前', '知识库 v2 路线图|昨天', '常用命令速查|10-21', '2026 年度目标|09-03'].map(s => { const [a, b] = s.split('|'); return `<div class="nr"><span style="color:var(--accent)">${I('pin', 'sm')}</span><span class="tx">${a}</span><time class="num">${b}</time></div>`; }).join('')}
          </div>
        </div>
      </div>

      <div class="cols g12 h5-last">
        <div class="card" style="grid-column:span 9">
          <div class="card-h"><span class="cico o">${I('flame')}</span><h3>写作活力</h3>${mark(4)}<span class="sp"></span>${hide}</div>
          <div class="h5-vital">
            <div class="stt"><b class="num">125</b><span>笔记总数</span></div>
            <div class="stt"><b class="num">2.8<small>万字</small></b><span>总字数</span></div>
            <div class="stt"><b class="num">1<small>天</small></b><span>连续写作</span></div>
            <div class="stt"><b class="num">刚刚</b><span>距上次写作</span></div>
            <div class="stt"><b class="num">620<small>字</small></b><span>本周字数</span></div>
            ${HEAT()}
            <div class="h5-pop"><h4><span class="d"></span> 写过的笔记</h4>
              ${note('cal', 'o', '当天的日记', '620 字')}
              ${note('note', 'v', 'Rust 所有权', '1,240 字')}
              ${note('note', 'v', '知识库 v2 路线图', '380 字')}
              <span class="all" data-go="notes">在笔记列表中查看这天的全部 →</span></div>
          </div>
        </div>
        <div class="card" style="grid-column:span 3">
          <div class="card-h"><span class="cico v">${I('sparkle')}</span><h3>问 AI</h3><span class="sp"></span>${hide}<span class="lnk" data-go="ai">所有会话${I('right', 'xs')}</span></div>
          <div class="card-b">
            <div class="ask-in"><span>基于你的笔记回答…</span><button class="go">${I('send', 'sm')}</button></div>
            <div class="pills" style="margin-top:10px"><button>总结本周日记</button><button>找出孤立笔记</button></div>
          </div>
        </div>
      </div>

      <button class="h5-tip" onclick="const n=this.nextElementSibling;n.style.display=n.style.display==='block'?'none':'block'">改动说明</button>
      <div class="h5-note">
        <h4>原型说明：和现在的首页相比改了什么（数据为示例）</h4>
        <ul>
          <li>${mark(1)}<span><b>随手记</b>：一个输入框给两个去处，「记到今天的日记」（Ctrl+Enter，原快速记一笔）和「存为新笔记」。原来那一排「今日笔记」快捷按钮改成右上角「今天的日记 · 620 字」链接。全站把「今日笔记」统一叫「今天的日记」，和侧栏的「日记」对上。</span></li>
          <li>${mark(2)}<span><b>添加待办</b>并进待办卡顶部的输入框，AI 规划待办放在输入框右侧的 ✦ 按钮。</span></li>
          <li>${mark(3)}<span><b>最近笔记 + 置顶笔记</b>合成一张卡，用标签切换；日记在列表里带「日记」标记。</span></li>
          <li>${mark(4)}<span><b>写作活力</b>：悬停在下方显示日期和字数，点有记录的格子弹出当天写过的笔记，可跳到按这天筛选的笔记列表。</span></li>
          <li><span class="h5-mk" style="background:var(--ink4)">–</span><span>去掉的快捷按钮行里，「AI 问答」「知识图谱」侧栏已有入口，「AI 问答」在下方问 AI 卡里也有；首页不再显示图谱节点数。</span></li>
        </ul>
        <div style="margin-top:6px;color:var(--ink3)">首页从 9 块减到 5 块：标题栏、随手记、待办、笔记、写作活力 + 问 AI。</div>
      </div>
    </div></div>`;
  }
});
