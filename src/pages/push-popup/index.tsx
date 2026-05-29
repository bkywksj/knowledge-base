import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Button, Spin, message } from "antd";
import { BellRing, Copy, ExternalLink, NotebookPen, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { MarkdownContent } from "@/components/ai/MarkdownContent";
import { pushApi, dailyApi } from "@/lib/api";
import type { PushPopupData } from "@/types";

// 窗口尺寸常量
const HEADER_H = 40; // 顶部拖动条
const FOOTER_H = 49; // 底部操作栏
const MIN_H = 200;
const MIN_W = 360;
/** 按内容字数选宽度档：短内容窄、长新闻宽。高度永远按实测内容自适应。 */
function pickWidth(len: number): number {
  if (len < 50) return 400;
  if (len < 200) return 480;
  if (len < 600) return 560;
  return 640;
}

/**
 * 定时推送「居中弹窗」承载页面（独立悬浮窗，参考 quick-add / emergency-reminder）。
 *
 * - 独立窗口，不依赖也不抢占主窗；无边框，顶部窄条作拖动区
 * - 按 URL 的 :logId 拉 run_log 快照（推送名 + 生成内容）
 * - 操作：复制 / 写入今日日记 / 打开主窗（show+focus 主窗）/ 关闭（关自身窗口）
 * - lib.rs on_window_event 只拦 main 窗，本窗 close() 直接生效
 */
export default function PushPopupPage() {
  const { logId } = useParams<{ logId: string }>();
  const id = logId ? Number(logId) : NaN;
  const [data, setData] = useState<PushPopupData | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  // 测量内容真实高度的隐藏探针（与正式内容区同宽同字体）
  const measureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!Number.isFinite(id)) {
      setErrorText("无效的推送记录 ID");
      setLoading(false);
      return;
    }
    let cancelled = false;
    pushApi
      .popupData(id)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setErrorText(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // 智能尺寸：内容加载后按字数选宽度、按实测内容高度定窗口高，
  // 高度封顶到屏幕 82%（超出则内部滚动），再重新居中。用户之后仍可手动拉伸。
  useEffect(() => {
    if (!data || !measureRef.current) return;
    const len = data.content.length;
    const width = pickWidth(len);
    // 实测内容高度（探针已用目标宽度渲染）
    const contentH = measureRef.current.scrollHeight;
    const screenH = window.screen?.availHeight ?? 900;
    const maxH = Math.floor(screenH * 0.82);
    const desiredH = Math.min(maxH, Math.max(MIN_H, HEADER_H + FOOTER_H + contentH + 24));
    const finalW = Math.max(MIN_W, width);
    const win = getCurrentWindow();
    win
      .setSize(new LogicalSize(finalW, desiredH))
      .then(() => win.center())
      .catch((e) => console.error("[push-popup] setSize failed:", e));
  }, [data]);

  async function closeSelf() {
    try {
      await getCurrentWindow().close();
    } catch (e) {
      console.error("[push-popup] window close failed:", e);
    }
  }

  async function copyContent() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.content);
      message.success("已复制");
    } catch {
      message.error("复制失败");
    }
  }

  async function writeToDaily() {
    if (!data) return;
    try {
      await dailyApi.appendQuickCapture(`📡 ${data.name}\n${data.content}`);
      message.success("已写入今日日记");
    } catch (e) {
      message.error(`写入失败: ${e}`);
    }
  }

  /** 唤起主窗：show + 取消最小化 + 抢焦点（不关闭本弹窗，用户可继续看内容） */
  async function openMain() {
    try {
      const main = await WebviewWindow.getByLabel("main");
      if (main) {
        await main.unminimize();
        await main.show();
        await main.setFocus();
      }
    } catch (e) {
      console.error("[push-popup] open main failed:", e);
    }
  }

  const isFailed = data?.status === "failed";

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden"
      style={{
        background: "var(--kb-bg-elevated, #fff)",
        color: "var(--kb-text, #1f1f1f)",
        borderRadius: 12,
        border: "1px solid var(--kb-border, #e5e7eb)",
      }}
    >
      {/* 顶部拖动条 + 标题（整条都是拖动区，光标提示可拖；按钮显式排除） */}
      <div
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-2 px-4 select-none"
        style={{
          height: HEADER_H,
          cursor: "grab",
          borderBottom: "1px solid var(--kb-border, #eee)",
          // 标题色条：成功用主色，失败用红
          borderLeft: `4px solid ${isFailed ? "#ff4d4f" : "var(--kb-primary, #6366f1)"}`,
        }}
      >
        <BellRing
          size={16}
          className={isFailed ? "text-red-500" : "text-indigo-500"}
          style={{ pointerEvents: "none" }}
        />
        <span
          className="flex-1 truncate text-sm font-medium"
          style={{ pointerEvents: "none" }}
        >
          {data?.name ?? "定时推送"}
        </span>
        <Button
          type="text"
          size="small"
          icon={<X size={16} />}
          data-tauri-drag-region={false}
          onClick={closeSelf}
        />
      </div>

      {/* 内容区：超出窗口高度时内部滚动（长新闻不会撑爆窗口） */}
      <div className="flex-1 overflow-auto px-4 py-3">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spin />
          </div>
        ) : errorText ? (
          <div className="text-sm text-red-500">{errorText}</div>
        ) : isFailed ? (
          // 失败内容是报错文本，按纯文本展示（不当 markdown 解析）
          <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-red-500">
            {data?.content}
          </div>
        ) : (
          // 成功内容是 AI 输出，可能含 Markdown（**加粗**/列表/标题等），用统一组件渲染
          <div className="kb-md break-words text-[15px] leading-relaxed">
            <MarkdownContent>{data?.content ?? ""}</MarkdownContent>
          </div>
        )}
      </div>

      {/* 隐藏探针：与内容区同宽同字体，用于测量真实内容高度后定窗口大小。
          宽度跟随 pickWidth 选出的宽度减去左右 padding(32)，保证测量与实际换行一致。 */}
      {data && (
        <div
          ref={measureRef}
          aria-hidden
          className="whitespace-pre-wrap break-words text-[15px] leading-relaxed"
          style={{
            position: "absolute",
            visibility: "hidden",
            pointerEvents: "none",
            left: -99999,
            top: 0,
            width: pickWidth(data.content.length) - 32,
          }}
        >
          {data.content}
        </div>
      )}

      {/* 底部操作栏 */}
      <div
        className="flex shrink-0 items-center justify-end gap-2 px-4 py-2"
        style={{ borderTop: "1px solid var(--kb-border, #eee)" }}
      >
        <Button
          size="small"
          icon={<ExternalLink size={14} />}
          onClick={openMain}
        >
          打开主窗
        </Button>
        {!isFailed && (
          <>
            <Button
              size="small"
              icon={<Copy size={14} />}
              onClick={copyContent}
            >
              复制
            </Button>
            <Button
              size="small"
              icon={<NotebookPen size={14} />}
              onClick={writeToDaily}
            >
              写入日记
            </Button>
          </>
        )}
        <Button size="small" type="primary" onClick={closeSelf}>
          关闭
        </Button>
      </div>
    </div>
  );
}
