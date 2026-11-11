import { Button } from "antd";
import { CircleCheck, X } from "lucide-react";
import { useUpdater } from "@/components/updater/UpdaterProvider";

/**
 * 更新包已下载并验签后，内容区顶部的一条轻提示（v4 原型 H 画板 .strip）：
 * 「3.1.0 已下载好，空闲时重启即可完成更新」+ 更新内容 / 立即重启 / 关闭。
 *
 * 不打断：不弹窗、不抢焦点；关掉后这个版本不再出现（出了更新的版本再提示）。
 * 选了「下次启动时安装」时不显示 —— 那种情况用户已经安排好了，不需要提醒。
 * 样式在 global.css 的 .kb-upd-strip。
 */
export function UpdateReadyStrip() {
  const updater = useUpdater();
  if (!updater?.showReadyBanner || !updater.update) return null;

  return (
    <div className="kb-upd-strip" role="status">
      <CircleCheck size={16} className="kb-upd-strip-lead" />
      <span className="kb-upd-strip-text">{updater.update.version} 已下载好，空闲时重启即可完成更新</span>
      <span className="flex-1" />
      <Button type="text" size="small" onClick={updater.openModal}>
        更新内容
      </Button>
      <Button type="primary" size="small" onClick={() => void updater.installAndRelaunch()}>
        立即重启
      </Button>
      <Button
        type="text"
        size="small"
        icon={<X size={14} />}
        onClick={updater.dismissReadyBanner}
        title="关闭（这个版本不再提示）"
        aria-label="关闭"
      />
    </div>
  );
}
