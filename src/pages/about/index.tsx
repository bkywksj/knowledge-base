import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Typography, Spin, message, Modal, Button, Image } from "antd";
import {
  Activity,
  Database,
  ExternalLink,
  FolderOpen,
  Heart,
  Monitor,
  Puzzle,
  RefreshCw,
  Settings,
  Star,
  Truck,
  Tv,
  Upload,
  Users,
  Video,
} from "lucide-react";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { appLogDir } from "@tauri-apps/api/path";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import type { SystemInfo } from "@/types";
import { systemApi } from "@/lib/api";
import { RecommendCards } from "@/components/ui/RecommendCards";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { useUpdater } from "@/components/updater/UpdaterProvider";

const OFFICIAL_SITE = "https://kb.ruoyi.plus/";
const BILIBILI_URL = "https://space.bilibili.com/520725002";
const BILIBILI_TUTORIAL_URL = "https://www.bilibili.com/video/BV1xvosBREbr";
const ZSXQ_NAME = "后端转AI实战派";
const ZSXQ_ID = "91839984";
const QQ_GROUP_ID = "1090770702";
const AUTHOR_CONTACT = "7704929366";

const { Text, Paragraph } = Typography;

function DesktopAboutPage() {
  const navigate = useNavigate();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dbChecking, setDbChecking] = useState(false);
  const updater = useUpdater();

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

  async function handleOpenLogs() {
    try {
      await openPath(await appLogDir());
    } catch (e) {
      message.error(`打开日志目录失败: ${e}`);
    }
  }

  async function handleExportDiagnostics() {
    setExporting(true);
    try {
      const zip = await systemApi.exportDiagnostics();
      message.success("诊断包已导出到桌面");
      // 在文件管理器中定位到 zip，方便用户直接拿去发送
      await revealItemInDir(zip).catch(() => {});
    } catch (e) {
      message.error(`导出诊断包失败: ${e}`);
    } finally {
      setExporting(false);
    }
  }

  /**
   * 数据库文本体检：先只读扫描，发现问题再让用户确认是否修复。
   *
   * 排查的是「同步报 Conversion error from type Text at index: N, invalid utf-8」——
   * db 文件被外部拷坏（跨平台直接拷 app.db 漏了 -wal、数据目录放网盘双向同步、
   * 磁盘坏道）导致某个 TEXT cell 存了非法 UTF-8 字节。
   */
  async function handleCheckDbText() {
    setDbChecking(true);
    try {
      const report = await systemApi.checkDbTextHealth(false);
      if (report.issues.length === 0) {
        message.success(`数据库文本正常（已扫描 ${report.scannedCells} 处）`);
        return;
      }
      // 只列前 10 条，避免坏数据多时弹窗撑爆
      const list = report.issues
        .slice(0, 10)
        .map((i) => `· ${i.table}.${i.column} (#${i.rowId})：${i.preview}`)
        .join("\n");
      const more =
        report.issues.length > 10 ? `\n…另有 ${report.issues.length - 10} 处` : "";
      Modal.confirm({
        title: `发现 ${report.issues.length} 处损坏文本`,
        width: 640,
        content: (
          <div>
            <Paragraph type="secondary" style={{ fontSize: 13 }}>
              这些内容含非法 UTF-8 字节，会让同步整体失败。成因通常是跨设备
              <Text strong>直接拷贝 app.db</Text>
              ，或把数据目录放在网盘里双向同步。修复会把坏字节替换成 �，
              只影响已损坏的那几个字符，其余内容不动。
            </Paragraph>
            <pre
              style={{
                maxHeight: 240,
                overflow: "auto",
                fontSize: 12,
                background: "var(--kb-bg-subtle, rgba(0,0,0,.04))",
                padding: 8,
                borderRadius: 4,
                whiteSpace: "pre-wrap",
              }}
            >
              {list + more}
            </pre>
          </div>
        ),
        okText: "立即修复",
        cancelText: "暂不修复",
        onOk: async () => {
          const fixed = await systemApi.checkDbTextHealth(true);
          if (fixed.errors.length > 0) {
            message.warning(
              `修复 ${fixed.repairedCells} 处，${fixed.errors.length} 处失败：${fixed.errors[0]}`,
            );
          } else {
            message.success(`已修复 ${fixed.repairedCells} 处，可以重新同步了`);
          }
        },
      });
    } catch (e) {
      message.error(`数据库体检失败: ${e}`);
    } finally {
      setDbChecking(false);
    }
  }

  async function handleCheckUpdate() {
    if (!updater) return;
    setChecking(true);
    try {
      // 走全局更新状态机：有更新会自动弹出（并已在后台开始下载）的全局 UpdateModal，
      // 这里只需对「已是最新 / 检查失败」给出反馈。
      const r = await updater.checkManually();
      if (r.error) {
        message.warning(`检查更新失败: ${r.error}`);
      } else if (!r.hasUpdate) {
        message.success("当前已是最新版本");
      }
    } finally {
      setChecking(false);
    }
  }

  /** 复制号码（星球号 / 群号）到剪贴板：走 clipboard-manager 插件，不受 WebView 用户手势时效限制 */
  async function copyText(text: string, label: string) {
    try {
      await writeClipboardText(text);
      message.success(`${label}已复制：${text}`);
    } catch (e) {
      message.error(`复制失败: ${e}`);
    }
  }

  return (
    <div className="kb-about">
      {/* 横幅（原型顶部卡片）：Logo · 名称 · 副标题 ｜ 版本胶囊 · 检查更新 · 前往设置 */}
      <section className="kb-cards-panel kb-about-hero">
        <BrandLogo size={60} />
        <div className="kb-about-hero-t">
          <h1>Knowledge Base</h1>
          <p>本地优先的知识库 · 系统信息和应用版本</p>
        </div>
        {info && <span className="kb-about-ver">v{info.appVersion}</span>}
        <Button
          type="primary"
          size="large"
          icon={<RefreshCw size={15} className={checking ? "animate-spin" : undefined} />}
          disabled={checking || !updater}
          onClick={handleCheckUpdate}
        >
          检查更新
        </Button>
        <Button size="large" icon={<Settings size={15} />} onClick={() => navigate("/settings")}>
          前往设置
        </Button>
      </section>

      <div className="kb-about-grid">
        {/* 系统信息 */}
        <section className="kb-cards-panel kb-qc">
          <div className="kb-qc-head">
            <span className="kb-qc-ico">
              <Monitor size={15} />
            </span>
            系统信息
          </div>
          {loading ? (
            <div className="flex justify-center py-8">
              <Spin />
            </div>
          ) : info ? (
            <div className="kb-kv">
              <span>操作系统</span>
              <b>{info.os}</b>
              <i />
              <span>CPU 架构</span>
              <b>{info.arch}</b>
              <i />
              <span>应用版本</span>
              <b>{info.appVersion}</b>
              <i />
              <span>官网</span>
              <b>{OFFICIAL_SITE.replace(/^https?:\/\/|\/$/g, "")}</b>
              <Button
                type="text"
                size="small"
                icon={<ExternalLink size={13} />}
                onClick={() => openUrl(OFFICIAL_SITE)}
              >
                在浏览器中打开
              </Button>
              <span>数据目录</span>
              <Text className="kb-kv-path" copyable={{ text: info.dataDir }} title={info.dataDir}>
                {info.dataDir}
              </Text>
              <Button type="text" size="small" icon={<FolderOpen size={13} />} onClick={handleOpenDataDir}>
                在文件管理器中打开
              </Button>
            </div>
          ) : (
            <Text type="danger">无法获取系统信息</Text>
          )}
        </section>

        {/* 日志与诊断（原来挤在系统信息表格最后一行） */}
        <section className="kb-cards-panel kb-qc">
          <div className="kb-qc-head">
            <span className="kb-qc-ico is-warn">
              <Activity size={15} />
            </span>
            日志与诊断
          </div>
          <div className="kb-about-acts">
            <Button icon={<FolderOpen size={14} />} onClick={handleOpenLogs}>
              打开日志目录
              <span className="kb-about-act-hint">本次运行与历史日志</span>
            </Button>
            <Button icon={<Upload size={14} />} loading={exporting} onClick={handleExportDiagnostics}>
              导出诊断包
              <span className="kb-about-act-hint">闪退 / 异常时生成 zip 发给开发者</span>
            </Button>
            <Button icon={<Database size={14} />} loading={dbChecking} onClick={handleCheckDbText}>
              数据库体检
              <span className="kb-about-act-hint">同步报「invalid utf-8」时检查修复</span>
            </Button>
          </div>
        </section>

        {/* 作者 & 社区 */}
        <section className="kb-cards-panel kb-qc">
          <div className="kb-qc-head">
            <span className="kb-qc-ico is-info">
              <Users size={15} />
            </span>
            作者 &amp; 社区
          </div>
          <div className="kb-about-author">
            <span className="kb-about-avatar">抓</span>
            <div>
              <b>抓蛙师</b>
              <p>Java 全栈 AI 架构师 · Agent 架构师</p>
            </div>
          </div>
          <p className="kb-about-bio">
            专注于 Java 后端 + 前端全栈工程实践，深耕大模型应用与 Agent
            架构落地（RAG、工具调用、多智能体编排、知识库工程化）。
            这款本地知识库即源于「把 AI 真正用进自己日常工作流」的长期实验。
          </p>
          <div className="kb-about-links">
            <Button icon={<Tv size={14} />} title={BILIBILI_URL} onClick={() => openUrl(BILIBILI_URL)}>
              B 站主页
            </Button>
            <Button
              icon={<Video size={14} />}
              title="B 站使用教程 / 功能演示"
              onClick={() => openUrl(BILIBILI_TUTORIAL_URL)}
            >
              视频讲解
            </Button>
            <Button
              icon={<Star size={14} />}
              title={`知识星球「${ZSXQ_NAME}」，点击复制星球号`}
              onClick={() => copyText(ZSXQ_ID, "星球号")}
            >
              知识星球 · {ZSXQ_ID}
            </Button>
            <Button
              icon={<Users size={14} />}
              title="点击复制群号"
              onClick={() => copyText(QQ_GROUP_ID, "群号")}
            >
              QQ 交流群 · {QQ_GROUP_ID}
            </Button>
          </div>
          <p className="kb-about-foot">
            星球「{ZSXQ_NAME}」· QQ 群：Bug 反馈 / 使用交流 / 新功能讨论
            <br />
            联系作者 QQ / 微信{" "}
            <Text copyable={{ text: AUTHOR_CONTACT }} strong>
              {AUTHOR_CONTACT}
            </Text>
            ，添加时请备注「来自知识库」
          </p>
        </section>

        {/* 赞赏支持：本应用完全开源免费，扫码请作者喝杯咖啡 ☕ */}
        <section className="kb-cards-panel kb-qc">
          <div className="kb-qc-head">
            <span className="kb-qc-ico is-err">
              <Heart size={15} />
            </span>
            赞赏支持
          </div>
          <div className="kb-about-donate">
            <Image
              src="/donate-qr.png"
              alt="赞赏码"
              width={120}
              height={120}
              className="kb-about-qr"
              // Ant Design Image 自带点击预览：点开可全屏放大 / 缩放，方便扫码
              preview={{ mask: "放大扫码" }}
            />
            <div>
              <b>如果这款工具帮到了你 ❤️</b>
              <p>扫码请作者喝杯咖啡，你的支持会变成下一个版本里的新功能。</p>
              <p className="kb-about-foot">
                本应用完全开源免费、无任何会员 / 订阅。不想赞赏也欢迎：在 B 站点个关注 /
                在 GitHub 给项目点 Star / 把它推荐给身边需要的朋友。点击二维码可放大扫码。
              </p>
            </div>
          </div>
        </section>

        {/* 数据迁移说明（跨两列） */}
        <section className="kb-cards-panel kb-qc kb-about-wide">
          <div className="kb-qc-head">
            <span className="kb-qc-ico is-ok">
              <Truck size={15} />
            </span>
            数据迁移说明
            <span className="kb-about-head-note">按使用场景从简单到专业，推荐 4 种方式</span>
          </div>
          <div className="kb-way">
            <span className="kb-way-n">1</span>
            <div>
              <b>单台电脑换硬盘 / 搬到 D 盘</b>
              <p>
                设置 → 数据目录，选新路径，勾选「自动迁移」即可。应用会启动迁移引导窗口完成搬运，无需手工复制文件。
              </p>
            </div>
          </div>
          <div className="kb-way">
            <span className="kb-way-n">2</span>
            <div>
              <b>一次性整包搬到另一台电脑（离线）</b>
              <p>
                旧电脑：设置 → 同步 → 本地 ZIP → 导出，得到一个 .zip 快照（含全部数据库 + 图片 + PDF + 附件 + 源文件）；
                新电脑安装应用后到同位置选择「导入 ZIP」，自动解压覆盖。
              </p>
            </div>
          </div>
          <div className="kb-way">
            <span className="kb-way-n">3</span>
            <div>
              <b>多端实时双向同步（推荐长期用户）</b>
              <p>
                设置 → 同步 → 多端同步（V1），配置 WebDAV / 坚果云 / NAS 后端；多台电脑都登录同一个账号，应用会按文件级
                manifest 增量推拉，自动消化双端冲突。也可以只用「WebDAV 全量快照」做单向手动备份。
              </p>
            </div>
          </div>
          <div className="kb-way">
            <span className="kb-way-n">4</span>
            <div>
              <b>手动复制（兜底方案，应急用）</b>
              <p>
                关闭应用 → 把整个数据目录复制到新电脑相同路径 → 启动即可。核心内容：<code>app.db</code>（全部元数据）、
                <code>kb_assets/</code>（笔记内嵌图片，含 <code>videos/</code> 视频）、<code>pdfs/</code>（导入的
                PDF）、<code>sources/</code>（导入的 Word 原文件）、<code>attachments/</code>（附件）、
                <code>settings.json</code>（应用偏好）。<b>务必整目录一起搬</b>，单独复制 <code>app.db</code>{" "}
                会丢图片 / PDF / 附件。
              </p>
            </div>
          </div>
          <p className="kb-about-warn">
            ⚠ 任何方式都要在迁移前关闭应用；新旧两端版本号差距不要超过一个小版本，避免 schema 不兼容。需要给其他工具用，可在
            设置 → 导出 Markdown 单独导出标准 .md 文件。
          </p>
        </section>

        {/* 推荐应用（跨两列，与设置页共用 RecommendCards） */}
        <section className="kb-cards-panel kb-qc kb-about-wide">
          <div className="kb-qc-head">
            <span className="kb-qc-ico">
              <Puzzle size={15} />
            </span>
            推荐应用
            <span className="kb-about-head-note">9 款 · 点击查看详情</span>
          </div>
          <RecommendCards />
        </section>
      </div>
    </div>
  );
}

// 手机端单独一版（v4 重构 M3-11）：原来手机上直接渲染这个桌面页，布局挤成一团
import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileAbout } from "./MobileAbout";

export default function AboutPage() {
  const isMobile = useIsMobile();
  return isMobile ? (
      <MobileAbout />
  ) : (
    <DesktopAboutPage />
  );
}
