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
  Popconfirm,
  Progress,
  Alert,
  List,
} from "antd";
import { SyncOutlined, PlusOutlined, StarFilled, StarOutlined } from "@ant-design/icons";
import { Trash2, Pencil, FolderInput, FolderOutput, LayoutTemplate } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type { Update } from "@tauri-apps/plugin-updater";
import type { AiModel, AiModelInput, ImportResult, ImportProgress, ScannedFile, ExportResult, ExportProgress, NoteTemplate, NoteTemplateInput } from "@/types";
import { systemApi, updaterApi, aiModelApi, importApi, exportApi, folderApi, templateApi } from "@/lib/api";
import { Checkbox } from "antd";
import { UpdateModal } from "@/components/ui/UpdateModal";
import { RecommendCards } from "@/components/ui/RecommendCards";
import type { Folder } from "@/types";

const { Title, Text } = Typography;

/** 模型提供商选项 */
const PROVIDERS = [
  { value: "ollama", label: "Ollama (本地)" },
  { value: "openai", label: "OpenAI" },
  { value: "claude", label: "Claude (兼容)" },
];

/** 提供商默认 URL */
const DEFAULT_URLS: Record<string, string> = {
  ollama: "http://localhost:11434",
  openai: "https://api.openai.com",
  claude: "https://api.openai.com",
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

  useEffect(() => {
    loadModels();
    loadFolders();
    loadTemplates();
    systemApi
      .getSystemInfo()
      .then((info) => setAppVersion(info.appVersion))
      .catch(() => {});
  }, []);

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
                <StarFilled style={{ color: "#faad14" }} />
              ) : (
                <StarOutlined />
              )
            }
            onClick={() => handleSetDefault(record.id)}
            title="设为默认"
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
        <Space>
          <Button
            icon={<SyncOutlined spin={checking} />}
            onClick={handleCheckUpdate}
            loading={checking}
          >
            检查更新
          </Button>
          <Text type="secondary">当前版本: {appVersion}</Text>
        </Space>
      </Card>

      {/* 导入 Markdown */}
      <Card
        title={
          <span className="flex items-center gap-2">
            <FolderInput size={16} />
            导入 Markdown
          </span>
        }
      >
        <div className="mb-3">
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 13 }}>
            从本地文件夹中批量导入 .md 文件为笔记。
            支持递归读取子文件夹，自动提取 Markdown 标题，导入前可预览并勾选。
          </Typography.Paragraph>
          <Space>
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
              选择文件夹
            </Button>
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
            <Input placeholder="https://api.openai.com" />
          </Form.Item>

          <Form.Item name="api_key" label="API Key">
            <Input.Password placeholder="sk-... (Ollama 无需填写)" />
          </Form.Item>

          <Form.Item
            name="model_id"
            label="模型标识"
            rules={[{ required: true, message: "请输入模型标识" }]}
          >
            <Input placeholder="如: gpt-4o-mini / llama3 / claude-sonnet-4-20250514" />
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
          <Form.Item name="content" label="模板内容（HTML）" initialValue="">
            <Input.TextArea
              rows={8}
              placeholder="输入 HTML 格式的模板内容，创建笔记时将自动填充"
              style={{ fontFamily: "monospace", fontSize: 12 }}
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
