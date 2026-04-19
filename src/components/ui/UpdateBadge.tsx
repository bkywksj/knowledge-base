import { Tooltip } from "antd";
import { ArrowUpCircle } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";

interface Props {
  update: Update | null;
  onClick: () => void;
}

/**
 * 顶部栏右侧的"有可用更新"徽章。
 *
 * 仅当 update 存在时渲染；形态为绿色圆角带图标 + 版本号，点击触发外部 Modal。
 */
export function UpdateBadge({ update, onClick }: Props) {
  if (!update) return null;
  return (
    <Tooltip title={`发现新版本 v${update.version}，点击查看更新`}>
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-1 mx-1 px-2 h-6 rounded-full text-xs transition-colors"
        style={{
          border: "1.5px solid #52c41a",
          color: "#52c41a",
          background: "transparent",
          cursor: "pointer",
          lineHeight: 1,
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(82, 196, 26, 0.12)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <ArrowUpCircle size={12} />
        <span>有可用更新</span>
      </button>
    </Tooltip>
  );
}
