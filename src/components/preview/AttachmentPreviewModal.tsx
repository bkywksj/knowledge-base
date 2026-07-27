import { useEffect, useState } from "react";
import {
  Alert,
  Modal,
  Button,
  Space,
  Tooltip,
  App as AntdApp,
  theme as antdTheme,
} from "antd";
import { FolderOpen, Maximize2, Minimize2 } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  useAttachmentPreviewStore,
  isTextAttachmentExt,
} from "@/store/attachmentPreview";
import { systemApi } from "@/lib/api";
import { DocxPreview } from "./DocxPreview";
import { XlsxPreview } from "./XlsxPreview";
import { TextPreview } from "./TextPreview";

/**
 * 全局附件预览 Modal（单例，挂在 AppLayout 根部）。
 *
 * 设计：
 * - 状态由 useAttachmentPreviewStore 全局控制，任何地方都能 open(...)
 * - 按扩展名分发到 Docx/Xlsx/Text/PDF 各子预览组件
 * - 标题栏始终带"用系统应用打开"按钮兜底（任何预览失败都能跳外部程序）
 * - 最大化按钮：参考 editor.tsx PDF Modal 的体验，默认 85vw，点最大化变 100vw
 */
export function AttachmentPreviewModal() {
  const target = useAttachmentPreviewStore((s) => s.target);
  const close = useAttachmentPreviewStore((s) => s.close);
  const { token } = antdTheme.useToken();
  const { message } = AntdApp.useApp();
  const [maximized, setMaximized] = useState(false);
  /** PDF / 图片预览要用的 asset URL（http://asset.localhost/...） */
  const [pdfSrc, setPdfSrc] = useState<string>("");
  /** 系统程序打开兜底用的绝对路径（避免每次点按钮重新 resolve） */
  const [absPath, setAbsPath] = useState<string>("");

  const open = target != null;
  const fileName = target?.fileName ?? "";
  /**
   * 用哪个预览器，**必须**按 `rel`（真实文件路径）判断，不能按 `fileName`。
   *
   * `fileName` 优先取笔记里链接的显示文本（见 TiptapEditor 的 attachment 点击处理），
   * 用户完全可能把它改成不带扩展名的中文标题（"关于 XX 的通知"）。此前这里按
   * fileName 推扩展名，遇到改过名的 PDF 就三个分支都不匹配 → 落到 TextPreview
   * 兜底 → 用 UTF-8 读二进制 PDF → 报 "stream did not contain valid UTF-8"。
   *
   * 而"能不能预览"那一侧（isPreviewableAttachment）本来就是按 rel 判断的，
   * 两处口径不一致才是 bug 根因。这里统一到 rel。
   */
  const ext = (target?.rel ?? "").toLowerCase().split(".").pop() ?? "";

  // 解析 rel → 绝对路径（系统程序打开 + PDF iframe src 都要用）
  useEffect(() => {
    if (!target) {
      setPdfSrc("");
      setAbsPath("");
      return;
    }
    let cancelled = false;
    systemApi
      .resolveAssetAbsolute(target.rel)
      .then((abs) => {
        if (cancelled) return;
        setAbsPath(abs);
        // PDF iframe 用 asset 协议 URL（不是绝对路径，那是给 opener 用的）
        if (ext === "pdf") setPdfSrc(convertFileSrc(abs));
      })
      .catch((e) => {
        if (!cancelled) message.error(`路径解析失败：${e}`);
      });
    return () => {
      cancelled = true;
    };
  }, [target, ext, message]);

  // 关闭时重置最大化状态（下次打开回到默认）
  useEffect(() => {
    if (!open) setMaximized(false);
  }, [open]);

  async function openExternal() {
    if (!absPath) return;
    try {
      await openPath(absPath);
      close();
    } catch (e) {
      message.error(`打开失败：${e}`);
    }
  }

  const isOfficeWord = ext === "docx" || ext === "doc";
  const isExcel =
    ext === "xlsx" ||
    ext === "xls" ||
    ext === "xlsm" ||
    ext === "xlsb" ||
    ext === "ods";
  const isPdf = ext === "pdf";

  return (
    <Modal
      open={open}
      destroyOnHidden
      title={
        <div
          className="flex items-center justify-between"
          style={{ paddingRight: 32, gap: 8 }}
        >
          <span className="truncate" style={{ minWidth: 0 }}>
            {fileName || "附件预览"}
          </span>
          <Space size={4}>
            <Tooltip title={maximized ? "还原窗口" : "最大化"}>
              <Button
                size="small"
                type="text"
                icon={
                  maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />
                }
                onClick={() => setMaximized((v) => !v)}
              />
            </Tooltip>
            <Button
              size="small"
              icon={<FolderOpen size={14} />}
              onClick={() => void openExternal()}
              disabled={!absPath}
            >
              用系统应用打开
            </Button>
          </Space>
        </div>
      }
      footer={null}
      onCancel={close}
      width={maximized ? "100vw" : "85vw"}
      style={{
        top: maximized ? 0 : 24,
        maxWidth: maximized ? "100vw" : undefined,
        paddingBottom: 0,
      }}
      styles={{
        body: {
          height: maximized ? "calc(100vh - 56px)" : "75vh",
          overflow: "auto",
          background: token.colorBgContainer,
        },
      }}
    >
      {target == null ? null : isPdf ? (
        // PDF 直接用 iframe + asset 协议；如果失败用户可点"用系统应用打开"
        pdfSrc ? (
          <iframe
            src={pdfSrc}
            style={{ width: "100%", height: "100%", border: "none" }}
            title={fileName}
          />
        ) : (
          <div style={{ padding: 24 }}>正在加载 PDF...</div>
        )
      ) : isOfficeWord ? (
        <DocxPreview rel={target.rel} fileName={fileName} />
      ) : isExcel ? (
        <XlsxPreview rel={target.rel} />
      ) : isTextAttachmentExt(ext) ? (
        <TextPreview rel={target.rel} fileName={fileName} />
      ) : (
        // 不认识的类型不再硬塞给 TextPreview——那会拿 UTF-8 去读二进制然后报
        // 一句用户看不懂的 "stream did not contain valid UTF-8"。
        // 明确告诉用户"预览不了"，并引导到已经在标题栏的"用系统应用打开"。
        <Alert
          type="info"
          showIcon
          message={`暂不支持在应用内预览 .${ext || "未知"} 文件`}
          description="可以点右上角「用系统应用打开」，用系统默认程序查看。"
        />
      )}
    </Modal>
  );
}
