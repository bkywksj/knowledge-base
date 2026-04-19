import { useEffect, useState } from "react";
import { Card, Typography, Descriptions, Spin, message, Button, Tooltip } from "antd";
import { FolderOpen, Copy } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { SystemInfo } from "@/types";
import { systemApi } from "@/lib/api";
import { RecommendCards } from "@/components/ui/RecommendCards";

const { Title, Text } = Typography;

export default function AboutPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    systemApi
      .getSystemInfo()
      .then(setInfo)
      .catch((e) => message.error(String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function handleOpenDataDir() {
    if (!info?.dataDir) return;
    try {
      await openPath(info.dataDir);
    } catch (e) {
      message.error(`打开目录失败: ${e}`);
    }
  }

  async function handleCopyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      message.success("已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  }

  const dbPath = info ? `${info.dataDir}${info.dataDir.includes("\\") ? "\\" : "/"}app.db` : "";

  return (
    <div className="max-w-2xl mx-auto" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <Title level={3} style={{ marginBottom: 4 }}>关于</Title>
        <Text type="secondary">系统信息和应用版本</Text>
      </div>

      <Card title="系统信息">
        {loading ? (
          <div className="flex justify-center py-8">
            <Spin />
          </div>
        ) : info ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="操作系统">{info.os}</Descriptions.Item>
            <Descriptions.Item label="CPU 架构">{info.arch}</Descriptions.Item>
            <Descriptions.Item label="应用版本">
              v{info.appVersion}
            </Descriptions.Item>
            <Descriptions.Item label="数据目录">
              <div className="flex items-center justify-between gap-2">
                <Text copyable={{ text: info.dataDir }} style={{ fontSize: 13 }}>
                  {info.dataDir}
                </Text>
                <Tooltip title="在文件管理器中打开">
                  <Button
                    type="link"
                    size="small"
                    icon={<FolderOpen size={14} />}
                    onClick={handleOpenDataDir}
                  />
                </Tooltip>
              </div>
            </Descriptions.Item>
            <Descriptions.Item label="数据库文件">
              <div className="flex items-center justify-between gap-2">
                <code style={{ fontSize: 12 }}>app.db</code>
                <Tooltip title="复制完整路径">
                  <Button
                    type="link"
                    size="small"
                    icon={<Copy size={14} />}
                    onClick={() => handleCopyPath(dbPath)}
                  />
                </Tooltip>
              </div>
            </Descriptions.Item>
            <Descriptions.Item label="图片存储">
              <div className="flex items-center justify-between gap-2">
                <Text style={{ fontSize: 13 }}>
                  {info.imagesDir}
                </Text>
                <span className="flex items-center gap-1">
                  <Tooltip title="复制路径">
                    <Button
                      type="link"
                      size="small"
                      icon={<Copy size={14} />}
                      onClick={() => handleCopyPath(info.imagesDir)}
                    />
                  </Tooltip>
                  <Tooltip title="在文件管理器中打开">
                    <Button
                      type="link"
                      size="small"
                      icon={<FolderOpen size={14} />}
                      onClick={async () => {
                        try {
                          await openPath(info.imagesDir);
                        } catch (e) {
                          message.error(`打开目录失败: ${e}`);
                        }
                      }}
                    />
                  </Tooltip>
                </span>
              </div>
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Text type="danger">无法获取系统信息</Text>
        )}
      </Card>

      {info && (
        <Card
          title="数据迁移说明"
          size="small"
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 8 }}>
            笔记数据保存在 SQLite 数据库文件中，图片保存在 <code>kb_assets/images/</code> 目录下。迁移步骤：
          </Typography.Paragraph>
          <ol style={{ fontSize: 13, paddingLeft: 20, margin: 0 }}>
            <li style={{ marginBottom: 4 }}>关闭应用</li>
            <li style={{ marginBottom: 4 }}>
              复制 <code>app.db</code> 和 <code>kb_assets/</code> 目录到新电脑的相同路径
            </li>
            <li>启动应用即可</li>
          </ol>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            也可以使用 <Text strong style={{ fontSize: 12 }}>设置 → 导出 Markdown</Text> 将笔记导出为通用格式，便于导入其他工具。
          </Typography.Paragraph>
        </Card>
      )}

      {/* 推荐：RuoYi-Plus-UniApp */}
      <div
        onClick={() => setPromoOpen(true)}
        style={{
          padding: "12px 16px",
          borderRadius: 8,
          border: "1px solid var(--ant-color-border)",
          background: "var(--ant-color-bg-container)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 12,
          transition: "border-color 0.2s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-border)")}
      >
        <RocketOutlined style={{ fontSize: 20, color: "var(--ant-color-primary)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>RuoYi-Plus-UniApp</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>业内首个适配 Claude Code 的企业级全栈框架</Text>
        </div>
        <RightOutlined style={{ fontSize: 11, color: "var(--ant-color-text-quaternary)" }} />
      </div>

      {/* 推荐：灵动桌面应用开发框架 */}
      <div
        onClick={() => setFrameworkOpen(true)}
        style={{
          padding: "12px 16px",
          borderRadius: 8,
          border: "1px solid var(--ant-color-border)",
          background: "var(--ant-color-bg-container)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 12,
          transition: "border-color 0.2s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-border)")}
      >
        <ThunderboltOutlined style={{ fontSize: 20, color: "var(--ant-color-primary)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>灵动桌面应用开发框架</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>面向 AI 时代的桌面应用快速开发框架</Text>
        </div>
        <RightOutlined style={{ fontSize: 11, color: "var(--ant-color-text-quaternary)" }} />
      </div>

      {/* 推荐：AI 全能工作站 */}
      <div
        onClick={() => setWorkstationOpen(true)}
        style={{
          padding: "12px 16px",
          borderRadius: 8,
          border: "1px solid var(--ant-color-border)",
          background: "var(--ant-color-bg-container)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 12,
          transition: "border-color 0.2s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-border)")}
      >
        <AppstoreOutlined style={{ fontSize: 20, color: "var(--ant-color-primary)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>AI 全能工作站</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>42 集视频教程已发布，MCP 接入试用中</Text>
        </div>
        <RightOutlined style={{ fontSize: 11, color: "var(--ant-color-text-quaternary)" }} />
      </div>

      {/* RuoYi-Plus-UniApp 详情弹窗 */}
      <Modal
        title={null}
        open={promoOpen}
        onCancel={() => setPromoOpen(false)}
        footer={[
          <Button key="close" onClick={() => setPromoOpen(false)}>关闭</Button>,
        ]}
        width={520}
      >
        <div style={{ textAlign: "center", paddingTop: 8, paddingBottom: 12 }}>
          <RocketOutlined style={{ fontSize: 36, color: "var(--ant-color-primary)" }} />
          <Title level={4} style={{ margin: "12px 0 4px" }}>RuoYi-Plus-UniApp</Title>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>全栈开发框架 &middot; 业内首个完整适配 Claude Code</Paragraph>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[
              ["200万+", "行代码增删"],
              ["80+", "企业信赖"],
              ["300+", "开发者"],
            ].map(([num, label]) => (
              <div key={label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ant-color-primary)" }}>{num}</div>
                <Text type="secondary" style={{ fontSize: 11 }}>{label}</Text>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 8 }}>
            <Tag color="blue">Java 21</Tag>
            <Tag color="blue">Spring Boot 3.5</Tag>
            <Tag color="green">Vue 3</Tag>
            <Tag color="green">UniApp</Tag>
            <Tag color="purple">Claude Code</Tag>
          </div>

          {[
            ["AI 智能开发", "45+ 技能 · 10+ 命令 · 子代理协同，CLAUDE.md 上下文工程"],
            ["智能代码生成", "四层架构模板一键生成 · 文件直传，代码量减少 70%"],
            ["全端覆盖", "Web + 小程序 + App，一套代码多端运行"],
            ["企业级能力", "MQTT 物联网 · RocketMQ 消息队列 · 微信/支付宝支付 · 多模型 AI"],
          ].map(([title, desc]) => (
            <div key={title} style={{ padding: "8px 12px", borderRadius: 6, background: "var(--ant-color-bg-layout)", border: "1px solid var(--ant-color-border)" }}>
              <Text strong style={{ fontSize: 13 }}>{title}</Text>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>{desc}</Text>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Button
            type="text"
            size="small"
            icon={promoCopied ? <CheckOutlined /> : <CopyOutlined />}
            onClick={() => {
              navigator.clipboard.writeText("770492966").then(() => {
                setPromoCopied(true);
                setTimeout(() => setPromoCopied(false), 1500);
              });
            }}
          >
            {promoCopied ? "已复制!" : "咨询: 770492966"}
          </Button>
        </div>
      </Modal>

      {/* AI 全能工作站 详情弹窗 */}
      <Modal
        title={null}
        open={workstationOpen}
        onCancel={() => setWorkstationOpen(false)}
        footer={[
          <Button key="close" onClick={() => setWorkstationOpen(false)}>关闭</Button>,
          <Button key="site" type="primary" onClick={() => openUrl("https://ai-workstation.ruoyi.plus/")}>
            访问官网
          </Button>,
        ]}
        width={520}
      >
        <div style={{ textAlign: "center", paddingTop: 8, paddingBottom: 12 }}>
          <AppstoreOutlined style={{ fontSize: 36, color: "var(--ant-color-primary)" }} />
          <Title level={4} style={{ margin: "12px 0 4px" }}>AI 全能工作站</Title>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>一句话说出需求，自动路由到对应专业模块执行</Paragraph>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[
              ["55+", "专业模块"],
              ["1300+", "AI 技能"],
              ["42", "集视频教程"],
            ].map(([num, label]) => (
              <div key={label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ant-color-primary)" }}>{num}</div>
                <Text type="secondary" style={{ fontSize: 11 }}>{label}</Text>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 8 }}>
            <Tag color="orange">MCP</Tag>
            <Tag color="blue">Claude Code</Tag>
            <Tag color="green">55+ 模块</Tag>
            <Tag color="purple">全域覆盖</Tag>
          </div>

          {[
            ["42 集视频教程", "从入门到精通的完整使用教程，最后一集为 MCP 接入实战"],
            ["MCP 试用体验", "通过 MCP 即可试用工作站，邀请新用户试用天数 +1"],
            ["55+ 专业模块", "覆盖设计、视频、文档、代码、企业管理等全域场景"],
            ["智能路由调度", "自然语言输入需求，自动匹配最佳模块和技能执行"],
          ].map(([title, desc]) => (
            <div key={title} style={{ padding: "8px 12px", borderRadius: 6, background: "var(--ant-color-bg-layout)", border: "1px solid var(--ant-color-border)" }}>
              <Text strong style={{ fontSize: 13 }}>{title}</Text>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>{desc}</Text>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Button type="link" size="small" onClick={() => openUrl("https://www.bilibili.com/video/BV17cXNBkEEV")}>
            观看教程 (B站)
          </Button>
          <Button type="link" size="small" onClick={() => openUrl("https://ai-workstation-mcp.agilefr.com/")}>
            MCP 试用
          </Button>
          <Button type="link" size="small" onClick={() => openUrl("https://ai-workstation.ruoyi.plus/")}>
            官网
          </Button>
        </div>
      </Modal>

      {/* 灵动桌面应用开发框架 详情弹窗 */}
      <Modal
        title={null}
        open={frameworkOpen}
        onCancel={() => setFrameworkOpen(false)}
        footer={[
          <Button key="close" onClick={() => setFrameworkOpen(false)}>关闭</Button>,
        ]}
        width={520}
      >
        <div style={{ textAlign: "center", paddingTop: 8, paddingBottom: 12 }}>
          <ThunderboltOutlined style={{ fontSize: 36, color: "var(--ant-color-primary)" }} />
          <Title level={4} style={{ margin: "12px 0 4px" }}>灵动桌面应用开发框架</Title>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>面向 AI 时代 &middot; 桌面应用快速开发框架</Paragraph>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[
              ["数周→数天", "开发周期"],
              ["极小", "安装包体积"],
              ["跨平台", "多端兼容"],
            ].map(([num, label]) => (
              <div key={label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ant-color-primary)" }}>{num}</div>
                <Text type="secondary" style={{ fontSize: 11 }}>{label}</Text>
              </div>
            ))}
          </div>
        </div>

        <Paragraph type="secondary" style={{ textAlign: "center", fontSize: 12, margin: "0 0 12px" }}>
          框架深度融合 AI 辅助架构，内置完善的项目规范与智能提示体系，让 AI
          能精准理解项目意图，大幅提升开发效率。开发者只需描述需求，即可快速
          生成高质量的桌面应用。
        </Paragraph>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 8 }}>
            <Tag color="orange">Tauri 2.x</Tag>
            <Tag color="blue">Rust</Tag>
            <Tag color="green">React 19</Tag>
            <Tag color="cyan">TypeScript</Tag>
            <Tag color="purple">AI 驱动</Tag>
          </div>

          {[
            ["AI 深度融合", "内置智能提示体系与项目规范，AI 精准理解意图，描述需求即可生成代码"],
            ["极致轻量", "安装包体积小、启动速度快、内存占用低，媲美原生应用体验"],
            ["原生体验", "系统级窗口管理、文件操作、通知推送，告别 Electron 的臃肿"],
            ["跨平台兼容", "Windows + macOS 全平台支持，一套代码多端运行"],
          ].map(([title, desc]) => (
            <div key={title} style={{ padding: "8px 12px", borderRadius: 6, background: "var(--ant-color-bg-layout)", border: "1px solid var(--ant-color-border)" }}>
              <Text strong style={{ fontSize: 13 }}>{title}</Text>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>{desc}</Text>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Button
            type="text"
            size="small"
            icon={frameworkCopied ? <CheckOutlined /> : <CopyOutlined />}
            onClick={() => {
              navigator.clipboard.writeText("770492966").then(() => {
                setFrameworkCopied(true);
                setTimeout(() => setFrameworkCopied(false), 1500);
              });
            }}
          >
            {frameworkCopied ? "已复制!" : "咨询: 770492966"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
