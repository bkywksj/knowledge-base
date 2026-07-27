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
  Checkbox,
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
import { McpHttpSection } from "./McpHttpSection";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { MarkdownContent as Markdown } from "@/components/ai/MarkdownContent";
import { save as saveDialog, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { systemApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { McpServer, McpServerInput } from "@/types";

interface ClaudeCodeTemplate {
  claudeMd: string;
  settingsSnippetReadonly: string;
  settingsSnippetWritable: string;
}

type InstallTarget = "claudedesktop" | "cursor" | "claudecode";

interface InstallResult {
  configPath: string;
  createdNew: boolean;
  overwritten: boolean;
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
  // #5 工具白名单裁剪：全量目录(27) + 当前启用集合
  const [allTools, setAllTools] = useState<{ name: string; description: string }[]>([]);
  const [enabledTools, setEnabledTools] = useState<Set<string>>(new Set());
  const [whitelistDirty, setWhitelistDirty] = useState(false);
  const [savingWhitelist, setSavingWhitelist] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<string | null>(null);
  const [claudeCodeTpl, setClaudeCodeTpl] = useState<ClaudeCodeTemplate | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  const [docContent, setDocContent] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const aiWritable = useAppStore((s) => s.aiWritable);
  const setAiWritable = useAppStore((s) => s.setAiWritable);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [i, t, tpl, all, keep] = await Promise.all([
        invoke<McpRuntimeInfo>("mcp_runtime_info"),
        invoke<McpToolInfo[]>("mcp_internal_list_tools").catch(() => [] as McpToolInfo[]),
        invoke<ClaudeCodeTemplate>("mcp_get_claude_md_template").catch(() => null),
        invoke<{ name: string; description: string }[]>("mcp_list_all_tools").catch(
          () => [] as { name: string; description: string }[],
        ),
        invoke<string[]>("mcp_get_tool_whitelist").catch(() => [] as string[]),
      ]);
      setInfo(i);
      setTools(t);
      setClaudeCodeTpl(tpl);
      setAllTools(all);
      // 白名单为空 = 不过滤（全部启用）；否则启用集合 = 白名单
      setEnabledTools(
        new Set(keep.length ? keep : all.map((x) => x.name)),
      );
      setWhitelistDirty(false);
    } catch (e) {
      message.error(`加载 MCP 信息失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  // #5 保存工具白名单。全选 = 存空数组（不过滤）；否则存启用的工具名。
  async function saveWhitelist() {
    setSavingWhitelist(true);
    try {
      const enabled = Array.from(enabledTools);
      const payload = enabled.length === allTools.length ? [] : enabled;
      await invoke("mcp_set_tool_whitelist", { tools: payload });
      setWhitelistDirty(false);
      message.success(
        "已保存。自家 AI 对话重启应用后生效；外部客户端重连 kb-mcp 后生效",
      );
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setSavingWhitelist(false);
    }
  }

  function toggleTool(name: string, checked: boolean) {
    setEnabledTools((prev) => {
      const next = new Set(prev);
      if (checked) next.add(name);
      else next.delete(name);
      next.add("ping"); // ping 始终保留（健康检查）
      return next;
    });
    setWhitelistDirty(true);
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

  // 打开「详细文档」弹窗（首次点击时懒加载内容）
  async function openDoc() {
    setDocOpen(true);
    if (docContent !== null) return; // 已加载过，直接复用
    setDocLoading(true);
    try {
      const md = await invoke<string>("mcp_get_setup_doc");
      setDocContent(md);
    } catch (e) {
      message.error(`加载文档失败: ${e}`);
    } finally {
      setDocLoading(false);
    }
  }

  // 一键安装到客户端配置文件（自动 merge JSON，不覆盖已有 server）
  async function handleInstall(target: InstallTarget, writable: boolean, label: string) {
    try {
      const r = await invoke<InstallResult>("mcp_install_to_client", {
        target,
        writable,
      });
      Modal.success({
        title: `已安装到 ${label}`,
        width: 540,
        content: (
          <div className="space-y-2">
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                配置文件路径
              </Text>
              <Paragraph
                copyable={{ text: r.configPath }}
                style={{ margin: 0, fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}
              >
                {r.configPath}
              </Paragraph>
            </div>
            <Alert
              type={r.overwritten ? "warning" : "info"}
              showIcon
              message={
                r.createdNew
                  ? "已新建配置文件并写入"
                  : r.overwritten
                    ? "已覆盖原有的 knowledge-base 配置（其它 MCP server 保留）"
                    : "已合并到现有配置（其它 MCP server 保留）"
              }
              description={`重启 ${label} 后生效${writable ? "（已开启可写模式，LLM 能修改你的笔记）" : ""}`}
            />
          </div>
        ),
      });
    } catch (e) {
      message.error(`安装失败: ${e}`);
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
          {/* ─── 内置 MCP · AI 写权限开关 ─────────────────── */}
          <Alert
            type={aiWritable ? "warning" : "info"}
            showIcon
            className="mb-4"
            message={
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <span>
                  <Text strong>允许 AI 修改我的知识库</Text>
                  <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                    （内置 AI 问答页用的 MCP server）
                  </Text>
                </span>
                <Switch
                  checked={aiWritable}
                  onChange={async (v) => {
                    try {
                      await setAiWritable(v);
                      message.success(
                        v
                          ? "已允许 AI 创建/修改/删除你的笔记"
                          : "已切回只读，AI 只能搜索不能改",
                      );
                    } catch (e) {
                      message.error(`切换失败：${e}`);
                    }
                  }}
                  checkedChildren="可写"
                  unCheckedChildren="只读"
                />
              </div>
            }
            description={
              aiWritable
                ? "开启后，AI 可调用 create_note / update_note / delete_note / move_notes_batch / add_tag_to_note 等 11 个写工具。批量删除/移动前请让 AI 先列计划再确认。"
                : "关闭后，AI 调用任何写工具都会被后端拦截并返回友好错误，相当于安全只读模式。"
            }
          />

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
                    key: "claude-code",
                    label: "Claude Code (CLI) ✨",
                    children: claudeCodeTpl ? (
                      <ClaudeCodeBlock
                        tpl={claudeCodeTpl}
                        onCopy={copyConfig}
                        onSaveAs={() => void saveClaudeMdAs()}
                        onOpenClaudeDir={() => void openClaudeDir()}
                        onInstall={handleInstall}
                      />
                    ) : (
                      <Empty description="模板未加载" />
                    ),
                  },
                  {
                    key: "claude-ro",
                    label: "Claude Desktop（只读）",
                    children: (
                      <ConfigBlock
                        json={configs.claudeConfig}
                        label="Claude Desktop 只读"
                        onCopy={copyConfig}
                        onInstall={handleInstall}
                        installer={{
                          target: "claudedesktop",
                          writable: false,
                          clientLabel: "Claude Desktop",
                        }}
                        hint="LLM 只能搜不能改你的笔记。手动方式：抄到 %APPDATA%\\Claude\\claude_desktop_config.json"
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
                        onInstall={handleInstall}
                        installer={{
                          target: "claudedesktop",
                          writable: true,
                          clientLabel: "Claude Desktop",
                        }}
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
                        onInstall={handleInstall}
                        installer={{
                          target: "cursor",
                          writable: false,
                          clientLabel: "Cursor",
                        }}
                        hint="手动方式：抄到 ~/.cursor/mcp.json"
                      />
                    ),
                  },
                ]}
              />
            </div>
          )}

          {/* ─── 工具清单 + 白名单裁剪（#5：勾选保留哪些，省 token） ─────── */}
          <Collapse
            size="small"
            items={[
              {
                key: "tools",
                label: `内置工具 · 共 ${allTools.length} 个（勾选保留哪些，裁剪可给外部 agent / 自家 AI 省 token）`,
                children: allTools.length === 0 ? (
                  <Empty description="未加载到工具" />
                ) : (
                  <div>
                    <Space style={{ marginBottom: 8 }} wrap>
                      <Button
                        size="small"
                        onClick={() => {
                          setEnabledTools(new Set(allTools.map((x) => x.name)));
                          setWhitelistDirty(true);
                        }}
                      >
                        全选
                      </Button>
                      <Button
                        size="small"
                        onClick={() => {
                          setEnabledTools(new Set(["ping"]));
                          setWhitelistDirty(true);
                        }}
                      >
                        仅保留 ping
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        loading={savingWhitelist}
                        disabled={!whitelistDirty}
                        onClick={() => void saveWhitelist()}
                      >
                        保存裁剪
                      </Button>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        已选 {enabledTools.size}/{allTools.length}
                      </Text>
                    </Space>
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 8 }}
                      message="生效时机：自家 AI 对话重启应用后生效；外部客户端（Claude Desktop 等）重连 kb-mcp 后生效，无需改客户端配置。全选 = 不裁剪。"
                    />
                    <List
                      size="small"
                      dataSource={allTools}
                      renderItem={(t) => {
                        const isWrite =
                          t.name.startsWith("create_") ||
                          t.name.startsWith("update_") ||
                          t.name.startsWith("add_") ||
                          t.name.startsWith("delete_") ||
                          t.name.startsWith("remove_") ||
                          t.name.startsWith("restore_") ||
                          t.name.startsWith("move_");
                        return (
                          <List.Item>
                            <div style={{ width: "100%" }}>
                              <Checkbox
                                checked={enabledTools.has(t.name)}
                                disabled={t.name === "ping"}
                                onChange={(e) =>
                                  toggleTool(t.name, e.target.checked)
                                }
                              >
                                <Space>
                                  <code style={{ fontSize: 13 }}>{t.name}</code>
                                  {isWrite ? (
                                    <Tag color="orange">写</Tag>
                                  ) : (
                                    <Tag color="blue">读</Tag>
                                  )}
                                </Space>
                              </Checkbox>
                              <div style={{ marginLeft: 24 }}>
                                <Text style={{ fontSize: 12 }} type="secondary">
                                  {t.description || "（无说明）"}
                                </Text>
                              </div>
                            </div>
                          </List.Item>
                        );
                      }}
                    />
                  </div>
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

          {/* ─── 文档（应用内弹窗，不跳浏览器） ─────────── */}
          <div className="mt-4 text-right">
            <Button
              type="link"
              size="small"
              icon={<ExternalLink size={12} />}
              onClick={() => void openDoc()}
            >
              查看详细文档
            </Button>
          </div>

          <Modal
            title="📖 MCP 接入完整指南（docs/mcp-setup.md）"
            open={docOpen}
            onCancel={() => setDocOpen(false)}
            footer={null}
            width={900}
            destroyOnClose={false}
          >
            <div
              style={{
                maxHeight: "70vh",
                overflow: "auto",
                paddingRight: 8,
              }}
              className="kb-markdown-doc"
            >
              {docLoading && <Empty description="加载中..." />}
              {!docLoading && docContent && <Markdown>{docContent}</Markdown>}
              {!docLoading && !docContent && <Empty description="文档未加载" />}
            </div>
          </Modal>
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

  // #8 安装插件：选 kb-plugin.json → 后端读文件解析 + 创建外部 MCP server
  async function installPlugin() {
    const file = await openFileDialog({
      multiple: false,
      filters: [{ name: "插件清单", extensions: ["json"] }],
      title: "选择 kb-plugin.json",
    });
    if (!file) return;
    try {
      await invoke<McpServer>("plugin_install_from_file", { path: file as string });
      message.success("插件已安装，可在下方列表点「列出工具」验证");
      void load();
    } catch (e) {
      message.error(`安装失败: ${e}`);
    }
  }

  // #8 创建插件：选目录 → 生成可直接 coding 的 Node MCP 插件脚手架
  async function createPlugin() {
    const dir = await openFileDialog({ directory: true, title: "选择放插件的目录" });
    if (!dir) return;
    let name = "my-plugin";
    Modal.confirm({
      title: "创建插件脚手架",
      content: (
        <div>
          <p style={{ marginBottom: 8 }}>
            将在所选目录下生成一个可直接 coding 的 Node MCP 插件模板（kb-plugin.json + server.mjs + package.json + README）。
          </p>
          <Input
            defaultValue={name}
            placeholder="插件名（作为目录名 + server 别名）"
            onChange={(e) => {
              name = e.target.value;
            }}
          />
        </div>
      ),
      okText: "生成",
      onOk: async () => {
        try {
          const created = await invoke<string>("plugin_scaffold", {
            parentDir: dir as string,
            name: name.trim() || "my-plugin",
          });
          Modal.success({
            title: "插件脚手架已生成",
            content: (
              <div>
                <p style={{ marginBottom: 4 }}>目录：</p>
                <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
                  {created}
                </p>
                <p style={{ marginTop: 8 }}>
                  下一步：进该目录 <code>npm install</code> → 编辑 <code>server.mjs</code> 加你的工具 →
                  回来用「安装插件」导入它的 <code>kb-plugin.json</code>。
                </p>
              </div>
            ),
            okText: "打开文件夹",
            onOk: () => revealItemInDir(created).catch(() => {}),
          });
        } catch (e) {
          message.error(`生成失败: ${e}`);
        }
      },
    });
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
        <Text strong>外部 MCP servers / 插件 · {servers.length}</Text>
        <Space wrap>
          <Button size="small" icon={<PlusOutlined />} onClick={installPlugin}>
            安装插件（导入清单）
          </Button>
          <Button size="small" onClick={createPlugin}>
            创建插件（脚手架）
          </Button>
          <Button size="small" icon={<PlusOutlined />} onClick={quickAddSelf}>
            一键添加 kb-mcp
          </Button>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreate}>
            添加 server
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        className="mb-2"
        message="插件 = 一个 stdio MCP server（任意语言写都行，进程隔离最安全）。「创建插件」生成脚手架开始 coding，「安装插件」从 kb-plugin.json 一键装入；安装后即出现在下方列表。"
      />

      {servers.length === 0 ? (
        <Empty
          description="还没有插件 / 外部 MCP server。点「创建插件」生成脚手架开始写，或「安装插件」导入 kb-plugin.json，也可「一键添加 kb-mcp」自我集成测试"
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

      {/* HTTP 服务：把自家工具暴露给外部 agent（与上面"调用别人的 MCP"是反方向） */}
      <McpHttpSection />
    </div>
  );
}

interface ConfigBlockProps {
  json: string;
  label: string;
  hint: string;
  onCopy: (json: string, label: string) => void;
  /// 提供时显示「一键安装」按钮，自动 merge JSON 到客户端配置文件
  installer?: { target: InstallTarget; writable: boolean; clientLabel: string };
  onInstall?: (target: InstallTarget, writable: boolean, label: string) => void;
}

function ConfigBlock({ json, label, hint, onCopy, installer, onInstall }: ConfigBlockProps) {
  return (
    <div>
      {installer && onInstall && (
        <Alert
          type="success"
          showIcon
          message={`点击下方「一键安装」按钮自动 merge 到 ${installer.clientLabel} 配置文件`}
          description="不会覆盖你已有的其它 MCP server 配置；如已存在 knowledge-base 条目会更新为最新配置"
          className="mb-2"
        />
      )}
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
        <Space>
          {installer && onInstall && (
            <Button
              type="primary"
              size="small"
              onClick={() => onInstall(installer.target, installer.writable, installer.clientLabel)}
            >
              ⚡ 一键安装到 {installer.clientLabel}
            </Button>
          )}
          <Button size="small" icon={<CopyOutlined />} onClick={() => onCopy(json, label)}>
            复制 JSON
          </Button>
        </Space>
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
  onInstall: (target: InstallTarget, writable: boolean, label: string) => void;
}

function ClaudeCodeBlock({ tpl, onCopy, onSaveAs, onOpenClaudeDir, onInstall }: ClaudeCodeBlockProps) {
  // 注：不用 space-y-* —— TailwindCSS 4 的 space utilities 在 antd 组件嵌套
  // 场景下偶尔被覆盖（Alert 内部样式优先级），改用每块显式 mt-5 兜底。
  return (
    <div>
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
              <strong>「一键安装到 Claude Code」</strong>会把 mcpServers 自动写到{" "}
              <code>~/.claude.json</code>（与 tauri-cc 同一份文件，merge 不覆盖其它 server）；
              不想自动写也可以复制下方 JSON 自己改
            </li>
            <li>
              在某个项目目录里跑 <code>claude</code>，对话里说「找一下我笔记里关于 X」试试
            </li>
          </ol>
        }
      />

      {/* CLAUDE.md 块 */}
      <div className="mt-5">
        <div className="flex items-center justify-between mb-2">
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
      <div className="mt-5">
        <div className="flex items-center justify-between mb-2">
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
                  installer={{ target: "claudecode", writable: false, clientLabel: "Claude Code" }}
                  onInstall={onInstall}
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
                  installer={{ target: "claudecode", writable: true, clientLabel: "Claude Code" }}
                  onInstall={onInstall}
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
  installer?: { target: InstallTarget; writable: boolean; clientLabel: string };
  onInstall?: (target: InstallTarget, writable: boolean, label: string) => void;
}

function SnippetBlock({ json, label, hint, onCopy, installer, onInstall }: SnippetBlockProps) {
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
        <Space>
          {installer && onInstall && (
            <Button
              type="primary"
              size="small"
              onClick={() => onInstall(installer.target, installer.writable, installer.clientLabel)}
            >
              ⚡ 一键安装到 {installer.clientLabel}（写 ~/.claude.json）
            </Button>
          )}
          <Button size="small" icon={<CopyOutlined />} onClick={() => onCopy(json, label)}>
            复制 JSON
          </Button>
        </Space>
      </div>
    </div>
  );
}
