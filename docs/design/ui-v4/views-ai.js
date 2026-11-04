// ═════════════ AI 问答 / 提示词 / 定时推送 ═════════════

// ─── AI 问答：会话列表在主区内（与现状一致，不占侧栏） ───
KB.add('ai', {
  panel: null, rail: 'ai', title: '',
  main: () => `
    <style>
      .aiw{display:grid;grid-template-columns:256px 1fr;flex:1;min-height:0}
      .ai-l{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--hair);background:linear-gradient(180deg,#FBFAFF,#F7F5FE);padding:12px 10px}
      .sess{display:block;padding:8px 10px;border-radius:9px;cursor:default;position:relative}
      .sess:hover{background:var(--hover)}
      .sess.on{background:linear-gradient(180deg,#fff,#FBFAFF);box-shadow:var(--sh-raised)}
      .sess b{display:block;font-size:13px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:40px}
      .sess.on b{color:var(--accent);font-weight:600}
      .sess small{font-size:11.5px;color:var(--ink4)}
      .sess .acts{position:absolute;right:6px;top:8px;display:flex;opacity:0}
      .sess:hover .acts{opacity:1}
      .ai-r{display:flex;flex-direction:column;min-height:0;min-width:0}
      .ch{height:50px;flex:none;display:flex;align-items:center;gap:8px;padding:0 14px 0 24px;border-bottom:1px solid var(--hair);background:var(--grad-bar)}
      .ch h2{font-size:14.5px;font-weight:700}
      .mchip{height:28px;display:flex;align-items:center;gap:6px;padding:0 10px;border-radius:999px;background:#fff;box-shadow:var(--sh-raised);font-size:12px;color:var(--ink2);cursor:default}
      .mchip .p{width:6px;height:6px;border-radius:50%;background:var(--ok)}
      .tgl{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink2);padding:0 6px}
      .msgs{flex:1;overflow:auto;padding:22px 0 10px;scrollbar-gutter:stable both-edges}
      .mi-in{max-width:1020px;margin:0 auto;padding:0 30px}
      .um{display:flex;justify-content:flex-end;align-items:flex-start;gap:6px;margin-bottom:18px}
      .um .bub{max-width:72%;padding:10px 14px;border-radius:14px 14px 4px 14px;background:var(--grad);color:#fff;font-size:14.5px;line-height:1.7;box-shadow:0 4px 14px -6px rgba(124,99,220,.5)}
      .um .acts{display:flex;opacity:0;margin-top:4px}
      .um:hover .acts{opacity:1}
      .turn{border-radius:14px;background:#fff;box-shadow:var(--sh-card);margin-bottom:22px;overflow:hidden}
      .turn-h{display:flex;align-items:center;gap:8px;padding:9px 14px;background:linear-gradient(180deg,#FBFAFF,#F6F3FE);border-bottom:1px solid var(--hair);font-size:12px;color:var(--ink3)}
      .turn-h .av{width:22px;height:22px;border-radius:7px;background:var(--grad);color:#fff;display:grid;place-items:center}
      .step{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:999px;background:#fff;box-shadow:0 0 0 .5px var(--hair2);font-size:11.5px}
      .step svg{color:var(--ok)}
      .turn-b{padding:14px 18px 6px;font-size:14.5px;line-height:1.85}
      .turn-b p{margin-bottom:10px}
      .turn-b ol{padding-left:22px;margin-bottom:10px}
      .cite{display:inline-grid;place-items:center;min-width:17px;height:17px;padding:0 4px;border-radius:4px;background:var(--accent-soft);color:var(--accent);font-size:11px;font-weight:700;vertical-align:2px;margin-left:2px}
      .src{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:2px 18px 12px;padding-top:12px;border-top:1px dashed var(--hair2)}
      .src div{padding:8px 10px;border-radius:9px;background:var(--grad-soft);font-size:12px;color:var(--ink3);cursor:default}
      .src div b{display:flex;align-items:center;gap:6px;color:var(--ink);font-size:12.5px;margin-bottom:2px}
      .imgs{display:flex;gap:8px;margin:0 18px 12px}
      .imgs i{width:96px;height:64px;border-radius:8px;background:linear-gradient(135deg,#EDE7FD,#F8E9F3);box-shadow:inset 0 0 0 .5px var(--hair2)}
      .turn-f{display:flex;align-items:center;gap:2px;padding:4px 10px;border-top:1px solid var(--hair);font-size:12px;color:var(--ink4)}
      .cmp{flex:none;padding:6px 30px 16px}
      .cmp-in{max-width:960px;margin:0 auto;border-radius:16px;background:#fff;box-shadow:0 0 0 .5px var(--hair2),0 10px 30px -12px rgba(110,85,200,.3)}
      .cmp-in textarea{display:block;width:100%;border:0;outline:0;resize:none;background:transparent;padding:10px 16px 4px;font-size:14.5px;line-height:1.7;min-height:48px}
      .cmp-in textarea::placeholder{color:var(--ink4)}
      .att{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px 0}
      .att span{height:24px;display:inline-flex;align-items:center;gap:5px;padding:0 6px 0 9px;border-radius:7px;background:var(--grad-soft);font-size:12px;color:var(--ink2);box-shadow:0 0 0 .5px var(--accent-line) inset}
      .cmp-bar{display:flex;align-items:center;gap:4px;padding:6px 8px 8px 10px}
      .send{width:36px;height:36px;border-radius:10px;background:var(--grad);color:#fff;display:grid;place-items:center;box-shadow:var(--sh-btn)}
    </style>
    <div class="aiw">
      <div class="ai-l">
        <div style="display:flex;gap:6px;margin-bottom:10px">
          <button class="btn btn-p" style="flex:1">${I('plus', 'sm')}新对话</button>
          <button class="ghost hv" data-menu="m-aiclean" title="批量清理">${I('broom', 'sm')}${I('cv', 'xs')}</button>
        </div>
        <div class="search">${I('search', 'sm')}<span>搜索会话</span></div>
        <div class="side-scroll" style="margin:0">
          <div class="sec">今天</div>
          <div class="sess on" title="双击重命名"><b>所有权和借用到底差在哪</b><small>知识库 · 引用 3 篇</small><span class="acts"><button class="ib sm hv" title="重命名">${I('pen', 'xs')}</button><button class="ib sm hv" title="删除">${I('trash', 'xs')}</button></span></div>
          <div class="sess"><b>把本周日记整理成周报</b><small>智能模式 · 23:04</small><span class="acts"><button class="ib sm hv">${I('pen', 'xs')}</button><button class="ib sm hv">${I('trash', 'xs')}</button></span></div>
          <div class="sec">本周</div>
          <div class="sess"><b>Tauri 多窗口通信方案对比</b><small>限定文件夹：项目 · 引用 5 篇</small></div>
          <div class="sess"><b>CSAPP 第 3 章要点</b><small>知识库 · 引用 2 篇</small></div>
          <div class="sess"><b>给读书笔记打标签</b><small>AI 写权限 · 周三</small></div>
          <div class="sec">更早</div>
          <div class="sess"><b>SQLite FTS5 中文分词</b><small>10-24</small></div>
          <div class="sess"><b>番茄钟时间统计怎么做</b><small>10-19</small></div>
        </div>
      </div>
      <div class="ai-r">
        <div class="ch">
          <h2 title="双击重命名">所有权和借用到底差在哪</h2>
          <span class="mchip" data-menu="m-model" title="切换当前会话使用的模型服务"><span class="p"></span>DeepSeek · deepseek-chat${I('cv', 'xs')}</span>
          <span class="mchip" data-menu="m-role" title="角色">${I('role', 'xs')}默认助手${I('cv', 'xs')}</span>
          <span class="sp"></span>
          <label class="tgl" title="自动调用工具：检索、读笔记、建待办……"><span class="sw on"></span>智能模式</label>
          <label class="tgl" title="允许 AI 新建 / 修改笔记与待办"><span class="sw"></span>AI 写权限</label>
          <span class="vsep"></span>
          <button class="btn btn-t sm" title="把所有回复的执行过程收成一行摘要">${I('collapse', 'sm')}收起过程</button>
          <button class="btn btn-o sm" title="把整个对话归档成一篇笔记">${I('save', 'sm')}存为笔记</button>
        </div>
        <div class="msgs"><div class="mi-in">
          <div class="um"><div class="acts"><button class="ib sm hv" title="把这条提问放回输入框修改后重发（会撤回它之后的消息）">${I('pen', 'xs')}</button><button class="ib sm hv" title="复制">${I('copy', 'xs')}</button></div>
            <div class="bub">所有权和借用到底差在哪？结合我自己的笔记讲，别给我教科书。</div></div>
          <div class="turn">
            <div class="turn-h"><span class="av">${I('sparkle', 'xs')}</span><b style="color:var(--ink)">知识库检索</b>
              <span class="step">${I('tick', 'xs')}检索 12 篇</span><span class="step">${I('tick', 'xs')}精选 3 篇</span><span class="step">${I('tick', 'xs')}读取笔记 1 次</span>
              <span class="sp"></span><span class="num">首字 1.2s · 842 tokens</span><button class="ib sm hv" title="展开过程">${I('cv', 'xs')}</button></div>
            <div class="turn-b">
              <p>按你笔记里的说法，两者回答的是两个不同的问题：</p>
              <ol>
                <li><b>所有权管「谁负责释放」</b>。你在 <a class="wl">Rust 所有权</a> 里写的「每个值有且只有一个所有者」就是它的全部。<span class="cite">1</span></li>
                <li><b>借用管「不交出所有权也能用」</b>。<code>&amp;T</code> 可以多个、<code>&amp;mut T</code> 只能一个。<span class="cite">2</span></li>
                <li>两者靠<b>生命周期</b>连起来：借用不能比所有者活得久，这正是你 11 月 2 日日记里卡住的那个错误。<span class="cite">3</span></li>
              </ol>
              <p>你的笔记里还缺一块：<b>函数传参时的移动</b>，建议先补这个例子。</p>
            </div>
            <div class="src">
              <div data-go="editor"><b><span class="cite">1</span>Rust 所有权</b>学习 / Rust · 相关度 0.91</div>
              <div><b><span class="cite">2</span>借用检查器</b>学习 / Rust · 相关度 0.87</div>
              <div data-go="daily"><b><span class="cite">3</span>2026-11-02</b>每日笔记 · 相关度 0.74</div>
            </div>
            <div style="font-size:11.5px;color:var(--ink4);margin:0 18px 6px">出处笔记中的图片</div>
            <div class="imgs">${['所有权转移示意.png', '借用规则表.png', '作用域图解.png'].map(n => `<span class="thumb">${I('image', 'lg')}<small>${n}</small></span>`).join('')}</div>
            <div class="turn-f">
              <button class="btn btn-t sm">${I('copy', 'xs')}复制内容</button>
              <button class="btn btn-t sm">${I('quote', 'xs')}复制为引用块</button>
              <button class="btn btn-t sm">${I('refresh', 'xs')}重新生成</button>
              <button class="btn btn-t sm">${I('save', 'xs')}存为笔记</button>
              <span class="sp"></span><span>23:18</span>
            </div>
          </div>
        </div></div>
        <div class="cmp"><div class="cmp-in">
          <div class="att">
            <span>${I('clip', 'xs')}已附加：Rust 所有权<button class="ib sm" style="width:18px;height:18px">${I('x', 'xs')}</button></span>
            <span>${I('folder', 'xs')}已限定在「学习 / Rust」（含子文件夹）检索<button class="ib sm" style="width:18px;height:18px">${I('x', 'xs')}</button></span>
          </div>
          <textarea placeholder="输入问题开始对话，AI 会参考你的笔记内容回答"></textarea>
          <div class="cmp-bar">
            <button class="btn btn-t sm" title="附加笔记 / 日记到对话上下文（整对话共享）">${I('clip', 'sm')}附加笔记</button>
            <button class="btn btn-t sm" title="本会话只在该文件夹及其子文件夹的笔记里检索作答">${I('folder', 'sm')}限定文件夹</button>
            <label class="tgl"><span class="ck">${I('tick')}</span>同时附加日记</label>
            <button class="ib hv" title="语音输入">${I('mic')}</button>
            <span class="sp"></span>
            <span class="faint" style="font-size:12px">Enter 发送 · Shift+Enter 换行</span>
            <button class="btn btn-o sm" title="停止生成（只在生成中出现）" style="display:none">${I('stop', 'xs')}停止</button>
            <button class="send" title="发送">${I('send', 'sm')}</button>
          </div>
        </div></div>
      </div>
    </div>`
});

// ─── 提示词库（无侧栏） ───
KB.add('prompts', {
  panel: null, rail: 'prompts', title: '',
  main: () => {
    const ps = [
      ['润色公众号文案', '让语气更口语、段落更短，保留原意', '替换选区', true, true, 'pen'],
      ['生成读书摘要', '提炼 3 – 5 个要点 + 一句话总结', '追加到末尾', true, true, 'book'],
      ['翻译为英文', '保持术语一致，输出地道英文', '替换选区', true, false, 'globe'],
      ['周报整理', '把本周日记汇总为周报结构', '追加到末尾', false, true, 'cal'],
      ['解释这段代码', '逐行解释并指出潜在问题', '仅展示', false, true, 'code'],
      ['提取待办', '从文本中找出可执行事项', '仅展示', false, true, 'check'],
    ];
    return `
    <style>
      .pgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
      .pc{padding:14px 16px;display:flex;flex-direction:column;gap:8px;min-height:120px}
      .pc .h{display:flex;align-items:center;gap:10px}
      .pc .h b{font-size:14px;flex:1}
      .pc p{font-size:12.5px;color:var(--ink3);line-height:1.6;flex:1}
      .pc .f{display:flex;align-items:center;gap:6px}
      .pc .acts{display:flex;gap:2px;opacity:0;margin-left:auto}
      .pc:hover .acts{opacity:1}
      .pc.off{opacity:.62}
    </style>
    <div class="bar"><h1>AI 提示词库</h1><span class="muted" style="font-size:12px">编辑器「AI 写作」菜单里直接调用</span><span class="sp"></span>
      <div class="inp" style="width:220px">${I('search', 'sm')}<input placeholder="搜索提示词"></div>
      <button class="btn btn-p">${I('plus', 'sm')}新建提示词</button></div>
    <div class="scroll tinted"><div class="pg wide" style="display:grid;grid-template-columns:1fr 380px;gap:18px;padding:18px 22px 30px;align-items:start">
      <div class="pgrid">
        ${ps.map((p, i) => `<div class="card pc ${p[4] ? '' : 'off'} ${i === 0 ? 'editing' : ''}">
          <div class="h"><span class="cico v">${I(p[5])}</span><b>${p[0]}</b>${p[3] ? '<span class="badge v">内置</span>' : ''}<span class="sw ${p[4] ? 'on' : ''}" title="启用"></span></div>
          <p>${p[1]}</p>
          <div class="f"><span class="badge">${p[2]}</span>
            <div class="acts"><button class="ib sm hv" title="编辑">${I('pen', 'sm')}</button><button class="ib sm hv" title="复制为新模板">${I('copy', 'sm')}</button><button class="ib sm hv" title="删除">${I('trash', 'sm')}</button></div></div>
        </div>`).join('')}
      </div>
      <div class="card" style="position:sticky;top:0"><div class="card-h"><span class="cico v">${I('pen')}</span><h3>编辑提示词</h3></div>
        <div class="card-b" style="display:flex;flex-direction:column;gap:9px">
          <span style="font-size:12px;color:var(--ink3)">标题</span><div class="inp"><input value="润色公众号文案" placeholder="如：润色公众号文案"></div>
          <span style="font-size:12px;color:var(--ink3)">说明（可选）</span><div class="inp"><input placeholder="一句话描述这个 Prompt 的用途" value="让语气更口语、段落更短，保留原意"></div>
          <span style="font-size:12px;color:var(--ink3)">图标（可选）</span><div class="iconpick" data-group>${['pen', 'book', 'globe', 'cal', 'code', 'check', 'sparkle', 'chat', 'bulb', 'tag'].map((n, i) => `<button class="${i === 0 ? 'on' : ''}" title="${n}">${I(n)}</button>`).join('')}</div>
          <span style="font-size:12px;color:var(--ink3)">Prompt 内容 <span class="faint">· 支持 {{selection}} {{note_title}} 占位符</span></span>
          <textarea class="ta" style="min-height:110px;font-family:var(--ff-mono);font-size:12.5px">请把下面这段文字改写成公众号风格：语气口语、每段不超过 3 句，保留原意和关键数据。

{{selection}}</textarea>
          <span style="font-size:12px;color:var(--ink3)">结果插入方式</span>
          <div class="seg"><button class="on" style="flex:1;justify-content:center">替换选区</button><button style="flex:1;justify-content:center">追加到末尾</button><button style="flex:1;justify-content:center">仅展示</button></div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-top:2px"><span class="sw on"></span>启用</label>
          <div style="display:flex;gap:8px;margin-top:4px"><button class="btn btn-o" style="flex:1">取消</button><button class="btn btn-p" style="flex:1">保存</button></div>
        </div></div>
    </div></div>`;
  }
});

// ─── 定时推送（无侧栏） ───
KB.add('push', {
  panel: null, rail: 'push', title: '',
  main: () => {
    const jobs = [
      ['每日励志', '用一句话鼓励我开始今天的写作，结合我最近的日记', '每天 08:30', '居中弹窗', 'DeepSeek', true],
      ['周日复盘提醒', '列出本周写过的笔记和未完成待办，生成复盘提纲', '每周日 21:00', '系统通知', '默认模型服务', true],
      ['卡片复习提醒', '告诉我今天有几张卡片到期，挑一张最难的出题', '每天 20:00', '系统通知', '通义千问', false],
    ];
    return `
    <div class="bar"><h1>定时推送</h1><span class="muted" style="font-size:12px">到点让 AI 生成一段内容推给你</span><span class="sp"></span>
      <button class="btn btn-p">${I('plus', 'sm')}新建推送</button></div>
    <div class="scroll tinted"><div class="pg wide" style="display:grid;grid-template-columns:1fr 400px;gap:18px;padding:18px 22px 30px;align-items:start">
      <div style="display:flex;flex-direction:column;gap:12px">
        ${jobs.map(j => `<div class="card" style="padding:14px 16px;${j[5] ? '' : 'opacity:.7'}">
          <div style="display:flex;align-items:center;gap:10px">
            <span class="cico ${j[3] === '居中弹窗' ? 'v' : 'b'} lg">${I(j[3] === '居中弹窗' ? 'sparkle' : 'bell')}</span>
            <div style="flex:1;min-width:0"><b style="font-size:14px">${j[0]}</b> ${j[5] ? '' : '<span class="badge">已停用</span>'}
              <p style="font-size:12.5px;color:var(--ink3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${j[1]}</p></div>
            <span class="sw ${j[5] ? 'on' : ''}" title="启用"></span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:12px;padding-top:10px;border-top:1px solid var(--hair)">
            <span class="badge v">${I('clock', 'xs')}${j[2]}</span><span class="badge">${j[3]}</span><span class="badge">${I('bot', 'xs')}${j[4]}</span>
            <span class="sp"></span>
            <button class="btn btn-t sm">${I('play', 'xs')}立即运行一次</button>
            <button class="ib sm hv" title="编辑">${I('pen', 'sm')}</button>
            <button class="ib sm hv" title="删除">${I('trash', 'sm')}</button>
          </div></div>`).join('')}
        <div class="card" style="padding:16px">
          <div style="font-size:12px;color:var(--ink3);margin-bottom:10px">居中弹窗效果预览</div>
          <div style="margin:0 auto;width:340px;padding:18px 20px;border-radius:16px;background:linear-gradient(180deg,#fff,#FAF7FF);box-shadow:var(--sh-pop);text-align:center">
            <span class="cico v lg" style="margin:0 auto">${I('sparkle')}</span>
            <b style="display:block;margin:10px 0 6px">每日励志 · 08:30</b>
            <p style="font-size:13px;color:var(--ink2);line-height:1.7">昨天你把借用规则捋顺了，今天就把它写成 10 张卡片 —— 能讲清楚的东西才真正属于你。</p>
            <div style="display:flex;gap:8px;justify-content:center;margin-top:12px"><button class="btn btn-o sm">存为笔记</button><button class="btn btn-p sm">知道了</button></div>
          </div>
        </div>
      </div>
      <div class="card" style="position:sticky;top:0"><div class="card-h"><span class="cico v">${I('plus')}</span><h3>新建推送</h3></div>
        <div class="card-b" style="display:flex;flex-direction:column;gap:9px">
          <span style="font-size:12px;color:var(--ink3)">名称</span><div class="inp"><input placeholder="例如：每日励志"></div>
          <span style="font-size:12px;color:var(--ink3)">提示词</span><textarea class="ta" placeholder="到点后发给 AI 的内容"></textarea>
          <span style="font-size:12px;color:var(--ink3)">模型服务</span><div class="inp sel"><span class="v">默认模型服务</span>${I('cv', 'xs')}</div>
          <span style="font-size:12px;color:var(--ink3)">触发时间</span><div class="inp sel">${I('clock', 'sm')}<span class="v num">08:30</span></div>
          <span style="font-size:12px;color:var(--ink3)">重复</span>
          <div class="seg"><button style="flex:1;justify-content:center">每天</button><button class="on" style="flex:1;justify-content:center">每周</button></div>
          <div class="pills multi" title="选择星期（每周时）">${['一', '二', '三', '四', '五', '六', '日'].map((d, i) => `<button class="${[0, 2, 4].includes(i) ? 'on' : ''}" style="width:34px;justify-content:center" data-toggle>${d}</button>`).join('')}</div>
          <span style="font-size:12px;color:var(--ink3)">推送方式</span>
          <div class="seg"><button class="on" style="flex:1;justify-content:center">居中弹窗</button><button style="flex:1;justify-content:center">系统通知</button></div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-top:2px"><span class="sw on"></span>启用</label>
          <button class="btn btn-p" style="margin-top:4px">保存推送</button>
        </div></div>
    </div></div>`;
  }
});
