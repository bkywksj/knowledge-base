import { useState } from "react";
import { Button, Modal, Tag, Typography } from "antd";
import {
  RightOutlined,
  CopyOutlined,
  CheckOutlined,
} from "@ant-design/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
// 产品 logo —— 各软件真实图标
import aicoderLogo from "@/assets/promo/aicoder.png";
import sigilLogo from "@/assets/promo/sigil.svg";
import reeveLogo from "@/assets/promo/reeve.png";
import ruoyiLogo from "@/assets/promo/ruoyi.png";
import tauriLogo from "@/assets/promo/tauri.svg";
import workstationLogo from "@/assets/promo/workstation.svg";
import agileshotLogo from "@/assets/promo/agileshot.png";
import storyloomLogo from "@/assets/promo/storyloom.png";
import officiaLogo from "@/assets/promo/officia.svg";

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
  const [aicoderOpen, setAicoderOpen] = useState(false);
  const [sigilOpen, setSigilOpen] = useState(false);
  const [reeveOpen, setReeveOpen] = useState(false);
  const [agileshotOpen, setAgileshotOpen] = useState(false);
  const [storyloomOpen, setStoryloomOpen] = useState(false);
  const [officiaOpen, setOfficiaOpen] = useState(false);

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
        <img src={ruoyiLogo} alt="" style={{ width: 22, height: 22, objectFit: "contain" }} />
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
        <img src={tauriLogo} alt="" style={{ width: 22, height: 22, objectFit: "contain" }} />
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
        <img src={workstationLogo} alt="" style={{ width: 22, height: 22, objectFit: "contain" }} />
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

      {/* 推荐：智码 AICoder */}
      <div
        onClick={() => setAicoderOpen(true)}
        style={cardStyle}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-border)")}
      >
        <img src={aicoderLogo} alt="" style={{ width: 22, height: 22, objectFit: "contain" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>
            智码 AICoder
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>
            多 AI 编码工具一站式管理 · 移动端实时联动
          </Text>
        </div>
        <RightOutlined style={{ fontSize: 11, color: "var(--ant-color-text-quaternary)" }} />
      </div>

      {/* 推荐：Sigil */}
      <div
        onClick={() => setSigilOpen(true)}
        style={cardStyle}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-border)")}
      >
        <img src={sigilLogo} alt="" style={{ width: 22, height: 22, objectFit: "contain" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>
            Sigil · AI 凭据金库
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>
            让 AI 帮你干活，但永远拿不到你的密钥
          </Text>
        </div>
        <RightOutlined style={{ fontSize: 11, color: "var(--ant-color-text-quaternary)" }} />
      </div>

      {/* 推荐：Reeve */}
      <div
        onClick={() => setReeveOpen(true)}
        style={cardStyle}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-border)")}
      >
        <img src={reeveLogo} alt="" style={{ width: 22, height: 22, objectFit: "contain" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>
            Reeve · 服务器庄园总管
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>
            你持钥，AI 借道 —— AI 操作服务器却拿不到密码私钥
          </Text>
        </div>
        <RightOutlined style={{ fontSize: 11, color: "var(--ant-color-text-quaternary)" }} />
      </div>

      {/* 推荐：AgileShot */}
      <div
        onClick={() => setAgileshotOpen(true)}
        style={cardStyle}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-border)")}
      >
        <img src={agileshotLogo} alt="" style={{ width: 22, height: 22, objectFit: "contain" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>
            AgileShot · 截图标注工具
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>
            AI 时代的桌面截图与标注工具
          </Text>
        </div>
        <RightOutlined style={{ fontSize: 11, color: "var(--ant-color-text-quaternary)" }} />
      </div>

      {/* 推荐：StoryLoom */}
      <div
        onClick={() => setStoryloomOpen(true)}
        style={cardStyle}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-border)")}
      >
        <img src={storyloomLogo} alt="" style={{ width: 22, height: 22, objectFit: "contain" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>
            StoryLoom · 故事织机
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>
            面向网文作者的本地 AI 创作工作台
          </Text>
        </div>
        <RightOutlined style={{ fontSize: 11, color: "var(--ant-color-text-quaternary)" }} />
      </div>

      {/* 推荐：Officia（同生态 Java 文档处理开发套件，面向做集成的开发者） */}
      <div
        onClick={() => setOfficiaOpen(true)}
        style={cardStyle}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ant-color-border)")}
      >
        <img src={officiaLogo} alt="" style={{ width: 22, height: 22, objectFit: "contain" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>
            Officia · Java 文档处理套件
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>
            零依赖 · 支持 JDK 8 · Office 无损转 PDF + 在线编辑
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
          <img src={ruoyiLogo} alt="" style={{ width: 44, height: 44, objectFit: "contain" }} />
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
          <img src={workstationLogo} alt="" style={{ width: 44, height: 44, objectFit: "contain" }} />
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
          <img src={tauriLogo} alt="" style={{ width: 44, height: 44, objectFit: "contain" }} />
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

      {/* Sigil 详情弹窗 */}
      <Modal
        title={null}
        open={sigilOpen}
        onCancel={() => setSigilOpen(false)}
        footer={[
          <Button key="close" onClick={() => setSigilOpen(false)}>关闭</Button>,
          <Button key="site" type="primary" onClick={() => openUrl("https://sigil.ruoyi.plus")}>
            访问官网
          </Button>,
        ]}
        width={520}
      >
        <div style={{ textAlign: "center", paddingTop: 8, paddingBottom: 12 }}>
          <img src={sigilLogo} alt="" style={{ width: 44, height: 44, objectFit: "contain" }} />
          <Title level={4} style={{ margin: "12px 0 4px" }}>
            Sigil · AI 凭据金库
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>
            MCP 协议代理 —— AI 用得到、看不到明文
          </Paragraph>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[
              ["AES-256", "加密金库"],
              ["MCP", "标准协议"],
              ["100%", "本地存储"],
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
            <Tag color="orange">Tauri 2.x</Tag>
            <Tag color="blue">Rust</Tag>
            <Tag color="geekblue">MCP</Tag>
            <Tag color="green">AES-256-GCM</Tag>
            <Tag color="purple">Local-first</Tag>
          </div>

          {[
            ["加密金库 · 密钥永不离手", "系统密钥环 + AES-256-GCM + SQLCipher 整库加密；AI 通过 MCP 调用能力，凭据只在 Sigil 内部使用，结果脱敏返回"],
            ["MCP 标准协议", "Claude Code / Cursor / Cline / Zed 等 MCP 客户端原生支持，一键接入"],
            ["内置能力 + 用户可扩展", "Git push、Gitee/GitHub/GitCode 仓库操作、HTTP API 代理、数据库查询；UI 配置 HTTP 模板能力，无需编程"],
            ["审计日志 + 范围控制", "每次凭据访问留痕可追溯；每个凭据可限定只允许哪些能力使用"],
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
      </Modal>

      {/* Reeve 详情弹窗 */}
      <Modal
        title={null}
        open={reeveOpen}
        onCancel={() => setReeveOpen(false)}
        footer={[
          <Button key="close" onClick={() => setReeveOpen(false)}>关闭</Button>,
          <Button key="site" type="primary" onClick={() => openUrl("https://reeve.ruoyi.plus")}>
            访问官网
          </Button>,
        ]}
        width={520}
      >
        <div style={{ textAlign: "center", paddingTop: 8, paddingBottom: 12 }}>
          <img src={reeveLogo} alt="" style={{ width: 44, height: 44, objectFit: "contain" }} />
          <Title level={4} style={{ margin: "12px 0 4px" }}>
            Reeve · 服务器庄园总管
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>
            SSH 服务器管理 + 受控 AI 接入（MCP）
          </Paragraph>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[
              ["持钥借道", "凭据不出本机"],
              ["四重关卡", "策略+审批+审计"],
              ["127.0.0.1", "绝不公网监听"],
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
            <Tag color="orange">Tauri 2</Tag>
            <Tag color="blue">Rust</Tag>
            <Tag color="geekblue">MCP</Tag>
            <Tag color="green">SSH</Tag>
            <Tag color="purple">AES-256-GCM</Tag>
          </div>

          {[
            ["一流 SSH 客户端", "多标签终端 · 服务器清单 · SFTP · 命令片段，可替代 Xshell / Termius / FinalShell"],
            ["AI 安全跳板", "Claude Code / Codex / claude.ai 通过 MCP 操作服务器；AI 只看到服务器别名，看不到账号 / 密码 / 私钥"],
            ["四重安全关卡", "全局总开关 → 每服务器分级策略（只读 / 审批 / 白名单）→ 危险命令黑名单 → 全量审计；MCP 仅监听 127.0.0.1"],
            ["越用越懂你", "以项目目录为单位沉淀经验库 / Runbook / 可配置技能（CLAUDE.md + .reeve/）"],
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
      </Modal>

      {/* AgileShot 详情弹窗 */}
      <Modal
        title={null}
        open={agileshotOpen}
        onCancel={() => setAgileshotOpen(false)}
        footer={[
          <Button key="close" onClick={() => setAgileshotOpen(false)}>关闭</Button>,
          <Button key="site" type="primary" onClick={() => openUrl("https://agileshot.ruoyi.plus")}>
            访问官网
          </Button>,
        ]}
        width={520}
      >
        <div style={{ textAlign: "center", paddingTop: 8, paddingBottom: 12 }}>
          <img src={agileshotLogo} alt="" style={{ width: 44, height: 44, objectFit: "contain" }} />
          <Title level={4} style={{ margin: "12px 0 4px" }}>
            AgileShot · 截图标注工具
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>
            截图 · 标注 · 钉图 · OCR · 录屏 · MCP 扩展，一体化
          </Paragraph>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[
              ["11 种", "标注工具"],
              ["AI 标注", "OCR / 翻译"],
              ["MCP", "Claude / Cursor"],
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
            <Tag color="orange">C++20</Tag>
            <Tag color="blue">Qt 6</Tag>
            <Tag color="green">Agile-Qt</Tag>
            <Tag color="geekblue">MCP</Tag>
            <Tag color="purple">Windows</Tag>
          </div>

          {[
            ["11 种标注工具开箱即用", "矩形 / 椭圆 / 箭头 / 文字 / 马赛克 / 模糊 / 计数 / 高亮 / 图章…，撤销重做完整支持"],
            ["AI 智能标注", "一键 OCR、翻译、代码解释；截图即问 AI"],
            ["MCP Server", "让 Claude Desktop / Cursor 直接在屏幕上工作（9 个 MCP 工具）"],
            ["钉图 / 录屏 / 取色", "钉图鼠标穿透、多张同存、独立缩放；录屏 + GIF；取色器 + 历史全文搜索"],
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
          <Button type="link" size="small" onClick={() => openUrl("https://www.bilibili.com/video/BV1uQ7k6nEvq")}>
            B站介绍
          </Button>
        </div>
      </Modal>

      {/* StoryLoom 详情弹窗 */}
      <Modal
        title={null}
        open={storyloomOpen}
        onCancel={() => setStoryloomOpen(false)}
        footer={[
          <Button key="close" onClick={() => setStoryloomOpen(false)}>关闭</Button>,
          <Button key="site" type="primary" onClick={() => openUrl("https://storyloom.ruoyi.plus")}>
            访问官网
          </Button>,
        ]}
        width={520}
      >
        <div style={{ textAlign: "center", paddingTop: 8, paddingBottom: 12 }}>
          <img src={storyloomLogo} alt="" style={{ width: 44, height: 44, objectFit: "contain" }} />
          <Title level={4} style={{ margin: "12px 0 4px" }}>
            StoryLoom · 故事织机
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>
            面向网文作者的本地 AI 创作工作台
          </Paragraph>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[
              ["100% 本地", "Key 不出本机"],
              ["Story Bible", "一致性资产"],
              ["多供应商", "云 API 可切换"],
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
            <Tag color="orange">Tauri 2.x</Tag>
            <Tag color="blue">Rust</Tag>
            <Tag color="green">React 19</Tag>
            <Tag color="cyan">TypeScript</Tag>
            <Tag color="purple">SQLite</Tag>
          </div>

          {[
            ["AI 辅助创作", "大纲生成、续写、扩写、润色、卡文救场，多供应商云 API 流式输出"],
            ["Story Bible 故事圣经", "角色卡、世界观词条、时间线，把角色与设定沉淀为一致性资产"],
            ["一致性守护", "写作时引用设定、自动检测前后矛盾，长篇连载不崩人设"],
            ["本地优先 · 隐私安全", "本地 SQLite + 文件存储，云算力经 Rust Command 代理，API Key 不出本机"],
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
          <Button type="link" size="small" onClick={() => openUrl("https://www.bilibili.com/video/BV1S4Tu6cE55")}>
            B站介绍
          </Button>
          <Button type="link" size="small" onClick={() => openUrl("https://storyloom.ruoyi.plus")}>
            官网
          </Button>
        </div>
      </Modal>

      {/* 智码 AICoder 详情弹窗 */}
      <Modal
        title={null}
        open={aicoderOpen}
        onCancel={() => setAicoderOpen(false)}
        footer={[
          <Button key="close" onClick={() => setAicoderOpen(false)}>关闭</Button>,
          <Button key="site" type="primary" onClick={() => openUrl("https://aicoder.ruoyi.plus/")}>
            访问官网
          </Button>,
        ]}
        width={520}
      >
        <div style={{ textAlign: "center", paddingTop: 8, paddingBottom: 12 }}>
          <img src={aicoderLogo} alt="" style={{ width: 44, height: 44, objectFit: "contain" }} />
          <Title level={4} style={{ margin: "12px 0 4px" }}>
            智码 AICoder
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>
            多 AI 编码工具一站式管理 · PC + 移动端联动
          </Paragraph>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[
              ["4 in 1", "Claude / Codex / Gemini / OpenCode"],
              ["PC + 手机", "实时联动 · 远程接管"],
              ["跨平台", "Win + macOS + Android"],
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
            <Tag color="orange">Tauri 2.x</Tag>
            <Tag color="blue">Claude Code</Tag>
            <Tag color="green">Codex</Tag>
            <Tag color="cyan">Gemini</Tag>
            <Tag color="purple">OpenCode</Tag>
          </div>

          {[
            ["多工具统一入口", "Claude / Codex / Gemini / OpenCode 一个面板切换，配置 / 会话 / 历史互不打架"],
            ["原生终端体验", "PTY 真终端 + XTerm.js 渲染，工具调用卡片、Markdown 高亮、变更追踪一应俱全"],
            ["移动端实时联动", "手机扫码配对桌面端，远程查看会话 / 发送消息 / 上传图片，AI 回复完成实时通知"],
            ["会话归档与搜索", "本地 SQLite 存所有会话，全文搜索 + 一键导出 Markdown / HTML / JSON"],
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
          <Button type="link" size="small" onClick={() => openUrl("https://aicoder.ruoyi.plus/")}>
            官网
          </Button>
          <Button type="link" size="small" onClick={() => openUrl("https://aicoder.ruoyi.plus/download.html")}>
            下载
          </Button>
        </div>
      </Modal>

      {/* Officia 详情弹窗 */}
      <Modal
        title={null}
        open={officiaOpen}
        onCancel={() => setOfficiaOpen(false)}
        footer={[
          <Button key="close" onClick={() => setOfficiaOpen(false)}>关闭</Button>,
          <Button key="demo" onClick={() => openUrl("https://demo.officia.ruoyi.plus/")}>
            在线试用
          </Button>,
          <Button key="site" type="primary" onClick={() => openUrl("https://officia.ruoyi.plus/")}>
            访问官网
          </Button>,
        ]}
        width={520}
      >
        <div style={{ textAlign: "center", paddingTop: 8, paddingBottom: 12 }}>
          <img src={officiaLogo} alt="" style={{ width: 44, height: 44, objectFit: "contain" }} />
          <Title level={4} style={{ margin: "12px 0 4px" }}>
            Officia · Java 文档处理套件
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>
            Word/Excel/PPT ↔ PDF 双向转换、浏览器在线编辑；另含 PDF 加密 · 图像 · 条码 · 邮件 · OCR
          </Paragraph>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }}>
            {[
              ["124/124", "Word 样本转换成功"],
              ["JDK 8+", "仅需 JDK 标准库"],
              ["8 大", "能力模块门面"],
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
            <Tag color="red">无损转 PDF</Tag>
            <Tag color="volcano">PDF 转 Word</Tag>
            <Tag color="green">在线编辑</Tag>
            <Tag color="orange">JDK 8+</Tag>
            <Tag color="blue">零依赖</Tag>
            <Tag color="purple">离线授权</Tag>
          </div>

          {[
            [
              "无损转 PDF，版式不跑偏",
              "分页、表格、页眉页脚、图片与图表按原样还原；Excel 按每张表的打印设置分页；中文字体子集嵌入，正确显示、可复制可检索。还原度别看参数表，拿自己最难的那份文档上在线测试台跑一遍",
            ],
            [
              "在线编辑 · 免部署",
              "Officia.Editor 在浏览器里直接编辑 Word / Excel，不用另外部署 Document Server；PDF 转 Word 流式还原表格、跨页续表与多栏",
            ],
            [
              "零依赖 · JDK 8 起",
              "只依赖 JDK 标准库，引入不带任何传递依赖；JDK 8 即可运行，老项目也能直接接入，避开 POI + iText 那套依赖冲突与体积膨胀",
            ],
            [
              "对齐 Aspose · 洁净室自研",
              "OfficiaWords.toPdf(docx) 一行出 PDF；Words / Cells / Slides / Pdf / Email / Imaging / BarCode / OCR 八大门面；只依据公开规范实现，可闭源商用，officia.lic 离线验签、不联网不锁机器",
            ],
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
          <Button type="link" size="small" onClick={() => openUrl("https://www.bilibili.com/video/BV1QGuS6SEVp")}>
            视频演示
          </Button>
          <Button type="link" size="small" onClick={() => openUrl("https://gitee.com/bkywksj/officia-demo")}>
            示例仓库
          </Button>
          <Button type="link" size="small" onClick={() => openUrl("https://officia.ruoyi.plus/guide/licensing.html")}>
            授权定价 ¥1288 起
          </Button>
        </div>
      </Modal>
    </div>
  );
}
