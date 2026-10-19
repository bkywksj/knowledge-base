import { useEffect, useState } from "react";
import { Tooltip } from "antd";
import { ArrowUpCircle, Download, RefreshCw } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import type { Update } from "@tauri-apps/plugin-updater";
import type { UpdatePhase } from "@/hooks/useUpdateChecker";

interface Props {
  update: Update | null;
  phase: UpdatePhase;
  progress: number;
  /** 有更新时点击：打开更新弹窗 */
  onClick: () => void;
  /** 平时点击版本号：手动检查更新（反馈由调用方负责） */
  onCheck: () => void;
}

/**
 * 顶部栏右侧的版本 / 更新徽章，随 phase 切换：
 * - idle / checking：中性灰的「v1.2.3 ⟳」，点击手动检查（检查中图标转圈、禁用）
 * - downloading：「下载中 X%」（下载图标上下浮动，仍可点开看进度）
 * - ready：「重启以更新」（绿色高亮，点击弹窗确认重启秒装）
 * - available / error：「有可用更新」（兜底，点击弹窗手动下载/重试）
 * - installing：不渲染（已在弹窗里处理）
 *
 * 平时也常驻版本号：关掉「自动更新」的用户，右上角就是最顺手的手动检查入口。
 */
export function UpdateBadge({ update, phase, progress, onClick, onCheck }: Props) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  if (phase === "installing") return null;

  if (!update || phase === "idle" || phase === "checking") {
    if (!version) return null;
    const checking = phase === "checking";
    return (
      <Tooltip title={checking ? "正在检查更新…" : "点击检查更新"}>
        <button
          type="button"
          onClick={onCheck}
          disabled={checking}
          className="flex items-center gap-1 mx-1 px-2 h-6 rounded-full text-xs transition-colors"
          style={{
            border: "1px solid var(--kb-border)",
            color: "var(--kb-text-tertiary)",
            background: "transparent",
            cursor: checking ? "default" : "pointer",
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--kb-bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <span>v{version}</span>
          <RefreshCw size={11} className={checking ? "animate-spin" : undefined} />
        </button>
      </Tooltip>
    );
  }

  const ready = phase === "ready";
  const downloading = phase === "downloading";

  const color = ready ? "#52c41a" : downloading ? "#1677ff" : "#faad14";
  const hoverBg = ready
    ? "rgba(82, 196, 26, 0.12)"
    : downloading
      ? "rgba(22, 119, 255, 0.12)"
      : "rgba(250, 173, 20, 0.12)";

  const label = ready ? "重启以更新" : downloading ? `下载中 ${progress}%` : "有可用更新";
  const from = version ? `v${version} → ` : "";
  const tip = ready
    ? `新版本 ${from}v${update.version} 已下载完成，点击重启秒装`
    : downloading
      ? `正在后台下载 ${from}v${update.version}（${progress}%）`
      : `发现新版本 ${from}v${update.version}，点击查看`;

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
        <Icon size={12} className={downloading ? "kb-update-float" : undefined} />
        <span>{label}</span>
      </button>
    </Tooltip>
  );
}
