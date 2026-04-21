import { useEffect, useState } from "react";
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
} from "antd";
import { SyncOutlined, PlusOutlined, CheckCircleFilled, CheckCircleOutlined } from "@ant-design/icons";
import { Trash2, Pencil, FolderInput, FolderOutput, LayoutTemplate, Power } from "lucide-react";
import dayjs, { type Dayjs } from "dayjs";
import { TimePicker } from "antd";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import type { AiModel, AiModelInput, ImportResult, ImportProgress, ScannedFile, ExportResult, ExportProgress, NoteTemplate, NoteTemplateInput, OrphanImageScan } from "@/types";
import { systemApi, updaterApi, aiModelApi, importApi, exportApi, folderApi, templateApi, pdfApi, sourceFileApi, imageMaintApi, autostartApi, configApi } from "@/lib/api";
import { importWordFiles } from "@/lib/wordImport";
import { Checkbox } from "antd";
import { UpdateModal } from "@/components/ui/UpdateModal";
import { RecommendCards } from "@/components/ui/RecommendCards";
import { SyncSection } from "@/components/settings/SyncSection";
import { TiptapEditor } from "@/components/editor";
import type { Folder } from "@/types";

const { Title, Text } = Typography;

/** 模型提供商选项 */
const PROVIDERS = [
  { value: "ollama", label: "Ollama (本地)" },
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "zhipu", label: "智谱 AI (GLM)" },
  { value: "claude", label: "Claude" },
];

/** 提供商默认 API 地址
 * 后端会智能拼接 `/chat/completions`，所以 URL 末尾可带也可不带 `/v1` / `/paas/v4` 之类版本段。
 */
const DEFAULT_URLS: Record<string, string> = {
  ollama: "http://localhost:11434",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  claude: "https://openrouter.ai/api/v1",
};

/** 各 provider 的模型标识占位提示 */
const MODEL_ID_PLACEHOLDERS: Record<string, string> = {
  ollama: "如: qwen2.5:7b / llama3.2:3b",
  openai: "如: gpt-4o-mini / gpt-4o",
  deepseek: "如: deepseek-chat / deepseek-reasoner",
  zhipu: "如: glm-4-plus / glm-4-flash / glm-4-air",
  claude: "如: anthropic/claude-sonnet-4.6 (经 OpenRouter 等兼容代理)",
};

/** 各 provider 的常用模型预置（下拉联想；也可手动输入任意值） */
const MODEL_PRESETS: Record<string, { value: string; label: string }[]> = {
  ollama: [
    { value: "qwen2.5:7b", label: "qwen2.5:7b" },
    { value: "qwen2.5:14b", label: "qwen2.5:14b" },
    { value: "qwen2.5:3b", label: "qwen2.5:3b" },
    { value: "llama3.2:3b", label: "llama3.2:3b" },
    { value: "llama3.1:8b", label: "llama3.1:8b" },
    { value: "gemma2:9b", label: "gemma2:9b" },
    { value: "phi3:mini", label: "phi3:mini" },
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
};

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

  // 孤儿图片清理
  const [orphanScan, setOrphanScan] = useState<OrphanImageScan | null>(null);
  const [orphanScanning, setOrphanScanning] = useState(false);
  const [orphanCleaning, setOrphanCleaning] = useState(false);
  const [orphanPreviewOpen, setOrphanPreviewOpen] = useState(false);

  // 启动设置
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(false);
  const [startMinimizedLoading, setStartMinimizedLoading] = useState(false);

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

  async function handleScanOrphans() {
    setOrphanScanning(true);
    try {
      const result = await imageMaintApi.scanOrphans();
      setOrphanScan(result);
    } catch (e) {
      message.error(`扫描失败: ${e}`);
    } finally {
      setOrphanScanning(false);
    }
  }

  async function handleCleanOrphans() {
    if (!orphanScan || orphanScan.paths.length === 0) return;
    setOrphanCleaning(true);
    try {
      const result = await imageMaintApi.cleanOrphans(orphanScan.paths);
      const freedMb = (result.freedBytes / 1024 / 1024).toFixed(2);
      if (result.failed.length > 0) {
        message.warning(
          `清理完成：删除 ${result.deleted} 个，失败 ${result.failed.length} 个，释放 ${freedMb} MB`,
        );
      } else {
        message.success(`清理完成：删除 ${result.deleted} 个文件，释放 ${freedMb} MB`);
      }
      // 清理后重新扫，看是否还有（或是否截断过）
      await handleScanOrphans();
    } catch (e) {
      message.error(`清理失败: ${e}`);
    } finally {
      setOrphanCleaning(false);
    }
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

  useEffect(() => {
    loadModels();
    loadFolders();
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
    configApi
      .get("all_day_reminder_time")
      .then((v) => {
        if (v && /^\d{2}:\d{2}(:\d{2})?$/.test(v)) {
          setAllDayReminderTime(v.slice(0, 5));
        }
      })
      .catch(() => {});
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
      const result = await importApi.importSelected(paths, importFolderId ?? null);
      setImportResult(result);
      if (result.imported > 0) {
        message.success(`成功导入 ${result.imported} 篇笔记`);
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
        message.success(`成功导出 ${result.exported} 篇笔记到 ${result.output_dir}`);
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
    });
    setModelModalOpen(true);
  }

  async function handleModelSave() {
    try {
      const values = await form.validateFields();
      if (editingModel) {
        await aiModelApi.update(editingModel.id, values);
        message.success("模型已更新");
      } else {
        await aiModelApi.create(values);
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
      width: 160,
      render: (_: unknown, record: AiModel) => (
        <Space size="small">
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
    <div className="max-w-2xl mx-auto" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <Title level={3}>设置</Title>
        <Text type="secondary">应用配置与 AI 模型管理</Text>
      </div>

      <Card title="软件更新">
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
      </Card>

      <Card title="待办提醒">
        <div className="flex items-center justify-between py-1">
          <div>
            <div>全天任务的提醒时刻</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              不带具体时间的任务，以该时刻为基准触发提醒（对标 Apple 提醒事项 / MS To Do）
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

      {/* 导入笔记（Markdown / PDF / Word） */}
      <Card
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
            message={`导出完成: ${exportResult.exported} 篇笔记`}
            description={
              exportResult.errors.length > 0 ? (
                <List
                  size="small"
                  dataSource={exportResult.errors.slice(0, 10)}
                  renderItem={(err) => (
                    <List.Item style={{ padding: "2px 0", fontSize: 12 }}>
                      <Text type="danger">{err}</Text>
                    </List.Item>
                  )}
                />
              ) : undefined
            }
            closable
            onClose={() => setExportResult(null)}
          />
        )}
      </Card>

      <Card
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

      <SyncSection />

      {/* 维护：孤儿图片清理 */}
      <Card
        title={
          <Space>
            <Trash2 size={16} />
            <span>维护</span>
          </Space>
        }
        className="mb-4"
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <div>
            <Button
              icon={<SyncOutlined />}
              onClick={handleScanOrphans}
              loading={orphanScanning}
            >
              扫描孤儿图片
            </Button>
            <Typography.Text type="secondary" className="ml-3 text-xs">
              笔记删掉图片后，磁盘上的文件不会自动删，用这里手动清理
            </Typography.Text>
          </div>

          {orphanScan &&
            (orphanScan.count === 0 ? (
              <Alert type="success" showIcon message="没有孤儿图片，磁盘干净" />
            ) : (
              <Alert
                type="warning"
                showIcon
                message={
                  <span>
                    发现 <b>{orphanScan.count}</b> 张孤儿图片，共{" "}
                    <b>{(orphanScan.totalBytes / 1024 / 1024).toFixed(2)} MB</b>
                    {orphanScan.truncated && (
                      <span className="text-xs">（列表已截断至前 500 条，可多次清理）</span>
                    )}
                  </span>
                }
                action={
                  <Space size="small">
                    <Button size="small" onClick={() => setOrphanPreviewOpen(true)}>
                      查看
                    </Button>
                    <Popconfirm
                      title="确认清理？"
                      description={`将删除 ${orphanScan.paths.length} 个文件，不可撤销。`}
                      okText="删除"
                      okType="danger"
                      cancelText="取消"
                      onConfirm={handleCleanOrphans}
                    >
                      <Button size="small" danger loading={orphanCleaning}>
                        立即清理
                      </Button>
                    </Popconfirm>
                  </Space>
                }
              />
            ))}
        </Space>
      </Card>

      {/* 孤儿图片预览弹窗 */}
      <Modal
        title={`孤儿图片预览（${orphanScan?.paths.length ?? 0} / ${orphanScan?.count ?? 0}）`}
        open={orphanPreviewOpen}
        onCancel={() => setOrphanPreviewOpen(false)}
        footer={[
          <Button key="close" onClick={() => setOrphanPreviewOpen(false)}>
            关闭
          </Button>,
          <Popconfirm
            key="clean"
            title="确认清理这些图片？"
            description={`将删除 ${orphanScan?.paths.length ?? 0} 个文件，不可撤销。`}
            okText="删除"
            okType="danger"
            cancelText="取消"
            onConfirm={async () => {
              await handleCleanOrphans();
              setOrphanPreviewOpen(false);
            }}
          >
            <Button danger loading={orphanCleaning}>
              立即清理
            </Button>
          </Popconfirm>,
        ]}
        width={760}
        styles={{ body: { maxHeight: "60vh", overflow: "auto" } }}
      >
        {orphanScan?.truncated && (
          <Alert
            type="info"
            showIcon
            className="mb-3"
            message={`共 ${orphanScan.count} 张孤儿图片，仅预览前 ${orphanScan.paths.length} 张。清理后会重新扫描剩余文件。`}
          />
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            gap: 12,
          }}
        >
          {orphanScan?.paths.map((p) => (
            <div
              key={p}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                overflow: "hidden",
                background: "#fafafa",
              }}
            >
              <div
                style={{
                  height: 100,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#fff",
                }}
              >
                <img
                  src={convertFileSrc(p)}
                  alt={p}
                  style={{
                    maxWidth: "100%",
                    maxHeight: "100%",
                    objectFit: "contain",
                  }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
              <div
                className="text-xs px-2 py-1 truncate"
                style={{ color: "#666" }}
                title={p}
              >
                {p.split(/[\\/]/).pop()}
              </div>
            </div>
          ))}
        </div>
      </Modal>

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

      {/* 添加/编辑模型弹窗 */}
      <Modal
        title={editingModel ? "编辑 AI 模型" : "添加 AI 模型"}
        open={modelModalOpen}
        onOk={handleModelSave}
        onCancel={() => setModelModalOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          className="mt-4"
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
            tooltip="可从下拉选预置模型，也可直接输入任意自定义名称"
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
        destroyOnClose
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
  );
}
