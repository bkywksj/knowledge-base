import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal, message } from "antd";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { Bug, Globe, HardDrive, MessageCircle, PlayCircle, RefreshCw, Stethoscope, Tv, User, Users } from "lucide-react";
import { systemApi } from "@/lib/api";
import type { SystemInfo } from "@/types";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { MGroup, MNavBar, MRow } from "@/components/mobile/primitives";

/**
 * 移动端「关于」（路由 /about）
 *
 * 与 PC 关于页同一套信息：版本 / 系统 / 数据目录、官网与教程、社群与联系方式、诊断包与数据库文本体检。
 * 「检查更新」走「我的」页那套 App 内下载安装流程（PC 的 updater 不适用于 APK），这里跳过去。
 */

// 与 PC 关于页一致（pages/about/index.tsx）
const OFFICIAL_SITE = "https://kb.ruoyi.plus/";
const BILIBILI_URL = "https://space.bilibili.com/520725002";
const BILIBILI_TUTORIAL_URL = "https://www.bilibili.com/video/BV1xvosBREbr";
const ZSXQ_NAME = "后端转AI实战派";
const ZSXQ_ID = "91839984";
const QQ_GROUP_ID = "1090770702";
const AUTHOR_CONTACT = "7704929366";

export function MobileAbout() {
  const navigate = useNavigate();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [exporting, setExporting] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    systemApi
      .getSystemInfo()
      .then(setInfo)
      .catch((e) => console.warn("[about] getSystemInfo failed:", e));
  }, []);

  /** 复制号码 / 路径：走 clipboard-manager 插件，不受 WebView 用户手势时效限制（同 PC） */
  async function copyText(text: string, label: string) {
    try {
      await writeClipboardText(text);
      message.success(`${label}已复制：${text}`);
    } catch (e) {
      message.error(`复制失败: ${e}`);
    }
  }

  function open(url: string) {
    openUrl(url).catch((e) => message.error(`打开失败: ${e}`));
  }

  async function exportDiagnostics() {
    if (exporting) return;
    setExporting(true);
    try {
      // 手机上没有「桌面」也不能在文件管理器里定位，直接把保存位置告诉用户
      const zip = await systemApi.exportDiagnostics();
      Modal.success({ title: "诊断包已导出", content: <div className="break-all text-[13px]">{zip}</div>, okText: "知道了", centered: true });
    } catch (e) {
      message.error(`导出诊断包失败: ${e}`);
    } finally {
      setExporting(false);
    }
  }

  /** 数据库文本体检：先只读扫描，发现问题再让用户确认是否修复（同 PC） */
  async function checkDbText() {
    if (checking) return;
    setChecking(true);
    try {
      const report = await systemApi.checkDbTextHealth(false);
      if (report.issues.length === 0) {
        message.success(`数据库文本正常（已扫描 ${report.scannedCells} 处）`);
        return;
      }
      const list = report.issues
        .slice(0, 10)
        .map((i) => `· ${i.table}.${i.column} (#${i.rowId})：${i.preview}`)
        .join("\n");
      const more = report.issues.length > 10 ? `\n…另有 ${report.issues.length - 10} 处` : "";
      Modal.confirm({
        title: `发现 ${report.issues.length} 处损坏文本`,
        centered: true,
        content: (
          <div className="text-[13px]">
            <p className="mb-2">
              这些内容含非法 UTF-8 字节，会让同步整体失败。成因通常是跨设备直接拷贝 app.db，或把数据目录放在网盘里双向同步。修复会把坏字节替换成 �，只影响已损坏的那几个字符。
            </p>
            <pre className="m-0 max-h-[30vh] overflow-auto whitespace-pre-wrap rounded p-2 text-[12px]" style={{ background: "var(--m-well)" }}>
              {list + more}
            </pre>
          </div>
        ),
        okText: "立即修复",
        cancelText: "暂不修复",
        onOk: async () => {
          const fixed = await systemApi.checkDbTextHealth(true);
          if (fixed.errors.length > 0) message.warning(`修复 ${fixed.repairedCells} 处，${fixed.errors.length} 处失败：${fixed.errors[0]}`);
          else message.success(`已修复 ${fixed.repairedCells} 处，可以重新同步了`);
        },
      });
    } catch (e) {
      message.error(`数据库体检失败: ${e}`);
    } finally {
      setChecking(false);
    }
  }

  const iconStyle = { color: "var(--m-ink2)" };

  return (
    <div className="mx-auto w-full max-w-[860px] pb-12">
      <MNavBar onBack={() => navigate(-1)} title="关于" />

      <div className="m-px mt-4 flex flex-col items-center text-center">
        <BrandLogo size={64} />
        <div className="mt-3 text-[20px] font-bold" style={{ color: "var(--m-ink)" }}>
          Knowledge Base
        </div>
        <div className="m-t-meta mt-0.5">本地优先的个人知识库</div>
        {info && <span className="m-tag m-num mt-2" style={{ background: "var(--m-accent-soft2)", color: "var(--m-accent-ink)" }}>v{info.appVersion}</span>}
      </div>

      <div className="m-px mt-6">
        <MGroup>
          <MRow icon={<RefreshCw size={20} style={iconStyle} />} chevron right="在「我的」里" onClick={() => navigate("/settings")}>
            检查更新
          </MRow>
          <MRow icon={<HardDrive size={20} style={iconStyle} />} right={info ? `${info.os} · ${info.arch}` : undefined}>
            系统
          </MRow>
          <MRow
            icon={<HardDrive size={20} style={iconStyle} />}
            right={info ? <span className="block max-w-[11em] truncate">{info.dataDir}</span> : undefined}
            onClick={() => info && void copyText(info.dataDir, "数据目录")}
          >
            数据目录
          </MRow>
        </MGroup>

        <div className="m-t-cap mt-4 mb-1.5 px-1">了解更多</div>
        <MGroup>
          <MRow icon={<Globe size={20} style={iconStyle} />} chevron right="kb.ruoyi.plus" onClick={() => open(OFFICIAL_SITE)}>
            官网
          </MRow>
          <MRow icon={<PlayCircle size={20} style={iconStyle} />} chevron onClick={() => open(BILIBILI_TUTORIAL_URL)}>
            使用教程（B 站）
          </MRow>
          <MRow icon={<Tv size={20} style={iconStyle} />} chevron onClick={() => open(BILIBILI_URL)}>
            B 站主页
          </MRow>
        </MGroup>

        <div className="m-t-cap mt-4 mb-1.5 px-1">交流与反馈（点一下复制号码）</div>
        <MGroup>
          <MRow icon={<Users size={20} style={iconStyle} />} right={ZSXQ_ID} onClick={() => void copyText(ZSXQ_ID, "星球号")}>
            知识星球「{ZSXQ_NAME}」
          </MRow>
          <MRow icon={<MessageCircle size={20} style={iconStyle} />} right={QQ_GROUP_ID} onClick={() => void copyText(QQ_GROUP_ID, "群号")}>
            QQ 群
          </MRow>
          <MRow icon={<User size={20} style={iconStyle} />} right={AUTHOR_CONTACT} onClick={() => void copyText(AUTHOR_CONTACT, "联系方式")}>
            联系作者
          </MRow>
        </MGroup>

        <div className="m-t-cap mt-4 mb-1.5 px-1">排查问题</div>
        <MGroup>
          <MRow icon={<Bug size={20} style={iconStyle} />} right={exporting ? "导出中…" : undefined} onClick={() => void exportDiagnostics()}>
            导出诊断包
          </MRow>
          <MRow icon={<Stethoscope size={20} style={iconStyle} />} right={checking ? "检查中…" : undefined} onClick={() => void checkDbText()}>
            数据库文本体检
          </MRow>
        </MGroup>
      </div>
    </div>
  );
}
