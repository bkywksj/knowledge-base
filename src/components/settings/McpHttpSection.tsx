import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Input,
  InputNumber,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import { CopyOutlined, ReloadOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

const { Text, Paragraph } = Typography;

interface McpHttpConfig {
  enabled: boolean;
  port: number;
  token: string;
  writable: boolean;
  bindLan: boolean;
}

interface McpHttpStatus {
  running: boolean;
  addr: string | null;
  endpoint: string | null;
}

/**
 * MCP HTTP 服务配置区。
 *
 * 把自家知识库以 Streamable HTTP 暴露给外部 agent —— 对方不用能 spawn 进程
 * （stdio 的前提），Web 端 / 局域网里的 agent 也能连。
 *
 * 这是**对外暴露面**，UI 上刻意做了几件事：
 * · Token 默认打码，点一下才看；换 Token 是显式动作
 * · 「允许局域网访问」用红色警示 Alert，不藏在折叠区里
 * · 「允许写入」单独开关，默认关（外部 agent 默认只能读）
 */
export function McpHttpSection() {
  const { message } = AntdApp.useApp();
  const [cfg, setCfg] = useState<McpHttpConfig | null>(null);
  const [status, setStatus] = useState<McpHttpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([
        invoke<McpHttpConfig>("get_mcp_http_config"),
        invoke<McpHttpStatus>("get_mcp_http_status"),
      ]);
      setCfg(c);
      setStatus(s);
    } catch (e) {
      message.error(`读取 MCP HTTP 配置失败：${e}`);
    }
  }, [message]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!cfg) return null;

  const patch = (p: Partial<McpHttpConfig>) => setCfg({ ...cfg, ...p });

  async function handleToggle(next: boolean) {
    if (!cfg) return;
    setBusy(true);
    try {
      const s = next
        ? await invoke<McpHttpStatus>("start_mcp_http", {
            port: cfg.port,
            writable: cfg.writable,
            bindLan: cfg.bindLan,
          })
        : await invoke<McpHttpStatus>("stop_mcp_http");
      setStatus(s);
      patch({ enabled: next });
      // 首次启动会自动生成 Token，回读一次让界面显示出来
      if (next) await refresh();
      message.success(next ? "MCP HTTP 服务已启动" : "已停止");
    } catch (e) {
      message.error(`${next ? "启动" : "停止"}失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  /** 改了端口 / 只读 / 局域网后需要重启才生效 */
  async function handleRestart() {
    if (!cfg) return;
    setBusy(true);
    try {
      const s = await invoke<McpHttpStatus>("start_mcp_http", {
        port: cfg.port,
        writable: cfg.writable,
        bindLan: cfg.bindLan,
      });
      setStatus(s);
      message.success("已按新配置重启");
    } catch (e) {
      message.error(`重启失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRegenerate() {
    setBusy(true);
    try {
      const token = await invoke<string>("regenerate_mcp_http_token");
      patch({ token });
      message.success(
        status?.running
          ? "已生成新 Token —— 点「应用并重启」后旧 Token 才会失效"
          : "已生成新 Token",
      );
    } catch (e) {
      message.error(`生成失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 pt-3" style={{ borderTop: "1px solid #f0f0f0" }}>
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Text strong>HTTP 服务（供外部 agent 调用）</Text>
            {status?.running ? (
              <Tag color="success">运行中</Tag>
            ) : (
              <Tag>未启动</Tag>
            )}
          </div>
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            把本知识库的 MCP 工具以 HTTP 暴露出去。对方不需要能启动进程（那是 stdio
            方式的前提），浏览器插件 / 局域网里的 agent 都能连。默认关闭。
          </Paragraph>
        </div>
        <Switch checked={cfg.enabled} loading={busy} onChange={handleToggle} />
      </div>

      {cfg.enabled && (
        <div className="mt-3 pl-3" style={{ borderLeft: "2px solid #f0f0f0" }}>
          {status?.endpoint && (
            <Alert
              type="success"
              showIcon
              className="mb-3"
              message={
                <Space size={4} wrap>
                  <span>端点：</span>
                  <Text code copyable>
                    {status.endpoint}
                  </Text>
                </Space>
              }
              description="客户端按 Streamable HTTP 方式连接，并在请求头带上 Authorization: Bearer <Token>"
            />
          )}

          <div className="flex items-center gap-2 py-1 flex-wrap">
            <span className="text-xs shrink-0" style={{ color: "#8c8c8c", width: 64 }}>
              端口
            </span>
            <InputNumber
              size="small"
              min={1024}
              max={65535}
              value={cfg.port}
              onChange={(v) => patch({ port: Number(v) || 8765 })}
              style={{ width: 120 }}
            />
            <Button size="small" loading={busy} onClick={handleRestart}>
              应用并重启
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              改端口 / 权限 / 网络范围后需重启才生效
            </Text>
          </div>

          <div className="flex items-center gap-2 py-1 flex-wrap">
            <span className="text-xs shrink-0" style={{ color: "#8c8c8c", width: 64 }}>
              Token
            </span>
            <Input.Password
              size="small"
              readOnly
              value={cfg.token}
              visibilityToggle={{
                visible: showToken,
                onVisibleChange: setShowToken,
              }}
              style={{ flex: 1, minWidth: 240, fontFamily: "monospace" }}
            />
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => {
                navigator.clipboard
                  .writeText(cfg.token)
                  .then(() => message.success("已复制"))
                  .catch((err) => message.error(String(err)));
              }}
            >
              复制
            </Button>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={busy}
              onClick={handleRegenerate}
            >
              换一个
            </Button>
          </div>

          {/* 一键把「端点 + Token + 请求头」整份给出去。
              用户反馈：拿浏览器插件连过来一律 HTTP 401 —— 端点和 Token 虽然各自
              能复制，但要用户自己意识到"还得配一个 Authorization 头"。这里直接
              产出可粘贴的配置，少一步猜。 */}
          {status?.running && (
            <div className="flex items-center gap-2 py-1 flex-wrap">
              <span
                className="text-xs shrink-0"
                style={{ color: "#8c8c8c", width: 64 }}
              >
                快速接入
              </span>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => {
                  const json = JSON.stringify(
                    {
                      url: status.endpoint,
                      transport: "streamable-http",
                      headers: { Authorization: `Bearer ${cfg.token}` },
                    },
                    null,
                    2,
                  );
                  navigator.clipboard
                    .writeText(json)
                    .then(() => message.success("已复制连接配置（含 Token）"))
                    .catch((err) => message.error(String(err)));
                }}
              >
                复制连接配置 (JSON)
              </Button>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => {
                  navigator.clipboard
                    .writeText(`Authorization: Bearer ${cfg.token}`)
                    .then(() => message.success("已复制请求头"))
                    .catch((err) => message.error(String(err)));
                }}
              >
                复制请求头
              </Button>
              <Text type="secondary" style={{ fontSize: 12 }}>
                本服务是 MCP 协议，接不了思源 API / Obsidian Local REST 那类接口
              </Text>
            </div>
          )}

          <div className="flex items-center justify-between py-1">
            <div>
              <div style={{ fontSize: 13 }}>允许写入</div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                关闭时外部 agent 只能读（搜索 / 读笔记 / 列标签）；打开后它能创建和修改你的笔记
              </Text>
            </div>
            <Switch
              checked={cfg.writable}
              onChange={(v) => patch({ writable: v })}
            />
          </div>

          <div className="flex items-center justify-between py-1">
            <div>
              <div style={{ fontSize: 13 }}>允许局域网访问</div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                关闭 = 只有本机能连（推荐）；打开后同一网络下的其他设备也能连
              </Text>
            </div>
            <Switch
              checked={cfg.bindLan}
              onChange={(v) => patch({ bindLan: v })}
            />
          </div>

          {cfg.bindLan && (
            <Alert
              type="warning"
              showIcon
              className="mt-2"
              message="局域网访问已开启"
              description={
                <span style={{ fontSize: 12 }}>
                  同一网络下的任何设备都能尝试连接，此时 <strong>Token 是唯一的防线</strong>。
                  不要把 Token 贴进聊天记录 / 截图 / 公开仓库；在公共 WiFi（咖啡馆、酒店）下
                  建议关掉这个开关。
                  {cfg.writable && (
                    <>
                      <br />
                      <strong style={{ color: "#cf1322" }}>
                        当前还同时开着「允许写入」—— 拿到 Token 的人可以任意修改你的笔记。
                      </strong>
                    </>
                  )}
                </span>
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
