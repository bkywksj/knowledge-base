import { useEffect, useState } from "react";
import { Modal, Checkbox, Button, Space, App as AntdApp } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { configApi } from "@/lib/api";

const CFG_KEY = "window.close_action";
type CloseAction = "ask" | "minimize" | "exit";

/**
 * 监听窗口关闭按钮（Rust 已 prevent_close 并 emit `app:close-requested`），
 * 根据 app_config 里的 `window.close_action` 决定行为：
 *   - minimize：直接隐藏到托盘
 *   - exit    ：转发 `tray:request-exit` 让 ExitConfirmListener 走脏数据检查 → exit
 *   - ask（默认）：弹三选一对话框，可勾选"记住选择"
 *
 * 用 emit 触发已有的 ExitConfirmListener 而不是自己 exit(0)，避免脏数据丢失。
 *
 * ⚠️ 与 Rust 侧 `close_watchdog` 的契约：收到事件必须**立刻**回 `app:close-ack`
 * （回调第一行，不能排在任何 await 之后）。Rust 靠这个信号判断 WebView 是否还活着，
 * 超时未收到就强制退出进程 —— 这是 WebView 崩掉后唯一的退出兜底。
 */
export function CloseRequestedListener() {
  const { message } = AntdApp.useApp();
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen("app:close-requested", async () => {
      // 🔴 第一行、任何 await 之前先回 ack —— 这是 Rust 侧 close_watchdog 的探活信号。
      // Rust 已经 prevent_close()，窗口的生死从此刻起完全握在本组件手里；若 WebView 白屏
      // 或渲染进程崩了，这个回调压根不会执行，看门狗超时后会替用户强制退出，
      // 避免出现「关不掉、只能开任务管理器杀进程」的僵尸窗口。
      // 必须放在最前面：晚于任何 IO 都会让"活着但慢"被误判成"已死"。
      void emit("app:close-ack").catch(() => {});

      const action = ((await configApi.get(CFG_KEY).catch(() => "")) ||
        "ask") as CloseAction;
      if (action === "minimize") {
        await hideToTray();
      } else if (action === "exit") {
        await emit("tray:request-exit");
      } else {
        setRemember(false);
        setOpen(true);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  async function hideToTray() {
    try {
      await getCurrentWindow().hide();
    } catch (e) {
      message.error(`隐藏窗口失败：${e}`);
    }
  }

  async function persistIfRemember(action: CloseAction) {
    if (remember) {
      await configApi.set(CFG_KEY, action).catch(() => {});
    }
  }

  async function handleMinimize() {
    setOpen(false);
    await persistIfRemember("minimize");
    await hideToTray();
  }

  async function handleExit() {
    setOpen(false);
    await persistIfRemember("exit");
    // 走脏数据检查；ExitConfirmListener 没有脏数据时会自己 exit(0)
    await emit("tray:request-exit");
  }

  function handleCancel() {
    setOpen(false);
  }

  return (
    <Modal
      open={open}
      title="关闭窗口"
      onCancel={handleCancel}
      mask={{ closable: false }}
      footer={
        <Space>
          <Button onClick={handleMinimize}>最小化到托盘</Button>
          <Button danger onClick={handleExit}>
            退出程序
          </Button>
        </Space>
      }
    >
      <p style={{ marginTop: 0, marginBottom: 16 }}>
        你想要关闭窗口还是退出程序？
      </p>
      <Checkbox
        checked={remember}
        onChange={(e) => setRemember(e.target.checked)}
      >
        记住我的选择，不再询问
      </Checkbox>
    </Modal>
  );
}
