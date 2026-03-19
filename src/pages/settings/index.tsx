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
import { Trash2, Pencil, FolderInput } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type { Update } from "@tauri-apps/plugin-updater";
import type { AppConfig, AiModel, AiModelInput, ImportResult, ImportProgress } from "@/types";
import { configApi, systemApi, updaterApi, aiModelApi, importApi, folderApi } from "@/lib/api";
import { UpdateModal } from "@/components/ui/UpdateModal";
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
  const [configs, setConfigs] = useState<AppConfig[]>([]);
  const [loading, setLoading] = useState(false);
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

  async function loadConfigs() {
    setLoading(true);
    try {
      const data = await configApi.getAll();
      setConfigs(data);
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }

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

  useEffect(() => {
    loadConfigs();
    loadModels();
    loadFolders();
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

  async function handleImport() {
    // 选择文件夹
    const selected = await open({ directory: true, title: "选择 Markdown 文件夹" });
    if (!selected) return;

    setImporting(true);
    setImportProgress(null);
    setImportResult(null);

    // 监听进度
    const unlistenProgress = await listen<ImportProgress>("import:progress", (e) => {
      setImportProgress(e.payload);
    });
    const unlistenDone = await listen<ImportResult>("import:done", (e) => {
      setImportResult(e.payload);
    });

    try {
      const result = await importApi.importFolder(selected as string, importFolderId ?? null);
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

  const configColumns = [
    {
      title: "配置键",
      dataIndex: "key",
      key: "key",
      render: (text: string) => <Tag color="blue">{text}</Tag>,
    },
    {
      title: "配置值",
      dataIndex: "value",
      key: "value",
    },
  ];

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
    <div className="max-w-2xl mx-auto">
      <Title level={3}>设置</Title>
      <Text type="secondary">应用配置与 AI 模型管理</Text>

      <Card title="软件更新" className="mt-6">
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
        className="mt-4"
      >
        <div className="mb-3">
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 13 }}>
            从 Obsidian vault 或 Typora 文件夹中批量导入 .md 文件为笔记。
            支持递归读取子文件夹，自动提取 Markdown 标题。
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
              onClick={handleImport}
              loading={importing}
            >
              选择文件夹并导入
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

      <Card
        title="AI 模型配置"
        className="mt-4"
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

      <Card title="应用配置" className="mt-4">
        <Table
          columns={configColumns}
          dataSource={configs}
          rowKey="key"
          loading={loading}
          pagination={false}
          size="small"
        />
      </Card>

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

      <UpdateModal
        open={updateModalOpen}
        onClose={() => setUpdateModalOpen(false)}
        update={update}
      />
    </div>
  );
}
