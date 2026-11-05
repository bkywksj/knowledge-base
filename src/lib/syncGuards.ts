/**
 * 同步的两道安全闸在前端的对话（2026-11-05 数据安全审查第 5、6 条）：
 *
 * - 拉取：远端要求删除的笔记数量异常时，后端一条都不删，返回 deletionsHeld；
 *   这里问用户确认，确认后带 allowMassDelete 再拉一次。
 * - 整包推送：本机笔记为空或比上次推送少一半以上时，后端返回 PUSH_SAFETY: 前缀的错误；
 *   这里问用户确认，确认后带 force 再推一次。
 */
import type { ModalFuncProps } from "antd";

/** 后端 commands::sync::PUSH_SAFETY_PREFIX */
export const PUSH_SAFETY_PREFIX = "PUSH_SAFETY:";

/** 推送安全检查没过时的提示原文；不是这类错误返回 null */
export function pushSafetyMessage(err: unknown): string | null {
  const s = String(err);
  const i = s.indexOf(PUSH_SAFETY_PREFIX);
  return i < 0 ? null : s.slice(i + PUSH_SAFETY_PREFIX.length).trim();
}

/** 拉取时被暂停的删除说明；没有被暂停的返回 null */
export function heldDeletionsText(r: { deletionsHeld?: number; localNotes?: number }): string | null {
  const held = r.deletionsHeld ?? 0;
  if (held <= 0) return null;
  const total = r.localNotes ?? 0;
  const pct = total > 0 ? `，占本机 ${Math.round((held / total) * 100)}%` : "";
  return `云端要求删除 ${held} 篇笔记（本机共 ${total} 篇${pct}），数量异常，这次先没有删。`;
}

type Confirm = (props: ModalFuncProps) => unknown;

/** 把 antd 的 confirm 包成 Promise：点确定 → true，取消 / 关闭 → false */
export function askConfirm(confirm: Confirm, props: ModalFuncProps): Promise<boolean> {
  return new Promise((resolve) => {
    confirm({
      ...props,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

/** 拉取结果里有被暂停的删除时问用户；返回用户是否确认跟着删除（没有暂停的直接返回 false） */
export function confirmHeldDeletions(
  confirm: Confirm,
  r: { deletionsHeld?: number; localNotes?: number },
): Promise<boolean> {
  const text = heldDeletionsText(r);
  if (!text) return Promise.resolve(false);
  return askConfirm(confirm, {
    title: "跟着云端删除这些笔记？",
    content: `${text}可能是另一台设备误删了一批笔记，或者用空库 / 错误的库推送了。确认是你自己删的，再点「跟着删除」；删除的笔记会进回收站。`,
    okText: "跟着删除",
    okButtonProps: { danger: true },
    cancelText: "先不删",
  });
}

/** 整包推送安全检查没过时问用户；返回用户是否仍要推送 */
export function confirmUnsafePush(confirm: Confirm, reason: string): Promise<boolean> {
  return askConfirm(confirm, {
    title: "推送会覆盖云端备份，确定吗？",
    content: `${reason}。云端的备份可能是你唯一的完整备份，推送后会被本机内容替换。`,
    okText: "仍然推送",
    okButtonProps: { danger: true },
    cancelText: "取消",
  });
}
