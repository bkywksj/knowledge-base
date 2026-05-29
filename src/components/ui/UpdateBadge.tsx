import { Tooltip } from "antd";
import { ArrowUpCircle, Download, RefreshCw } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";
import type { UpdatePhase } from "@/hooks/useUpdateChecker";

interface Props {
  update: Update | null;
  phase: UpdatePhase;
  progress: number;
  onClick: () => void;
}

/**
 * 顶部栏右侧的更新徽章，随 phase 三态切换：
 * - downloading：「下载中 X%」（图标旋转，仍可点开看进度）
 * - ready：「重启以更新」（绿色高亮，点击弹窗确认重启秒装）
 * - available / error：「有可用更新」（兜底，点击弹窗手动下载/重试）
 *
 * idle / checking / installing 不渲染（无更新 or 已在弹窗里处理）。
 */
export function UpdateBadge({ update, phase, progress, onClick }: Props) {
  if (!update) return null;
  if (phase === "idle" || phase === "checking" || phase === "installing") return null;

  const ready = phase === "ready";
  const downloading = phase === "downloading";

  const color = ready ? "#52c41a" : downloading ? "#1677ff" : "#faad14";
  const hoverBg = ready
    ? "rgba(82, 196, 26, 0.12)"
    : downloading
      ? "rgba(22, 119, 255, 0.12)"
      : "rgba(250, 173, 20, 0.12)";

  const label = ready ? "重启以更新" : downloading ? `下载中 ${progress}%` : "有可用更新";
  const tip = ready
    ? `新版本 v${update.version} 已下载完成，点击重启秒装`
    : downloading
      ? `正在后台下载 v${update.version}（${progress}%）`
      : `发现新版本 v${update.version}，点击查看`;

  const Icon = ready ? ArrowUpCircle : downloading ? Download : RefreshCw;

  return (
    <Tooltip title={tip}>
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-1 mx-1 px-2 h-6 rounded-full text-xs transition-colors"
        style={{
          border: `1.5px solid ${color}`,
          color,
          background: ready ? "rgba(82, 196, 26, 0.12)" : "transparent",
          cursor: "pointer",
          lineHeight: 1,
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = hoverBg;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = ready ? "rgba(82, 196, 26, 0.12)" : "transparent";
        }}
      >
        <Icon size={12} className={downloading ? "animate-spin" : undefined} />
        <span>{label}</span>
      </button>
    </Tooltip>
  );
}
