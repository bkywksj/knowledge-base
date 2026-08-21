/**
 * 右下角批量导入悬浮条。
 *
 * 挂在 LayoutSwitch（路由根）上，桌面 / 移动共用一份，所以**不随页面卸载** ——
 * 导 30 个 PDF 的时候去写笔记、翻文件夹，进度仍在角落里跑。
 *
 * 定位说明：只显示"正在进行 / 刚结束"的批量导入。成败明细不归它管
 * （成功由 message.success、失败由带「复制清单」的弹窗负责），
 * 所以结束几秒后自己消失，不需要用户清理。
 */
import { Progress, Tooltip, Typography, theme } from "antd";
import { X } from "lucide-react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useAppStore } from "@/store";

const { Text } = Typography;

export function ImportStatusDock() {
  const jobs = useAppStore((s) => s.importJobs);
  const dismiss = useAppStore((s) => s.dismissImportJob);
  const isMobile = useIsMobile();
  const { token } = theme.useToken();

  if (jobs.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        // 移动端底部有 64px 的 Tab 栏 + 安全区，抬高到它上面（与 MobileLayout 的 FAB 同一算法）
        bottom: isMobile
          ? `calc(64px + env(safe-area-inset-bottom, 0px) + 16px)`
          : 16,
        // 低于 antd Modal（1000）：导入失败清单弹出来时该盖住悬浮条，而不是被它压住
        zIndex: 900,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      {jobs.map((job) => {
        const done = job.result != null;
        const percent = job.total > 0
          ? Math.round((job.current / job.total) * 100)
          : 0;
        return (
          <div
            key={job.id}
            style={{
              pointerEvents: "auto",
              width: 268,
              padding: "10px 12px",
              borderRadius: token.borderRadiusLG,
              background: token.colorBgElevated,
              border: `1px solid ${token.colorBorderSecondary}`,
              boxShadow: token.boxShadowSecondary,
            }}
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <Text strong style={{ fontSize: 13 }}>
                {done ? `${job.kind} 导入完成` : `正在导入 ${job.kind}`}
              </Text>
              <Tooltip title="关闭提示（导入仍在后台继续）">
                <X
                  size={14}
                  style={{ cursor: "pointer", color: token.colorTextTertiary, flexShrink: 0 }}
                  onClick={() => dismiss(job.id)}
                />
              </Tooltip>
            </div>

            <Progress
              percent={percent}
              size="small"
              status={
                done
                  ? job.result!.failed > 0
                    ? "exception"
                    : "success"
                  : "active"
              }
              format={() => `${job.current}/${job.total}`}
            />

            <Text
              type="secondary"
              // 文件名可能很长，单行截断优于把悬浮条撑成一堵墙
              style={{
                fontSize: 11,
                display: "block",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={done ? undefined : job.fileName}
            >
              {done
                ? `成功 ${job.result!.ok}${job.result!.failed > 0 ? ` · 失败 ${job.result!.failed}` : ""}`
                : job.fileName || "准备中…"}
            </Text>
          </div>
        );
      })}
    </div>
  );
}
