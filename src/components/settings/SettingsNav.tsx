import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Input } from "antd";
import {
  Bell,
  Bot,
  Boxes,
  CloudCog,
  EyeOff,
  FolderInput,
  FolderOutput,
  HardDrive,
  History,
  Keyboard,
  LayoutTemplate,
  Lock,
  Mic,
  Palette,
  PanelLeft,
  Power,
  Rocket,
  Save,
  ScanText,
  Search,
  Server,
  Trash2,
  Type,
  Users,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";

/**
 * 设置页分区清单：顺序 = 页面里卡片的顺序。
 * id 对应卡片（或包裹卡片的 div）的 DOM id，其他页面带 state.scrollTo 跳过来也用它；
 * keywords 给左侧搜索框用 —— 用户多半搜的是分区里的设置项，而不是分区名。
 */
export const SETTINGS_SECTIONS: { id: string; label: string; icon: LucideIcon; keywords: string }[] = [
  { id: "settings-update", label: "软件更新", icon: Rocket, keywords: "版本 升级 自动更新 官网" },
  { id: "settings-startup", label: "启动设置", icon: Power, keywords: "开机 自启 托盘 关闭窗口 窗口大小" },
  { id: "settings-sidebar", label: "侧边栏", icon: PanelLeft, keywords: "活动栏 文字 隐藏 文件夹 折叠 连线" },
  { id: "settings-features", label: "功能模块", icon: Boxes, keywords: "模块 开关 日记 待办 白板 卡片" },
  { id: "settings-app-lock", label: "应用启动锁", icon: Lock, keywords: "锁屏 密码 自动锁定" },
  { id: "settings-hidden-pin", label: "隐藏笔记 PIN", icon: EyeOff, keywords: "PIN 隐藏 保护" },
  { id: "settings-shortcuts", label: "全局快捷键", icon: Keyboard, keywords: "快捷键 热键 快速记录" },
  { id: "settings-ui-scale", label: "界面显示", icon: ZoomIn, keywords: "缩放 放大 字号 DPI" },
  { id: "settings-appearance", label: "外观自定义", icon: Palette, keywords: "主题 淡紫 暖炭 暗色 强调色 背景图 遮罩" },
  { id: "settings-editor", label: "编辑器外观", icon: Type, keywords: "字体 字号 行高 标题编号 大纲 阅读模式" },
  { id: "settings-autosave", label: "自动保存", icon: Save, keywords: "保存 延迟" },
  { id: "settings-task-reminder", label: "待办提醒", icon: Bell, keywords: "提醒 通知 提醒音 识别" },
  { id: "settings-import", label: "导入笔记", icon: FolderInput, keywords: "Markdown Obsidian PDF Word Excel 外部" },
  { id: "settings-export", label: "导出 Markdown", icon: FolderOutput, keywords: "导出 md 备份" },
  { id: "settings-ai-models", label: "模型服务", icon: Bot, keywords: "AI 模型 服务商 API Key Ollama DeepSeek ai.profile" },
  { id: "settings-asr", label: "语音识别", icon: Mic, keywords: "语音 Whisper 录音 速记" },
  { id: "settings-templates", label: "模板管理", icon: LayoutTemplate, keywords: "笔记模板" },
  { id: "settings-data-dir", label: "数据目录", icon: HardDrive, keywords: "存储位置 迁移 路径" },
  { id: "settings-sync", label: "同步备份", icon: CloudCog, keywords: "WebDAV 坚果云 S3 R2 ZIP 快照 多端" },
  { id: "settings-mcp", label: "MCP 服务器", icon: Server, keywords: "Claude Cursor 端口 工具 白名单" },
  { id: "settings-ocr", label: "本地 OCR", icon: ScanText, keywords: "识别 图片 扫描件 文字" },
  { id: "settings-snapshots", label: "历史版本", icon: History, keywords: "快照 版本 清理" },
  { id: "settings-orphan-assets", label: "孤儿素材清理", icon: Trash2, keywords: "素材 图片 附件 清理 维护" },
  { id: "settings-community", label: "作者 & 社区", icon: Users, keywords: "B 站 星球 QQ 推荐应用 关于" },
];


/**
 * 设置页左侧导航（v4 原型 .st-nav）：标题 + 搜索 + 带图标的分区列表。
 *
 * 高亮跟随滚动：监听右侧内容滚动区（scrollRef）的 scroll，取「顶部已越过阅读线」的最后一个分区。
 * 不用 IntersectionObserver：它只回报状态变化的条目，矮卡片（如模型服务）滚到顶时
 * 下一张卡片刚进入观察区，会把高亮抢走。
 */
export function SettingsNav({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const [activeId, setActiveId] = useState<string>(SETTINGS_SECTIONS[0].id);
  const [keyword, setKeyword] = useState("");
  /** 点导航跳过去的分区：靠近底部的分区滚不到阅读线，滚到底时仍高亮它而不是最后一个 */
  const clickedRef = useRef<string | null>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const box = root.getBoundingClientRect();
      // 阅读线：内容区顶部往下 60px（卡片 scroll-margin 16 + 余量）。放得太低会被下面的矮卡片抢走高亮
      const line = box.top + 60;
      let current = SETTINGS_SECTIONS[0].id;
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) {
        // 滚到底：最后几张卡片到不了阅读线
        current = clickedRef.current ?? SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1].id;
      } else {
        for (const s of SETTINGS_SECTIONS) {
          const el = document.getElementById(s.id);
          if (el && el.getBoundingClientRect().top <= line) current = s.id;
        }
      }
      setActiveId(current);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    // 用户自己滚动 → 不再沿用点击的分区
    const onManual = () => {
      clickedRef.current = null;
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("wheel", onManual, { passive: true });
    root.addEventListener("keydown", onManual);
    root.addEventListener("pointerdown", onManual);
    return () => {
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("wheel", onManual);
      root.removeEventListener("keydown", onManual);
      root.removeEventListener("pointerdown", onManual);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef]);

  function jumpTo(id: string) {
    // 先高亮目标：平滑滚动途中会经过别的分区，滚完由 scroll 计算再校正
    setActiveId(id);
    clickedRef.current = id;
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const shown = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return SETTINGS_SECTIONS;
    return SETTINGS_SECTIONS.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(kw));
  }, [keyword]);

  return (
    <nav className="kb-set-nav">
      <h1>设置</h1>
      <p className="kb-set-nav-sub">应用配置与模型服务管理</p>
      <Input
        className="kb-set-search"
        allowClear
        prefix={<Search size={14} />}
        placeholder="搜索设置项"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        // 回车跳到第一个匹配分区
        onPressEnter={() => shown[0] && jumpTo(shown[0].id)}
      />
      {shown.map((s) => {
        const Icon = s.icon;
        return (
          <a
            key={s.id}
            className={"kb-set-nav-i" + (activeId === s.id ? " is-on" : "")}
            onClick={() => jumpTo(s.id)}
          >
            <Icon size={15} />
            {s.label}
          </a>
        );
      })}
      {shown.length === 0 && <p className="kb-set-nav-empty">没有匹配的设置项</p>}
    </nav>
  );
}
