import { useCallback, useEffect, useState } from "react";
import { Button, Tooltip, App as AntdApp } from "antd";
import { ArrowDownUp } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { syncV1Api } from "@/lib/api";
import type { SyncBackend } from "@/types";
import { relativeTime } from "@/lib/utils";

/**
 * Header 右上角的"立即增量同步"按钮。
 * - hover：Tooltip 展示最近一次 push / pull 时间（取所有 enabled backend 中最近的）
 * - click：对所有 enabled backend 串行 pull → push（与后台 scheduler 一致），完成后刷新时间
 *
 * 没配置 backend 时按钮 disabled + Tooltip 引导去设置页配置。
 */
export function SyncStatusButton() {
  const { message } = AntdApp.useApp();
  const [backends, setBackends] = useState<SyncBackend[]>([]);
  const [syncing, setSyncing] = useState(false);

  const loadBackends = useCallback(async () => {
    try {
      const list = await syncV1Api.listBackends();
      setBackends(list);
    } catch {
      // 后端 schema 还没就绪等少见场景，按钮维持 disabled 即可，不打扰用户
    }
  }, []);

  useEffect(() => {
    loadBackends();
    // 后台 scheduler 跑完会 emit 'sync_v1:auto-triggered'，此时刷新时间显示
    let unlisten: UnlistenFn | null = null;
    listen("sync_v1:auto-triggered", () => {
      loadBackends();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [loadBackends]);

  /** 取所有 enabled backend 中最近的 push/pull 时间 */
  const enabled = backends.filter((b) => b.enabled);
  const latestPush = pickLatest(enabled.map((b) => b.lastPushTs));
  const latestPull = pickLatest(enabled.map((b) => b.lastPullTs));

  const handleClick = useCallback(async () => {
    if (syncing) return;
    if (enabled.length === 0) {
      message.info("请先在设置 → 同步 中配置后端");
      return;
    }
    setSyncing(true);
    let okCount = 0;
    const errs: string[] = [];
    for (const b of enabled) {
      try {
        await syncV1Api.pull(b.id);
        await syncV1Api.push(b.id);
        okCount++;
      } catch (e) {
        errs.push(`${b.name}: ${e}`);
      }
    }
    setSyncing(false);
    await loadBackends();
    if (errs.length === 0) {
      message.success(`同步完成（${okCount} 个后端）`);
    } else if (okCount > 0) {
      message.warning(`部分成功：成功 ${okCount}，失败 ${errs.length}\n${errs.join("；")}`);
    } else {
      message.error(`同步失败：${errs.join("；")}`);
    }
  }, [syncing, enabled, loadBackends, message]);

  const tooltipTitle = (
    <div style={{ minWidth: 180 }}>
      <div>
        最近推送：
        {latestPush ? `${relativeTime(latestPush)}（${latestPush.slice(0, 16)}）` : "—"}
      </div>
      <div>
        最近拉取：
        {latestPull ? `${relativeTime(latestPull)}（${latestPull.slice(0, 16)}）` : "—"}
      </div>
      <div style={{ marginTop: 4, opacity: 0.7, fontSize: 12 }}>
        {enabled.length === 0 ? "未配置后端，点击去配置" : "点击立即同步"}
      </div>
    </div>
  );

  return (
    <Tooltip title={tooltipTitle} placement="bottom">
      <Button
        type="text"
        className="kb-tb-btn"
        icon={<ArrowDownUp size={16} className={syncing ? "kb-update-float" : ""} />}
        onClick={handleClick}
        loading={false}
        disabled={syncing}
      />
    </Tooltip>
  );
}

/** 字符串时间数组中取最近的；忽略 null/空串 */
function pickLatest(times: (string | null)[]): string | null {
  let best: string | null = null;
  for (const t of times) {
    if (!t) continue;
    if (!best || t > best) best = t;
  }
  return best;
}
