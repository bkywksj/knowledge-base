// ═════════════ 笔记工作区：笔记列表 / 编辑器 / 日记 / 白板 ═════════════

// 格式工具栏：编辑器与日记共用，原工具栏 50+ 个按钮全部保留，
// 「插入」类 20 项收进一个分组菜单，其余按 撤销 / 段落 / 文字样式 / 排版 / 列表 / 对齐缩进 / 插入 / 清理 / 工具 / AI 分组
window.FMT = () => `
<div class="fmt">
  <button class="fb" title="撤销 (Ctrl+Z)">${I('undo')}</button>
  <button class="fb" title="重做 (Ctrl+Y)">${I('redo')}</button>
  <span class="fsep"></span>
  <button class="fb drop-l" data-menu="m-para" title="段落格式" style="min-width:64px">正文${I('cv', 'cv')}</button>
  <span class="fsep"></span>
  <button class="fb ft" title="粗体 (Ctrl+B)"><span class="glyph">B</span></button>
  <button class="fb ft" title="斜体 (Ctrl+I)"><span class="glyph it">I</span></button>
  <button class="fb ft" title="下划线 (Ctrl+U)"><span class="glyph ul">U</span></button>
  <button class="fb ft" title="删除线"><span class="glyph st">S</span></button>
  <button class="fb ft" title="高亮">${I('marker')}</button>
  <button class="fb" title="批注">${I('comment')}</button>
  <button class="fb ft" title="行内代码">${I('code')}</button>
  <button class="fb ft" title="上标">${I('sup')}</button>
  <button class="fb ft" title="下标">${I('subs')}</button>
  <span class="fsep"></span>
  <button class="fb color" data-menu="m-color" title="字体颜色">${I('fontA')}<span class="chip-c" style="background:#7C63DC"></span></button>
  <button class="fb color" data-menu="m-bg" title="背景颜色">${I('fill')}<span class="chip-c" style="background:#F6D88A"></span></button>
  <button class="fb" data-menu="m-typo" title="字体 / 字号 / 行间距" style="font-size:12px;gap:4px">${I('type')}16${I('cv', 'cv')}</button>
  <span class="fsep"></span>
  <button class="fb" title="无序列表">${I('ul')}</button>
  <button class="fb" title="有序列表">${I('ol')}</button>
  <button class="fb" title="任务列表">${I('tasklist')}</button>
  <button class="fb" title="引用">${I('quote')}</button>
  <span class="fsep"></span>
  <button class="fb" data-menu="m-align" title="对齐方式：左 / 居中 / 右">${I('alL')}${I('cv', 'cv')}</button>
  <button class="fb" title="减少缩进">${I('outdent')}</button>
  <button class="fb" title="增加缩进">${I('indent')}</button>
  <span class="fsep"></span>
  <button class="fb" data-menu="m-insert" title="插入：表格 / 图片 / 链接 / 视频 / 白板 / 公式 / Callout / 分栏 / 附件 …" style="padding:0 8px;color:var(--accent);font-weight:600">${I('plus')}插入${I('cv', 'cv')}</button>
  <span class="fsep"></span>
  <button class="fb ft" title="格式刷">${I('brush')}</button>
  <button class="fb" title="清除格式">${I('eraser')}</button>
  <button class="fb" data-menu="m-tidy" title="格式规整（清理从别处复制来的内容）">${I('wand')}${I('cv', 'cv')}</button>
  <span class="fsep"></span>
  <button class="fb" title="查找替换 (Ctrl+F / Ctrl+H)">${I('find')}</button>
  <button class="fb" title="语音输入">${I('mic')}</button>
  <button class="fb" data-menu="m-compare" title="对比剪贴板 / 对比其他笔记">${I('diff')}${I('cv', 'cv')}</button>
  <button class="fb ai" data-menu="m-aiwrite" title="AI 写作">${I('sparkle', 'sm')}AI 写作${I('cv', 'cv')}</button>
</div>`;

// ─── 侧栏：笔记树（笔记列表 / 编辑器 / 白板共用） ───
KB.panel('notes', `
  <div class="ph">
    <h2>笔记</h2>
    <button class="ib hv" data-toggle title="只显示文件夹">${I('foldonly', 'sm')}</button>
    <button class="ib hv caret" data-menu="m-expand" title="折叠 / 展开全部 · 按层级展开">${I('collapse', 'sm')}${I('cv', 'xs')}</button>
  </div>
  <div style="display:flex;gap:6px;margin:4px 0 8px;flex:none">
    <div class="split" style="flex:1">
      <button class="main" title="新建笔记（建到选中的文件夹）">${I('plus', 'sm')}新建笔记</button>
      <button class="more" data-menu="m-new" title="从模板 / 白板 / 剪藏 / 导入">${I('cv', 'xs')}</button>
    </div>
    <button class="ghost hv" data-menu="m-open" title="打开本机 .md 文件 · 临时文件">${I('folderopen', 'sm')}${I('cv', 'xs')}</button>
  </div>
  <div class="search">${I('search', 'sm')}<span>搜索笔记…</span><kbd>Ctrl K</kbd></div>
  <div class="side-scroll">
    <div class="sec">文件夹<span class="sp"></span>
      <button class="ib hv" title="清理空文件夹">${I('broom')}</button>
      <button class="ib hv" title="新建文件夹">${I('folderplus')}</button>
    </div>
    <div class="row hv" data-ctx="m-cat"><span class="cv">${I('cv', 'xs')}</span><span class="ic fd">${I('folder', 'sm')}</span><span class="lb">学习</span><span class="ct num">146</span></div>
    <div class="kids">
      <div class="row hv"><span class="cv">${I('cv', 'xs')}</span><span class="ic fd">${I('folder', 'sm')}</span><span class="lb">Rust</span><span class="ct num">23</span></div>
      <div class="kids">
        <div class="row hv on" data-go="editor" data-ctx="m-notecard"><span class="ic">${I('note', 'sm')}</span><span class="lb">Rust 所有权</span><span class="ic" style="color:var(--warn)" title="已置顶">${I('pin', 'xs')}</span></div>
        <div class="row hv" data-ctx="m-notecard"><span class="ic">${I('note', 'sm')}</span><span class="lb">Rust 生命周期</span></div>
        <div class="row hv" data-ctx="m-notecard"><span class="ic">${I('note', 'sm')}</span><span class="lb">借用检查器</span><span class="ic" title="已加密">${I('lock', 'xs')}</span></div>
        <div class="row hv" data-go="whiteboard"><span class="ic">${I('whiteboard', 'sm')}</span><span class="lb">架构草图</span></div>
      </div>
      <div class="row hv shut"><span class="cv">${I('cv', 'xs')}</span><span class="ic fd">${I('folder', 'sm')}</span><span class="lb">TypeScript</span><span class="ct num">31</span></div>
      <div class="kids"><div class="row hv"><span class="ic">${I('note', 'sm')}</span><span class="lb">类型体操笔记</span></div></div>
    </div>
    <div class="row hv shut"><span class="cv">${I('cv', 'xs')}</span><span class="ic fd">${I('folder', 'sm')}</span><span class="lb">项目</span><span class="ct num">58</span></div>
    <div class="kids"><div class="row hv"><span class="ic">${I('note', 'sm')}</span><span class="lb">知识库 v2 路线图</span></div></div>
    <div class="row hv shut"><span class="cv">${I('cv', 'xs')}</span><span class="ic fd">${I('folder', 'sm')}</span><span class="lb">读书</span><span class="ct num">41</span></div>
    <div class="kids"><div class="row hv"><span class="ic">${I('note', 'sm')}</span><span class="lb">深入理解计算机系统</span></div></div>
    <div class="row hv"><span class="cv"></span><span class="ic fd">${I('folder', 'sm')}</span><span class="lb">未分类</span><span class="ct num">9</span></div>
    <div class="sec">标签<span class="sp"></span><button class="ib hv" data-go="tags" title="管理标签">${I('gear')}</button></div>
    <div class="tagrow">
      <span class="tg"><i style="background:#A08BEC"></i>编程语言<small>61</small></span>
      <span class="tg"><i style="background:#E496A6"></i>Rust<small>23</small></span>
      <span class="tg"><i style="background:#7CC1A4"></i>读书<small>41</small></span>
      <span class="tg"><i style="background:#E6BC6E"></i>灵感<small>12</small></span>
      <span class="tg"><i style="background:#8DAEEA"></i>周复盘<small>9</small></span>
    </div>
    <div class="drop">拖入 .md / .txt 文件到这里<br>直接新建为笔记</div>
  </div>`);

// ─── 笔记列表（/notes） ───
KB.add('notes', {
  panel: 'notes', rail: 'notes', tabs: true,
  main: () => {
    const rows = [
      ['note', 'Rust 所有权', '所有权系统的关键是编译期就能推导出每个值的唯一所有者……', '学习 / Rust', ['编程语言', 'Rust'], '2 分钟前', true],
      ['whiteboard', '架构草图', '白板 · 12 个图形', '学习 / Rust', [], '1 小时前', false],
      ['cal', '2026-11-02', '上午把 Rust 所有权里移动的例子跑通了，下午读 CSAPP 第 3 章……', '每日笔记', ['周复盘'], '昨天', false],
      ['note', 'Rust 生命周期', '生命周期标注不改变引用活多久，只是告诉编译器各个引用之间的关系……', '学习 / Rust', ['Rust'], '11-01', false],
      ['note', '借用检查器', '已加密 · 解锁后查看内容', '学习 / Rust', ['Rust'], '10-29', false],
      ['note', '智能指针 Box / Rc / Arc', 'Box 独占堆内存；Rc 单线程共享；Arc 原子计数跨线程共享……', '学习 / Rust', ['Rust'], '10-26', true],
      ['note', '编程语言对比', '内存管理：GC / 引用计数 / Rust 所有权；并发模型：线程 / 协程 / Actor……', '学习', ['编程语言'], '10-21', false],
      ['note', '所有权与 C++ RAII 对照', 'RAII 靠析构函数释放资源，Rust 把这件事交给了编译器检查……', '学习 / Rust', ['Rust'], '10-19', false],
      ['note', 'Rust 错误处理', 'Result + ? 运算符，thiserror 定义错误类型，anyhow 用在应用层……', '学习 / Rust', ['Rust'], '10-17', false],
      ['note', 'Cargo 常用命令', 'cargo check / clippy / test --manifest-path，workspace 下的依赖管理……', '学习 / Rust', ['编程语言'], '10-15', false],
    ];
    const tagColor = { '编程语言': '#A08BEC', 'Rust': '#E496A6', '周复盘': '#8DAEEA' };
    return `
    <div class="bar">
      <h1>Rust</h1><span class="muted" style="font-size:12px">学习 / Rust · 23 篇</span>
      <span class="vsep"></span>
      <div class="seg"><button class="on" title="列出所选文件夹及全部子文件夹的笔记">含子文件夹</button><button title="只列出所选文件夹本层的笔记">仅本级</button></div>
      <span class="sp"></span>
      <div class="inp" style="width:220px">${I('search', 'sm')}<input placeholder="搜索笔记标题..."></div>
      <div class="inp sel" style="width:170px" title="筛选标签，没有就输入新名字回车新建">${I('tag', 'sm')}<span class="v faint">筛选标签</span>${I('cv', 'xs')}</div>
      <button class="btn btn-o" data-menu="m-sort">${I('sort', 'sm')}修改时间${I('cv', 'xs')}</button>
    </div>
    <div class="scroll tinted">
      <div class="pg wide" style="padding:16px 22px 30px">
        <div class="notice" style="margin-bottom:12px;background:linear-gradient(135deg,#F3EEFF,#ECE6FE)">
          ${I('check', 'sm')}<b style="color:var(--accent)">已选 2 篇</b>
          <span class="sp"></span>
          <button class="btn btn-t sm">${I('tag', 'sm')}打标签…</button>
          <button class="btn btn-t sm">${I('folder', 'sm')}移动到…</button>
          <button class="btn btn-t sm" data-menu="m-batchexp">${I('export', 'sm')}批量导出${I('cv', 'xs')}</button>
          <button class="btn btn-t sm">${I('diff', 'sm')}对比</button>
          <button class="btn btn-t sm">${I('sparkle', 'sm')}发到 AI</button>
          <button class="btn btn-d sm">${I('trash', 'sm')}全部移到回收站</button>
          <button class="btn btn-t sm">取消选择</button>
        </div>
        <div class="card" style="padding:6px">
          <div class="list">
          ${rows.map((r, i) => `
            <div class="li" data-ctx="m-notecard" ${r[1] === 'Rust 所有权' ? 'data-go="editor"' : ''}>
              <span class="ck ${r[6] ? 'on' : ''}" onclick="event.stopPropagation()">${I('tick')}</span>
              <span class="cico ${r[0] === 'whiteboard' ? 'b' : r[0] === 'cal' ? 'o' : 'v'}">${I(r[0])}</span>
              <div class="tx"><b>${r[1]}</b><p>${r[2]}</p></div>
              <span class="badge">${I('folder', 'xs')}${r[3]}</span>
              <span class="tagc">${r[4].map(t => `<span class="tg"><i style="background:${tagColor[t]}"></i>${t}</span>`).join('')}</span>
              <time class="num" style="min-width:64px;text-align:right">${r[5]}</time>
              <div class="acts">
                <button class="ib sm hv" title="编辑">${I('pen', 'sm')}</button>
                <button class="ib sm hv" data-menu="m-export" title="导出">${I('export', 'sm')}</button>
                <button class="ib sm hv" title="删除">${I('trash', 'sm')}</button>
                <button class="ib sm hv" data-menu="m-notecard" title="更多">${I('dots', 'sm')}</button>
              </div>
            </div>`).join('')}
          </div>
        </div>
      </div>
    </div>
    <!-- 分页固定在列表区右下角：不随列表滚动、不随条数多少上下跳 -->
    <div class="pager">
      <span>共 <b class="num">23</b> 篇 · 第 1 / 3 页</span>
      <span class="sp"></span>
      <div class="inp sel" style="height:28px;width:auto;padding:0 8px;font-size:12px"><span class="v">每页 10 篇</span>${I('cv', 'xs')}</div>
      <span class="vsep"></span>
      <button class="ib sm hv" title="上一页">${I('left', 'sm')}</button>
      <div class="pg-n" data-group><button class="on">1</button><button>2</button><button>3</button></div>
      <button class="ib sm hv" title="下一页">${I('right', 'sm')}</button>
    </div>`;
  }
});

// ─── 编辑器 ───
KB.add('editor', {
  panel: 'notes', rail: 'notes', tabs: true,
  main: () => `
    <div class="ebar">
      <div class="crumb">学习${I('right', 'xs')}Rust${I('right', 'xs')}<b>Rust 所有权</b></div>
      <span class="saved" title="停止输入片刻即自动保存，可在设置 → 自动保存里关闭"><span class="p"></span>已自动保存</span>
      <span class="sp"></span>
      <div class="seg" style="margin-right:8px">
        <button class="on" title="富文本编辑">${I('pen', 'xs')}编辑</button>
        <button title="阅读模式（只读）">${I('book', 'xs')}阅读</button>
        <button title="源码模式（直接编辑 Markdown）">${I('code', 'xs')}源码</button>
      </div>
      <button class="ib hv" title="专注模式 (F11)">${I('focus')}</button>
      <button class="ib hv" title="历史版本（保存 / 同步覆盖前会自动留底）">${I('history')}</button>
      <button class="ib hv on" data-toggle title="取消置顶">${I('pin')}</button>
      <button class="ib hv on" data-rail title="隐藏大纲">${I('outline')}</button>
      <span class="vsep"></span>
      <button class="ib hv" title="思维导图（只读视图）">${I('mind')}</button>
      <button class="ib hv" title="幻灯片演示（用 --- 分页）">${I('slides')}</button>
      <button class="ib hv" title="新窗口打开">${I('newwin')}</button>
      <button class="ib hv caret" data-menu="m-export" title="导出 (Ctrl+Shift+E)">${I('export')}${I('cv', 'xs')}</button>
      <span class="vsep"></span>
      <button class="btn btn-s" title="问 AI">${I('sparkle', 'sm')}问 AI</button>
      <button class="ib hv" data-menu="m-more" title="更多操作">${I('dots')}</button>
    </div>
    ${FMT()}
    <div class="scroll">
      <div class="edgrid">
        <article class="doc">
          <div class="ttl">
            <h1 class="doc-title" contenteditable="true" spellcheck="false">Rust 所有权</h1>
            <div class="ttl-act">
              <button class="ib hv" title="语音输入标题">${I('mic')}</button>
              <button class="ib hv" title="清空">${I('clear')}</button>
            </div>
          </div>
          <div class="doc-meta">
            <span class="chip" title="所在文件夹 · 点击移动">${I('folder', 'xs')}学习 / Rust${I('cv', 'xs')}</span>
            <span class="chip tag"><i style="background:#A08BEC"></i>编程语言</span>
            <span class="chip tag"><i style="background:#E496A6"></i>Rust</span>
            <span class="chip add">+ 标签</span>
          </div>
          <div class="prose">
            <p>所有权系统的关键是编译期就能推导出每个值的唯一所有者，离开作用域即释放，不需要 GC。它和 <a class="wl">Rust 生命周期</a> 是一体两面：所有权回答「谁负责释放」，生命周期回答「引用能活多久」。和 <a class="wl">JavaScript 闭包</a> 对照着看更容易理解。</p>
            <div class="callout">${I('bulb', 'ci')}<div>一句话记住：<strong>每个值有且只有一个所有者</strong>；所有者离开作用域，值被 <code>drop</code>。</div></div>
            <h2>三条规则</h2>
            <ol><li>每个值都有一个变量作为它的所有者；</li><li>同一时刻只能有一个所有者；</li><li>所有者离开作用域时，值被丢弃。</li></ol>
            <h2>移动与克隆</h2>
            <p>赋值给另一个变量时发生<strong>移动</strong>，原变量随即失效。需要两份数据就显式 <code>clone()</code>；实现了 <code>Copy</code> 的类型按位复制。</p>
            <div class="code"><div class="code-h"><span class="lang"><i></i>Rust</span><button>${I('copy', 'xs')}复制</button></div>
<pre><span class="k">fn</span> <span class="f">main</span>() {
    <span class="k">let</span> s1 = <span class="y">String</span>::<span class="f">from</span>(<span class="s">"hello"</span>);
    <span class="k">let</span> s2 = s1;            <span class="c">// s1 的所有权移动到 s2</span>
    <span class="k">let</span> s3 = s2.<span class="f">clone</span>();    <span class="c">// 深拷贝，s2 仍然可用</span>
}</pre></div>
            <h2>和借用的关系</h2>
            <p>不想交出所有权时就借用：<code>&amp;T</code> 可以同时有多个，<code>&amp;mut T</code> 同一时刻只能有一个。规则记在 <a class="wl">借用检查器</a> 里。</p>
            <div class="quote">共享不可变，可变不共享 —— 这八个字基本就是借用规则的全部。</div>
            <h2>待补充</h2>
            <ul class="tasks">
              <li class="done"><span class="ck">${I('tick')}</span><span class="tx">补一个函数传参时移动的例子</span></li>
              <li><span class="ck">${I('tick')}</span><span class="tx">对比 <a class="wl">智能指针 Box / Rc / Arc</a> 里共享所有权的做法</span></li>
              <li><span class="ck">${I('tick')}</span><span class="tx">做 10 张复习卡片</span></li>
            </ul>
            <p style="color:var(--ink4)">输入 <code>/</code> 唤出快捷插入：标题、表格、Callout、白板、数据视图、分栏、公式……</p>
          </div>
        </article>
        <aside class="aside">
          <div class="aside-in">
            <div class="ah">大纲</div>
            <nav class="toc"><a class="on">三条规则</a><a>移动与克隆</a><a>和借用的关系</a><a>待补充</a></nav>
            <div class="ah">反向链接<span class="n num">3</span></div>
            <a class="bl"><b>${I('note', 'xs')}学习 Rust（MOC）</b><p>第一阶段：<em>Rust 所有权</em> → 生命周期 → trait</p></a>
            <a class="bl"><b>${I('cal', 'xs')}2026-11-02</b><p>上午把 <em>Rust 所有权</em> 里移动的例子跑通了</p></a>
            <a class="bl"><b>${I('note', 'xs')}编程语言对比</b><p>内存管理：GC / 引用计数 / <em>Rust 所有权</em></p></a>
            <div class="unl"><span>未链接提及：深入理解计算机系统</span><button>链接</button></div>
          </div>
        </aside>
      </div>
    </div>
    <div class="statusbar">
      <span class="g">富文本</span><span>10 月 27 日创建 · 2 分钟前修改</span>
      <span class="sp"></span>
      <span class="num">1,280 字</span><span>约 4 分钟</span><span class="g"><span class="p"></span>已同步</span>
    </div>`
});

// ─── 日记：侧栏月历 ───
KB.panel('daily', () => {
  // 2026 年 11 月：1 号是周日
  const has = [1, 2, 3, 5, 6, 8, 9, 12, 13, 14, 16, 19, 20, 22, 23, 26, 27, 29, 30].filter(d => d <= 3);
  let cells = '';
  ['日', '一', '二', '三', '四', '五', '六'].forEach(w => cells += `<span class="cw">${w}</span>`);
  for (let i = 0; i < 0; i++) cells += '<span></span>';
  for (let d = 1; d <= 30; d++) {
    const cls = [d === 3 ? 'today' : '', d === 3 ? 'sel' : '', has.includes(d) ? 'has' : '', d > 3 ? 'fut' : ''].join(' ');
    cells += `<span class="cd ${cls}">${d}</span>`;
  }
  const oct = [31, 30, 29, 28, 27, 25, 24, 23, 22, 21];
  return `
  <style>
    .cal{padding:4px 6px 10px}
    .cal-h{display:flex;align-items:center;gap:2px;padding:0 0 8px 4px}
    .cal-h b{font-size:13.5px;flex:1}
    .cal-g{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center}
    .cal-g .cw{font-size:11px;color:var(--ink4);padding:4px 0}
    .cal-g .cd{height:30px;display:grid;place-items:center;border-radius:8px;font-size:12.5px;color:var(--ink2);position:relative;cursor:default;font-variant-numeric:tabular-nums}
    .cal-g .cd:hover{background:var(--hover)}
    .cal-g .cd.has::after{content:"";position:absolute;bottom:3px;width:4px;height:4px;border-radius:50%;background:var(--accent);opacity:.7}
    .cal-g .cd.fut{color:var(--ink4)}
    .cal-g .cd.today{background:var(--grad);color:#fff;font-weight:700;box-shadow:var(--sh-btn)}
    .cal-g .cd.today::after{background:#fff}
  </style>
  <div class="ph"><h2>日记</h2>
    <button class="ib hv" title="跳到今天">${I('target', 'sm')}</button>
  </div>
  <div class="seg" style="margin:4px 0 10px"><button class="on" style="flex:1;justify-content:center">月历</button><button style="flex:1;justify-content:center">全部</button></div>
  <div class="side-scroll">
    <div class="card cal">
      <div class="cal-h"><b>2026 年 11 月</b><button class="ib sm hv">${I('left', 'sm')}</button><button class="ib sm hv">${I('right', 'sm')}</button></div>
      <div class="cal-g">${cells}</div>
      <div style="display:flex;gap:12px;font-size:11.5px;color:var(--ink4);padding:8px 4px 0"><span style="display:flex;align-items:center;gap:5px"><i style="width:5px;height:5px;border-radius:50%;background:var(--accent)"></i>有日记</span><span>本月 3 篇</span></div>
    </div>
    <div class="sec">本月</div>
    <div class="row hv on" data-ctx="m-dailyrow"><span class="ic">${I('cal', 'sm')}</span><span class="lb">11-03 · 周二</span><span class="ct">今天</span></div>
    <div class="row hv" data-ctx="m-dailyrow"><span class="ic">${I('cal', 'sm')}</span><span class="lb">11-02 · 周一</span><span class="ct num">620 字</span></div>
    <div class="row hv" data-ctx="m-dailyrow"><span class="ic">${I('cal', 'sm')}</span><span class="lb">11-01 · 周日</span><span class="ct num">1,140 字</span></div>
    <div class="sec">10 月</div>
    ${oct.map(d => `<div class="row hv" data-ctx="m-dailyrow"><span class="ic">${I('cal', 'sm')}</span><span class="lb">10-${d}</span><span class="ct num">${[860, 1240, 430, 990, 1520, 710, 380, 1160, 640, 920][oct.indexOf(d)].toLocaleString()} 字</span></div>`).join('')}
  </div>`;
});

KB.add('daily', {
  panel: 'daily', rail: 'daily', tabs: true,
  main: () => `
    <div class="ebar">
      <button class="ib hv" title="前一天">${I('left')}</button>
      <div style="font-size:14px;font-weight:700;margin:0 4px">2026 年 11 月 3 日 · 星期二</div>
      <button class="ib hv" title="后一天">${I('right')}</button>
      <button class="btn btn-o sm" style="margin-left:6px">今天</button>
      <span class="saved" style="color:var(--warn)"><span class="p" style="background:var(--warn)"></span>未保存</span>
      <span class="sp"></span>
      <button class="btn btn-s">${I('sparkle', 'sm')}AI 规划今日</button>
      <button class="btn btn-o">${I('import', 'sm')}导入日记</button>
      <button class="btn btn-o">${I('save', 'sm')}保存</button>
      <button class="ib hv on" data-rail title="大纲">${I('outline')}</button>
    </div>
    ${FMT()}
    <div class="scroll">
      <div class="edgrid">
        <article class="doc">
          <div class="ttl"><h1 class="doc-title" contenteditable="true" spellcheck="false">周二 · 把借用规则捋顺</h1>
            <div class="ttl-act"><button class="ib hv" title="清空">${I('clear')}</button></div></div>
          <div class="doc-meta"><span class="chip">${I('cal', 'xs')}每日笔记</span><span class="chip tag"><i style="background:#8DAEEA"></i>周复盘</span><span class="chip add">+ 标签</span></div>
          <div class="prose">
            <h2>今天做了什么</h2>
            <ul class="tasks">
              <li class="done"><span class="ck">${I('tick')}</span><span class="tx">把 <a class="wl">Rust 所有权</a> 里移动的例子补完</span></li>
              <li class="done"><span class="ck">${I('tick')}</span><span class="tx">读 CSAPP 第 3 章 3.4 – 3.6 节</span></li>
              <li><span class="ck">${I('tick')}</span><span class="tx">复习 Rust 卡片 20 张</span></li>
            </ul>
            <h2>想法</h2>
            <p>借用检查器报的错其实都在说同一件事：<strong>引用不能比被引用的值活得久</strong>。下次遇到先画出各个变量的作用域，再看哪个引用越界。</p>
            <div class="callout">${I('bulb', 'ci')}<div>明天：把多窗口方案写进 <a class="wl">知识库 v2 路线图</a>。</div></div>
          </div>
        </article>
        <aside class="aside"><div class="aside-in">
          <div class="ah">大纲</div>
          <nav class="toc"><a class="on">今天做了什么</a><a>想法</a></nav>
          <div class="ah">今日待办<span class="n num">3</span></div>
          <div class="list" style="padding:0 4px">
            <div class="td" style="display:flex;align-items:center;gap:8px;height:32px;font-size:12.5px"><span class="ck">${I('tick')}</span><span class="tx">复习 Rust 卡片</span></div>
            <div class="td" style="display:flex;align-items:center;gap:8px;height:32px;font-size:12.5px"><span class="ck">${I('tick')}</span><span class="tx">写多窗口方案</span></div>
            <div class="td done" style="display:flex;align-items:center;gap:8px;height:32px;font-size:12.5px"><span class="ck">${I('tick')}</span><span class="tx">写周复盘</span></div>
          </div>
        </div></aside>
      </div>
    </div>
    <div class="statusbar"><span class="g">富文本</span><span class="sp"></span><span class="num">620 字</span><span class="g"><span class="p" style="background:var(--warn)"></span>未保存</span></div>`
});

// ─── 白板 ───
KB.add('whiteboard', {
  panel: 'notes', rail: 'notes', tabs: true,
  main: () => `
    <style>
      .wb{position:relative;flex:1;background:radial-gradient(circle,#E3DDF5 1px,transparent 1.2px) 0 0/22px 22px,#FDFCFF;overflow:hidden}
      .wb-tools{position:absolute;top:14px;left:50%;transform:translateX(-50%);display:flex;gap:2px;padding:4px;border-radius:12px;background:#fff;box-shadow:var(--sh-pop)}
      .wb-tools .fb{width:34px;height:34px}
      .wb-zoom{position:absolute;left:14px;bottom:14px;display:flex;align-items:center;gap:2px;padding:3px;border-radius:10px;background:#fff;box-shadow:var(--sh-card);font-size:12px;color:var(--ink2)}
      .wb-side{position:absolute;right:14px;top:14px;width:200px;padding:12px;border-radius:12px;background:#fff;box-shadow:var(--sh-card);font-size:12px;color:var(--ink3)}
      .wb-side .sw-row{display:flex;gap:6px;margin:6px 0 12px}
      .wb-side .sw-row i{width:20px;height:20px;border-radius:6px;box-shadow:inset 0 0 0 .5px rgba(80,60,150,.15)}
    </style>
    <div class="ebar">
      <div class="crumb">学习${I('right', 'xs')}Rust${I('right', 'xs')}<b>架构草图</b></div>
      <span class="saved"><span class="p"></span>已自动保存</span>
      <span class="sp"></span>
      <button class="btn btn-o" title="插入笔记链接">${I('link', 'sm')}找某条笔记</button>
      <button class="ib hv" title="新窗口打开">${I('newwin')}</button>
      <button class="ib hv" data-menu="m-wb" title="复制为图片 / 导出 PNG / SVG / 删除">${I('dots')}</button>
    </div>
    <div class="wb">
      <div class="wb-tools" data-group>
        <button class="fb on" title="选择 (V)">${I('arrr')}</button>
        <button class="fb" title="矩形 (R)">${I('max')}</button>
        <button class="fb" title="椭圆 (O)">${I('clear')}</button>
        <button class="fb" title="箭头 (A)">${I('right')}</button>
        <button class="fb" title="直线 (L)">${I('min')}</button>
        <button class="fb" title="画笔 (P)">${I('pen')}</button>
        <button class="fb" title="文字 (T)">${I('type')}</button>
        <button class="fb" title="图片">${I('image')}</button>
        <button class="fb" title="橡皮擦 (E)">${I('eraser')}</button>
      </div>
      <svg width="100%" height="100%" style="position:absolute;inset:0" font-family="Segoe UI, Microsoft YaHei UI" font-size="14">
        <defs><marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0 10 5 0 10z" fill="#8E7AD9"/></marker></defs>
        <rect x="200" y="150" width="170" height="70" rx="14" fill="#F1ECFF" stroke="#9C88E8" stroke-width="1.6"/>
        <text x="285" y="190" text-anchor="middle" fill="#4A4166">React 前端</text>
        <rect x="520" y="150" width="170" height="70" rx="14" fill="#EAF6F0" stroke="#7CC1A4" stroke-width="1.6"/>
        <text x="605" y="190" text-anchor="middle" fill="#3B5A4D">Rust Core</text>
        <rect x="520" y="320" width="170" height="70" rx="14" fill="#FFF5E3" stroke="#E6BC6E" stroke-width="1.6"/>
        <text x="605" y="360" text-anchor="middle" fill="#6A5326">SQLite</text>
        <path d="M372 185 H512" stroke="#8E7AD9" stroke-width="1.8" fill="none" marker-end="url(#ah)"/>
        <text x="442" y="174" text-anchor="middle" fill="#8E86A8" font-size="12">invoke()</text>
        <path d="M605 222 V312" stroke="#8E7AD9" stroke-width="1.8" fill="none" marker-end="url(#ah)"/>
        <path d="M230 300 q40 -40 90 0 t90 0" stroke="#E496A6" stroke-width="2" fill="none"/>
        <text x="250" y="340" fill="#B06A7A" font-size="13">手写批注：事件回推走 emit</text>
      </svg>
      <div class="wb-side">
        描边<div class="sw-row"><i style="background:#8E7AD9"></i><i style="background:#E496A6"></i><i style="background:#7CC1A4"></i><i style="background:#E6BC6E"></i><i style="background:#635D7B"></i></div>
        填充<div class="sw-row"><i style="background:#F1ECFF"></i><i style="background:#FDEFF1"></i><i style="background:#EAF6F0"></i><i style="background:#FFF5E3"></i><i style="background:#fff"></i></div>
        粗细<div class="seg" style="margin-top:6px"><button>细</button><button class="on">中</button><button>粗</button></div>
      </div>
      <div class="wb-zoom"><button class="ib sm hv">${I('min', 'sm')}</button><span class="num" style="padding:0 6px">100%</span><button class="ib sm hv">${I('plus', 'sm')}</button><span class="vsep"></span><button class="ib sm hv" title="撤销">${I('undo', 'sm')}</button><button class="ib sm hv" title="重做">${I('redo', 'sm')}</button></div>
    </div>`
});
