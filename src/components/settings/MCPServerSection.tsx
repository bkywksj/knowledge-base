import { useEffect, useMemo, useState } from "react";
import {
  Card,
  Typography,
  Tag,
  Button,
  Space,
  Collapse,
  Tabs,
  Alert,
  message,
  Tooltip,
  List,
  Empty,
  Table,
  Switch,
  Modal,
  Form,
  Input,
  Popconfirm,
  Divider,
} from "antd";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CopyOutlined,
  PlayCircleOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { ExternalLink, Folder, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { systemApi } from "@/lib/api";
import type { McpServer, McpServerInput } from "@/types";

interface ClaudeCodeTemplate {
  claudeMd: string;
  settingsSnippetReadonly: string;
  settingsSnippetWritable: string;
}

// 用浏览器原生 clipboard，省一个 npm 依赖；webview 在 https / tauri:// 协议下都允许
async function writeClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

const { Text, Paragraph } = Typography;

interface McpRuntimeInfo {
  internalReady: boolean;
  sidecarBinaryPath: string | null;
  dbPath: string;
  targetTriple: string;
  os: string;
}

interface McpToolInfo {
  name: string;
  description: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input_schema: any;
}

/**
 * 设置页 · MCP 服务器面板
 *
 * 功能：
 * - 显示内置 in-memory MCP server 状态 + 12 工具
 * - 测试 ping（验证活体）
 * - 一键生成 Claude Desktop / Cursor / Cherry Studio 配置 JSON
 * - 一键打开 sidecar binary 所在目录（方便复制路径）
 */
export function MCPServerSection() {
  const [info, setInfo] = useState<McpRuntimeInfo | null>(null);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<string | null>(null);
  const [claudeCodeTpl, setClaudeCodeTpl] = useState<ClaudeCodeTemplate | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [i, t, tpl] = await Promise.all([
        invoke<McpRuntimeInfo>("mcp_runtime_info"),
        invoke<McpToolInfo[]>("mcp_internal_list_tools").catch(() => [] as McpToolInfo[]),
        invoke<ClaudeCodeTemplate>("mcp_get_claude_md_template").catch(() => null),
      ]);
      setInfo(i);
      setTools(t);
      setClaudeCodeTpl(tpl);
    } catch (e) {
      message.error(`加载 MCP 信息失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  // CLAUDE.md「另存为...」：弹文件对话框选目录
  async function saveClaudeMdAs() {
    if (!claudeCodeTpl) return;
    try {
      const path = await saveDialog({
        defaultPath: "CLAUDE.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      await systemApi.writeTextFile(path, claudeCodeTpl.claudeMd);
      message.success(`已保存到 ${path}`);
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  }

  // 在文件管理器打开 ~/.claude/ 目录（不存在则提示用户先 mkdir）
  async function openClaudeDir() {
    try {
      const dir = await join(await homeDir(), ".claude");
      await revealItemInDir(dir);
    } catch (e) {
      message.error(
        `打开 ~/.claude/ 失败（目录可能不存在，先跑一次 \`claude\` 命令初始化）: ${e}`,
      );
    }
  }

  async function handlePing() {
    setPinging(true);
    setPingResult(null);
    try {
      const t0 = performance.now();
      const r = await invoke<string>("mcp_internal_call_tool", {
        name: "ping",
        arguments: {},
      });
      const ms = Math.round(performance.now() - t0);
      setPingResult(`${r} · ${ms}ms`);
    } catch (e) {
      setPingResult(`错误: ${e}`);
    } finally {
      setPinging(false);
    }
  }

  async function copyConfig(json: string, label: string) {
    try {
      await writeClipboard(json);
      message.success(`已复制 ${label} 配置到剪贴板`);
    } catch (e) {
      message.error(`复制失败: ${e}`);
    }
  }

  async function openBinaryDir() {
    if (!info?.sidecarBinaryPath) return;
    try {
      await revealItemInDir(info.sidecarBinaryPath);
    } catch (e) {
      message.error(`打开目录失败: ${e}`);
    }
  }

  // 生成三种客户端的配置 JSON
  const configs = useMemo(() => {
    if (!info?.sidecarBinaryPath) return null;
    // JSON 字符串里 Windows 路径需要转义反斜杠
    const escapedBinary = info.sidecarBinaryPath.replace(/\\/g, "\\\\");
    const escapedDb = info.dbPath.replace(/\\/g, "\\\\");
    const claudeConfig = JSON.stringify(
      {
        mcpServers: {
          "knowledge-base": {
            command: escapedBinary,
            args: ["--db-path", escapedDb],
          },
        },
      },
      null,
      2,
    );
    const claudeWritable = JSON.stringify(
      {
        mcpServers: {
          "knowledge-base": {
            command: escapedBinary,
            args: ["--db-path", escapedDb, "--writable"],
          },
        },
      },
      null,
      2,
    );
    // Cursor 用 forward slash 也行
    const cursorConfig = JSON.stringify(
      {
        mcpServers: {
          "knowledge-base": {
            command: info.sidecarBinaryPath.replace(/\\/g, "/"),
            args: ["--db-path", info.dbPath.replace(/\\/g, "/")],
          },
        },
      },
      null,
      2,
    );
    return { claudeConfig, claudeWritable, cursorConfig };
  }, [info]);

  return (
    <Card
      id="settings-mcp"
      title={
        <span className="flex items-center gap-2">
          🔌 MCP 服务器（接入 Claude Desktop / Cursor / Cherry Studio）
        </span>
      }
      className="mb-4"
      loading={loading}
      extra={
        <Button size="small" onClick={() => void load()}>
          刷新
        </Button>
      }
    >
      {!info ? (
        <Empty description="未加载到 MCP 信息" />
      ) : (
        <>
          {/* ─── 状态行 ─────────────────────────────── */}
          <div className="mb-4 flex items-center gap-4 flex-wrap">
            <Tag
              icon={info.internalReady ? <CheckCircleFilled /> : <CloseCircleFilled />}
              color={info.internalReady ? "success" : "error"}
            >
              内置 MCP Server {info.internalReady ? "已就绪" : "未就绪"}
            </Tag>
            <Tag>{tools.length} 个工具</Tag>
            <Tag>{info.targetTriple}</Tag>
            <Button
              size="small"
              icon={<PlayCircleOutlined />}
              loading={pinging}
              onClick={() => void handlePing()}
              disabled={!info.internalReady}
            >
              测试 ping
            </Button>
            {pingResult && (
              <Text
                type={pingResult.startsWith("错误") ? "danger" : "secondary"}
                style={{ fontFamily: "monospace", fontSize: 12 }}
              >
                {pingResult}
              </Text>
            )}
          </div>

          {/* ─── 路径信息 ─────────────────────────────── */}
          <div className="mb-4 space-y-2">
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Sidecar binary
              </Text>
              <div className="flex items-center gap-2">
                {info.sidecarBinaryPath ? (
                  <>
                    <Paragraph
                      copyable={{ text: info.sidecarBinaryPath }}
                      style={{
                        margin: 0,
                        fontFamily: "monospace",
                        fontSize: 12,
                        flex: 1,
                        wordBreak: "break-all",
                      }}
                    >
                      {info.sidecarBinaryPath}
                    </Paragraph>
                    <Tooltip title="在文件管理器中显示">
                      <Button
                        size="small"
                        icon={<Folder size={14} />}
                        onClick={() => void openBinaryDir()}
                      />
                    </Tooltip>
                  </>
                ) : (
                  <Alert
                    type="warning"
                    showIcon
                    message="未找到 kb-mcp binary"
                    description={
                      <span>
                        开发期请先运行 <code>pnpm build:mcp</code> 编译 sidecar；
                        正式安装包应自带（如果没有，重新打一遍）
                      </span>
                    }
                    style={{ flex: 1 }}
                  />
                )}
              </div>
            </div>

            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                知识库 db
              </Text>
              <Paragraph
                copyable={{ text: info.dbPath }}
                style={{
                  margin: 0,
                  fontFamily: "monospace",
                  fontSize: 12,
                  wordBreak: "break-all",
                }}
              >
                {info.dbPath}
              </Paragraph>
            </div>
          </div>

          {/* ─── 客户端配置 JSON ─────────────────────── */}
          {configs && (
            <div className="mb-4">
              <Text strong>外部客户端配置</Text>
              <Tabs
                size="small"
                items={[
                  {
                    key: "claude-ro",
                    label: "Claude Desktop（只读）",
                    children: (
                      <ConfigBlock
                        json={configs.claudeConfig}
                        label="Claude Desktop 只读"
                        onCopy={copyConfig}
                        hint="抄到 %APPDATA%\\Claude\\claude_desktop_config.json，重启即可。LLM 只能搜不能改你的笔记。"
                      />
                    ),
                  },
                  {
                    key: "claude-rw",
                    label: "Claude Desktop（可写）",
                    children: (
                      <ConfigBlock
                        json={configs.claudeWritable}
                        label="Claude Desktop 可写"
                        onCopy={copyConfig}
                        hint="加 --writable 后 LLM 能调用 create_note / update_note / add_tag_to_note 修改你的知识库。"
                      />
                    ),
                  },
                  {
                    key: "cursor",
                    label: "Cursor",
                    children: (
                      <ConfigBlock
                        json={configs.cursorConfig}
                        label="Cursor"
                        onCopy={copyConfig}
                        hint="抄到 ~/.cursor/mcp.json"
                      />
                    ),
                  },
                  {
                    key: "claude-code",
                    label: "Claude Code (CLI) ✨",
                    children: claudeCodeTpl ? (
                      <ClaudeCodeBlock
                        tpl={claudeCodeTpl}
                        onCopy={copyConfig}
                        onSaveAs={() => void saveClaudeMdAs()}
                        onOpenClaudeDir={() => void openClaudeDir()}
                      />
                    ) : (
                      <Empty description="模板未加载" />
                    ),
                  },
                ]}
              />
            </div>
          )}

          {/* ─── 12 工具列表（折叠） ─────────────────── */}
          <Collapse
            size="small"
            items={[
              {
                key: "tools",
                label: `内置工具 · ${tools.length} 个（kb-core 实现，sidecar 与自家 AI 对话页共享）`,
                children: tools.length === 0 ? (
                  <Empty description="未加载到工具" />
                ) : (
                  <List
                    size="small"
                    dataSource={tools}
                    renderItem={(t) => (
                      <List.Item>
                        <List.Item.Meta
                          title={
                            <Space>
                              <code style={{ fontSize: 13 }}>{t.name}</code>
                              {t.name.startsWith("create_") ||
                              t.name.startsWith("update_") ||
                              t.name.startsWith("add_") ? (
                                <Tag color="orange">写</Tag>
                              ) : (
                                <Tag color="blue">读</Tag>
                              )}
                            </Space>
                          }
                          description={
                            <Text style={{ fontSize: 12 }} type="secondary">
                              {t.description || "（无说明）"}
                            </Text>
                          }
                        />
                      </List.Item>
                    )}
                  />
                ),
              },
            ]}
          />

          <Divider style={{ margin: "16px 0" }} />

          {/* ─── 外部 MCP servers（用户加的 GitHub / Filesystem / 等） ─── */}
          <ExternalServersSubsection
            sidecarBinaryPath={info.sidecarBinaryPath}
            dbPath={info.dbPath}
          />

          {/* ─── 文档链接 ─────────────────────────────── */}
          <div className="mt-4 text-right">
            <Button
              type="link"
              size="small"
              icon={<ExternalLink size={12} />}
              onClick={() =>
                void openUrl(
                  "https://gitee.com/bkywksj/knowledge-base/blob/master/docs/mcp-setup.md",
                ).catch((e) => message.error(`打开文档失败: ${e}`))
              }
            >
              详细文档：docs/mcp-setup.md
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

// ─── 外部 MCP servers 子区域 ─────────────────────────────────────

interface ExternalServersSubsectionProps {
  sidecarBinaryPath: string | null;
  dbPath: string;
}

function ExternalServersSubsection({ sidecarBinaryPath, dbPath }: ExternalServersSubsectionProps) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm<McpServerInput & { argsText: string; envText: string }>();

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const list = await invoke<McpServer[]>("mcp_list_servers");
      setServers(list);
    } catch (e) {
      message.error(`加载外部 MCP server 列表失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({ enabled: true, argsText: "[]", envText: "{}" });
    setModalOpen(true);
  }

  function openEdit(s: McpServer) {
    setEditingId(s.id);
    form.setFieldsValue({
      name: s.name,
      command: s.command,
      enabled: s.enabled,
      argsText: JSON.stringify(s.args, null, 2),
      envText: JSON.stringify(s.env, null, 2),
    });
    setModalOpen(true);
  }

  // 一键添加自家 kb-mcp 作为外部 server（dogfooding）
  async function quickAddSelf() {
    if (!sidecarBinaryPath) {
      message.warning("还没找到 kb-mcp binary，先 pnpm build:mcp");
      return;
    }
    try {
      await invoke<McpServer>("mcp_create_server", {
        input: {
          name: "kb-mcp (self)",
          transport: "stdio",
          command: sidecarBinaryPath,
          args: ["--db-path", dbPath],
          env: {},
          enabled: true,
        } as McpServerInput,
      });
      message.success("已添加 kb-mcp 自身作为外部 server，可点 「列出工具」 测试");
      void load();
    } catch (e) {
      message.error(`添加失败: ${e}`);
    }
  }

  async function handleSave() {
    try {
      const v = await form.validateFields();
      let args: string[];
      let env: Record<string, string>;
      try {
        args = JSON.parse(v.argsText || "[]");
        if (!Array.isArray(args)) throw new Error("args 必须是 JSON 数组");
      } catch (e) {
        message.error(`args JSON 解析失败: ${e}`);
        return;
      }
      try {
        env = JSON.parse(v.envText || "{}");
        if (typeof env !== "object" || Array.isArray(env)) throw new Error("env 必须是 JSON object");
      } catch (e) {
        message.error(`env JSON 解析失败: ${e}`);
        return;
      }

      const input: McpServerInput = {
        name: v.name,
        transport: "stdio",
        command: v.command,
        args,
        env,
        enabled: v.enabled,
      };

      if (editingId === null) {
        await invoke<McpServer>("mcp_create_server", { input });
        message.success("已创建");
      } else {
        await invoke<McpServer>("mcp_update_server", { id: editingId, input });
        message.success("已更新（client 缓存已清，下次调用重新 spawn）");
      }
      setModalOpen(false);
      void load();
    } catch (e) {
      // antd Form validate 会 throw，无需额外报错
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(`保存失败: ${e}`);
    }
  }

  async function handleDelete(id: number) {
    try {
      await invoke("mcp_delete_server", { id });
      message.success("已删除");
      void load();
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  }

  async function handleToggleEnabled(id: number, enabled: boolean) {
    try {
      await invoke("mcp_set_server_enabled", { id, enabled });
      void load();
    } catch (e) {
      message.error(`切换失败: ${e}`);
    }
  }

  async function handleListTools(id: number, name: string) {
    const hide = message.loading(`正在 spawn ${name} ...`, 0);
    try {
      const tools = await invoke<{ name: string }[]>("mcp_external_list_tools", {
        serverId: id,
      });
      hide();
      Modal.info({
        title: `${name} · ${tools.length} 个工具`,
        width: 600,
        content: (
          <div style={{ maxHeight: 400, overflow: "auto" }}>
            <pre style={{ fontSize: 12 }}>{JSON.stringify(tools, null, 2)}</pre>
          </div>
        ),
      });
    } catch (e) {
      hide();
      message.error(`列出工具失败: ${e}`);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <Text strong>外部 MCP servers · {servers.length}</Text>
        <Space>
          <Button size="small" icon={<PlusOutlined />} onClick={quickAddSelf}>
            一键添加 kb-mcp（自我集成测试）
          </Button>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreate}>
            添加 server
          </Button>
        </Space>
      </div>

      {servers.length === 0 ? (
        <Empty
          description="还没有外部 MCP server。试试「一键添加 kb-mcp」自我集成测试，或加 GitHub/Filesystem/高德地图 等第三方 server"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={servers}
          pagination={false}
          columns={[
            { title: "名称", dataIndex: "name", width: 150 },
            {
              title: "Command",
              dataIndex: "command",
              ellipsis: true,
              render: (v: string, r: McpServer) => (
                <Tooltip title={`${v} ${r.args.join(" ")}`}>
                  <code style={{ fontSize: 12 }}>{v}</code>
                </Tooltip>
              ),
            },
            {
              title: "启用",
              dataIndex: "enabled",
              width: 70,
              render: (v: boolean, r: McpServer) => (
                <Switch
                  size="small"
                  checked={v}
                  onChange={(checked) => void handleToggleEnabled(r.id, checked)}
                />
              ),
            },
            {
              title: "操作",
              width: 220,
              render: (_, r: McpServer) => (
                <Space size="small">
                  <Button
                    size="small"
                    onClick={() => void handleListTools(r.id, r.name)}
                    disabled={!r.enabled}
                  >
                    列出工具
                  </Button>
                  <Button size="small" onClick={() => openEdit(r)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除该 MCP server？"
                    onConfirm={() => void handleDelete(r.id)}
                  >
                    <Button danger size="small" icon={<Trash2 size={12} />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      )}

      <Modal
        title={editingId === null ? "添加 MCP server" : "编辑 MCP server"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleSave()}
        width={640}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="名称（唯一）"
            rules={[{ required: true, message: "必填" }]}
          >
            <Input placeholder="github / 高德地图 / filesystem" />
          </Form.Item>
          <Form.Item
            name="command"
            label="可执行文件路径或命令"
            rules={[{ required: true, message: "必填" }]}
            extra="例：npx / 绝对路径 / kb-mcp.exe"
          >
            <Input placeholder="C:/path/to/kb-mcp.exe 或 npx" />
          </Form.Item>
          <Form.Item
            name="argsText"
            label="参数（JSON 数组）"
            extra='例：["-y", "@modelcontextprotocol/server-github"]'
          >
            <Input.TextArea rows={3} style={{ fontFamily: "monospace" }} />
          </Form.Item>
          <Form.Item
            name="envText"
            label="环境变量（JSON 对象）"
            extra='例：{"GITHUB_TOKEN": "ghp_..."}'
          >
            <Input.TextArea rows={3} style={{ fontFamily: "monospace" }} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

interface ConfigBlockProps {
  json: string;
  label: string;
  hint: string;
  onCopy: (json: string, label: string) => void;
}

function ConfigBlock({ json, label, hint, onCopy }: ConfigBlockProps) {
  return (
    <div>
      <Alert type="info" showIcon message={hint} className="mb-2" />
      <pre
        style={{
          background: "var(--ant-color-fill-quaternary)",
          padding: 12,
          borderRadius: 6,
          fontSize: 12,
          maxHeight: 200,
          overflow: "auto",
          margin: 0,
        }}
      >
        {json}
      </pre>
      <div className="mt-2 text-right">
        <Button size="small" icon={<CopyOutlined />} onClick={() => onCopy(json, label)}>
          复制 JSON
        </Button>
      </div>
    </div>
  );
}

// ─── Claude Code (CLI) Tab 块：CLAUDE.md + settings.json 片段 ──────────

interface ClaudeCodeBlockProps {
  tpl: ClaudeCodeTemplate;
  onCopy: (text: string, label: string) => void;
  onSaveAs: () => void;
  onOpenClaudeDir: () => void;
}

function ClaudeCodeBlock({ tpl, onCopy, onSaveAs, onOpenClaudeDir }: ClaudeCodeBlockProps) {
  return (
    <div className="space-y-3">
      <Alert
        type="info"
        showIcon
        message="把这里的两段文本放到你的 Claude Code 配置里"
        description={
          <ol style={{ marginBottom: 0, paddingLeft: 20 }}>
            <li>
              <code>CLAUDE.md</code> 复制 / 另存为到某个项目根（或 <code>~/.claude/CLAUDE.md</code>），
              告诉 Claude 怎么用知识库工具
            </li>
            <li>
              <code>settings.json</code> 片段合并到 <code>~/.claude/settings.json</code>
              （或项目级 <code>.claude/settings.json</code>），让 Claude 真有工具能力
            </li>
            <li>
              在某个项目目录里跑 <code>claude</code>，对话里说「找一下我笔记里关于 X」试试
            </li>
          </ol>
        }
      />

      {/* CLAUDE.md 块 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <Text strong style={{ fontSize: 13 }}>
            📄 CLAUDE.md（行为指引，纯文字）
          </Text>
          <Space size="small">
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => onCopy(tpl.claudeMd, "CLAUDE.md")}
            >
              复制
            </Button>
            <Button size="small" onClick={onSaveAs}>
              💾 另存为...
            </Button>
          </Space>
        </div>
        <pre
          style={{
            background: "var(--ant-color-fill-quaternary)",
            padding: 12,
            borderRadius: 6,
            fontSize: 12,
            maxHeight: 240,
            overflow: "auto",
            margin: 0,
          }}
        >
          {tpl.claudeMd}
        </pre>
      </div>

      {/* settings.json 片段（只读 / 可写两种） */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <Text strong style={{ fontSize: 13 }}>
            ⚙️ settings.json 片段（MCP 能力）
          </Text>
          <Button size="small" onClick={onOpenClaudeDir}>
            🗂 打开 ~/.claude/ 目录
          </Button>
        </div>
        <Tabs
          size="small"
          items={[
            {
              key: "ro",
              label: "只读模式（推荐）",
              children: (
                <SnippetBlock
                  json={tpl.settingsSnippetReadonly}
                  label="settings.json 只读"
                  hint="LLM 只能搜不能改你的笔记。安全默认。"
                  onCopy={onCopy}
                />
              ),
            },
            {
              key: "rw",
              label: "可写模式（高级）",
              children: (
                <SnippetBlock
                  json={tpl.settingsSnippetWritable}
                  label="settings.json 可写"
                  hint="加 --writable 后 Claude 能 create_note / update_note / add_tag_to_note。慎用。"
                  onCopy={onCopy}
                />
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}

interface SnippetBlockProps {
  json: string;
  label: string;
  hint: string;
  onCopy: (text: string, label: string) => void;
}

function SnippetBlock({ json, label, hint, onCopy }: SnippetBlockProps) {
  return (
    <div>
      <Alert type="warning" showIcon message={hint} className="mb-2" />
      <pre
        style={{
          background: "var(--ant-color-fill-quaternary)",
          padding: 12,
          borderRadius: 6,
          fontSize: 12,
          maxHeight: 200,
          overflow: "auto",
          margin: 0,
        }}
      >
        {json}
      </pre>
      <div className="mt-2 text-right">
        <Button size="small" icon={<CopyOutlined />} onClick={() => onCopy(json, label)}>
          复制 JSON
        </Button>
      </div>
    </div>
  );
}
