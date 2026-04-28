import { useEffect, useMemo, useState } from "react";
import {
  Card,
  Typography,
  Table,
  message,
  Tag,
  Button,
  Space,
  Modal,
  Form,
  Input,
  Select,
  AutoComplete,
  Popconfirm,
  Progress,
  Alert,
  List,
  Switch,
  Radio,
} from "antd";
import { SyncOutlined, PlusOutlined, CheckCircleFilled, CheckCircleOutlined } from "@ant-design/icons";
import { Trash2, Pencil, FolderInput, FolderOutput, LayoutTemplate, Power, ExternalLink, Type, Zap } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";
import { TimePicker } from "antd";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useLocation } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import type { Update } from "@tauri-apps/plugin-updater";
import type { AiModel, AiModelInput, ImportResult, ImportProgress, ImportConflictPolicy, ScannedFile, ExportResult, ExportProgress, NoteTemplate, NoteTemplateInput } from "@/types";
import { systemApi, updaterApi, aiModelApi, importApi, exportApi, folderApi, templateApi, pdfApi, sourceFileApi, autostartApi, configApi } from "@/lib/api";
import {
  useAppStore,
  EDITOR_FONT_LABELS,
  EDITOR_FONT_STACKS,
  EDITOR_FONT_SIZE_OPTIONS,
  EDITOR_LINE_HEIGHT_OPTIONS,
  type EditorFontFamily,
} from "@/store";
import { importWordFiles } from "@/lib/wordImport";
import { Checkbox } from "antd";
import { UpdateModal } from "@/components/ui/UpdateModal";
import { RecommendCards } from "@/components/ui/RecommendCards";
import { SyncTabs } from "@/components/settings/SyncTabs";
import { DataDirSection } from "@/components/settings/DataDirSection";
import OrphanAssetsPanel from "@/components/settings/OrphanAssetsPanel";
import { HiddenPinSection } from "@/components/hidden/HiddenPinSection";
import { ShortcutsSection } from "@/components/settings/ShortcutsSection";
import { TiptapEditor } from "@/components/editor";
import type { Folder } from "@/types";

const { Title, Text } = Typography;

/**
 * 把回调推迟到浏览器空闲时段。
 * Why: 设置页 mount 时一次性发起 6+ 个 invoke 会跟路由 commit / 编辑器 destroy
 *      抢主线程，造成"点击设置时卡一下"。把这些非首屏关键的 IPC 推到 idle 阶段，
 *      用户先看到骨架 UI，数据陆续填充。
 * 兼容：Webview2 / WKWebView 都支持 requestIdleCallback；不支持时回退到 setTimeout(0)。
 */
type IdleHandle = { kind: "idle"; id: number } | { kind: "timeout"; id: ReturnType<typeof setTimeout> };
type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};
function scheduleIdle(fn: () => void): IdleHandle {
  const w = window as IdleWindow;
  if (typeof w.requestIdleCallback === "function") {
    return { kind: "idle", id: w.requestIdleCallback(fn, { timeout: 500 }) };
  }
  return { kind: "timeout", id: setTimeout(fn, 0) };
}
function cancelIdle(handle: IdleHandle): void {
  const w = window as IdleWindow;
  if (handle.kind === "idle" && typeof w.cancelIdleCallback === "function") {
    w.cancelIdleCallback(handle.id);
  } else if (handle.kind === "timeout") {
    clearTimeout(handle.id);
  }
}

/** 作者社区信息 */
const BILIBILI_URL = "https://space.bilibili.com/520725002";
const BILIBILI_TUTORIAL_URL = "https://www.bilibili.com/video/BV1xvosBREbr";
const ZSXQ_NAME = "后端转AI实战派";
const ZSXQ_ID = "91839984";

/** 模型提供商选项
 *
 * T-012：除 Ollama 外其他都按 OpenAI 兼容协议处理。这里把"标签"按用途分组，
 * 用户选哪个值都不影响后端协议；选中时只是自动预填 baseUrl + 模型 ID。
 *
 * `lmstudio` / `minimax` / `siliconflow` / `custom` 是新增预设，与已有
 * `openai` / `claude` / `deepseek` / `zhipu` 同走 OpenAI 兼容协议。
 */
const PROVIDERS = [
  // 本地模型
  { value: "ollama", label: "Ollama (本地)" },
  { value: "lmstudio", label: "LM Studio (本地 OpenAI 兼容)" },
  // 云端预设
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "zhipu", label: "智谱 AI (GLM)" },
  { value: "claude", label: "Claude (经 OpenRouter 等代理)" },
  { value: "minimax", label: "Minimax" },
  { value: "siliconflow", label: "SiliconFlow (硅基流动)" },
  // 完全自定义
  { value: "custom", label: "自定义 (OpenAI 兼容)" },
];

/** 提供商默认 API 地址
 * 后端会智能拼接 `/chat/completions`，所以 URL 末尾可带也可不带 `/v1` / `/paas/v4` 之类版本段。
 */
const DEFAULT_URLS: Record<string, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234/v1",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  claude: "https://openrouter.ai/api/v1",
  minimax: "https://api.minimax.chat/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  custom: "",
};

/** 各 provider 的模型标识占位提示 */
const MODEL_ID_PLACEHOLDERS: Record<string, string> = {
  ollama: "如: qwen2.5:7b / llama3.2:3b",
  lmstudio: "看 LM Studio 模型页右上角 Model 标识",
  openai: "如: gpt-4o-mini / gpt-4o",
  deepseek: "如: deepseek-chat / deepseek-reasoner",
  zhipu: "如: glm-4-plus / glm-4-flash / glm-4-air",
  claude: "如: anthropic/claude-sonnet-4.6 (经 OpenRouter 等兼容代理)",
  minimax: "如: abab6.5s-chat / MiniMax-M1",
  siliconflow: "如: Qwen/Qwen2.5-72B-Instruct / deepseek-ai/DeepSeek-V3",
  custom: "填你目标服务的模型标识",
};

/** 各 provider 的常用模型预置（下拉联想；也可手动输入任意值） */
const MODEL_PRESETS: Record<string, { value: string; label: string }[]> = {
  ollama: [
    // ── Qwen3 系列（2025 通义千问最新） ──
    { value: "qwen3:4b", label: "qwen3:4b (千问3 / 入门)" },
    { value: "qwen3:8b", label: "qwen3:8b (千问3 / 推荐)" },
    { value: "qwen3:14b", label: "qwen3:14b (千问3 / 进阶)" },
    { value: "qwen3:32b", label: "qwen3:32b (千问3 / 旗舰)" },
    { value: "qwen3:30b-a3b", label: "qwen3:30b-a3b (千问3 / MoE)" },
    // ── QwQ 推理 ──
    { value: "qwq:32b", label: "qwq:32b (千问推理 / o1 同级)" },
    // ── Qwen2.5 主力尺寸 ──
    { value: "qwen2.5:7b", label: "qwen2.5:7b" },
    { value: "qwen2.5:14b", label: "qwen2.5:14b" },
    { value: "qwen2.5:32b", label: "qwen2.5:32b" },
    { value: "qwen2.5:72b", label: "qwen2.5:72b" },
    // ── Qwen2.5-Coder（编程场景） ──
    { value: "qwen2.5-coder:7b", label: "qwen2.5-coder:7b (编程)" },
    { value: "qwen2.5-coder:14b", label: "qwen2.5-coder:14b (编程)" },
    { value: "qwen2.5-coder:32b", label: "qwen2.5-coder:32b (编程)" },
    // ── 其他主流本地模型 ──
    { value: "llama3.1:8b", label: "llama3.1:8b" },
    { value: "gemma2:9b", label: "gemma2:9b" },
  ],
  openai: [
    { value: "gpt-4o", label: "gpt-4o" },
    { value: "gpt-4o-mini", label: "gpt-4o-mini" },
    { value: "gpt-4-turbo", label: "gpt-4-turbo" },
    { value: "gpt-3.5-turbo", label: "gpt-3.5-turbo" },
    { value: "o1-mini", label: "o1-mini" },
    { value: "o1-preview", label: "o1-preview" },
  ],
  deepseek: [
    { value: "deepseek-chat", label: "deepseek-chat (V3 通用)" },
    { value: "deepseek-reasoner", label: "deepseek-reasoner (推理)" },
  ],
  zhipu: [
    { value: "glm-4-plus", label: "glm-4-plus (旗舰)" },
    { value: "glm-4-0520", label: "glm-4-0520" },
    { value: "glm-4-air", label: "glm-4-air (轻量)" },
    { value: "glm-4-airx", label: "glm-4-airx" },
    { value: "glm-4-flash", label: "glm-4-flash (免费)" },
    { value: "glm-4-long", label: "glm-4-long (长上下文)" },
  ],
  claude: [
    { value: "anthropic/claude-sonnet-4.6", label: "anthropic/claude-sonnet-4.6 (OpenRouter)" },
    { value: "anthropic/claude-opus-4.7", label: "anthropic/claude-opus-4.7 (OpenRouter)" },
    { value: "claude-sonnet-4-5-20250929", label: "claude-sonnet-4-5-20250929" },
    { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5-20251001" },
  ],
  // T-012 新增 provider 的模型预设
  lmstudio: [],
  minimax: [
    { value: "abab6.5s-chat", label: "abab6.5s-chat (高速)" },
    { value: "abab6.5-chat", label: "abab6.5-chat" },
    { value: "MiniMax-M1", label: "MiniMax-M1" },
  ],
  siliconflow: [
    { value: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen/Qwen2.5-72B-Instruct" },
    { value: "Qwen/Qwen2.5-Coder-32B-Instruct", label: "Qwen/Qwen2.5-Coder-32B-Instruct" },
    { value: "deepseek-ai/DeepSeek-V3", label: "deepseek-ai/DeepSeek-V3" },
    { value: "deepseek-ai/DeepSeek-R1", label: "deepseek-ai/DeepSeek-R1 (推理)" },
    { value: "Pro/THUDM/glm-4-9b-chat", label: "GLM-4-9B-Chat (Pro)" },
  ],
  custom: [],
};

/**
 * 设置页左侧锚点导航。
 *
 * - 点击 → smooth scroll 到对应 section（用 id 锚定）
 * - 当前激活项用 IntersectionObserver 检测：哪个 section 进入视口顶部 30% 区域，
 *   就把对应导航项标灰底，实现"滚动同步高亮"
 * - sticky top: 16，跟随主区滚动；不依赖 Antd Anchor，省一份组件依赖
 */
const SETTINGS_NAV_ITEMS: { id: string; label: string }[] = [
  { id: "settings-update", label: "软件更新" },
  { id: "settings-startup", label: "启动设置" },
  { id: "settings-hidden-pin", label: "隐藏笔记 PIN" },
  { id: "settings-shortcuts", label: "全局快捷键" },
  { id: "settings-editor", label: "编辑器外观" },
  { id: "settings-task-reminder", label: "待办提醒" },
  { id: "settings-import", label: "导入笔记" },
  { id: "settings-export", label: "导出 Markdown" },
  { id: "settings-ai-models", label: "AI 模型" },
  { id: "settings-templates", label: "模板管理" },
  { id: "settings-data-dir", label: "数据目录" },
  { id: "settings-sync", label: "同步备份" },
  { id: "settings-orphan-assets", label: "孤儿素材清理" },
  { id: "settings-community", label: "作者 & 社区" },
];

function SettingsAnchorNav() {
  const [activeId, setActiveId] = useState<string>(SETTINGS_NAV_ITEMS[0].id);

  // 滚动监听：哪个 section 进入视口"顶部 1/3"区域 → 高亮对应导航项
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        // 取所有当前可见 entries 里 boundingClientRect.top 最小（最靠近顶部）的一个
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "0px 0px -66% 0px", threshold: 0 },
    );
    SETTINGS_NAV_ITEMS.forEach((item) => {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  function jumpTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <aside className="anchor-page-nav">
      <ul>
        {SETTINGS_NAV_ITEMS.map((item) => (
          <li
            key={item.id}
            data-active={activeId === item.id || undefined}
            onClick={() => jumpTo(item.id)}
          >
            {item.label}
          </li>
        ))}
      </ul>
    </aside>
  );
}

export default function SettingsPage() {
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("0.1.0");

  // AI 模型状态
  const [models, setModels] = useState<AiModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<AiModel | null>(null);
  const [form] = Form.useForm<AiModelInput>();
  // 表单内 provider 变化 → 动态占位
  const watchedProvider = Form.useWatch("provider", form) || "ollama";
  /** 行内"测试"按钮 loading 锁：值为正在测试的 model.id；Modal 内的测试按钮锁用 -1 */
  const [testingModelId, setTestingModelId] = useState<number | null>(null);

  // 导入状态
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [importFolderId, setImportFolderId] = useState<number | undefined>(undefined);
  // 扫描预览状态
  const [scannedFiles, setScannedFiles] = useState<ScannedFile[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  /** 扫描时用户选的根目录（后端用来按相对路径重建文件夹树） */
  const [scanRootPath, setScanRootPath] = useState<string | null>(null);
  /** 是否在目标下多套一层"源根目录名"作为导入批次根 */
  const [preserveRoot, setPreserveRoot] = useState(true);
  /** 冲突策略：默认跳过已导入过的文件；用户可切到"创建副本" */
  const [conflictPolicy, setConflictPolicy] = useState<ImportConflictPolicy>("skip");

  /** 扫描结果三桶统计（展示给用户看哪些是已有的） */
  const matchStats = useMemo(() => {
    let news = 0, paths = 0, fuzzies = 0;
    for (const f of scannedFiles) {
      if (f.match_kind === "path") paths++;
      else if (f.match_kind === "fuzzy") fuzzies++;
      else news++;
    }
    return { news, paths, fuzzies, conflicts: paths + fuzzies };
  }, [scannedFiles]);

  // 导出状态
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportFolderId, setExportFolderId] = useState<number | undefined>(undefined);

  // 模板管理状态
  const [tplList, setTplList] = useState<NoteTemplate[]>([]);
  const [tplLoading, setTplLoading] = useState(false);
  const [tplModalOpen, setTplModalOpen] = useState(false);
  const [editingTpl, setEditingTpl] = useState<NoteTemplate | null>(null);
  const [tplForm] = Form.useForm<NoteTemplateInput>();

  // 启动设置
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(false);
  const [startMinimizedLoading, setStartMinimizedLoading] = useState(false);
  const [multiInstanceEnabled, setMultiInstanceEnabled] = useState(false);
  const [multiInstanceLoading, setMultiInstanceLoading] = useState(false);
  // 关闭按钮行为：ask=每次询问 / minimize=最小化到托盘 / exit=直接退出
  const [closeAction, setCloseAction] = useState<"ask" | "minimize" | "exit">(
    "ask",
  );

  // 全天任务提醒基准时刻（HH:mm，默认 09:00）
  const [allDayReminderTime, setAllDayReminderTime] = useState<string>("09:00");

  async function loadModels() {
    setModelsLoading(true);
    try {
      const list = await aiModelApi.list();
      setModels(list);
    } catch (e) {
      message.error(`加载模型失败: ${e}`);
    } finally {
      setModelsLoading(false);
    }
  }

  async function handleCheckUpdate() {
    setChecking(true);
    try {
      const result = await updaterApi.checkUpdate();
      if (result) {
        setUpdate(result);
        setUpdateModalOpen(true);
      } else {
        message.success("当前已是最新版本");
      }
    } catch (e) {
      message.warning(`检查更新失败: ${String(e)}`);
    } finally {
      setChecking(false);
    }
  }

  async function loadFolders() {
    try {
      const list = await folderApi.list();
      setFolders(list);
    } catch {
      // 静默失败
    }
  }

  async function loadTemplates() {
    setTplLoading(true);
    try {
      const list = await templateApi.list();
      setTplList(list);
    } catch (e) {
      message.error(`加载模板失败: ${e}`);
    } finally {
      setTplLoading(false);
    }
  }

  function openAddTemplate() {
    setEditingTpl(null);
    tplForm.resetFields();
    setTplModalOpen(true);
  }

  function openEditTemplate(tpl: NoteTemplate) {
    setEditingTpl(tpl);
    tplForm.setFieldsValue({
      name: tpl.name,
      description: tpl.description,
      content: tpl.content,
    });
    setTplModalOpen(true);
  }

  async function handleTemplateSave() {
    try {
      const values = await tplForm.validateFields();
      if (editingTpl) {
        await templateApi.update(editingTpl.id, values);
        message.success("模板已更新");
      } else {
        await templateApi.create(values);
        message.success("模板已创建");
      }
      setTplModalOpen(false);
      loadTemplates();
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(`保存失败: ${e}`);
    }
  }

  async function handleDeleteTemplate(id: number) {
    try {
      await templateApi.delete(id);
      message.success("模板已删除");
      loadTemplates();
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }

  // 编辑器字体偏好（实时受控）
  const editorFontFamily = useAppStore((s) => s.editorFontFamily);
  const editorFontSize = useAppStore((s) => s.editorFontSize);
  const editorLineHeight = useAppStore((s) => s.editorLineHeight);
  const setEditorFontFamily = useAppStore((s) => s.setEditorFontFamily);
  const setEditorFontSize = useAppStore((s) => s.setEditorFontSize);
  const setEditorLineHeight = useAppStore((s) => s.setEditorLineHeight);
  const resetEditorTypography = useAppStore((s) => s.resetEditorTypography);

  // 订阅全局 foldersRefreshTick：Sidebar 修改文件夹后自动刷新设置页的文件夹选项
  // 走 idle defer：从笔记页切到设置页瞬间，路由 commit + 编辑器 destroy 已经吃掉一帧时间，
  // 这里再立即 invoke 会让首屏感知卡顿；推迟到 idle 让 UI 先出现
  const foldersRefreshTick = useAppStore((s) => s.foldersRefreshTick);
  useEffect(() => {
    const handle = scheduleIdle(() => {
      loadFolders();
    });
    return () => cancelIdle(handle);
  }, [foldersRefreshTick]);

  // 从其他页面带 state.scrollTo 跳转过来时，滚到目标区块并短暂高亮
  const location = useLocation();
  useEffect(() => {
    const target = (location.state as { scrollTo?: string } | null)?.scrollTo;
    if (!target) return;
    const el = document.getElementById(target);
    if (!el) return;
    // 等下一帧再滚，避免内容尚未铺满高度时计算偏差
    const raf = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("settings-target-flash");
    });
    const t = setTimeout(() => el.classList.remove("settings-target-flash"), 1800);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [location.state]);

  useEffect(() => {
    // 把 6 个并发 invoke 推迟到 idle：从笔记页切过来时主线程要先吃掉一帧的
    // 路由 commit + Tiptap destroy，立即并发 IPC 会让首屏明显卡顿。
    // idle 后再跑，用户视觉上"先看到 UI、再陆续填充数据"。
    const handle = scheduleIdle(() => {
      loadModels();
      // loadFolders 已由 foldersRefreshTick useEffect 在首次挂载时触发
      loadTemplates();
      systemApi
        .getSystemInfo()
        .then((info) => setAppVersion(info.appVersion))
        .catch(() => {});
      // 读取启动设置：autostart 状态来自系统注册项，start_minimized 存在 app_config 表
      autostartApi.isEnabled().then(setAutostartEnabled).catch(() => {});
      configApi
        .get("start_minimized")
        .then((v) => setStartMinimized(v === "1"))
        .catch(() => {});
      // 多开开关存在 framework_app_data_dir 下的 flag 文件，启动早期就要读得到
      systemApi
        .getMultiInstanceEnabled()
        .then(setMultiInstanceEnabled)
        .catch(() => {});
      configApi
        .get("window.close_action")
        .then((v) => {
          if (v === "minimize" || v === "exit" || v === "ask") {
            setCloseAction(v);
          }
        })
        .catch(() => {});
      configApi
        .get("all_day_reminder_time")
        .then((v) => {
          if (v && /^\d{2}:\d{2}(:\d{2})?$/.test(v)) {
            setAllDayReminderTime(v.slice(0, 5));
          }
        })
        .catch(() => {});
    });
    return () => cancelIdle(handle);
  }, []);

  async function handleAllDayReminderTimeChange(next: Dayjs | null) {
    const value = next ? next.format("HH:mm") : "09:00";
    try {
      await configApi.set("all_day_reminder_time", value);
      setAllDayReminderTime(value);
      message.success(`全天任务提醒时刻已设为 ${value}`);
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  }

  async function handleAutostartToggle(next: boolean) {
    setAutostartLoading(true);
    try {
      if (next) await autostartApi.enable();
      else await autostartApi.disable();
      setAutostartEnabled(next);
      message.success(next ? "已开启开机启动" : "已关闭开机启动");
    } catch (e) {
      message.error(`设置失败: ${e}`);
    } finally {
      setAutostartLoading(false);
    }
  }

  async function handleStartMinimizedToggle(next: boolean) {
    setStartMinimizedLoading(true);
    try {
      await configApi.set("start_minimized", next ? "1" : "0");
      setStartMinimized(next);
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setStartMinimizedLoading(false);
    }
  }

  async function handleMultiInstanceToggle(next: boolean) {
    setMultiInstanceLoading(true);
    try {
      await systemApi.setMultiInstanceEnabled(next);
      setMultiInstanceEnabled(next);
      message.info(
        next
          ? "已允许多开实例，下次启动生效"
          : "已禁止多开，下次再启动会唤起当前窗口",
      );
    } catch (e) {
      message.error(`设置失败: ${e}`);
    } finally {
      setMultiInstanceLoading(false);
    }
  }

  async function handleCloseActionChange(next: "ask" | "minimize" | "exit") {
    try {
      await configApi.set("window.close_action", next);
      setCloseAction(next);
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  }

  /** 扁平化文件夹树为选项列表 */
  function flattenFolders(list: Folder[], prefix = ""): { value: number; label: string }[] {
    const result: { value: number; label: string }[] = [];
    for (const f of list) {
      result.push({ value: f.id, label: prefix + f.name });
      if (f.children?.length) {
        result.push(...flattenFolders(f.children, prefix + f.name + " / "));
      }
    }
    return result;
  }

  async function handleImportPdfs() {
    const picked = await open({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    const hide = message.loading(`正在导入 ${paths.length} 个 PDF...`, 0);
    try {
      const results = await pdfApi.importPdfs(paths, importFolderId ?? null);
      const ok = results.filter((r) => r.noteId !== null);
      const fail = results.filter((r) => r.noteId === null);
      hide();
      if (ok.length > 0) message.success(`成功导入 ${ok.length} 个 PDF`);
      if (fail.length > 0) {
        Modal.warning({
          title: `${fail.length} 个 PDF 导入失败`,
          content: (
            <List
              size="small"
              dataSource={fail}
              renderItem={(r) => (
                <List.Item>
                  <Text type="danger" style={{ fontSize: 12 }}>
                    {r.sourcePath.split(/[\\/]/).pop()}: {r.error}
                  </Text>
                </List.Item>
              )}
            />
          ),
        });
      }
    } catch (e) {
      hide();
      message.error(`导入失败: ${e}`);
    }
  }

  async function handleImportWord() {
    const converter = await sourceFileApi.getConverterStatus().catch(() => "none" as const);
    const exts = converter === "none" ? ["docx"] : ["docx", "doc"];
    const picked = await open({
      multiple: true,
      filters: [{ name: "Word", extensions: exts }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    const hide = message.loading(`正在导入 ${paths.length} 个 Word...`, 0);
    try {
      const results = await importWordFiles(paths, importFolderId ?? null);
      const ok = results.filter((r) => r.noteId !== null);
      const fail = results.filter((r) => r.noteId === null);
      hide();
      if (ok.length > 0) message.success(`成功导入 ${ok.length} 个 Word`);
      if (fail.length > 0) {
        Modal.warning({
          title: `${fail.length} 个 Word 导入失败`,
          content: (
            <List
              size="small"
              dataSource={fail}
              renderItem={(r) => (
                <List.Item>
                  <Text type="danger" style={{ fontSize: 12 }}>
                    {r.sourcePath.split(/[\\/]/).pop()}: {r.error}
                  </Text>
                </List.Item>
              )}
            />
          ),
        });
      }
    } catch (e) {
      hide();
      message.error(`导入失败: ${e}`);
    }
  }

  async function handleScanFolder() {
    const selected = await open({ directory: true, title: "选择 Markdown 文件夹" });
    if (!selected) return;

    setScanning(true);
    setImportResult(null);
    try {
      const files = await importApi.scan(selected as string);
      if (files.length === 0) {
        message.info("该文件夹下没有 .md 文件");
        return;
      }
      setScannedFiles(files);
      setSelectedPaths(new Set(files.map((f) => f.path)));
      setScanRootPath(selected as string);
      setPreserveRoot(true);
      setScanModalOpen(true);
    } catch (e) {
      message.error(`扫描失败: ${e}`);
    } finally {
      setScanning(false);
    }
  }

  async function handleConfirmImport() {
    if (selectedPaths.size === 0) {
      message.warning("请至少选择一个文件");
      return;
    }

    setScanModalOpen(false);
    setImporting(true);
    setImportProgress(null);
    setImportResult(null);

    const unlistenProgress = await listen<ImportProgress>("import:progress", (e) => {
      setImportProgress(e.payload);
    });
    const unlistenDone = await listen<ImportResult>("import:done", (e) => {
      setImportResult(e.payload);
    });

    try {
      const paths = Array.from(selectedPaths);
      const result = await importApi.importSelected(
        paths,
        importFolderId ?? null,
        scanRootPath,
        preserveRoot,
        conflictPolicy,
      );
      setImportResult(result);
      if (result.imported > 0 || result.duplicated > 0) {
        const parts: string[] = [];
        if (result.imported > 0) parts.push(`导入 ${result.imported} 篇`);
        if (result.duplicated > 0) parts.push(`副本 ${result.duplicated} 篇`);
        if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 篇`);
        message.success(parts.join("，"));
        // 触发左侧笔记树 + 文件夹树刷新（导入过程会按层级新建文件夹）
        useAppStore.getState().bumpNotesRefresh();
        useAppStore.getState().bumpFoldersRefresh();
      }
    } catch (e) {
      message.error(`导入失败: ${e}`);
    } finally {
      setImporting(false);
      unlistenProgress();
      unlistenDone();
    }
  }

  async function handleExport() {
    const selected = await open({ directory: true, title: "选择导出目录" });
    if (!selected) return;

    // 导出前明确告知会包一层目录，避免用户找不到结果
    const confirmed = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: "确认导出",
        content: (
          <div>
            <p style={{ marginBottom: 8 }}>将在以下父目录中创建一个新的导出文件夹：</p>
            <p style={{ fontFamily: "monospace", fontSize: 12, marginBottom: 8 }}>
              {selected as string}
            </p>
            <p style={{ marginBottom: 4 }}>结构如下：</p>
            <pre style={{ fontSize: 12, background: "var(--ant-color-fill-tertiary)", padding: 8, borderRadius: 4, margin: 0 }}>
{`📁 知识库导出_YYYYMMDD_HHmmss/
  ├─ <文件夹>/
  │   ├─ <笔记>.md
  │   └─ <笔记>.assets/   (图片+附件)
  └─ ...`}
            </pre>
          </div>
        ),
        okText: "开始导出",
        cancelText: "取消",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!confirmed) return;

    setExporting(true);
    setExportProgress(null);
    setExportResult(null);

    const unlistenProgress = await listen<ExportProgress>("export:progress", (e) => {
      setExportProgress(e.payload);
    });
    const unlistenDone = await listen<ExportResult>("export:done", (e) => {
      setExportResult(e.payload);
    });

    try {
      const result = await exportApi.exportNotes(selected as string, exportFolderId ?? null);
      setExportResult(result);
      if (result.exported > 0) {
        message.success(`成功导出 ${result.exported} 篇笔记`);
        // 直接在资源管理器/Finder 高亮选中刚创建的导出目录
        try {
          await revealItemInDir(result.root_dir);
        } catch {
          // reveal 失败不阻塞导出流程
        }
      }
    } catch (e) {
      message.error(`导出失败: ${e}`);
    } finally {
      setExporting(false);
      unlistenProgress();
      unlistenDone();
    }
  }

  function toggleFileSelection(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedPaths.size === scannedFiles.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(scannedFiles.map((f) => f.path)));
    }
  }

  function openAddModel() {
    setEditingModel(null);
    form.resetFields();
    form.setFieldsValue({ provider: "ollama", api_url: DEFAULT_URLS.ollama });
    setModelModalOpen(true);
  }

  function openEditModel(model: AiModel) {
    setEditingModel(model);
    form.setFieldsValue({
      name: model.name,
      provider: model.provider,
      api_url: model.api_url,
      api_key: model.api_key,
      model_id: model.model_id,
      max_context: model.max_context,
    });
    setModelModalOpen(true);
  }

  async function handleModelSave() {
    try {
      const values = await form.validateFields();
      // Input type="number" 提交的是字符串，规范化为整数；缺省时给 32000 兜底
      const max_context_num = values.max_context
        ? parseInt(String(values.max_context), 10)
        : 32000;
      const payload = {
        ...values,
        max_context: Number.isFinite(max_context_num) ? max_context_num : 32000,
      };
      if (editingModel) {
        await aiModelApi.update(editingModel.id, payload);
        message.success("模型已更新");
      } else {
        await aiModelApi.create(payload);
        message.success("模型已添加");
      }
      setModelModalOpen(false);
      loadModels();
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(`保存失败: ${e}`);
    }
  }

  async function handleDeleteModel(id: number) {
    try {
      await aiModelApi.delete(id);
      message.success("模型已删除");
      loadModels();
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }

  async function handleSetDefault(id: number) {
    try {
      await aiModelApi.setDefault(id);
      message.success("已设为默认模型");
      loadModels();
    } catch (e) {
      message.error(`设置失败: ${e}`);
    }
  }

  /**
   * 跑一次模型连通性测试。
   *
   * 两个入口共用：
   * - 表格行内"测试"按钮：传 record（已保存模型，rowId = record.id）
   * - Modal 里"测试连接"按钮：传当前表单值（未保存，rowId = -1 占位）
   *
   * 失败信息行数往往较多（含 hint + 详情），用 `Modal.error` 多行展示，
   * 与 ai/index.tsx 里 send 失败的处理保持一致。
   */
  async function runModelTest(input: AiModelInput, rowId: number, label: string) {
    setTestingModelId(rowId);
    try {
      const result = await aiModelApi.test(input);
      const tail = result.sample ? ` · 样本: "${result.sample}"` : "";
      message.success(`✓ [${label}] 连接成功 · 延迟 ${result.latency_ms}ms${tail}`);
    } catch (e) {
      Modal.error({
        title: `[${label}] 测试失败`,
        width: 560,
        content: (
          <pre className="whitespace-pre-wrap text-xs leading-relaxed m-0">
            {String(e)}
          </pre>
        ),
      });
    } finally {
      setTestingModelId(null);
    }
  }

  function handleTestRow(record: AiModel) {
    runModelTest(
      {
        name: record.name,
        provider: record.provider,
        api_url: record.api_url,
        api_key: record.api_key,
        model_id: record.model_id,
        max_context: record.max_context,
      },
      record.id,
      record.name,
    );
  }

  async function handleTestForm() {
    try {
      const values = await form.validateFields();
      const max_context_num = values.max_context
        ? parseInt(String(values.max_context), 10)
        : 32000;
      const payload: AiModelInput = {
        ...values,
        max_context: Number.isFinite(max_context_num) ? max_context_num : 32000,
      };
      await runModelTest(payload, -1, payload.name || "当前表单");
    } catch (e) {
      // antd validateFields 的字段错误自带高亮，无需再弹
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(`测试失败: ${e}`);
    }
  }

  function handleProviderChange(provider: string) {
    form.setFieldValue("api_url", DEFAULT_URLS[provider] || "");
  }

  const modelColumns = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (text: string, record: AiModel) => (
        <span className="flex items-center gap-1.5">
          {text}
          {record.is_default && (
            <Tag color="gold" className="ml-1">
              默认
            </Tag>
          )}
        </span>
      ),
    },
    {
      title: "提供商",
      dataIndex: "provider",
      key: "provider",
      render: (text: string) => {
        const label = PROVIDERS.find((p) => p.value === text)?.label || text;
        return <Tag>{label}</Tag>;
      },
    },
    {
      title: "模型 ID",
      dataIndex: "model_id",
      key: "model_id",
      render: (text: string) => (
        <code className="text-xs px-1.5 py-0.5 rounded bg-gray-100">{text}</code>
      ),
    },
    {
      title: "操作",
      key: "action",
      width: 200,
      render: (_: unknown, record: AiModel) => (
        <Space size="small">
          <Button
            type="text"
            size="small"
            icon={<Zap size={14} />}
            loading={testingModelId === record.id}
            disabled={testingModelId !== null && testingModelId !== record.id}
            onClick={() => handleTestRow(record)}
            title="测试连通性"
          />
          <Button
            type="text"
            size="small"
            icon={
              record.is_default ? (
                <CheckCircleFilled style={{ color: "#52c41a" }} />
              ) : (
                <CheckCircleOutlined />
              )
            }
            disabled={record.is_default}
            onClick={() => handleSetDefault(record.id)}
            title={record.is_default ? "当前默认模型" : "设为默认"}
          />
          <Button
            type="text"
            size="small"
            icon={<Pencil size={14} />}
            onClick={() => openEditModel(record)}
          />
          <Popconfirm
            title="确认删除此模型？"
            onConfirm={() => handleDeleteModel(record.id)}
          >
            <Button
              type="text"
              size="small"
              danger
              icon={<Trash2 size={14} />}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="anchor-page-layout">
      <SettingsAnchorNav />
      <div className="anchor-page-content" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <Title level={3}>设置</Title>
          <Text type="secondary">应用配置与 AI 模型管理</Text>
        </div>

      <Card id="settings-update" title="软件更新">
        <Space wrap>
          <Button
            icon={<SyncOutlined spin={checking} />}
            onClick={handleCheckUpdate}
            loading={checking}
          >
            检查更新
          </Button>
          <Text type="secondary">当前版本: {appVersion}</Text>
          <Button
            type="link"
            size="small"
            onClick={() => openUrl("https://kb.ruoyi.plus/")}
          >
            官网 https://kb.ruoyi.plus/
          </Button>
        </Space>
      </Card>

      <Card
        id="settings-startup"
        title={
          <span className="flex items-center gap-2">
            <Power size={16} />
            启动设置
          </span>
        }
      >
        <div className="flex items-center justify-between py-1">
          <div>
            <div>开机自动启动</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              登录系统后自动打开知识库，用于定时提醒等后台任务
            </Text>
          </div>
          <Switch
            checked={autostartEnabled}
            loading={autostartLoading}
            onChange={handleAutostartToggle}
          />
        </div>
        <div
          className="flex items-center justify-between py-1 mt-2"
          style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}
        >
          <div>
            <div>启动时最小化到托盘</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              仅在开机自动启动时生效；手动双击打开仍会正常显示窗口
            </Text>
          </div>
          <Switch
            checked={startMinimized}
            loading={startMinimizedLoading}
            disabled={!autostartEnabled}
            onChange={handleStartMinimizedToggle}
          />
        </div>
        <div
          className="flex items-center justify-between py-1 mt-2"
          style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}
        >
          <div>
            <div>允许多开实例</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              关闭时再次启动会唤起已有窗口（默认）；开启后每次启动都开新窗口，
              注意多个实例同时写同一份数据库可能导致冲突。下次启动生效。
            </Text>
          </div>
          <Switch
            checked={multiInstanceEnabled}
            loading={multiInstanceLoading}
            onChange={handleMultiInstanceToggle}
          />
        </div>
        <div
          className="py-1 mt-2"
          style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}
        >
          <div className="flex items-start justify-between gap-3">
            <div style={{ flex: 1 }}>
              <div>关闭窗口时</div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                点击右上角关闭按钮的行为。选"每次询问"会弹出三选一对话框。
              </Text>
            </div>
            <Radio.Group
              value={closeAction}
              onChange={(e) => handleCloseActionChange(e.target.value)}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="ask">每次询问</Radio.Button>
              <Radio.Button value="minimize">最小化到托盘</Radio.Button>
              <Radio.Button value="exit">直接退出</Radio.Button>
            </Radio.Group>
          </div>
        </div>
      </Card>

      <div id="settings-hidden-pin">
        <HiddenPinSection />
      </div>

      <div id="settings-shortcuts">
        <ShortcutsSection />
      </div>

      <Card
        id="settings-editor"
        title={
          <span className="flex items-center gap-2">
            <Type size={16} />
            编辑器外观
          </span>
        }
      >
        <div className="flex items-center justify-between py-1">
          <div>
            <div>正文字体</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              用户系统未装首选字体时自动 fallback 到下一项，不会出错
            </Text>
          </div>
          <Select
            value={editorFontFamily}
            onChange={(v) => setEditorFontFamily(v as EditorFontFamily)}
            style={{ width: 220 }}
            options={(Object.keys(EDITOR_FONT_LABELS) as EditorFontFamily[]).map(
              (key) => ({
                value: key,
                label: (
                  <span
                    style={{
                      fontFamily: EDITOR_FONT_STACKS[key] || undefined,
                    }}
                  >
                    {EDITOR_FONT_LABELS[key]}
                  </span>
                ),
              }),
            )}
          />
        </div>

        <div
          className="flex items-center justify-between py-1 mt-2"
          style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}
        >
          <div>
            <div>正文字号</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              标题、代码块按比例缩放
            </Text>
          </div>
          <Select
            value={editorFontSize}
            onChange={setEditorFontSize}
            style={{ width: 120 }}
            options={EDITOR_FONT_SIZE_OPTIONS.map((s) => ({
              value: s,
              label: `${s} px`,
            }))}
          />
        </div>

        <div
          className="flex items-center justify-between py-1 mt-2"
          style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}
        >
          <div>
            <div>行距</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              段落行间距倍数
            </Text>
          </div>
          <Select
            value={editorLineHeight}
            onChange={setEditorLineHeight}
            style={{ width: 120 }}
            options={EDITOR_LINE_HEIGHT_OPTIONS.map((h) => ({
              value: h,
              label: h.toFixed(1),
            }))}
          />
        </div>

        <div
          style={{
            borderTop: "1px solid #f0f0f0",
            marginTop: 12,
            paddingTop: 12,
          }}
        >
          <Text
            type="secondary"
            style={{ fontSize: 12, display: "block", marginBottom: 6 }}
          >
            预览
          </Text>
          <div
            style={{
              padding: "12px 14px",
              background: "var(--ant-color-fill-quaternary, #fafafa)",
              border: "1px solid var(--ant-color-border-secondary, #f0f0f0)",
              borderRadius: 6,
              fontFamily: EDITOR_FONT_STACKS[editorFontFamily] || undefined,
              fontSize: editorFontSize,
              lineHeight: editorLineHeight,
            }}
          >
            春有百花秋有月，夏有凉风冬有雪。
            <br />
            The quick brown fox jumps over the lazy dog. 1234567890
          </div>
          <div className="flex justify-end mt-3">
            <Button size="small" onClick={resetEditorTypography}>
              恢复默认
            </Button>
          </div>
        </div>
      </Card>

      <div id="settings-task-reminder">
        <Card title="待办提醒">
          <div className="flex items-center justify-between py-1">
            <div>
              <div>任务默认提醒时刻</div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                新建任务时若未指定时间，自动填充此时刻；编辑/创建弹窗里的"默认"也指这个值
              </Text>
            </div>
            <TimePicker
              value={dayjs(allDayReminderTime, "HH:mm")}
              onChange={handleAllDayReminderTimeChange}
              format="HH:mm"
              minuteStep={5}
              allowClear={false}
              style={{ width: 120 }}
            />
          </div>
        </Card>
      </div>

      {/* 导入笔记（Markdown / PDF / Word） */}
      <Card
        id="settings-import"
        title={
          <span className="flex items-center gap-2">
            <FolderInput size={16} />
            导入笔记
          </span>
        }
      >
        <div className="mb-3">
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 13 }}>
            支持三种导入方式：从文件夹批量扫描 .md 文件；从本地选择 PDF 或 Word 文档。
          </Typography.Paragraph>
          <Space wrap>
            <Select
              placeholder="导入到文件夹（可选）"
              allowClear
              style={{ width: 200 }}
              value={importFolderId}
              onChange={setImportFolderId}
              options={flattenFolders(folders)}
            />
            <Button
              type="primary"
              icon={<FolderInput size={14} />}
              onClick={handleScanFolder}
              loading={scanning || importing}
            >
              扫描 Markdown 文件夹
            </Button>
            <Button onClick={handleImportPdfs}>导入 PDF</Button>
            <Button onClick={handleImportWord}>导入 Word</Button>
          </Space>
        </div>

        {importing && importProgress && (
          <div className="mb-3">
            <Progress
              percent={Math.round((importProgress.current / importProgress.total) * 100)}
              size="small"
              format={() => `${importProgress.current}/${importProgress.total}`}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              正在导入: {importProgress.file_name}
            </Text>
          </div>
        )}

        {importResult && (
          <Alert
            type={importResult.errors.length > 0 ? "warning" : "success"}
            showIcon
            message={`导入完成: ${importResult.imported} 篇成功, ${importResult.skipped} 篇跳过`}
            description={
              importResult.errors.length > 0 ? (
                <List
                  size="small"
                  dataSource={importResult.errors.slice(0, 10)}
                  renderItem={(err) => (
                    <List.Item style={{ padding: "2px 0", fontSize: 12 }}>
                      <Text type="danger">{err}</Text>
                    </List.Item>
                  )}
                  footer={
                    importResult.errors.length > 10 ? (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        还有 {importResult.errors.length - 10} 条错误...
                      </Text>
                    ) : null
                  }
                />
              ) : undefined
            }
            closable
            onClose={() => setImportResult(null)}
          />
        )}
      </Card>

      {/* 导出 Markdown */}
      <Card
        id="settings-export"
        title={
          <span className="flex items-center gap-2">
            <FolderOutput size={16} />
            导出 Markdown
          </span>
        }
      >
        <div className="mb-3">
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 13 }}>
            将笔记导出为 Markdown 文件，按文件夹结构组织。便于备份或迁移到其他笔记工具。
          </Typography.Paragraph>
          <Space>
            <Select
              placeholder="导出指定文件夹（可选，默认全部）"
              allowClear
              style={{ width: 240 }}
              value={exportFolderId}
              onChange={setExportFolderId}
              options={flattenFolders(folders)}
            />
            <Button
              type="primary"
              icon={<FolderOutput size={14} />}
              onClick={handleExport}
              loading={exporting}
            >
              选择导出目录
            </Button>
          </Space>
        </div>

        {exporting && exportProgress && (
          <div className="mb-3">
            <Progress
              percent={Math.round((exportProgress.current / exportProgress.total) * 100)}
              size="small"
              format={() => `${exportProgress.current}/${exportProgress.total}`}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              正在导出: {exportProgress.file_name}
            </Text>
          </div>
        )}

        {exportResult && (
          <Alert
            type={exportResult.errors.length > 0 ? "warning" : "success"}
            showIcon
            message={`导出完成: ${exportResult.exported} 篇笔记，附带 ${exportResult.assets_copied} 个资产文件`}
            description={
              <div className="space-y-2">
                <div style={{ fontSize: 12, fontFamily: "monospace", wordBreak: "break-all" }}>
                  {exportResult.root_dir}
                </div>
                <Space size="small">
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => revealItemInDir(exportResult.root_dir).catch(() => {})}
                  >
                    打开所在文件夹
                  </Button>
                </Space>
                {exportResult.errors.length > 0 && (
                  <List
                    size="small"
                    dataSource={exportResult.errors.slice(0, 10)}
                    renderItem={(err) => (
                      <List.Item style={{ padding: "2px 0", fontSize: 12 }}>
                        <Text type="danger">{err}</Text>
                      </List.Item>
                    )}
                  />
                )}
              </div>
            }
            closable
            onClose={() => setExportResult(null)}
          />
        )}
      </Card>

      <Card
        id="settings-ai-models"
        title="AI 模型配置"
        extra={
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={openAddModel}
          >
            添加模型
          </Button>
        }
      >
        <Table
          columns={modelColumns}
          dataSource={models}
          rowKey="id"
          loading={modelsLoading}
          pagination={false}
          size="small"
        />
      </Card>

      {/* 模板管理 */}
      <Card
        id="settings-templates"
        title={
          <span className="flex items-center gap-2">
            <LayoutTemplate size={16} />
            笔记模板
          </span>
        }
        extra={
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={openAddTemplate}
          >
            新建模板
          </Button>
        }
      >
        <Table
          columns={[
            {
              title: "模板名称",
              dataIndex: "name",
              key: "name",
            },
            {
              title: "描述",
              dataIndex: "description",
              key: "description",
              ellipsis: true,
              render: (text: string) => (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {text || "—"}
                </Text>
              ),
            },
            {
              title: "操作",
              key: "action",
              width: 100,
              render: (_: unknown, record: NoteTemplate) => (
                <Space size="small">
                  <Button
                    type="text"
                    size="small"
                    icon={<Pencil size={14} />}
                    onClick={() => openEditTemplate(record)}
                  />
                  <Popconfirm
                    title="确认删除此模板？"
                    onConfirm={() => handleDeleteTemplate(record.id)}
                  >
                    <Button type="text" size="small" danger icon={<Trash2 size={14} />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          dataSource={tplList}
          rowKey="id"
          loading={tplLoading}
          pagination={false}
          size="small"
        />
      </Card>

      <div id="settings-data-dir">
        <DataDirSection />
      </div>

      <div id="settings-sync">
        <SyncTabs />
      </div>

      {/* 维护：孤儿素材清理（5 类素材统一） */}
      <Card
        id="settings-orphan-assets"
        title={
          <Space>
            <Trash2 size={16} />
            <span>维护 · 孤儿素材清理</span>
          </Space>
        }
        className="mb-4"
      >
        <OrphanAssetsPanel />
      </Card>

      <Card id="settings-community" title="作者 & 社区">
        <div className="flex items-center justify-between py-1">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div>
              <Text strong style={{ fontSize: 13 }}>B 站主页</Text>
            </div>
            <Text
              type="secondary"
              style={{ fontSize: 12, wordBreak: "break-all" }}
            >
              {BILIBILI_URL}
            </Text>
          </div>
          <Button
            type="link"
            size="small"
            icon={<ExternalLink size={14} />}
            onClick={() => openUrl(BILIBILI_URL)}
          >
            打开
          </Button>
        </div>
        <div
          className="flex items-center justify-between py-1 mt-2"
          style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div>
              <Text strong style={{ fontSize: 13 }}>视频讲解</Text>
            </div>
            <Text
              type="secondary"
              style={{ fontSize: 12, wordBreak: "break-all" }}
            >
              B 站使用教程 / 功能演示
            </Text>
          </div>
          <Button
            type="link"
            size="small"
            icon={<ExternalLink size={14} />}
            onClick={() => openUrl(BILIBILI_TUTORIAL_URL)}
          >
            打开
          </Button>
        </div>
        <div
          className="py-1 mt-2"
          style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}
        >
          <div>
            <Text strong style={{ fontSize: 13 }}>知识星球</Text>
          </div>
          <div style={{ marginTop: 2 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {ZSXQ_NAME} · 星球号{" "}
            </Text>
            <Text copyable={{ text: ZSXQ_ID }} strong style={{ fontSize: 13 }}>
              {ZSXQ_ID}
            </Text>
          </div>
        </div>
      </Card>

      <RecommendCards />

      {/* 导入预览弹窗 */}
      <Modal
        title={`选择要导入的文件（共 ${scannedFiles.length} 个）`}
        open={scanModalOpen}
        onCancel={() => setScanModalOpen(false)}
        onOk={handleConfirmImport}
        okText={`导入 ${selectedPaths.size} 个文件`}
        cancelText="取消"
        width={600}
        styles={{ body: { maxHeight: 400, overflow: "auto" } }}
      >
        <div className="flex items-center justify-between mb-3 pb-2" style={{ borderBottom: "1px solid #f0f0f0" }}>
          <Checkbox
            checked={selectedPaths.size === scannedFiles.length && scannedFiles.length > 0}
            indeterminate={selectedPaths.size > 0 && selectedPaths.size < scannedFiles.length}
            onChange={toggleSelectAll}
          >
            全选 / 取消全选
          </Checkbox>
          <Text type="secondary" style={{ fontSize: 12 }}>
            已选 {selectedPaths.size} / {scannedFiles.length}
          </Text>
        </div>
        {/* 分桶统计 + 冲突策略 */}
        <div className="mb-3 pb-2" style={{ borderBottom: "1px solid #f0f0f0" }}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2" style={{ fontSize: 12 }}>
            <span>
              🆕 全新 <strong>{matchStats.news}</strong>
            </span>
            <span title="路径已匹配到已有笔记（上次导入过）">
              🔁 已导入过 <strong>{matchStats.paths}</strong>
            </span>
            <span title="路径不同但标题+内容与已有笔记一致，可能是用户搬动过文件">
              ⚠️ 可能重复 <strong>{matchStats.fuzzies}</strong>
            </span>
          </div>
          {matchStats.conflicts > 0 && (
            <div>
              <Text style={{ fontSize: 12 }}>遇到已存在的文件：</Text>
              <Radio.Group
                value={conflictPolicy}
                onChange={(e) => setConflictPolicy(e.target.value as ImportConflictPolicy)}
                size="small"
                style={{ marginLeft: 8 }}
              >
                <Radio value="skip">跳过（推荐）</Radio>
                <Radio value="duplicate">创建副本</Radio>
              </Radio.Group>
            </div>
          )}
        </div>

        {/* 保留目录层级选项 */}
        <div className="mb-3 pb-2" style={{ borderBottom: "1px solid #f0f0f0" }}>
          <Checkbox
            checked={preserveRoot}
            onChange={(e) => setPreserveRoot(e.target.checked)}
          >
            <span style={{ fontSize: 13 }}>保留源文件夹作为根</span>
          </Checkbox>
          <div className="mt-1" style={{ paddingLeft: 24 }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              导入时按源目录层级自动创建子文件夹，同名文件夹复用已有记录。
              {preserveRoot
                ? "将在目标下创建与源目录同名的根文件夹。"
                : "子目录直接挂到目标位置。"}
            </Text>
          </div>
        </div>
        <List
          size="small"
          dataSource={scannedFiles}
          renderItem={(file) => (
            <List.Item style={{ padding: "6px 0" }}>
              <Checkbox
                checked={selectedPaths.has(file.path)}
                onChange={() => toggleFileSelection(file.path)}
                style={{ marginRight: 8 }}
              />
              <div className="flex-1 min-w-0">
                <Text ellipsis style={{ fontSize: 13 }}>
                  {file.name}.md
                </Text>
                {file.relative_dir && (
                  <div>
                    <Text
                      type="secondary"
                      ellipsis
                      style={{ fontSize: 11, display: "block" }}
                    >
                      {file.relative_dir}
                    </Text>
                  </div>
                )}
              </div>
              <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                {file.size < 1024
                  ? `${file.size} B`
                  : file.size < 1048576
                    ? `${(file.size / 1024).toFixed(1)} KB`
                    : `${(file.size / 1048576).toFixed(1)} MB`}
              </Text>
            </List.Item>
          )}
        />
      </Modal>

      {/* 添加/编辑模型弹窗
       *
       * 表单字段较多（name / provider / url / key / model_id / max_context + 各种 extra 提示），
       * 全展开会顶到屏幕外。固定 body 最大高度 + 内部滚动 → 在小屏（笔记本 13"）也能看全。
       * extra 字号统一缩小 (12px) 进一步压缩纵向占用，见 Modal styles.body 内的 .ant-form-item-extra。 */}
      <Modal
        title={editingModel ? "编辑 AI 模型" : "添加 AI 模型"}
        open={modelModalOpen}
        onCancel={() => setModelModalOpen(false)}
        destroyOnHidden
        // 类名配合 global.css 里的 .ai-model-modal .ant-form-item-extra → 提示文字 12px
        className="ai-model-modal"
        styles={{
          body: {
            // 固定 body 最大高度 + 内部滚动，避免表单顶到屏幕外（小屏 13" 笔记本也能看全）
            maxHeight: "calc(100vh - 220px)",
            overflowY: "auto",
          },
        }}
        // 自定义 footer：在「保存/取消」前面加「测试连接」，让用户填完字段不必先存就能验
        footer={
          <Space>
            <Button
              icon={<Zap size={14} />}
              loading={testingModelId === -1}
              disabled={testingModelId !== null && testingModelId !== -1}
              onClick={handleTestForm}
            >
              测试连接
            </Button>
            <Button onClick={() => setModelModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={handleModelSave}>
              保存
            </Button>
          </Space>
        }
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ provider: "ollama", api_url: DEFAULT_URLS.ollama }}
        >
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入模型名称" }]}
          >
            <Input placeholder="如: GPT-4o Mini" />
          </Form.Item>

          <Form.Item
            name="provider"
            label="提供商"
            extra="除 Ollama 外都按 OpenAI 兼容协议处理。选「自定义」可填任意 baseUrl（OpenRouter / Moonshot / 字节豆包 / 自建网关 / lm studio 等任何 OpenAI 兼容服务）"
            rules={[{ required: true }]}
          >
            <Select
              options={PROVIDERS}
              onChange={handleProviderChange}
            />
          </Form.Item>

          <Form.Item
            name="api_url"
            label="API 地址"
            extra="支持任意 OpenAI 兼容服务的 base_url（不含 /chat/completions 后缀）"
            rules={[{ required: true, message: "请输入 API 地址" }]}
          >
            <Input placeholder={DEFAULT_URLS[watchedProvider] || "https://api.openai.com/v1"} />
          </Form.Item>

          <Form.Item name="api_key" label="API Key">
            <Input.Password placeholder="sk-... (Ollama 无需填写)" />
          </Form.Item>

          <Form.Item
            name="model_id"
            label="模型标识"
            extra="✏️ 可直接输入任意模型名（如 anthropic/claude-sonnet-4.6、moonshotai/kimi-k2 等），不必限于下拉候选"
            rules={[{ required: true, message: "请输入或选择模型标识" }]}
          >
            <AutoComplete
              options={MODEL_PRESETS[watchedProvider] || []}
              placeholder={
                MODEL_ID_PLACEHOLDERS[watchedProvider] ||
                "如: gpt-4o-mini / qwen2.5:7b"
              }
              filterOption={(input, option) =>
                (option?.value as string)
                  ?.toLowerCase()
                  .includes(input.toLowerCase())
              }
              allowClear
            />
          </Form.Item>

          <Form.Item
            name="max_context"
            label="最大上下文 token"
            extra="从下拉选常用量级，或手动输入任意数字。不确定就保留 32000。"
            initialValue={32000}
          >
            <AutoComplete
              placeholder="32000"
              options={[
                { value: 32000, label: "32K  （OpenAI 老款 / 默认）" },
                { value: 64000, label: "64K" },
                { value: 128000, label: "128K （DeepSeek / GPT-4o / 智谱）" },
                { value: 200000, label: "200K （Claude）" },
                { value: 1000000, label: "1M   （GLM-Long / MiniMax-M1）" },
                { value: 2000000, label: "2M" },
              ]}
              filterOption={(input, option) => {
                const q = input.trim().toLowerCase();
                if (!q) return true;
                return (
                  String(option?.value ?? "").includes(q) ||
                  String(option?.label ?? "").toLowerCase().includes(q)
                );
              }}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 模板编辑弹窗 */}
      <Modal
        title={editingTpl ? "编辑模板" : "新建模板"}
        open={tplModalOpen}
        onOk={handleTemplateSave}
        onCancel={() => setTplModalOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        width={820}
        styles={{ body: { maxHeight: "calc(100vh - 240px)", overflow: "auto" } }}
      >
        <Form form={tplForm} layout="vertical" className="mt-4">
          <Form.Item
            name="name"
            label="模板名称"
            rules={[{ required: true, message: "请输入模板名称" }]}
          >
            <Input placeholder="如：会议记录" />
          </Form.Item>
          <Form.Item name="description" label="描述" initialValue="">
            <Input placeholder="简要描述模板用途" />
          </Form.Item>
          <Form.Item
            name="content"
            label="模板内容"
            initialValue=""
            valuePropName="content"
          >
            <TiptapEditor
              content=""
              onChange={() => {}}
              placeholder="输入模板内容（支持富文本），创建笔记时将自动填充"
            />
          </Form.Item>
        </Form>
      </Modal>

      <UpdateModal
        open={updateModalOpen}
        onClose={() => setUpdateModalOpen(false)}
        update={update}
      />
      </div>
    </div>
  );
}
