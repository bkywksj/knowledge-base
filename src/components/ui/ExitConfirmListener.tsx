import { useEffect, useState } from "react";
import { Modal, Button, App as AntdApp, List } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { useTabsStore, type NoteTab } from "@/store/tabs";
import { noteApi } from "@/lib/api";

/**
 * 监听托盘"退出"事件 → 检查未保存草稿 → 三选一确认。
 * 流程：
 *   - 无 dirty tab：直接 exit(0)
 *   - 有 dirty tab：弹 Modal，让用户选择
 *     - 保存并退出：循环 dirty tabs，从 store draft 取内容 → noteApi.update → exit
 *     - 放弃修改并退出：直接 exit
 *     - 取消：关闭 Modal，什么都不做
 *
 * 注：托盘 quit 菜单项不再直接 app.exit(0)，而是 emit "tray:request-exit"，由本组件接管。
 */
export function ExitConfirmListener() {
  const { message } = AntdApp.useApp();
  const [dirtyTabs, setDirtyTabs] = useState<NoteTab[]>([]);
  const [exiting, setExiting] = useState(false);
  const open = dirtyTabs.length > 0;

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen("tray:request-exit", async () => {
      const tabs = useTabsStore.getState().getDirtyTabs();
      if (tabs.length === 0) {
        // 没有未保存内容，直接退出
        await exit(0);
        return;
      }
      setDirtyTabs(tabs);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  async function handleSaveAndExit() {
    setExiting(true);
    const { getDraft, clearDraft } = useTabsStore.getState();
    const failed: string[] = [];
    for (const tab of dirtyTabs) {
      const draft = getDraft(tab.id);
      if (!draft || !draft.title.trim()) {
        failed.push(tab.title || "未命名");
        continue;
      }
      try {
        await noteApi.update(tab.id, { title: draft.title.trim(), content: draft.content });
        clearDraft(tab.id);
      } catch (e) {
        failed.push(`${tab.title || "未命名"}（${e}）`);
      }
    }
    if (failed.length > 0) {
      setExiting(false);
      message.error(`${failed.length} 条笔记保存失败，已取消退出：${failed.join("；")}`);
      // 重新查一次 dirty 列表（有些可能保存成功了）
      setDirtyTabs(useTabsStore.getState().getDirtyTabs());
      return;
    }
    await exit(0);
  }

  async function handleDiscardAndExit() {
    setExiting(true);
    await exit(0);
  }

  function handleCancel() {
    if (exiting) return;
    setDirtyTabs([]);
  }

  return (
    <Modal
      open={open}
      title={`有 ${dirtyTabs.length} 条笔记尚未保存`}
      onCancel={handleCancel}
      maskClosable={!exiting}
      closable={!exiting}
      footer={[
        <Button key="discard" danger disabled={exiting} onClick={handleDiscardAndExit}>
          放弃修改并退出
        </Button>,
        <Button key="cancel" disabled={exiting} onClick={handleCancel}>
          取消
        </Button>,
        <Button key="save" type="primary" loading={exiting} onClick={handleSaveAndExit}>
          保存全部并退出
        </Button>,
      ]}
    >
      <p style={{ marginTop: 0 }}>退出后未保存的修改将丢失。请选择操作：</p>
      <List
        size="small"
        bordered
        dataSource={dirtyTabs}
        renderItem={(t) => <List.Item>{t.title || "未命名"}</List.Item>}
        style={{ maxHeight: 200, overflow: "auto" }}
      />
    </Modal>
  );
}
