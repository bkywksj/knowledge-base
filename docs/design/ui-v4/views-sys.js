
// 推荐应用 —— 与 src/components/ui/RecommendCards.tsx 一一对应（顺序 / 名称 / 副标题 / 图标），关于页与设置页共用
window.RECOMMEND = [
  ['ruoyi.png', 'RuoYi-Plus-UniApp', '业内首个适配 Claude Code 的企业级全栈框架'],
  ['tauri.svg', '灵动桌面应用开发框架', '面向 AI 时代的桌面应用快速开发框架'],
  ['workstation.svg', 'AI 全能工作站', '42 集视频教程已发布，MCP 接入试用中'],
  ['aicoder.png', '智码 AICoder', '多 AI 编码工具一站式管理 · 移动端实时联动'],
  ['sigil.svg', 'Sigil · AI 凭据金库', '让 AI 帮你干活，但永远拿不到你的密钥'],
  ['reeve.png', 'Reeve · 服务器庄园总管', '你持钥，AI 借道 —— AI 操作服务器却拿不到密码私钥'],
  ['agileshot.png', 'AgileShot · 截图标注工具', 'AI 时代的桌面截图与标注工具'],
  ['storyloom.png', 'StoryLoom · 故事织机', '面向网文作者的本地 AI 创作工作台'],
  ['officia.svg', 'Officia · Java 文档处理套件', '零依赖 · 支持 JDK 8u161+ · Office 无损转 PDF + 在线编辑'],
];
window.RECO_HTML = () => `<div class="reco">${RECOMMEND.map(([img, name, desc]) => `
  <div class="reco-i" title="点击查看详情"><span class="reco-logo"><img src="assets/promo/${img}" alt=""></span>
    <div class="reco-t"><b>${name}</b><p>${desc}</p></div>${I('right', 'sm')}</div>`).join('')}</div>`;
// ═════════════ 隐藏笔记 / 回收站 / 关于 / 设置 / 锁屏 ═════════════

// ─── 隐藏笔记：先 PIN 解锁 ───
KB.panel('hidden', `
  <div class="ph"><h2>隐藏笔记</h2><button class="ib hv" data-go="lock" title="重新上锁">${I('lock', 'sm')}</button></div>
  <div class="side-scroll">
    <div class="row hv on"><span class="ic">${I('eyeoff', 'sm')}</span><span class="lb">全部隐藏笔记</span><span class="ct num">7</span></div>
    <div class="sec">文件夹</div>
    <div class="row hv"><span class="ic fd">${I('folder', 'sm')}</span><span class="lb">私人</span><span class="ct num">4</span></div>
    <div class="row hv"><span class="ic fd">${I('folder', 'sm')}</span><span class="lb">财务</span><span class="ct num">2</span></div>
    <div class="row hv"><span class="ic fd">${I('folder', 'sm')}</span><span class="lb">未分类</span><span class="ct num">1</span></div>
  </div>`);

KB.add('hidden', {
  panel: 'hidden', rail: 'hidden', title: '',
  main: () => `
    <div class="bar"><h1>隐藏笔记</h1><span class="muted" style="font-size:12px">不出现在笔记列表、搜索和图谱里</span><span class="sp"></span>
      <div class="inp" style="width:220px">${I('search', 'sm')}<input placeholder="搜索隐藏笔记"></div></div>
    <div class="scroll tinted"><div class="pg">
      <div class="card" style="padding:6px"><div class="list">
        ${[['日记 · 情绪记录', '私人', '昨天'], ['体检报告解读', '私人', '10-28'], ['年度开支汇总', '财务', '10-15'], ['密码提示（不含密码）', '私人', '09-30'], ['给家人的信', '私人', '09-12'], ['理财计划 2027', '财务', '08-30'], ['随手记', '未分类', '08-02']].map(r => `
          <div class="li"><span class="cico v">${I('eyeoff')}</span><div class="tx"><b>${r[0]}</b><p>${r[1]}</p></div><time class="num">${r[2]}</time>
            <div class="acts"><button class="btn btn-t sm">${I('note', 'sm')}打开笔记</button><button class="btn btn-t sm">${I('eye', 'sm')}取消隐藏</button><button class="btn btn-t sm" style="color:var(--bad)">${I('trash', 'sm')}移到回收站</button></div></div>`).join('')}
      </div></div>
    </div></div>
    <div class="mask" id="pinMask">
      <div class="modal">
        <span class="cico v lg" style="margin:0 auto;width:52px;height:52px;border-radius:15px">${I('lock', 'lg')}</span>
        <h3>输入 PIN 解锁隐藏笔记</h3><p>PIN 在 设置 → 隐藏笔记 PIN 中设置</p>
        <div class="pin-dots"><i class="f">•</i><i class="f">•</i><i></i><i></i></div>
        <div style="display:flex;gap:8px"><button class="btn btn-o lg" style="flex:1" data-go="home">取消</button><button class="btn btn-p lg" style="flex:1" onclick="document.getElementById('pinMask').remove()">解锁</button></div>
      </div>
    </div>`
});

// ─── 回收站 ───
KB.add('trash', {
  panel: null, rail: 'trash', title: '',
  main: () => `
    <div class="bar"><h1>回收站</h1><span class="badge num">5 篇</span><span class="sp"></span>
      <button class="btn btn-d">${I('trash', 'sm')}清空回收站</button></div>
    <div class="scroll tinted"><div class="pg">
      <div class="notice" style="margin-bottom:12px">${I('info', 'sm')}提示：回收站中的笔记将在 30 天后自动永久删除。</div>
      <div class="notice" style="margin-bottom:12px;background:linear-gradient(135deg,#F3EEFF,#ECE6FE)">${I('check', 'sm')}<b style="color:var(--accent)">已选 2 篇</b><span class="sp"></span>
        <button class="btn btn-s sm">${I('restore', 'sm')}批量恢复</button><button class="btn btn-d sm">${I('trash', 'sm')}批量永久删除</button><button class="btn btn-t sm">取消选择</button></div>
      <div class="card" style="padding:6px"><div class="list">
        ${[['旧版路线图（草稿）', '项目', '今天', 30, true], ['Vue 学习笔记', '学习', '昨天', 29, true], ['会议纪要 10-20', '未分类', '10-31', 27], ['临时摘录', '读书', '10-22', 18], ['重复的周复盘', '每日笔记', '10-09', 5]].map(r => `
          <div class="li"><span class="ck ${r[4] ? 'on' : ''}">${I('tick')}</span><span class="cico r">${I('file')}</span><div class="tx"><b>${r[0]}</b><p>原位置：${r[1]} · ${r[2]}删除</p></div>
            <span class="badge ${r[3] < 7 ? 'r' : ''} num">${r[3]} 天后清除</span>
            <div class="acts"><button class="btn btn-s sm">${I('restore', 'sm')}恢复</button><button class="btn btn-d sm">永久删除</button></div></div>`).join('')}
      </div></div>
    </div></div>`
});

// ─── 关于 ───
KB.add('about', {
  panel: null, rail: 'about', title: '',
  main: () => `
    <style>
      .ab{display:grid;grid-template-columns:1fr 1fr;gap:14px}
      .kv{display:grid;grid-template-columns:90px 1fr auto;gap:10px 12px;align-items:center;font-size:12.5px}
      .kv span{color:var(--ink3)}
      .qr{width:92px;height:92px;border-radius:10px;background:repeating-conic-gradient(#E9E3FB 0 25%,#fff 0 50%) 0 0/12px 12px;box-shadow:inset 0 0 0 .5px var(--hair2);cursor:zoom-in}
      .way{display:flex;gap:12px;padding:12px 0;border-top:1px solid var(--hair)}
      .way:first-child{border-top:0}
      .way .n{width:26px;height:26px;border-radius:8px;background:var(--grad);color:#fff;display:grid;place-items:center;font-weight:700;font-size:12px;flex:none}
      .way b{font-size:13.5px}
      .way p{font-size:12.5px;color:var(--ink3);margin-top:3px;line-height:1.7}
      .way code{font-size:11.5px;background:var(--code-inline);padding:1px 5px;border-radius:4px}
    </style>
    <div class="scroll tinted"><div class="pg">
      <div class="card" style="padding:22px 24px;display:flex;align-items:center;gap:18px;margin-bottom:14px;background:linear-gradient(120deg,#FFFFFF 0%,#F6F2FF 60%,#F8EEFB 100%)">
        ${LOGO(60)}
        <div style="flex:1"><h1 style="font-size:22px;font-weight:700">Knowledge Base</h1><p class="muted" style="font-size:13px;margin-top:2px">本地优先的知识库 · 系统信息和应用版本</p></div>
        <span class="badge v num" style="height:26px;font-size:12.5px">v1.64.0</span>
        <button class="btn btn-p lg">${I('refresh', 'sm')}检查更新</button>
        <button class="btn btn-o lg" data-go="settings">${I('gear', 'sm')}前往设置</button>
      </div>
      <div class="ab">
        <div class="card"><div class="card-h"><span class="cico v">${I('monitor')}</span><h3>系统信息</h3></div><div class="card-b kv">
          <span>操作系统</span><b style="font-weight:400">Windows 11 Pro 26200</b><i></i>
          <span>CPU 架构</span><b style="font-weight:400">x86_64</b><i></i>
          <span>应用版本</span><b style="font-weight:400" class="num">1.64.0</b><i></i>
          <span>官网</span><b style="font-weight:400">kb.ruoyi.plus</b><button class="btn btn-t sm">${I('newwin', 'xs')}在浏览器中打开</button>
          <span>数据目录</span><b style="font-weight:400;font-family:var(--ff-mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">%APPDATA%\\com.agilefr.kb</b><button class="btn btn-t sm">${I('folderopen', 'xs')}在文件管理器中打开</button>
        </div></div>
        <div class="card"><div class="card-h"><span class="cico o">${I('health')}</span><h3>日志与诊断</h3></div><div class="card-b" style="display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-o" style="justify-content:flex-start">${I('folderopen', 'sm')}打开日志目录</button>
          <button class="btn btn-o" style="justify-content:flex-start">${I('export', 'sm')}导出诊断包<span class="sp"></span><span class="faint" style="font-weight:400">崩溃日志 + 配置摘要</span></button>
          <button class="btn btn-o" style="justify-content:flex-start">${I('db', 'sm')}数据库体检<span class="sp"></span><span class="faint" style="font-weight:400">完整性 / 索引 / 体积</span></button>
        </div></div>
        <div class="card"><div class="card-h"><span class="cico b">${I('users')}</span><h3>作者 &amp; 社区</h3></div><div class="card-b">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px"><span class="cico v lg" style="border-radius:50%;font-weight:700">抓</span><div><b>抓蛙师</b><p class="muted" style="font-size:12px">Java 全栈 AI 架构师 · Agent 架构师</p></div></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <button class="btn btn-o" style="justify-content:flex-start">${I('tv', 'sm')}B 站主页</button>
            <button class="btn btn-o" style="justify-content:flex-start">${I('video', 'sm')}视频讲解</button>
            <button class="btn btn-o" style="justify-content:flex-start">${I('star', 'sm')}知识星球 · 星球号</button>
            <button class="btn btn-o" style="justify-content:flex-start">${I('users', 'sm')}QQ 交流群 · 点击复制</button>
          </div>
          <p class="muted" style="font-size:12px;margin-top:10px">QQ 群：Bug 反馈 / 使用交流 / 新功能讨论 · 联系作者请备注「来自知识库」</p>
          <div style="display:flex;gap:14px;margin-top:12px;align-items:flex-end"><div class="qr" title="点击图片可放大扫码"></div><div class="qr"></div><span class="faint" style="font-size:12px">点击图片可放大扫码</span></div>
        </div></div>
        <div class="card"><div class="card-h"><span class="cico r">${I('heart')}</span><h3>赞赏支持</h3></div><div class="card-b" style="display:flex;gap:16px;align-items:center">
          <div class="qr" style="width:120px;height:120px"></div><div><b style="font-size:14px">如果这款工具帮到了你 ❤️</b><p class="muted" style="font-size:12.5px;margin-top:4px;line-height:1.7">扫码请作者喝杯咖啡，你的支持会变成下一个版本里的新功能。</p></div>
        </div></div>
        <div class="card" style="grid-column:1/3"><div class="card-h"><span class="cico g">${I('truck')}</span><h3>数据迁移说明</h3><span class="n">按使用场景从简单到专业，推荐 4 种方式</span></div><div class="card-b">
          <div class="way"><span class="n">1</span><div><b>单台电脑换硬盘 / 搬到 D 盘</b><p>设置 → 数据目录，选新路径，勾选「自动迁移」。</p></div></div>
          <div class="way"><span class="n">2</span><div><b>一次性整包搬到另一台电脑（离线）</b><p>旧电脑：设置 → 同步 → 本地 ZIP → 导出；新电脑：导入 ZIP，自动解压覆盖。</p></div></div>
          <div class="way"><span class="n">3</span><div><b>多端实时双向同步（推荐长期用户）</b><p>设置 → 同步 → 多端同步（V1）；或用「WebDAV 全量快照」做单向手动备份。</p></div></div>
          <div class="way"><span class="n">4</span><div><b>手动复制（兜底方案，应急用）</b><p>直接拷贝 <code>app.db</code> 和 <code>images/</code>（笔记内嵌图片含视频）、<code>pdfs/</code>、<code>docs/</code>、<code>attachments/</code>、<code>settings.json</code>，<b>务必整目录一起搬</b>；单独要 .md 文件用 设置 → 导出 Markdown。</p></div></div>
        </div></div>
        <div class="card" style="grid-column:1/3"><div class="card-h"><span class="cico v">${I('puzzle')}</span><h3>推荐应用</h3><span class="n">9 款 · 点击查看详情</span></div><div class="card-b">${RECO_HTML()}</div></div>
      </div>
    </div></div>`
});

// ─── 设置：22 个分区全部保留，左侧锚点导航 ───
KB.add('settings', {
  panel: null, rail: '', title: '',
  main: () => {
    const R = (label, desc, ctl) => `<div class="sr"><div><b>${label}</b>${desc ? `<p>${desc}</p>` : ''}</div><div class="ctl">${ctl}</div></div>`;
    const sw = on => `<span class="sw ${on ? 'on' : ''}"></span>`;
    const sel = v => `<div class="inp sel" style="width:200px"><span class="v">${v}</span>${I('cv', 'xs')}</div>`;
    const seg = (arr, on = 0) => `<div class="seg">${arr.map((a, i) => `<button class="${i === on ? 'on' : ''}">${a}</button>`).join('')}</div>`;
    const S = (id, icon, cls, title, body) => `<section class="ss" id="${id}"><div class="card-h"><span class="cico ${cls}">${I(icon)}</span><h3>${title}</h3></div><div class="sb">${body}</div></section>`;
    const nav = [['s1', '软件更新', 'rocket'], ['s2', '启动设置', 'play'], ['s3', '侧边栏', 'sidebarI'], ['s4', '功能模块', 'puzzle'], ['s5', '隐藏笔记 PIN', 'key'], ['s6', '全局快捷键', 'keyboard'], ['s7', '外观自定义', 'palette'], ['s8', '编辑器外观', 'type'], ['s9', '自动保存', 'save'], ['s10', '待办提醒', 'bell'], ['s11', '导入笔记', 'import'], ['s12', '导出 Markdown', 'export'], ['s13', '模型服务', 'bot'], ['s14', '语音识别', 'mic'], ['s15', '模板管理', 'template'], ['s16', '数据目录', 'folder'], ['s17', '同步备份', 'cloud'], ['s18', 'MCP 服务器', 'server'], ['s19', '本地 OCR', 'scan'], ['s20', '历史版本', 'history'], ['s21', '孤儿素材清理', 'broom'], ['s22', '作者 & 社区', 'users']];
    return `
    <style>
      .st-w{display:grid;grid-template-columns:220px 1fr;flex:1;min-height:0}
      .st-nav{border-right:1px solid var(--hair);background:linear-gradient(180deg,#FBFAFF,#F7F5FE);overflow:auto;padding:16px 10px}
      .st-nav h1{font-size:17px;font-weight:700;padding:0 10px 4px}
      .st-nav .inp{margin:10px 2px 10px}
      .st-nav a{display:flex;align-items:center;gap:9px;height:32px;padding:0 10px;border-radius:8px;font-size:12.5px;color:var(--ink2);cursor:default}
      .st-nav a svg{color:var(--ink4)}
      .st-nav a:hover{background:var(--hover)}
      .st-nav a.on{background:linear-gradient(180deg,#fff,#FBFAFF);color:var(--accent);font-weight:600;box-shadow:var(--sh-raised)}
      .st-nav a.on svg{color:var(--accent)}
      .st-c{overflow:auto;padding:20px 30px 60px;background:linear-gradient(180deg,#FAF8FF,#F7F5FE)}
      .ss{max-width:960px;margin:0 auto 14px;border-radius:14px;background:linear-gradient(180deg,#fff,#FDFCFF);box-shadow:var(--sh-card);scroll-margin-top:16px}
      .sb{padding:0 18px 8px}
      .sr{display:flex;align-items:center;gap:20px;padding:12px 0;border-top:1px solid var(--hair)}
      .sr:first-child{border-top:0}
      .sr > div:first-child{flex:1;min-width:0}
      .sr b{font-size:13px;font-weight:600}
      .sr p{font-size:12px;color:var(--ink3);margin-top:2px}
      .sr .ctl{display:flex;align-items:center;gap:8px;flex:none}
      .mods{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:6px 0 10px}
      .mods div{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:10px;background:var(--sheet-tint);box-shadow:0 0 0 .5px var(--hair) inset;font-size:12.5px}
      .mods div span:nth-child(2){flex:1}
      .prov{display:flex;align-items:center;gap:12px;padding:12px;border-radius:11px;background:var(--sheet-tint);box-shadow:0 0 0 .5px var(--hair) inset;margin-bottom:8px}
      .prov b{font-size:13px}
      .prov p{font-size:12px;color:var(--ink3)}
      .themes{display:flex;gap:10px}
      .themes div{width:86px;border-radius:10px;overflow:hidden;box-shadow:var(--sh-raised);font-size:11.5px;text-align:center;padding-bottom:6px;cursor:default}
      .themes div i{display:block;height:44px;margin-bottom:5px}
      .themes div.on{box-shadow:0 0 0 2px var(--accent),var(--sh-raised)}
    </style>
    <div class="st-w">
      <nav class="st-nav">
        <h1>设置</h1>
        <div class="inp">${I('search', 'sm')}<input placeholder="搜索设置项"></div>
        ${nav.map((n, i) => `<a class="${i === 0 ? 'on' : ''}" onclick="document.getElementById('${n[0]}').scrollIntoView({behavior:'smooth'});this.parentElement.querySelectorAll('a').forEach(x=>x.classList.remove('on'));this.classList.add('on')">${I(n[2], 'sm')}${n[1]}</a>`).join('')}
      </nav>
      <div class="st-c">
        ${S('s1', 'rocket', 'v', '软件更新', R('当前版本 v1.64.0', '发现新版本 v1.65.0 · 修复混合 DPI 下窗口尺寸问题', '<button class="btn btn-o">查看更新内容</button><button class="btn btn-p">立即更新</button>') + R('自动检查更新', '启动时在后台检查', sw(true)))}
        ${S('s2', 'play', 'g', '启动设置', R('开机自启', '', sw(false)) + R('启动后最小化到托盘', '', sw(false)) + R('启动时打开', '', seg(['首页', '上次打开的笔记'])))}
        ${S('s3', 'sidebarI', 'b', '侧边栏', R('活动栏显示文字', '关闭后只显示图标，悬停仍可看到名称', sw(true)) + R('面板位置', '', seg(['左侧', '右侧'])) + R('面板宽度', '拖动面板边缘可调，双击恢复默认', '<span class="badge num">260 px</span>'))}
        ${S('s4', 'puzzle', 'v', '功能模块', `<p class="muted" style="font-size:12px;padding:4px 0 6px">关闭的模块会从活动栏和首页隐藏；笔记、搜索、回收站、关于为核心模块，始终开启</p><div class="mods">${['日记', '待办', '卡片复习', '标签', '知识图谱', 'AI 问答', '提示词', '定时推送', '隐藏笔记', '白板', '语音识别', '本地 OCR'].map((m, i) => `<div><span class="cico v" style="width:22px;height:22px">${I('puzzle', 'xs')}</span><span>${m}</span>${sw(i !== 7)}</div>`).join('')}</div>`)}
        ${S('s5', 'key', 'o', '隐藏笔记 PIN', R('PIN 码', '进入「隐藏笔记」前需要输入，4 – 8 位数字', '<span class="badge g">已设置</span><button class="btn btn-o">修改 PIN</button>') + R('应用锁', '启用后活动栏出现「锁定」，离开时一键锁屏', sw(true)))}
        ${S('s6', 'keyboard', 'b', '全局快捷键', [['快速记一笔', 'Ctrl + Alt + N'], ['显示 / 隐藏主窗口', 'Ctrl + Alt + K'], ['语音速记', 'Ctrl + Alt + V'], ['快速新建待办', 'Ctrl + Alt + T'], ['编辑器内高亮', 'Ctrl + Shift + H']].map(k => R(k[0], '', `<kbd style="padding:5px 8px;font-size:12px">${k[1]}</kbd><button class="btn btn-t sm">修改</button>`)).join(''))}
        ${S('s7', 'palette', 'v', '外观自定义', R('主题', '', `<div class="themes"><div class="on"><i style="background:linear-gradient(135deg,#F4F1FD,#B3A3F6)"></i>淡紫</div><div><i style="background:linear-gradient(135deg,#ede9fe,#fce7f3)"></i>柔光</div><div><i style="background:linear-gradient(135deg,#faf8f5,#e8d5c0)"></i>暖木</div><div><i style="background:linear-gradient(135deg,#fafafa,#bfe9d3)"></i>玉青</div><div><i style="background:linear-gradient(135deg,#1e1e32,#4b3f8f)"></i>星夜</div></div>`) + R('背景图片', '可选一张图作为窗口背景', '<button class="btn btn-o">选择图片</button>') + R('图片填充方式', '', seg(['覆盖（裁切）', '包含（留白）', '原始大小', '平铺'])) + R('界面字体', '', sel('跟随系统')))}
        ${S('s8', 'type', 'b', '编辑器外观', R('正文字体', '', sel('默认')) + R('标题字体', '', sel('跟随正文')) + R('正文字号', '', sel('16')) + R('行高', '', sel('1.8')) + R('标题自动编号', '', seg(['关闭', '1 / 1.1 / 1.1.1', '一、/（一）/ 1.'])) + R('打开笔记默认模式', '', seg(['编辑模式（默认）', '阅读模式'])) + R('大纲位置', '', seg(['右侧', '左侧'])))}
        ${S('s9', 'save', 'g', '自动保存', R('自动保存', '停止输入片刻即自动保存', sw(true)) + R('保存延迟', '', sel('1 秒')))}
        ${S('s10', 'bell', 'o', '待办提醒', R('到期提醒', '截止前弹出系统通知', sw(true)) + R('提前提醒', '', sel('15 分钟')) + R('提醒音', '', sel('清脆')) + R('任务识别模式', '从笔记中识别 - [ ] 任务', seg(['自动', '手动'])))}
        ${S('s11', 'import', 'v', '导入笔记', `<div style="display:flex;flex-wrap:wrap;gap:8px;padding:8px 0 4px">${['Markdown / TXT', 'Markdown 文件夹 / Obsidian', 'PDF', 'Word', 'Excel / CSV'].map(t => `<button class="btn btn-o">${I('import', 'sm')}${t}</button>`).join('')}</div>` + R('打开外部 .md 时', '', seg(['每次询问（默认）', '加入知识库', '临时编辑'])))}
        ${S('s12', 'export', 'b', '导出 Markdown', R('导出全部笔记为 .md', '按文件夹结构导出，图片随笔记一起导出', '<button class="btn btn-p">选择目录并导出</button>') + R('包含附件', '', sw(true)))}
        ${S('s13', 'bot', 'v', '模型服务', `<div style="padding:8px 0">
            <div class="prov"><span class="cico v lg">${I('bot')}</span><div style="flex:1"><b>DeepSeek</b> <span class="badge v">默认</span><p>deepseek-chat · 上下文 64K · https://api.deepseek.com</p></div><button class="btn btn-t sm">测试连接</button><button class="ib sm hv">${I('pen', 'sm')}</button></div>
            <div class="prov"><span class="cico b lg">${I('bot')}</span><div style="flex:1"><b>通义千问</b><p>qwen-plus · 上下文 128K</p></div><button class="btn btn-t sm">测试连接</button><button class="ib sm hv">${I('pen', 'sm')}</button></div>
            <div class="prov"><span class="cico g lg">${I('cpu')}</span><div style="flex:1"><b>Ollama（本地）</b><p>qwen2.5:7b · http://localhost:11434</p></div><button class="btn btn-t sm">获取模型</button><button class="ib sm hv">${I('pen', 'sm')}</button></div>
            <div style="display:flex;gap:8px;margin-top:4px"><button class="btn btn-p">${I('plus', 'sm')}添加模型服务</button><button class="btn btn-o">${I('import', 'sm')}导入 ai.profile</button><button class="btn btn-o">${I('export', 'sm')}导出 ai.profile</button></div></div>`)}
        ${S('s14', 'mic', 'o', '语音识别', R('识别引擎', '', sel('本地 Whisper（离线）')) + R('模型', 'base · 142 MB · 已下载', '<button class="btn btn-o">管理模型</button>') + R('语音速记快捷键', '', '<kbd style="padding:5px 8px;font-size:12px">Ctrl + Alt + V</kbd>'))}
        ${S('s15', 'template', 'v', '模板管理', `<div class="list" style="padding:6px 0">${['读书笔记', '会议纪要', '周复盘', '项目立项'].map(t => `<div class="li" style="padding:6px 10px"><span class="cico v">${I('template')}</span><div class="tx"><b>${t}</b></div><div class="acts"><button class="ib sm hv">${I('pen', 'sm')}</button><button class="ib sm hv">${I('trash', 'sm')}</button></div></div>`).join('')}</div><button class="btn btn-s" style="margin-bottom:10px">${I('plus', 'sm')}新建模板</button>`)}
        ${S('s16', 'folder', 'g', '数据目录', R('当前位置', '<span style="font-family:var(--ff-mono)">%APPDATA%\\com.agilefr.kb</span> · 2.3 GB', '<button class="btn btn-o">打开</button><button class="btn btn-p">更改位置</button>') + R('更改后自动迁移数据', '', sw(true)))}
        ${S('s17', 'cloud', 'b', '同步备份', `<div style="padding:8px 0 4px">${seg(['多端同步（V1）', 'WebDAV 全量快照', 'S3 / R2', '本地 ZIP'])}</div>` + R('同步状态', '上次同步 23:12 · 全部最新', '<span class="badge g">已连接</span><button class="btn btn-p">立即同步</button>') + R('服务器', 'https://dav.example.com/kb', '<button class="btn btn-o">配置</button>') + R('冲突处理', '两端同时修改时', sel('保留双方并提示')))}
        ${S('s18', 'server', 'v', 'MCP 服务器', R('启用 MCP 服务', '让 Claude Code 等 AI 工具读写你的知识库', sw(true)) + R('HTTP 端口', '', '<div class="inp" style="width:100px"><input value="17890"></div>') + R('工具白名单', '允许 AI 调用的工具', '<button class="btn btn-o">管理 14 个工具</button>') + R('接入配置', '', '<button class="btn btn-s">复制配置</button>'))}
        ${S('s19', 'scan', 'o', '本地 OCR', R('图片文字识别', 'RapidOCR 引擎，离线运行；识别结果参与搜索', sw(true)) + R('状态', '引擎已就绪 · 已识别 342 张图片', '<button class="btn btn-o">重新识别</button>'))}
        ${S('s20', 'history', 'b', '历史版本', R('每篇笔记保留版本数', '保存 / 同步覆盖前自动留底', sel('50')) + R('占用空间', '86 MB', '<button class="btn btn-o">清理旧版本</button>'))}
        ${S('s21', 'broom', 'r', '孤儿素材清理', R('扫描未被任何笔记引用的图片和附件', '上次扫描：发现 23 个文件 · 41 MB', '<button class="btn btn-o">扫描</button><button class="btn btn-d">移到回收站</button>'))}
        ${S('s22', 'users', 'v', '作者 &amp; 社区', R('抓蛙师 · B 站 / 知识星球 / QQ 群', '使用教程、问题反馈与新功能讨论', '<button class="btn btn-o" data-go="about">前往关于页</button>') + '<div style="padding:4px 0 10px"><div style="font-size:12px;font-weight:700;color:var(--ink3);margin-bottom:8px">推荐应用</div>' + RECO_HTML() + '</div>')}
      </div>
    </div>`;
  }
});

// ─── 锁屏（启用应用锁后点「锁定」） ───
KB.add('lock', {
  panel: null, rail: 'lock', title: '',
  main: () => `
    <div style="flex:1;display:grid;place-items:center;background:radial-gradient(600px 400px at 50% 40%,#FFFFFF 0%,#F2EDFE 60%,#ECE5FC 100%)">
      <div style="text-align:center;width:340px">
        <span style="display:flex;justify-content:center">${LOGO(72)}</span>
        <h2 style="font-size:20px;font-weight:700;margin:18px 0 4px">Knowledge Base 已锁定</h2>
        <p class="muted" style="font-size:13px">输入密码解锁</p>
        <div class="inp big" style="margin:22px 0 12px;height:46px">${I('lock', 'sm')}<input type="password" value="••••••" style="letter-spacing:4px"><button class="ib sm hv" title="显示">${I('eye', 'sm')}</button></div>
        <button class="btn btn-p lg" style="width:100%;height:42px" data-go="home">解锁</button>
        <p class="faint" style="font-size:12px;margin-top:14px">${I('shield', 'xs')} 闲置 10 分钟自动锁定 · 可在设置中修改</p>
      </div>
    </div>`
});
