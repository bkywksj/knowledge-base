import { useEffect, useState } from "react";
import { Modal, Button, App as AntdApp, List } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { useTabsStore, type NoteTab } from "@/store/tabs";
import { noteApi, syncV1Api } from "@/lib/api";

/** 单个 backend 推送的等待上限 */
const PER_BACKEND_TIMEOUT_MS = 15_000;
/** 整个退出同步阶段的等待上限（兜底，防止 backend 数量多时累加成很长的等待） */
const TOTAL_EXIT_SYNC_TIMEOUT_MS = 30_000;

/**
 * 给 promise 套一个超时。超时只是**不再等**，并不会取消后端仍在跑的任务
 * （数据都还在本地，下次启动会自动补同步），所以超时按"本次没推成功"处理即可。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}s）`)), ms),
    ),
  ]);
}

/**
 * 退出前对所有启用的同步后端做一次 push。
 * Why：保证最后一次本地修改进了远端，下次在别的设备 pull 时不会丢这部分。
 *
 * 设计要点（与思源"必须同步成功才能退"的关键差异）：
 * 1. 只 push 不 pull —— 用户都要走了，不应该把远端新内容拉下来覆盖
 * 2. 任何一个 backend 失败都返回错误信息，由调用方决定是否阻断退出（弹"强制退出"）
 *    而不是默默吞掉，否则离线场景下用户感知不到丢数据风险
 * 3. 每个 backend 单独 try/catch，一个失败不影响其他成功
 * 4. **必须有超时**：调用方是先 `window.hide()` 再跑这里的。若某个 backend 卡住
 *    （弱网下 WebDAV 读超时 60s × N 个文件），用户看到的是"窗口没了但进程还在"，
 *    此时再点图标启动，新进程会被单实例锁挡回去 —— 体感就是"软件打不开了"。
 *    超时后走失败分支（把窗口重新显示出来让用户选），保证进程一定有个确定的去向。
 */
async function pushAllOnExit(): Promise<{ ok: number; errors: string[] }> {
  let ok = 0;
  const errors: string[] = [];
  const deadline = Date.now() + TOTAL_EXIT_SYNC_TIMEOUT_MS;
  try {
    const backends = await withTimeout(
      syncV1Api.listBackends(),
      5_000,
      "读取同步源列表",
    );
    const enabled = backends.filter((b) => b.enabled);
    for (const b of enabled) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        errors.push(`${b.name}: 退出同步总时长已超限，本次未推送`);
        continue;
      }
      try {
        await withTimeout(
          syncV1Api.push(b.id),
          Math.min(PER_BACKEND_TIMEOUT_MS, remaining),
          `推送「${b.name}」`,
        );
        ok++;
      } catch (e) {
        errors.push(`${b.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch (e) {
    errors.push(`读取后端列表失败: ${e instanceof Error ? e.message : e}`);
  }
  return { ok, errors };
}

/**
 * 监听托盘"退出"事件 → 检查未保存草稿 → 三选一确认 → 隐藏到托盘后台同步再退。
 * 流程：
 *   - 无 dirty tab：直接走 syncThenExit()
 *   - 有 dirty tab：弹 Modal，让用户选择
 *     - 保存并退出：循环 dirty tabs，从 store draft 取内容 → noteApi.update → syncThenExit()
 *     - 放弃修改并退出：直接 syncThenExit()
 *     - 取消：关闭 Modal，什么都不做
 *
 * syncThenExit()：先把窗口 hide() 到托盘，再后台 push —— 同步不阻塞主窗口，完成后自动 exit(0)。
 *
 * 注：托盘 quit 菜单项不再直接 app.exit(0)，而是 emit "tray:request-exit"，由本组件接管。
 */
export function ExitConfirmListener() {
  const { message } = AntdApp.useApp();
  const [dirtyTabs, setDirtyTabs] = useState<NoteTab[]>([]);
  const [exiting, setExiting] = useState(false);
  /** 同步失败兜底弹窗：显示错误 + 强制退出按钮 */
  const [syncFailedErrors, setSyncFailedErrors] = useState<string[] | null>(null);
  const open = dirtyTabs.length > 0;

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen("tray:request-exit", async () => {
      const tabs = useTabsStore.getState().getDirtyTabs();
      if (tabs.length === 0) {
        // 没有未保存草稿：仍然要尝试推送（DB 里可能有上次同步后的修改）
        await syncThenExit();
        return;
      }
      setDirtyTabs(tabs);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 先把窗口隐藏到托盘，再在后台跑 push —— 同步不阻塞/卡住主窗口，用户体感"点完就关了"。
   * 成功 → 直接 exit(0)；失败 → 把窗口重新显示出来，弹窗让用户选"强制退出 / 留下处理"。
   */
  async function syncThenExit() {
    // 收掉可能还开着的脏数据弹窗，窗口随即隐藏到托盘
    setDirtyTabs([]);
    try {
      await getCurrentWindow().hide();
    } catch {
      // 隐藏失败不阻断后台同步流程
    }

    // 窗口此刻是隐藏的 —— 从这里到"要么 exit、要么把窗口显示回来"之间**不允许有任何
    // 逃逸路径**，否则进程会停在"看不见窗口但还占着单实例锁"的状态，用户再点图标启动
    // 会被锁挡回去，体感就是软件打不开。pushAllOnExit 内部已全量 catch + 超时，
    // 这里再包一层兜底，任何意外都归入 errors 走"显示窗口"分支。
    let errors: string[];
    try {
      ({ errors } = await pushAllOnExit());
    } catch (e) {
      errors = [`退出同步异常: ${e instanceof Error ? e.message : e}`];
    }

    if (errors.length === 0) {
      // errors 为空（含无配置 ok=0）即视为通过，不阻塞退出
      await exit(0);
      return;
    }

    // 同步失败 / 超时：重新显示窗口，让用户决定强制退出还是回去手动处理
    try {
      const w = getCurrentWindow();
      await w.show();
      await w.setFocus();
    } catch {
      // 显示失败也要把错误弹窗挂出来（理论上窗口仍在）
    }
    setSyncFailedErrors(errors);
  }

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
    // 保存成功 → 清空 dirty 弹窗 → 走同步阶段
    setDirtyTabs([]);
    await syncThenExit();
    setExiting(false);
  }

  async function handleDiscardAndExit() {
    setExiting(true);
    setDirtyTabs([]);
    // 放弃修改也要 push DB 已有数据（用户可能在别的设备已经改过这些笔记的更老版本）
    await syncThenExit();
    setExiting(false);
  }

  function handleCancel() {
    if (exiting) return;
    setDirtyTabs([]);
  }

  return (
    <>
      {/* 主弹窗：脏数据保存确认（保存/放弃/取消） */}
      <Modal
        open={open}
        title={`有 ${dirtyTabs.length} 条笔记尚未保存`}
        onCancel={handleCancel}
        mask={{ closable: !exiting }}
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

      {/* 同步失败兜底:让用户决定强制退出还是回去手动处理（失败时窗口已重新显示） */}
      <Modal
        open={syncFailedErrors !== null}
        title="同步失败"
        onCancel={() => setSyncFailedErrors(null)}
        closable
        maskClosable={false}
        footer={[
          <Button key="cancel" onClick={() => setSyncFailedErrors(null)}>
            取消（留下处理）
          </Button>,
          <Button key="force" danger onClick={() => exit(0)}>
            强制退出（放弃同步）
          </Button>,
        ]}
      >
        <p style={{ marginTop: 0 }}>
          以下后端推送失败，本地修改可能未上传到云端。
          强制退出后这部分修改仍保留在本地，下次启动会再尝试同步。
        </p>
        <List
          size="small"
          bordered
          dataSource={syncFailedErrors ?? []}
          renderItem={(err) => <List.Item style={{ color: "#cf1322" }}>{err}</List.Item>}
          style={{ maxHeight: 200, overflow: "auto" }}
        />
      </Modal>
    </>
  );
}
