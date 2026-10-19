/**
 * 删除后的「撤销」提示条。
 *
 * 笔记进回收站、待办打墓碑都是软删，数据还在，所以删除不弹确认框，
 * 改成删完给一条带「撤销」的提示：误删一键找回，正常删除也少点一次。
 */
import type { MessageInstance } from "antd/es/message/interface";

import { taskApi, trashApi } from "@/lib/api";
import { useAppStore } from "@/store";

/** 提示条停留秒数：给够反应时间，又不至于一直挡着 */
const UNDO_SECONDS = 8;

let seq = 0;

/**
 * 显示「{text} · 撤销」。点撤销后提示条立即收起并执行 onUndo；
 * onUndo 失败时报错，不吞掉。
 */
export function showUndoMessage(
  message: MessageInstance,
  text: string,
  onUndo: () => Promise<void>,
): void {
  const key = `undo-delete-${++seq}`;
  void message.open({
    key,
    type: "success",
    duration: UNDO_SECONDS,
    content: (
      <span>
        {text}
        <a
          style={{ marginLeft: 12 }}
          onClick={() => {
            message.destroy(key);
            onUndo().catch((e) => message.error(`撤销失败：${e}`));
          }}
        >
          撤销
        </a>
      </span>
    ),
  });
}

/**
 * 笔记移到回收站后的提示。撤销 = 从回收站恢复，并刷新各处笔记列表。
 * @param afterUndo 调用方自己的额外刷新（比如笔记页当前分页），可不传
 */
export function notifyNotesTrashed(
  message: MessageInstance,
  ids: number[],
  text = ids.length > 1 ? `已移到回收站 ${ids.length} 篇` : "已移到回收站",
  afterUndo?: () => void | Promise<void>,
): void {
  showUndoMessage(message, text, async () => {
    await trashApi.restoreBatch(ids);
    useAppStore.getState().bumpNotesRefresh();
    await afterUndo?.();
    message.success("已恢复");
  });
}

/**
 * 待办删除后的提示。撤销 = 去掉删除标记，并刷新侧边栏待办计数。
 * @param afterUndo 调用方重新拉列表
 */
export function notifyTasksDeleted(
  message: MessageInstance,
  ids: number[],
  text = ids.length > 1 ? `已删除 ${ids.length} 条任务` : "已删除",
  afterUndo?: () => void | Promise<void>,
): void {
  showUndoMessage(message, text, async () => {
    await taskApi.restoreDeleted(ids);
    useAppStore.getState().refreshTaskStats();
    await afterUndo?.();
    message.success("已恢复");
  });
}
