/**
 * 回收站自动清理：算某条笔记还剩几天被永久删除。
 *
 * 规则与后端一致（services/trash.rs `list_expired_trash_ids`）：
 * 到期时间 = max(删除时间, 规则生效时间) + days 天；生效前就在回收站里的笔记、
 * 没有删除时间的老数据，都从生效时间起算。
 */

/** 后端时间串 `YYYY-MM-DD HH:MM:SS`（本地时间）→ 毫秒 */
function parseLocal(s: string): number {
  return new Date(s.replace(" ", "T")).getTime();
}

/**
 * 剩余天数（向上取整，最少 0）；`days = 0`（从不清理）返回 null。
 * 后台每 6 小时清理一次，所以 0 表示「下一轮就会删」。
 */
export function daysUntilPurge(
  deletedAt: string | null | undefined,
  since: string,
  days: number,
  now: number = Date.now(),
): number | null {
  if (days <= 0) return null;
  const start = Math.max(deletedAt ? parseLocal(deletedAt) : 0, parseLocal(since));
  const left = start + days * 86_400_000 - now;
  return Math.max(0, Math.ceil(left / 86_400_000));
}

/** 行内文案 */
export function purgeLabel(daysLeft: number | null): string | null {
  if (daysLeft === null) return null;
  return daysLeft === 0 ? "即将自动删除" : `${daysLeft} 天后自动删除`;
}
