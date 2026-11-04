import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  Info,
  Lock,
  SlidersHorizontal,
  Home,
  FileText,
  Search,
  Trash2,
  Info as InfoIcon,
  Calendar,
  CheckSquare,
  Layers,
  Tag,
  GitFork,
  Bot,
  Sparkles,
  BellRing,
  EyeOff,
  // 移动端 Dashboard 项 / Tab 选择器额外用到
  Home as HomeIcon,
  TrendingUp,
  BarChart3,
  Clock,
  Zap,
  CalendarDays,
  MessageSquareText,
  Sparkles as SparklesIcon,
  Layers as LayersIcon,
  User,
} from "lucide-react";
import { Drawer, Switch, message } from "antd";
import { useAppStore, OPTIONAL_VIEWS } from "@/store";
import type { ActiveView, MobileDashboardItem, MobileTabKey } from "@/store";
import { MOBILE_TAB_REGISTRY, MOBILE_TAB_KEYS } from "@/lib/mobileTabRegistry";

/**
 * 移动端「功能模块」开关页（设计稿：16-feature-toggle.html）
 *
 * 路由 /feature-toggle —— 移动端专用
 * 入口：MobileMe 「功能模块」一行
 *
 * 复用桌面端 useAppStore.enabledViews + toggleEnabledView：
 * - 数据存到 app_config.enabled_views（同一个 key，桌面 / 移动共用）
 * - 同步到 PC：通过 V1 sync push enabled_views 后桌面端也跟着变（T-M015 范围）
 *
 * MVP 不实装：
 * - 底部 Tab 配置（设计稿那块网格）— 需要新 app_config key + MobileLayout 动态读取
 * - 主页 Dashboard 显示项 — 需要新 app_config key + MobileHome 动态读取
 * 这两个移动端独有特性放下迭代，先把桌面端已有的 8 个可选模块开关接上去
 */

interface OptionMeta {
  view: ActiveView;
  label: string;
  desc: string;
  icon: React.ReactNode;
  iconBg: string;
  defaultOff?: boolean;
}

const CORE_MODULES = [
  {
    icon: <Home size={16} className="text-slate-500" />,
    label: "主页",
    desc: "每日仪表盘 · 数据总览",
  },
  {
    icon: <FileText size={16} className="text-slate-500" />,
    label: "笔记",
    desc: "笔记 CRUD / 文件夹",
  },
  {
    icon: <Search size={16} className="text-slate-500" />,
    label: "搜索",
    desc: "全文 / 标签 / 双链",
  },
  {
    icon: <Trash2 size={16} className="text-slate-500" />,
    label: "回收站",
    // 应用没有按时间自动清理回收站，原文案「30 天保留」与实际不符
    desc: "已删除的笔记，可恢复或永久删除",
  },
  {
    icon: <InfoIcon size={16} className="text-slate-500" />,
    label: "关于",
    desc: "版本 / 许可 / 反馈",
  },
];

const OPTIONS: OptionMeta[] = [
  {
    view: "daily",
    label: "日记",
    desc: "按日期写日记 / 工作日志",
    icon: <Calendar size={16} className="text-green-600" />,
    iconBg: "bg-green-100",
  },
  {
    view: "tasks",
    label: "待办",
    desc: "任务管理 / 提醒 / 重复任务",
    icon: <CheckSquare size={16} className="text-blue-600" />,
    iconBg: "bg-blue-100",
  },
  {
    view: "cards",
    label: "闪卡复习",
    desc: "FSRS 间隔重复 · 从批注一键转卡",
    icon: <Layers size={16} className="text-purple-600" />,
    iconBg: "bg-purple-100",
    defaultOff: true,
  },
  {
    view: "tags",
    label: "标签",
    desc: "标签管理 / 跨笔记标签视图",
    icon: <Tag size={16} className="text-pink-600" />,
    iconBg: "bg-pink-100",
  },
  {
    view: "graph",
    label: "知识图谱",
    desc: "可视化笔记之间的双向链接",
    icon: <GitFork size={16} className="text-cyan-600" />,
    iconBg: "bg-cyan-100",
  },
  {
    view: "ai",
    label: "AI 问答",
    desc: "和 AI 对话，让它读你的笔记",
    icon: <Bot size={16} className="text-[#FA8C16]" />,
    iconBg: "bg-orange-100",
  },
  {
    view: "prompts",
    label: "提示词",
    desc: "管理常用 AI 提示词模板",
    icon: <Sparkles size={16} className="text-yellow-600" />,
    iconBg: "bg-yellow-100",
  },
  {
    view: "push",
    label: "定时推送",
    desc: "定时让 AI 跑提示词并推送结果",
    icon: <BellRing size={16} className="text-indigo-600" />,
    iconBg: "bg-indigo-100",
  },
  {
    view: "hidden",
    label: "隐藏笔记",
    desc: "PIN 锁保护的私密笔记空间",
    icon: <EyeOff size={16} className="text-red-600" />,
    iconBg: "bg-red-100",
  },
];

/** 把 registry 的 icon key 翻译成 Lucide 组件（移动端 Tab 网格用） */
const TAB_ICONS: Record<MobileTabKey, React.ReactNode> = {
  home: <HomeIcon size={20} className="text-[var(--kb-primary)]" />,
  notes: <FileText size={20} className="text-[var(--kb-primary)]" />,
  ai: <SparklesIcon size={20} className="text-[#FA8C16]" />,
  tasks: <CheckSquare size={20} className="text-[var(--kb-primary)]" />,
  daily: <CalendarDays size={20} className="text-green-600" />,
  tags: <Tag size={20} className="text-pink-600" />,
  cards: <LayersIcon size={20} className="text-purple-600" />,
  prompts: <MessageSquareText size={20} className="text-yellow-600" />,
  hidden: <EyeOff size={20} className="text-red-600" />,
  graph: <GitFork size={20} className="text-cyan-600" />,
  search: <Search size={20} className="text-slate-600" />,
  trash: <Trash2 size={20} className="text-red-500" />,
};

interface DashItemMeta {
  key: MobileDashboardItem;
  label: string;
  icon: React.ReactNode;
}

const DASH_ITEM_META: DashItemMeta[] = [
  {
    key: "today_words",
    label: "今日字数（蓝渐变卡）",
    icon: <TrendingUp size={16} className="text-blue-500" />,
  },
  {
    key: "due_cards",
    label: "待复习闪卡（紫渐变卡）",
    icon: <Layers size={16} className="text-purple-500" />,
  },
  {
    key: "today_tasks_card",
    label: "今日待办计数",
    icon: <CheckSquare size={16} className="text-green-500" />,
  },
  {
    key: "total_notes",
    label: "笔记总数",
    icon: <HomeIcon size={16} className="text-slate-500" />,
  },
  {
    key: "quick_actions",
    label: "快速操作（4 按钮）",
    icon: <Zap size={16} className="text-amber-500" />,
  },
  {
    key: "today_tasks_list",
    label: "今日待办速览",
    icon: <CheckSquare size={16} className="text-green-500" />,
  },
  {
    key: "heatmap",
    label: "30 天写作热力图",
    icon: <BarChart3 size={16} className="text-blue-500" />,
  },
  {
    key: "recent_notes",
    label: "最近编辑",
    icon: <Clock size={16} className="text-slate-500" />,
  },
];

export default function FeatureTogglePage() {
  const navigate = useNavigate();
  const enabledViews = useAppStore((s) => s.enabledViews);
  const toggleEnabledView = useAppStore((s) => s.toggleEnabledView);
  const mobileDashItems = useAppStore((s) => s.mobileDashboardItems);
  const toggleMobileDashItem = useAppStore(
    (s) => s.toggleMobileDashboardItem,
  );
  const mobileTabKeys = useAppStore((s) => s.mobileTabKeys);
  const setMobileTabKey = useAppStore((s) => s.setMobileTabKey);
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);

  function reset() {
    // 重置：除 cards 外全开
    OPTIONAL_VIEWS.forEach((v) => {
      const shouldOn = v !== "cards";
      const isOn = enabledViews.has(v);
      if (shouldOn !== isOn) {
        toggleEnabledView(v);
      }
    });
    message.success("已重置为默认");
  }

  const enabledCount = OPTIONAL_VIEWS.filter((v) =>
    enabledViews.has(v),
  ).length;

  return (
    <div className="text-slate-800">
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between border-b border-slate-200 bg-white px-2">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-slate-700" />
        </button>
        <h1 className="text-base font-semibold">功能模块</h1>
        <button
          onClick={reset}
          className="px-2 text-sm text-slate-500 active:text-slate-700"
        >
          重置
        </button>
      </header>

      {/* 信息横幅 */}
      <div className="flex items-start gap-2 border-b border-blue-200 bg-blue-50 px-4 py-3">
        <Info size={16} className="mt-0.5 shrink-0 text-blue-600" />
        <p className="text-xs leading-relaxed text-blue-800">
          关闭后入口隐藏，但<strong>数据保留</strong>，重新开启即可恢复。
          <br />
          核心模块（主页 / 笔记 / 搜索 / 回收站 / 关于）不可关闭。
        </p>
      </div>

      <div className="bg-slate-50 pb-12">
        {/* 底部 Tab 配置（移动端独有） */}
        <SectionLabel text={`底部 Tab · 已选 ${mobileTabKeys.length}/4 + 我的`} />
        <div className="mx-4 mb-2 rounded-2xl bg-white p-3">
          <div className="mb-2 text-[11px] leading-relaxed text-slate-500">
            点击任意格子可换成其它功能。「我的」永远占最后一格，无需配置。
          </div>
          <div className="grid grid-cols-5 gap-2">
            {mobileTabKeys.map((k, idx) => (
              <button
                key={`${k}-${idx}`}
                onClick={() => setPickerSlot(idx)}
                className="flex flex-col items-center gap-1 rounded-xl border-2 border-[var(--kb-border)] bg-[var(--kb-primary-light)] py-2.5 active:scale-95 transition-transform"
              >
                {TAB_ICONS[k]}
                <span className="text-[10px] font-medium text-[var(--kb-primary)]">
                  {MOBILE_TAB_REGISTRY[k].label}
                </span>
              </button>
            ))}
            <div className="flex flex-col items-center gap-1 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 py-2.5">
              <User size={20} className="text-slate-400" />
              <span className="text-[10px] text-slate-400">我的（固定）</span>
            </div>
          </div>
        </div>

        {/* 核心模块 */}
        <SectionLabel
          icon={<Lock size={12} />}
          text="核心模块 · 始终启用"
        />
        <ListGroup>
          {CORE_MODULES.map((m) => (
            <CoreRow key={m.label} {...m} />
          ))}
        </ListGroup>

        {/* 可选模块 */}
        <SectionLabel
          icon={<SlidersHorizontal size={12} />}
          text={`可选模块 · ${OPTIONAL_VIEWS.length} 个，已开启 ${enabledCount}`}
        />
        <ListGroup>
          {OPTIONS.map((o) => (
            <OptionRow
              key={o.view}
              meta={o}
              checked={enabledViews.has(o.view)}
              onChange={() => toggleEnabledView(o.view)}
            />
          ))}
        </ListGroup>

        {/* 主页 Dashboard 显示 */}
        <SectionLabel
          icon={<HomeIcon size={12} />}
          text="主页 Dashboard 显示 · 移动端独有"
        />
        <ListGroup>
          {DASH_ITEM_META.map((m) => (
            <DashItemRow
              key={m.key}
              meta={m}
              checked={mobileDashItems.has(m.key)}
              onChange={() => toggleMobileDashItem(m.key)}
            />
          ))}
        </ListGroup>

        <div className="px-4 py-4 text-center text-[11px] text-slate-400">
          💾 配置写入 app_config · 自动同步到桌面端
        </div>
      </div>

      {/* Tab 选择 Drawer */}
      <Drawer
        title={`选择 Tab（第 ${(pickerSlot ?? 0) + 1} 格）`}
        placement="bottom"
        height={Math.min(MOBILE_TAB_KEYS.length * 60 + 80, 560)}
        open={pickerSlot !== null}
        onClose={() => setPickerSlot(null)}
      >
        <div className="grid grid-cols-3 gap-2">
          {MOBILE_TAB_KEYS.map((k) => {
            const meta = MOBILE_TAB_REGISTRY[k];
            const inUse = mobileTabKeys.includes(k);
            const inOtherSlot =
              inUse &&
              pickerSlot !== null &&
              mobileTabKeys[pickerSlot] !== k;
            return (
              <button
                key={k}
                onClick={() => {
                  if (pickerSlot !== null) {
                    setMobileTabKey(pickerSlot, k);
                    setPickerSlot(null);
                    message.success(`已设置第 ${pickerSlot + 1} 格为「${meta.label}」`);
                  }
                }}
                className={`flex flex-col items-center gap-1 rounded-xl py-3 ${
                  pickerSlot !== null && mobileTabKeys[pickerSlot] === k
                    ? "border-2 border-[var(--kb-primary)] bg-[var(--kb-primary-light)]"
                    : inOtherSlot
                      ? "border border-amber-200 bg-amber-50"
                      : "border border-slate-100 bg-white"
                } active:scale-95 transition-transform`}
              >
                {TAB_ICONS[k]}
                <span className="text-[11px] font-medium text-slate-700">
                  {meta.label}
                </span>
                {inOtherSlot && (
                  <span className="text-[9px] text-amber-600">已选 · 会自动换位</span>
                )}
              </button>
            );
          })}
        </div>
      </Drawer>
    </div>
  );
}

function SectionLabel({
  icon,
  text,
}: {
  icon?: React.ReactNode;
  text: string;
}) {
  return (
    <div className="flex items-center gap-1 px-4 pt-3 pb-1 text-xs font-medium text-slate-400">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function ListGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-4 mb-2 divide-y divide-slate-100 rounded-2xl bg-white">
      {children}
    </div>
  );
}

function CoreRow({
  icon,
  label,
  desc,
}: {
  icon: React.ReactNode;
  label: string;
  desc: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 opacity-90">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-700">{label}</div>
        <div className="text-[11px] text-slate-400">{desc}</div>
      </div>
      <Switch checked disabled />
    </div>
  );
}

function DashItemRow({
  meta,
  checked,
  onChange,
}: {
  meta: DashItemMeta;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="shrink-0">{meta.icon}</div>
      <span className="flex-1 text-sm text-slate-700">{meta.label}</span>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

function OptionRow({
  meta,
  checked,
  onChange,
}: {
  meta: OptionMeta;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 ${
        meta.defaultOff && !checked ? "bg-amber-50/40" : ""
      }`}
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${meta.iconBg}`}
      >
        {meta.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
          {meta.label}
          {meta.defaultOff && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700">
              默认关
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-500">{meta.desc}</div>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}
