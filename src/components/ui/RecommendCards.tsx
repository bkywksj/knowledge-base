import { useState } from "react";
import { Button, Modal, Tag, Typography } from "antd";
import {
  RocketOutlined,
  ThunderboltOutlined,
  RightOutlined,
  CopyOutlined,
  CheckOutlined,
  AppstoreOutlined,
} from "@ant-design/icons";
import { openUrl } from "@tauri-apps/plugin-opener";

const { Title, Text, Paragraph } = Typography;

/**
 * 三条推荐卡片 + 对应详情弹窗
 * 在 About 和 Settings 页共用
 */
export function RecommendCards() {
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoCopied, setPromoCopied] = useState(false);
  const [frameworkOpen, setFrameworkOpen] = useState(false);
  const [frameworkCopied, setFrameworkCopied] = useState(false);
  const [workstationOpen, setWorkstationOpen] = useState(false);

  const cardStyle: React.CSSProperties = {
    padding: "12px 16px",
    borderRadius: 8,
    border: "1px solid var(--ant-color-border)",
    background: "var(--ant-color-bg-container)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 12,
    transition: "border-color 0.2s",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* 推荐：RuoYi-Plus-UniApp */}
      <div
        onClick={() => setPromoOpen(true)}
        style={cardStyle}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-border)")}
      >
        <RocketOutlined style={{ fontSize: 20, color: "var(--ant-color-primary)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>
            RuoYi-Plus-UniApp
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>
            业内首个适配 Claude Code 的企业级全栈框架
          </Text>
        </div>
        <RightOutlined style={{ fontSize: 11, color: "var(--ant-color-text-quaternary)" }} />
      </div>

      {/* 推荐：灵动桌面应用开发框架 */}
      <div
        onClick={() => setFrameworkOpen(true)}
        style={cardStyle}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-border)")}
      >
        <ThunderboltOutlined style={{ fontSize: 20, color: "var(--ant-color-primary)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>
            灵动桌面应用开发框架
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>
            面向 AI 时代的桌面应用快速开发框架
          </Text>
        </div>
        <RightOutlined style={{ fontSize: 11, color: "var(--ant-color-text-quaternary)" }} />
      </div>

      {/* 推荐：AI 全能工作站 */}
      <div
        onClick={() => setWorkstationOpen(true)}
        style={cardStyle}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-border)")}
      >
        <AppstoreOutlined style={{ fontSize: 20, color: "var(--ant-color-primary)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>
            AI 全能工作站
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>
            42 集视频教程已发布，MCP 接入试用中
          </Text>
        </div>
        <RightOutlined style={{ fontSize: 11, color: "var(--ant-color-text-quaternary)" }} />
      </div>

      {/* RuoYi-Plus-UniApp 详情弹窗 */}
      <Modal
        title={null}
        open={promoOpen}
        onCancel={() => setPromoOpen(false)}
        footer={[<Button key="close" onClick={() => setPromoOpen(false)}>关闭</Button>]}
        width={520}
      >
        <div style={{ textAlign: "center", paddingTop: 8, paddingBottom: 12 }}>
          <RocketOutlined style={{ fontSize: 36, color: "var(--ant-color-primary)" }} />
          <Title level={4} style={{ margin: "12px 0 4px" }}>
            RuoYi-Plus-UniApp
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>
            全栈开发框架 &middot; 业内首个完整适配 Claude Code
          </Paragraph>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[
              ["200万+", "行代码增删"],
              ["80+", "企业信赖"],
              ["300+", "开发者"],
            ].map(([num, label]) => (
              <div key={label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ant-color-primary)" }}>
                  {num}
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {label}
                </Text>
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
            <div
              key={title}
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                background: "var(--ant-color-bg-layout)",
                border: "1px solid var(--ant-color-border)",
              }}
            >
              <Text strong style={{ fontSize: 13 }}>
                {title}
              </Text>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {desc}
              </Text>
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
          <Title level={4} style={{ margin: "12px 0 4px" }}>
            AI 全能工作站
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>
            一句话说出需求，自动路由到对应专业模块执行
          </Paragraph>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[
              ["55+", "专业模块"],
              ["1300+", "AI 技能"],
              ["42", "集视频教程"],
            ].map(([num, label]) => (
              <div key={label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ant-color-primary)" }}>
                  {num}
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {label}
                </Text>
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
            <div
              key={title}
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                background: "var(--ant-color-bg-layout)",
                border: "1px solid var(--ant-color-border)",
              }}
            >
              <Text strong style={{ fontSize: 13 }}>
                {title}
              </Text>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {desc}
              </Text>
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
        footer={[<Button key="close" onClick={() => setFrameworkOpen(false)}>关闭</Button>]}
        width={520}
      >
        <div style={{ textAlign: "center", paddingTop: 8, paddingBottom: 12 }}>
          <ThunderboltOutlined style={{ fontSize: 36, color: "var(--ant-color-primary)" }} />
          <Title level={4} style={{ margin: "12px 0 4px" }}>
            灵动桌面应用开发框架
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>
            面向 AI 时代 &middot; 桌面应用快速开发框架
          </Paragraph>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[
              ["数周→数天", "开发周期"],
              ["极小", "安装包体积"],
              ["跨平台", "多端兼容"],
            ].map(([num, label]) => (
              <div key={label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ant-color-primary)" }}>
                  {num}
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {label}
                </Text>
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
            <div
              key={title}
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                background: "var(--ant-color-bg-layout)",
                border: "1px solid var(--ant-color-border)",
              }}
            >
              <Text strong style={{ fontSize: 13 }}>
                {title}
              </Text>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {desc}
              </Text>
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
