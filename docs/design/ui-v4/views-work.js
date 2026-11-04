
// ─── 写作热力图（按天深浅方块，一年 53 周）───
window.HEAT = () => {
  const today = new Date(2026, 10, 3);
  const start = new Date(today); start.setDate(today.getDate() - 52 * 7 - today.getDay());
  let s = 17; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const cells = [], months = [];
  let total = 0, days = 0;
  for (let d = new Date(start), i = 0; d <= today; d.setDate(d.getDate() + 1), i++) {
    const col = Math.floor(i / 7) + 1;
    if (d.getDate() === 1) months.push(`<span style="grid-column:${col}/span 4">${d.getMonth() + 1} 月</span>`);
    const back = Math.round((today - d) / 864e5);
    let r = rnd() + (d.getDay() === 0 || d.getDay() === 6 ? -.18 : .05) + (d.getMonth() >= 8 ? .12 : 0);
    if (back < 12) r = Math.max(r, .35);              // 最近 12 天不断更
    if (back >= 70 && back < 84) r -= .55;           // 夏天断更两周，图上能看出来
    const lv = r < .44 ? 0 : r < .64 ? 1 : r < .82 ? 2 : r < .94 ? 3 : 4;
    const words = lv ? Math.round(lv * 520 + rnd() * 400) : 0;
    if (words) { total += words; days++; }
    const md = (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0');
    cells.push(`<i data-l="${lv}" class="${back === 0 ? 'now' : ''}" title="${md} · ${words ? words.toLocaleString() + ' 字' : '没有记录'}"></i>`);
  }
  return `<div class="heat">
    <div class="hm-mon">${months.join('')}</div>
    <div class="hm-row"><div class="hm-wd"><span></span><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span></div>
      <div class="hm-grid">${cells.join('')}</div></div>
    <div class="hm-foot"><span>近一年写了 <b>${days}</b> 天 · 共 <b>${(total / 10000).toFixed(1)} 万</b>字</span><span class="sp"></span>
      少<i data-l="0"></i><i data-l="1"></i><i data-l="2"></i><i data-l="3"></i><i data-l="4"></i>多</div>
  </div>`;
};
// ═════════════ 首页 / 待办 / 卡片复习 / 搜索 / 标签 / 知识图谱 ═════════════

// ─── 首页（无侧栏）：原有 6 块全部保留，每块可隐藏 ───
KB.add('home', {
  panel: null, rail: 'home', title: '',
  main: () => {
    const words = [820, 1460, 0, 2310, 1980, 640, 1200, 2650, 1730, 980, 2120, 1540, 2380, 1860];
    const max = Math.max(...words);
    const hide = `<button class="ib sm hv hide" title="隐藏此卡片">${I('eyeoff', 'sm')}</button>`;
    return `
    <style>
      /* 2026-11-04 照应用实际回写：内边距 20 24 12、块间距 10（一屏放下底部热力图） */
      .hm{padding:20px 24px 12px}
      .hm-h{display:flex;align-items:flex-end;gap:12px;margin-bottom:10px}
      .hm-h .eb{font-size:12.5px;color:var(--ink3);margin-bottom:4px;letter-spacing:.03em}
      .hm-h h1{font:700 26px/1.3 var(--ff-ui);letter-spacing:-.01em}
      .qa{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:10px}
      .qb{height:46px;display:flex;align-items:center;gap:10px;padding:0 6px 0 14px;border-radius:12px;background:linear-gradient(180deg,#fff,#FCFBFF);box-shadow:var(--sh-card);font-size:13px;font-weight:600}
      .qb:hover{box-shadow:0 0 0 1px var(--accent-line),var(--sh-card)}
      .qb .lb{flex:1;text-align:left}
      .qb .dd{position:relative;width:26px;height:26px;margin-left:8px;border-radius:6px;display:grid;place-items:center;color:var(--ink4)}
      .qb .dd::before{content:"";position:absolute;left:-8px;top:5px;width:1px;height:16px;background:var(--hair2)}
      .cap textarea{display:block;width:100%;border:0;outline:0;resize:none;background:transparent;padding:0 18px;font-size:14.5px;line-height:1.75;min-height:40px}
      .cap textarea::placeholder{color:var(--ink4)}
      .cap-bar{display:flex;align-items:center;gap:4px;padding:6px 10px 10px 18px;font-size:12px;color:var(--ink4)}
      .cols{display:grid;gap:14px;margin-bottom:10px}
      .hm .cols.g12{gap:10px 12px}
      /* 待办 / 最近 / 置顶一行固定 266，内容超出（展开子任务）在卡片内滚动 */
      .hm .cols.r2 > .card{height:266px;display:flex;flex-direction:column}
      .hm .cols.r2 > .card > div:last-child{flex:1;min-height:0;overflow:auto}
      .td .star{color:var(--accent);display:grid}
      .td .star svg{fill:currentColor}
      .td-more{height:20px;line-height:20px;padding:0 10px;font-size:12px;color:var(--accent);cursor:default}
      .td{display:flex;align-items:center;gap:10px;height:40px;padding:0 10px;border-radius:var(--r-m)}
      .td:hover{background:var(--hover)}
      .td .tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
      .td .due{font-size:12px;color:var(--ink3);min-width:40px;text-align:right}
      .td .due.bad{color:var(--bad);font-weight:600}
      .nr{display:flex;align-items:center;gap:10px;height:40px;padding:0 10px;border-radius:var(--r-m);cursor:default}
      .nr:hover{background:var(--hover)}
      .nr .tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
      .nr time{font-size:12px;color:var(--ink4)}
      .vital{display:grid;grid-template-columns:repeat(5,1fr);row-gap:16px;align-items:end;padding:4px 18px 16px}.vital > .heat{grid-column:1/-1}
      .stt b{display:block;font:700 22px/1.2 var(--ff-ui)}
      .stt b small{font-size:12px;font-weight:400;color:var(--ink3);margin-left:2px}
      .stt span{font-size:12px;color:var(--ink3)}
      .bars{display:flex;align-items:flex-end;gap:5px;height:56px;padding-left:16px;border-left:1px solid var(--hair)}
      .bars i{flex:1;border-radius:3px 3px 1px 1px;background:linear-gradient(180deg,#CFC3F6,#B9A9F1);min-height:3px}
      .bars i.t{background:var(--grad)}
      .ask-in{height:42px;display:flex;align-items:center;gap:8px;padding:0 5px 0 14px;border-radius:10px;background:var(--grad-soft);box-shadow:inset 0 0 0 .5px var(--accent-line);color:var(--ink4)}
      .ask-in span{flex:1}
      .ask-in .go{width:32px;height:32px;border-radius:8px;background:var(--grad);color:#fff;display:grid;place-items:center;box-shadow:var(--sh-btn)}
    </style>
    <div class="scroll tinted"><div class="hm">
      <div class="hm-h">
        <div><div class="eb">11 月 3 日 · 星期二</div><h1>晚上好，今天写了 <span class="gtext num">1,860</span> 字</h1></div>
        <span class="sp"></span>
        <div class="inp big" style="width:320px" title="输入即下拉建议（笔记 + 待办），回车看全部结果">${I('search', 'sm')}<input placeholder="搜索笔记和待办…"><kbd>Enter</kbd></div>
        <div class="split" style="height:42px;border-radius:11px"><button class="main" style="padding:0 16px">${I('plus', 'sm')}新建笔记</button><button class="more" data-menu="m-new" style="width:32px">${I('cv', 'xs')}</button></div>
        <button class="ib hv" data-toggle title="隐私模式：遮住首页所有卡片 (Ctrl+Shift+H)" style="width:42px;height:42px;border-radius:11px">${I('eye')}</button>
      </div>
      <div class="qa">
        <div class="qb hv"><span class="cico g">${I('check')}</span><span class="lb">添加待办</span><span class="qn">今日 3 条</span><button class="dd" data-menu="m-todo" title="AI 规划待办">${I('cv', 'xs')}</button></div>
        <button class="qb hv" data-go="daily"><span class="cico v">${I('cal')}</span><span class="lb">今日笔记</span><span class="qn">620 字</span></button>
        <button class="qb hv" data-go="ai"><span class="cico v">${I('bot')}</span><span class="lb">AI 问答</span><span class="qn">12 个会话</span></button>
        <button class="qb hv" data-go="graph"><span class="cico b">${I('graph')}</span><span class="lb">知识图谱</span><span class="qn">1,284 节点</span></button>
      </div>
      <div class="card cap" style="margin-bottom:10px">
        <div class="card-h" style="height:42px"><span class="cico v">${I('pen')}</span><h3>快速记一笔</h3><span class="n">追加到「今日笔记」</span></div>
        <textarea placeholder="想到什么先记下来…"></textarea>
        <div class="cap-bar">Ctrl + Enter 保存<span class="sp"></span><button class="ib hv" title="语音输入">${I('mic')}</button><button class="btn btn-p">${I('tick', 'sm')}保存</button></div>
      </div>
      <div class="cols g12 r2">
        <div class="card">
          <div class="card-h"><span class="cico g">${I('check')}</span><h3>待办速览</h3><span class="n num">共 11 条</span><span class="sp"></span>${hide}<span class="lnk" data-go="tasks">全部待办${I('right', 'xs')}</span></div>
          <div class="pills" style="padding:0 14px 4px"><button class="bad">逾期<b>2</b></button><button class="on">今日<b>3</b></button><button>即将到期<b>2</b></button><button>无截止日期<b>4</b></button></div>
          <div style="padding:0 8px 10px">
            <div class="td"><span class="ck">${I('tick')}</span><span class="tx">复习 Rust 卡片 20 张</span><span class="star" title="重要">${I('star', 'xs')}</span><span class="badge r">紧急</span><span class="due num">21:00</span></div>
            <div class="td"><span class="ck">${I('tick')}</span><span class="tx">把多窗口方案写进路线图</span><span class="badge" title="子任务">${I('sub', 'xs')}1/3</span><span class="badge o">普通</span><span class="due num">23:30</span></div>
            <div class="td done"><span class="ck">${I('tick')}</span><span class="tx">写周复盘</span><span class="due num">22:00</span></div>
            <div class="td"><span class="ck">${I('tick')}</span><span class="tx">给《深入理解计算机系统》第 3 章补摘要</span><span class="due num">18:00</span></div>
            <div class="td-more">+ 还有 7 条…</div>
          </div>
        </div>
        <div class="card">
          <div class="card-h"><span class="cico v">${I('note')}</span><h3>最近笔记</h3><span class="sp"></span>${hide}<span class="lnk" data-go="notes">更多${I('right', 'xs')}</span></div>
          <div style="padding:0 8px 10px">
            <div class="nr" data-go="editor"><span class="cico v" style="width:24px;height:24px">${I('note', 'xs')}</span><span class="tx">Rust 所有权</span><time>2 分钟前</time></div>
            <div class="nr" data-go="daily"><span class="cico o" style="width:24px;height:24px">${I('cal', 'xs')}</span><span class="tx">2026-11-03</span><time>18 分钟前</time></div>
            <div class="nr" data-go="whiteboard"><span class="cico b" style="width:24px;height:24px">${I('whiteboard', 'xs')}</span><span class="tx">架构草图</span><time>1 小时前</time></div>
            <div class="nr"><span class="cico v" style="width:24px;height:24px">${I('note', 'xs')}</span><span class="tx">知识库 v2 路线图</span><time>昨天</time></div>
            <div class="nr"><span class="cico v" style="width:24px;height:24px">${I('note', 'xs')}</span><span class="tx">深入理解计算机系统</span><time>周五</time></div>
          </div>
        </div>
        <div class="card">
          <div class="card-h"><span class="cico v">${I('pin')}</span><h3>置顶笔记</h3><span class="n">4</span><span class="sp"></span>${hide}</div>
          <div style="padding:0 8px 10px">
            ${['学习 Rust（MOC）|2 天前', '知识库 v2 路线图|昨天', '常用命令速查|10-21', '2026 年度目标|09-03'].map(s => { const [a, b] = s.split('|'); return `<div class="nr"><span style="color:var(--accent)">${I('pin', 'sm')}</span><span class="tx">${a}</span><time class="num">${b}</time></div>`; }).join('')}
          </div>
        </div>
      </div>
      <div class="cols g12 r3">
        <div class="card">
    <div class="card-h"><span class="cico o">${I('flame')}</span><h3>写作活力</h3><span class="sp"></span>${hide}</div>
    <div class="vital">
      <div class="stt"><b class="num">1,284</b><span>笔记总数</span></div>
      <div class="stt"><b class="num">86.4<small>万字</small></b><span>总字数</span></div>
      <div class="stt"><b class="num">12<small>天</small></b><span>连续写作</span></div>
      <div class="stt"><b class="num">2<small>分钟</small></b><span>距上次写作</span></div>
      <div class="stt"><b class="num">9,320<small>字</small></b><span>本周字数</span></div>
      ${HEAT()}
    </div>
  </div>
        <div class="card">
          <div class="card-h"><span class="cico v">${I('sparkle')}</span><h3>问 AI</h3><span class="sp"></span>${hide}<span class="lnk" data-go="ai">所有会话${I('right', 'xs')}</span></div>
          <div class="card-b">
            <div class="ask-in"><span>基于你的笔记回答，回答附出处…</span><button class="go">${I('send', 'sm')}</button></div>
            <div class="pills" style="margin-top:10px"><button>总结本周日记</button><button>Rust 里我还有哪些没搞懂</button><button>找出没有链接的孤立笔记</button></div>
            <div style="margin-top:8px;border-top:1px solid var(--hair);padding-top:6px">
              <div class="nr" data-go="ai" style="height:32px"><span class="faint">${I('chat', 'xs')}</span><span class="tx" style="font-size:12.5px">所有权和借用到底差在哪</span><time>23:18</time></div>
              <div class="nr" style="height:32px"><span class="faint">${I('chat', 'xs')}</span><span class="tx" style="font-size:12.5px">把本周日记整理成周报</span><time>23:04</time></div>
              <div class="nr" style="height:32px"><span class="faint">${I('chat', 'xs')}</span><span class="tx" style="font-size:12.5px">Tauri 多窗口通信方案对比</span><time>周日</time></div>
              <div class="nr" style="height:32px"><span class="faint">${I('chat', 'xs')}</span><span class="tx" style="font-size:12.5px">CSAPP 第 3 章要点</span><time>周六</time></div>
            </div>
          </div>
        </div>
      </div>
      <p style="text-align:center;font-size:11.5px;color:var(--ink4);margin-top:20px">界面原型 · 数据为示例 · 卡片悬停可隐藏</p>
    </div></div>`;
  }
});

// ─── 待办：侧栏 ───
KB.panel('tasks', `
  <div class="ph"><h2>待办</h2><button class="ib hv" title="新建任务">${I('plus', 'sm')}</button></div>
  <div class="side-scroll">
    <div class="row hv on"><span class="ic">${I('list', 'sm')}</span><span class="lb">全部任务</span><span class="ct num">24</span></div>
    <div class="row hv"><span class="ic" style="color:var(--bad)">${I('flag', 'sm')}</span><span class="lb">逾期</span><span class="ct bad num">2</span></div>
    <div class="row hv"><span class="ic">${I('target', 'sm')}</span><span class="lb">今天</span><span class="ct num">3</span></div>
    <div class="row hv"><span class="ic">${I('cal', 'sm')}</span><span class="lb">本周</span><span class="ct num">8</span></div>
    <div class="row hv"><span class="ic">${I('clock', 'sm')}</span><span class="lb">无日期</span><span class="ct num">4</span></div>
    <div class="sec">优先级</div>
    <div class="row hv"><span class="dot" style="background:var(--bad)"></span><span class="lb">紧急</span><span class="ct num">3</span></div>
    <div class="row hv"><span class="dot" style="background:var(--warn)"></span><span class="lb">普通</span><span class="ct num">14</span></div>
    <div class="row hv"><span class="dot" style="background:var(--ink4)"></span><span class="lb">低</span><span class="ct num">7</span></div>
    <div class="sec">属性</div>
    <div class="row hv"><span class="ic">${I('repeat', 'sm')}</span><span class="lb">循环任务</span><span class="ct num">5</span></div>
    <div class="row hv"><span class="ic">${I('link', 'sm')}</span><span class="lb">有关联</span><span class="ct num">9</span></div>
    <div class="sec">分类<span class="sp"></span><button class="ib hv" title="新建分类（右键分类可新建子分类）">${I('plus')}</button><button class="ib hv" title="管理分类">${I('gear')}</button></div>
    <div class="row hv" data-ctx="m-cat"><span class="cv">${I('cv', 'xs')}</span><span class="dot" style="background:#A08BEC"></span><span class="lb">工作</span><span class="ct num">9</span></div>
    <div class="kids"><div class="row hv" data-ctx="m-cat"><span class="dot" style="background:#C3B5F3"></span><span class="lb">写作</span><span class="ct num">3</span></div></div>
    <div class="row hv" data-ctx="m-cat"><span class="cv"></span><span class="dot" style="background:#7CC1A4"></span><span class="lb">学习</span><span class="ct num">8</span></div>
    <div class="row hv" data-ctx="m-cat"><span class="cv"></span><span class="dot" style="background:#E6BC6E"></span><span class="lb">生活</span><span class="ct num">4</span></div>
    <div class="row hv"><span class="cv"></span><span class="dot" style="background:var(--hair2)"></span><span class="lb">未分类</span><span class="ct num">3</span></div>
    <div class="sec">归档</div>
    <div class="row hv"><span class="ic">${I('check', 'sm')}</span><span class="lb">已完成</span><span class="ct num">186</span></div>
    <div class="row hv"><span class="ic">${I('archive', 'sm')}</span><span class="lb">已放弃</span><span class="ct num">12</span></div>
  </div>`);

KB.add('tasks', {
  panel: 'tasks', rail: 'tasks', title: '',
  main: () => {
    const grp = (name, cls, items) => `
      <div class="tg-h ${cls}">${name}<span class="faint num">${items.length}</span></div>
      ${items.map(t => `
        <div class="tk ${t.done ? 'done' : ''}">
          <span class="ck">${I('tick')}</span>
          <span class="dot" style="background:${t.p === '紧急' ? 'var(--bad)' : t.p === '普通' ? 'var(--warn)' : 'var(--ink4)'}" title="${t.p}"></span>
          <div class="tx"><b>${t.n}</b>${t.d ? `<p>${t.d}</p>` : ''}</div>
          ${t.sub ? `<span class="badge" title="子任务进度">${I('sub', 'xs')}${t.sub}</span>` : ''}
          ${t.rep ? `<span class="badge b" title="循环任务">${I('repeat', 'xs')}${t.rep}</span>` : ''}
          ${t.link ? `<span class="badge v" title="关联笔记">${I('link', 'xs')}${t.link}</span>` : ''}
          <span class="badge" title="分类"><i style="width:6px;height:6px;border-radius:50%;background:${t.cc}"></i>${t.c}</span>
          <span class="due num ${cls === 'bad' ? 'bad' : ''}">${t.due}</span>
          <div class="acts"><button class="ib sm hv" title="编辑">${I('pen', 'sm')}</button><button class="ib sm hv" data-menu="m-taskrow" title="更多">${I('dots', 'sm')}</button></div>
        </div>`).join('')}`;
    return `
    <style>
      .tk{display:flex;align-items:center;gap:10px;min-height:48px;padding:7px 14px;border-radius:10px;cursor:default}
      .tk:hover{background:var(--hover)}
      .tk .dot{width:8px;height:8px;border-radius:50%;flex:none}
      .tk .tx{flex:1;min-width:0}
      .tk .tx b{display:block;font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .tk .tx p{font-size:12px;color:var(--ink3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .tk.done .tx b{color:var(--ink4);text-decoration:line-through}
      .tk .due{font-size:12px;color:var(--ink3);min-width:56px;text-align:right}
      .tk .due.bad{color:var(--bad);font-weight:600}
      .tk .acts{display:flex;gap:2px;opacity:0}
      .tk:hover .acts{opacity:1}
      .tk + .tk{border-top:1px solid var(--hair)}
      .tg-h{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:var(--ink2);padding:14px 14px 6px}
      .tg-h.bad{color:var(--bad)}
      .batch{display:none}
      .view.multi .batch{display:flex}
      .tk .ck{margin:0}
    </style>
    <div class="bar">
      <h1>待办</h1>
      <div class="seg">
        <button class="on">${I('list', 'xs')}列表</button><button>${I('kanban', 'xs')}看板</button><button>${I('matrix', 'xs')}四象限</button><button>${I('cal', 'xs')}日历</button><button>${I('gantt', 'xs')}甘特图</button>
      </div>
      <span class="sp"></span>
      <div class="inp" style="width:220px">${I('search', 'sm')}<input placeholder="搜索任务标题 / 描述"></div>
      <button class="btn btn-o" data-menu="m-range">${I('cal', 'sm')}全部时间${I('cv', 'xs')}</button>
      <button class="btn btn-o" onclick="this.closest('.view').classList.toggle('multi')">${I('check', 'sm')}多选</button>
      <button class="btn btn-o">${I('layers', 'sm')}项目管理</button>
      <button class="btn btn-p">${I('plus', 'sm')}新建任务</button>
    </div>
    <div class="scroll tinted"><div class="pg wide" style="padding:16px 22px 30px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div class="pills"><button class="on">全部<b>7</b></button><button class="bad">逾期<b>2</b></button><button>今天<b>3</b></button><button>即将到期<b>2</b></button><button>无截止<b>4</b></button></div>
        <span class="sp"></span>
        <span class="muted" style="font-size:12px">右键任务可设优先级 / 复制为 Markdown / 放弃</span>
      </div>
      <div class="notice batch" style="margin-bottom:12px">${I('check', 'sm')}<b style="color:var(--accent)">已选 0 项</b><span class="sp"></span>
        <button class="btn btn-t sm">全选未完成</button><button class="btn btn-s sm">${I('tick', 'sm')}标记完成</button><button class="btn btn-d sm">${I('trash', 'sm')}删除</button>
        <button class="btn btn-t sm" onclick="this.closest('.view').classList.remove('multi')">退出多选</button></div>
      <div class="card" style="padding:4px 6px 8px" data-ctx="m-taskrow">
        ${grp('逾期', 'bad', [
          { n: '回复出版社关于第 4 章的修改意见', d: '对照批注逐条回复，附修改稿', p: '紧急', c: '写作', cc: '#C3B5F3', due: '昨天', link: '第 4 章初稿' },
          { n: '整理十月读书笔记并归档', p: '普通', c: '学习', cc: '#7CC1A4', due: '10-30' },
        ])}
        ${grp('今天', '', [
          { n: '复习 Rust 卡片 20 张', p: '紧急', c: '学习', cc: '#7CC1A4', due: '21:00', rep: '每天' },
          { n: '把多窗口方案写进路线图', d: '对比 emit 和共享状态两种做法', p: '普通', c: '工作', cc: '#A08BEC', due: '23:30', sub: '1/3', link: '知识库 v2 路线图' },
          { n: '写周复盘', p: '低', c: '生活', cc: '#E6BC6E', due: '22:00', rep: '每周日', done: true },
        ])}
        ${grp('即将到期', '', [
          { n: '报名 RustConf 线上场', p: '普通', c: '学习', cc: '#7CC1A4', due: '周三' },
          { n: '季度预算表', p: '低', c: '工作', cc: '#A08BEC', due: '11-08', sub: '0/4' },
        ])}
      </div>
    </div></div>`;
  }
});

// ─── 卡片复习（无侧栏） ───
KB.add('cards', {
  panel: null, rail: 'cards', title: '',
  main: () => `
    <style>
      .stat4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
      .stat4 .card{padding:14px 18px;display:flex;align-items:center;gap:12px}
      .stat4 b{display:block;font:700 22px/1.2 var(--ff-ui)}
      .stat4 span{font-size:12px;color:var(--ink3)}
      .rv{padding:22px 26px 20px;text-align:center}
      .rv .prog{height:4px;border-radius:2px;background:var(--hover);margin:0 0 22px;overflow:hidden}
      .rv .prog i{display:block;height:100%;width:25%;background:var(--grad);border-radius:2px}
      .rv .q{font:700 22px/1.5 var(--ff-ui);margin:10px 0 18px}
      .rv .a{padding:16px 18px;border-radius:12px;background:var(--grad-soft);box-shadow:0 0 0 .5px var(--accent-line) inset;font-size:15px;line-height:1.8;text-align:left}
      .rate{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:18px}
      .rate button{height:54px;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-weight:600;font-size:13.5px;box-shadow:var(--sh-raised);background:#fff}
      .rate button small{font-weight:400;font-size:11.5px;color:var(--ink3)}
      .rate .r1{color:var(--bad)} .rate .r2{color:var(--warn)} .rate .r3{color:var(--info)} .rate .r4{color:var(--ok)}
      .rate button:hover{box-shadow:0 0 0 1px currentColor,var(--sh-raised)}
    </style>
    <div class="bar"><h1>卡片复习</h1><span class="sp"></span>
      <button class="btn btn-o" title="重新加载（如有新到期卡）">${I('refresh', 'sm')}重新加载</button>
      <button class="btn btn-p">${I('plus', 'sm')}新建卡片</button></div>
    <div class="scroll tinted"><div class="pg">
      <div class="stat4">
        <div class="card"><span class="cico v lg">${I('cards')}</span><div><b class="num gtext">12</b><span>今日待复习</span></div></div>
        <div class="card"><span class="cico b lg">${I('sparkle')}</span><div><b class="num">5</b><span>新卡</span></div></div>
        <div class="card"><span class="cico o lg">${I('repeat')}</span><div><b class="num">18</b><span>学习中</span></div></div>
        <div class="card"><span class="cico g lg">${I('layers')}</span><div><b class="num">146</b><span>总卡数</span></div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 320px;gap:16px">
        <div class="card rv">
          <div style="display:flex;align-items:center;font-size:12px;color:var(--ink3)"><span class="num">第 3 / 12 张</span><span class="sp"></span><a class="badge v" data-go="editor" style="cursor:default">${I('note', 'xs')}原笔记：Rust 所有权</a></div>
          <div class="prog" style="margin-top:12px"><i></i></div>
          <div class="muted" style="font-size:12px">正面（问题 / 提示）</div>
          <div class="q">赋值 <code style="font-size:18px;background:var(--code-inline);padding:2px 6px;border-radius:6px">let s2 = s1;</code> 之后，s1 还能用吗？</div>
          <div class="muted" style="font-size:12px;text-align:left;margin-bottom:6px">反面（答案）</div>
          <div class="a">不能。<b>String</b> 没有实现 <b>Copy</b>，赋值发生的是<b>移动</b>：所有权转给 s2，s1 随即失效；再用会报 <i>value borrowed after move</i>。</div>
          <div class="rate">
            <button class="r1">忘了<small>1 分钟后</small></button>
            <button class="r2">模糊<small>10 分钟后</small></button>
            <button class="r3">还行<small>1 天后</small></button>
            <button class="r4">记牢了<small>4 天后</small></button>
          </div>
          <div style="margin-top:14px;font-size:12px;color:var(--ink4)">翻面前显示「显示答案 (空格)」按钮 · 数字键 1 – 4 评分</div>
        </div>
        <div class="card"><div class="card-h"><span class="cico v">${I('plus')}</span><h3>新建卡片</h3></div>
          <div class="card-b" style="display:flex;flex-direction:column;gap:10px">
            <div style="font-size:12px;color:var(--ink3)">正面（问题 / 提示）</div><textarea class="ta" placeholder="例如：TCP 三次握手第二步是？" style="min-height:70px"></textarea>
            <div style="font-size:12px;color:var(--ink3)">反面（答案）</div><textarea class="ta" placeholder="例如：服务端回 SYN+ACK" style="min-height:70px"></textarea>
            <div class="inp sel">${I('note', 'sm')}<span class="v">关联笔记（可选）</span>${I('cv', 'xs')}</div>
            <button class="btn btn-p" style="width:100%">保存卡片</button>
          </div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-h"><span class="cico g">${I('layers')}</span><h3>全部卡片</h3><span class="n num">146</span><span class="sp"></span><div class="inp" style="width:200px;height:28px">${I('search', 'xs')}<input placeholder="搜索卡片"></div></div>
        <div class="list" style="padding:0 6px 8px">
          ${[['所有权的三条规则是什么？', 'Rust 所有权', '今天'], ['&mut T 同一时刻能有几个？', '借用检查器', '明天'], ['Rc 和 Arc 的区别？', '智能指针 Box / Rc / Arc', '11-06'], ['TCP 三次握手第二步是？', '计算机网络', '11-09']].map(c => `
            <div class="li"><span class="cico v">${I('cards')}</span><div class="tx"><b>${c[0]}</b><p>来自「${c[1]}」</p></div><span class="badge num">下次 ${c[2]}</span>
            <div class="acts"><button class="ib sm hv" title="打开原笔记">${I('note', 'sm')}</button><button class="ib sm hv" title="编辑">${I('pen', 'sm')}</button><button class="ib sm hv" title="删除">${I('trash', 'sm')}</button></div></div>`).join('')}
        </div>
      </div>
    </div></div>`
});

// ─── 搜索 ───
KB.panel('search', `
  <div class="ph"><h2>搜索</h2><button class="ib hv" title="清空历史">${I('trash', 'sm')}</button></div>
  <div class="side-scroll">
    <div class="sec">最近搜索</div>
    ${['所有权', 'tauri 多窗口', 'FTS5 中文分词', '周复盘', 'mermaid', 'CSAPP 栈帧'].map((q, i) => `<div class="row hv ${i === 0 ? 'on' : ''}" data-ctx="m-searchhist"><span class="ic">${I('history', 'sm')}</span><span class="lb">${q}</span><span class="ct">${I('x', 'xs')}</span></div>`).join('')}
  </div>`);

KB.add('search', {
  panel: 'search', rail: 'search', title: '',
  main: () => `
    <style>
      mark{background:linear-gradient(180deg,transparent 45%,#E5DCFD 45%);color:inherit;padding:0 1px;border-radius:2px}
      .fl{display:flex;flex-wrap:wrap;gap:8px;padding:12px 14px;border-radius:12px;background:#fff;box-shadow:var(--sh-card);margin:10px 0 14px;align-items:center}
      .fl label{font-size:12px;color:var(--ink3)}
    </style>
    <div class="scroll tinted"><div class="pg" style="max-width:900px">
      <div class="inp big" style="height:48px;font-size:15px">${I('search')}<input value="所有权"><button class="btn btn-t sm" title="清空">${I('clear', 'sm')}</button><span class="vsep"></span>
        <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink2)"><span class="sw"></span>仅搜标题</label>
        <button class="btn btn-p">搜索</button></div>
      <div class="fl">
        ${I('filter', 'sm')}<span style="font-size:12.5px;font-weight:600">筛选</span>
        <label>文件夹</label><div class="inp sel" style="width:150px;height:28px"><span class="v">学习</span>${I('cv', 'xs')}</div>
        <label>标签（需同时含有）</label><div class="inp sel" style="width:150px;height:28px"><span class="tg" style="height:20px"><i style="background:#E496A6"></i>Rust</span><span class="v"></span>${I('cv', 'xs')}</div>
        <label>时间</label><div class="inp sel" style="width:110px;height:28px" data-menu="m-range"><span class="v">最近 30 天</span>${I('cv', 'xs')}</div>
        <label>类型</label><div class="seg"><button class="on">全部</button><button>笔记</button><button>白板</button><button>待办</button></div>
        <span class="sp"></span><button class="btn btn-t sm">清空全部筛选条件</button>
      </div>
      <div class="pills" style="margin-bottom:10px"><button class="on">全部<b>6</b></button><button>笔记<b>5</b></button><button>待办<b>1</b></button></div>
      <div class="card" style="padding:6px">
        <div class="list">
          ${[['note', 'v', 'Rust <mark>所有权</mark>', '…关键是编译期就能推导出每个值的唯一<mark>所有</mark>者，离开作用域即释放…', '学习 / Rust', '2 分钟前', 'editor'],
             ['note', 'v', '智能指针 Box / Rc / Arc', '…Rc 让多个变量共享<mark>所有权</mark>，引用计数归零时释放…', '学习 / Rust', '10-26', ''],
             ['cal', 'o', '2026-11-02', '…上午把 Rust <mark>所有权</mark>里移动的例子跑通了…', '每日笔记', '周一', 'daily'],
             ['note', 'v', '编程语言对比', '…内存管理：GC / 引用计数 / Rust <mark>所有权</mark>…', '学习', '10-21', ''],
             ['whiteboard', 'b', '架构草图', '白板 · 文字命中「<mark>所有权</mark>转移」', '学习 / Rust', '1 小时前', 'whiteboard']].map(r => `
            <div class="li" ${r[6] ? `data-go="${r[6]}"` : ''}><span class="cico ${r[1]}">${I(r[0])}</span><div class="tx"><b>${r[2]}</b><p>${r[3]}</p></div><span class="badge">${I('folder', 'xs')}${r[4]}</span><time>${r[5]}</time></div>`).join('')}
        </div>
        <div style="font-size:11.5px;font-weight:600;letter-spacing:.06em;color:var(--ink4);padding:12px 14px 4px">待办</div>
        <div class="list">
          <div class="li" data-go="tasks"><span class="cico g">${I('check')}</span><div class="tx"><b>补一个函数传参时<mark>所有权</mark>移动的例子</b><p>学习 · 已完成</p></div><time>昨天</time></div>
        </div>
      </div>
    </div></div>`
});

// ─── 标签 ───
KB.panel('tags', `
  <div class="ph"><h2>标签</h2><button class="ib hv" title="新建标签">${I('plus', 'sm')}</button></div>
  <div class="search">${I('search', 'sm')}<span>筛选标签...</span></div>
  <div class="side-scroll">
    <div class="row hv" data-ctx="m-tagrow"><span class="cv">${I('cv', 'xs')}</span><span class="dot" style="background:#A08BEC"></span><span class="lb">编程语言</span><span class="ct num">61</span></div>
    <div class="kids">
      <div class="row hv on" data-ctx="m-tagrow"><span class="dot" style="background:#E496A6"></span><span class="lb">Rust</span><span class="ct num">23</span></div>
      <div class="row hv" data-ctx="m-tagrow"><span class="dot" style="background:#8DAEEA"></span><span class="lb">TypeScript</span><span class="ct num">31</span></div>
    </div>
    <div class="row hv" data-ctx="m-tagrow"><span class="cv"></span><span class="dot" style="background:#7CC1A4"></span><span class="lb">读书</span><span class="ct num">41</span></div>
    <div class="row hv" data-ctx="m-tagrow"><span class="cv"></span><span class="dot" style="background:#E6BC6E"></span><span class="lb">灵感</span><span class="ct num">12</span></div>
    <div class="row hv" data-ctx="m-tagrow"><span class="cv"></span><span class="dot" style="background:#8DAEEA"></span><span class="lb">周复盘</span><span class="ct num">9</span></div>
    <div style="padding:10px 8px"><button class="btn btn-t sm" style="color:var(--accent)">+ 新建标签</button></div>
    <div class="drop">右键标签：新建子标签 / 同级标签 / 重命名 / 提升为顶层 / 删除</div>
  </div>`);

KB.add('tags', {
  panel: 'tags', rail: 'tags', title: '',
  main: () => `
    <div class="scroll tinted"><div class="pg">
      <div class="pg-h"><span class="pi" style="background:linear-gradient(135deg,#FDEFF1,#F8DCE2);color:#D07489">${I('tag')}</span>
        <div><h1>Rust</h1><p>编程语言 / Rust · 关联 23 篇笔记</p></div><span class="sp"></span>
        <button class="btn btn-d">${I('trash', 'sm')}删除</button></div>
      <div style="display:grid;grid-template-columns:1fr 320px;gap:16px;align-items:start">
        <div class="card"><div class="card-h"><span class="cico v">${I('note')}</span><h3>关联笔记</h3><span class="n num">23</span><span class="sp"></span><span class="lnk" data-go="notes">查看全部 23 篇${I('right', 'xs')}</span></div>
          <div class="list" style="padding:0 6px 8px">
            ${['Rust 所有权|学习 / Rust|2 分钟前', 'Rust 生命周期|学习 / Rust|昨天', '借用检查器|学习 / Rust|10-29', '智能指针 Box / Rc / Arc|学习 / Rust|10-26', '学习 Rust（MOC）|学习|10-20'].map(s => { const [a, b, c] = s.split('|'); return `<div class="li" data-go="editor"><span class="cico v">${I('note')}</span><div class="tx"><b>${a}</b><p>${b}</p></div><time class="num">${c}</time></div>`; }).join('')}
          </div></div>
        <div class="card"><div class="card-h"><span class="cico v">${I('pen')}</span><h3>编辑标签</h3></div>
          <div class="card-b" style="display:flex;flex-direction:column;gap:10px">
            <span style="font-size:12px;color:var(--ink3)">标签名称</span><div class="inp"><input value="Rust" placeholder="输入标签名称"></div>
            <span style="font-size:12px;color:var(--ink3)">父标签</span><div class="inp sel"><span class="v">编程语言</span>${I('cv', 'xs')}</div>
            <span style="font-size:12px;color:var(--ink4);margin-top:-6px">不选则为顶层标签</span>
            <span style="font-size:12px;color:var(--ink3)">颜色</span>
            <div style="display:flex;gap:8px;flex-wrap:wrap" data-group>${['#A08BEC', '#E496A6', '#7CC1A4', '#E6BC6E', '#8DAEEA', '#E0A08B', '#B7B2C9'].map((c, i) => `<i class="${i === 1 ? 'on' : ''}" style="width:24px;height:24px;border-radius:7px;background:${c};cursor:pointer;box-shadow:${i === 1 ? '0 0 0 2px #fff,0 0 0 3.5px ' + c : 'none'}"></i>`).join('')}</div>
            <button class="btn btn-p" style="margin-top:6px">保存</button>
          </div></div>
      </div>
    </div></div>`
});

// ─── 知识图谱（无侧栏） ───
KB.add('graph', {
  panel: null, rail: 'graph', title: '',
  main: () => {
    let s = 7; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    const nodes = [], edges = [];
    const W = 1100, H = 640;
    const hubs = [[540, 300, 'Rust 所有权', 'hot'], [340, 220, '学习 Rust（MOC）', 'pin'], [760, 210, '编程语言对比', 'hot'], [700, 440, '2026-11-02', 'daily'], [380, 450, '学习', 'folder']];
    hubs.forEach(h => nodes.push({ x: h[0], y: h[1], t: h[2], k: h[3], r: h[3] === 'hot' ? 16 : 13 }));
    for (let i = 0; i < 46; i++) {
      const hub = hubs[i % hubs.length];
      const a = rnd() * Math.PI * 2, d = 70 + rnd() * 130;
      nodes.push({ x: hub[0] + Math.cos(a) * d, y: hub[1] + Math.sin(a) * d * .8, k: rnd() > .85 ? 'daily' : 'note', r: 4 + rnd() * 5, h: i % hubs.length });
    }
    nodes.slice(5).forEach((n, i) => edges.push([n.h, i + 5, hubs[n.h][3] === 'folder']));
    edges.push([0, 1], [0, 2], [0, 3], [1, 4, true], [2, 3]);
    const col = { note: '#B9A9F1', hot: 'url(#gHot)', pin: '#E6BC6E', daily: '#8DAEEA', folder: '#7CC1A4' };
    return `
    <style>
      .gp{position:relative;flex:1;overflow:hidden;background:radial-gradient(800px 500px at 50% 45%,#FBFAFF 0%,#F3EFFD 100%)}
      .gp svg text{font:12px "Segoe UI","Microsoft YaHei UI";fill:#4A4466}
      .legend{position:absolute;left:16px;bottom:16px;display:flex;gap:14px;padding:10px 14px;border-radius:12px;background:rgba(255,255,255,.9);box-shadow:var(--sh-card);font-size:12px;color:var(--ink2)}
      .legend span{display:flex;align-items:center;gap:6px}
      .legend i{width:10px;height:10px;border-radius:50%}
      .nodecard{position:absolute;right:16px;top:16px;width:230px;padding:12px 14px;border-radius:12px;background:#fff;box-shadow:var(--sh-pop)}
    </style>
    <div class="bar"><h1>知识图谱</h1>
      <div class="seg"><button class="on">力导向</button><button>环形</button><button>径向</button><button>网格</button></div>
      <span class="muted" style="font-size:12px;margin-left:8px">双击笔记打开 · 虚线为文件夹归属</span>
      <span class="sp"></span>
      <div class="inp" style="width:200px">${I('search', 'sm')}<input placeholder="定位节点"></div>
      <button class="btn btn-o">${I('fit', 'sm')}适应画布</button><button class="btn btn-o">${I('target', 'sm')}居中</button><button class="btn btn-o">${I('refresh', 'sm')}刷新数据</button>
    </div>
    <div class="gp">
      <svg width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        <defs><radialGradient id="gHot"><stop offset="0" stop-color="#A893EE"/><stop offset="1" stop-color="#7C63DC"/></radialGradient>
          <filter id="gl"><feGaussianBlur stdDeviation="6"/></filter></defs>
        ${edges.map(e => { const a = nodes[e[0]], b = nodes[e[1]]; return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${e[2] ? '#9ED0BA' : '#D5CCF4'}" stroke-width="1.2" ${e[2] ? 'stroke-dasharray="4 4"' : ''}/>`; }).join('')}
        <circle cx="540" cy="300" r="30" fill="#A893EE" opacity=".35" filter="url(#gl)"/>
        ${nodes.map(n => `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${col[n.k]}" stroke="#fff" stroke-width="1.5"/>`).join('')}
        ${nodes.slice(0, 5).map(n => `<text x="${n.x}" y="${n.y + n.r + 16}" text-anchor="middle" font-weight="600">${n.t}</text>`).join('')}
      </svg>
      <div class="nodecard">
        <b style="font-size:13.5px">Rust 所有权</b><p style="font-size:12px;color:var(--ink3);margin:4px 0 10px">学习 / Rust · 7 条链接 · 热门笔记</p>
        <div style="display:flex;gap:6px"><button class="btn btn-p sm" data-go="editor">${I('note', 'sm')}打开笔记</button><button class="btn btn-o sm">${I('target', 'sm')}居中此节点</button></div>
      </div>
      <div class="legend"><span><i style="background:#B9A9F1"></i>普通笔记</span><span><i style="background:var(--grad)"></i>热门笔记</span><span><i style="background:#8DAEEA"></i>日记</span><span><i style="background:#E6BC6E"></i>置顶笔记</span><span><i style="background:#7CC1A4"></i>文件夹</span></div>
    </div>`;
  }
});
