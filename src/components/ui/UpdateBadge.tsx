import { useEffect, useState } from "react";
import { Tooltip } from "antd";
import { ArrowRight, RefreshCw } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import type { UpdateInfo, UpdatePhase } from "@/hooks/useUpdateChecker";

interface Props {
  update: UpdateInfo | null;
  phase: UpdatePhase;
  progress: number;
  /** 有更新时点击：打开更新弹窗 */
  onClick: () => void;
  /** 平时点击版本号：手动检查更新（反馈由调用方负责） */
  onCheck: () => void;
}

/**
 * 顶部栏右侧的版本 / 更新徽章，随 phase 切换：
 * - idle / checking：中性的「v1.2.3 ⟳」，点击手动检查（检查中图标转圈、禁用）
 * - available：「● v旧 → v新」，点击弹窗手动下载
 * - downloading / verifying：同上 + 「· X%」/「· 校验中」，整个胶囊就是进度条，已下载部分填上流动的斜纹（圆点呼吸），仍可点开看进度
 * - paused：同上 + 「· 已暂停」，斜纹变灰、停住
 * - ready：绿色「● v旧 → v新 · 重启生效」，点击弹窗确认重启秒装
 * - error：红色「· 下载失败」，点击弹窗看原因 / 重试
 * - installing：不渲染（已在弹窗里处理）
 *
 * 平时也常驻版本号：关掉「自动更新」的用户，右上角就是最顺手的手动检查入口。
 * 样式在 global.css 的 .kb-upd（v4 原型 .upd），颜色全走主题变量。
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
          className="kb-upd kb-upd-idle"
        >
          <span>v{version}</span>
          <RefreshCw size={11} className={checking ? "animate-spin" : undefined} />
        </button>
      </Tooltip>
    );
  }

  const ready = phase === "ready";
  const downloading = phase === "downloading";
  const verifying = phase === "verifying";
  const paused = phase === "paused";
  const failed = phase === "error";
  const showFill = downloading || verifying || paused;

  const from = version ? `v${version} → ` : "";
  const target = `${from}v${update.version}`;
  const tip = ready
    ? `新版本 ${target} 已下载完成，点击重启秒装`
    : downloading
      ? `正在后台下载 ${target}（${progress}%）`
      : verifying
        ? `${target} 已下载，正在校验签名`
        : paused
          ? `${target} 下载已暂停（${progress}%），点击继续`
          : failed
            ? `${target} 下载失败，点击查看原因`
            : `发现新版本 ${target}，点击查看`;

  const stateClass = ready
    ? " is-ready"
    : downloading
      ? " is-downloading"
      : verifying
        ? " is-downloading is-verifying"
        : paused
        ? " is-paused"
        : failed
          ? " is-error"
          : "";

  return (
    <Tooltip title={tip}>
      <button type="button" onClick={onClick} className={`kb-upd${stateClass}`}>
        {/* 进度 = 胶囊被斜纹填满的比例（样式见 global.css .kb-upd-fill） */}
        {showFill && <span className="kb-upd-fill" style={{ width: `${verifying ? 100 : progress}%` }} />}
        <i className="kb-upd-dot" />
        {version && (
          <>
            <span className="kb-upd-from">v{version}</span>
            <ArrowRight size={11} strokeWidth={2} className="kb-upd-arrow" />
          </>
        )}
        <b>v{update.version}</b>
        {downloading && <em>· {progress}%</em>}
        {verifying && <em>· 校验中</em>}
        {paused && <em>· 已暂停</em>}
        {failed && <em>· 下载失败</em>}
        {ready && <em>· 重启生效</em>}
      </button>
    </Tooltip>
  );
}
