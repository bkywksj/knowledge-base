import { useRef, useState, useEffect, useCallback } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Layout, Button, theme as antdTheme, Tooltip, Dropdown, message } from "antd";
import { MenuFoldOutlined, MenuUnfoldOutlined, SettingOutlined, PushpinOutlined, PushpinFilled } from "@ant-design/icons";
import { Search, Palette, ArrowLeft, ArrowRight } from "lucide-react";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { importApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { getThemesByCategory } from "@/theme/tokens";
import type { ThemeMode } from "@/theme/tokens";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { WindowControls } from "./WindowControls";
import { CommandPalette } from "@/components/ui/CommandPalette";
import { ShortcutsPanel } from "@/components/ui/ShortcutsPanel";
import { StarryBackground } from "@/components/ui/StarryBackground";
import { CreateNoteModal } from "@/components/CreateNoteModal";
import { UpdateBadge } from "@/components/ui/UpdateBadge";
import { UpdateModal } from "@/components/ui/UpdateModal";
import { ExitConfirmListener } from "@/components/ui/ExitConfirmListener";
import { useUpdateChecker } from "@/hooks/useUpdateChecker";

const { Header, Sider, Content } = Layout;

// macOS 上使用 titleBarStyle: "Overlay" 保留原生红黄绿按钮（见 tauri.macos.conf.json）。
// 避免 `decorations: false` 触发 NSWindow setStyleMask 反复重建（2026-04-22 卡死根因）。
// 因此 Mac 下需隐藏自绘 WindowControls，并给 Header 左侧留出 ~80px 让位给系统按钮。
const IS_MAC =
  typeof navigator !== "undefined" && /Mac OS X|Macintosh/.test(navigator.userAgent);
const HEADER_LEFT_PADDING = IS_MAC ? 80 : 16;

function getAppWindow(): Window | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

/** Header 中间的可拖拽空白区域 */
function DragRegion() {
  const windowRef = useRef<Window | null>(getAppWindow());

  function handleMouseDown(e: React.MouseEvent) {
    if (e.buttons === 1 && windowRef.current) {
      if (e.detail === 2) {
        windowRef.current.toggleMaximize();
      } else {
        windowRef.current.startDragging();
      }
    }
  }

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        flex: 1,
        height: "100%",
        cursor: "default",
        userSelect: "none",
      }}
    />
  );
}

export function AppLayout() {
  const {
    sidebarCollapsed, toggleSidebar,
    themeCategory,
    lightTheme, darkTheme,
    setLightTheme, setDarkTheme,
    setThemeCategory,
    focusMode, setFocusMode,
    createModalOpen, openCreateModal, closeCreateModal,
    alwaysOnTop, setAlwaysOnTop,
  } = useAppStore();
  const activeTheme = themeCategory === "light" ? lightTheme : darkTheme;
  const { token } = antdTheme.useToken();
  const navigate = useNavigate();

  // 双击 md 打开本应用 / 应用内"打开 md"按钮后的系统级落点：
  // 1) 首次启动：后端把 argv 里的 md 路径存到 AppState，这里拉一次
  // 2) 已打开应用时：single-instance 插件把新 argv emit 成 "open-md-file" 事件
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    async function openByPath(path: string) {
      try {
        const result = await importApi.openMarkdownFile(path);
        if (result.wasSynced) {
          message.info("已根据最新 md 文件同步笔记内容");
        }
        useAppStore.getState().bumpNotesRefresh();
        navigate(`/notes/${result.noteId}`);
      } catch (e) {
        message.error(`打开 ${path} 失败: ${e}`);
      }
    }

    // 启动时拉一次
    invoke<string | null>("take_pending_open_md_path")
      .then((path) => {
        if (path) openByPath(path);
      })
      .catch(() => {
        // 启动期没有 md 参数属于正常
      });

    // 监听"第二实例带来的 md 路径"
    listen<string>("open-md-file", (ev) => {
      if (ev.payload) openByPath(ev.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
    // 依赖只放 navigate，避免重复注册
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 托盘菜单事件（新建/今日/搜索/同步结果），在应用全局只注册一次
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    listen("tray:new-note", () => {
      openCreateModal();
    }).then((fn) => unlisteners.push(fn));

    listen("tray:open-daily", () => {
      navigate("/daily");
    }).then((fn) => unlisteners.push(fn));

    listen("tray:open-search", () => {
      setPaletteOpen(true);
    }).then((fn) => unlisteners.push(fn));

    listen<{ success: boolean; error?: string; stats?: { notesCount?: number } }>(
      "sync:manual-push-result",
      (e) => {
        if (e.payload.success) {
          const n = e.payload.stats?.notesCount;
          message.success(
            typeof n === "number" ? `已同步 ${n} 条笔记到云端` : "同步成功"
          );
        } else {
          message.error(`同步失败：${e.payload.error || "未知错误"}`);
        }
      }
    ).then((fn) => unlisteners.push(fn));

    listen("tray:check-update", async () => {
      const key = "tray-check-update";
      message.loading({ content: "正在检查更新…", key, duration: 0 });
      const r = await checkManually();
      if (r.error) {
        message.error({ content: `检查更新失败：${r.error}`, key });
      } else if (!r.hasUpdate) {
        message.success({ content: "已是最新版本", key });
      } else {
        // 有更新：checkManually 内部已自动打开 UpdateModal
        message.destroy(key);
      }
    }).then((fn) => unlisteners.push(fn));

    // 托盘 CheckMenuItem 切换"窗口置顶"后回传：skipEmit 避免再回流到 Rust
    listen<boolean>("rust:always-on-top-changed", (e) => {
      useAppStore.getState().setAlwaysOnTop(e.payload, { skipEmit: true });
    }).then((fn) => unlisteners.push(fn));

    return () => {
      unlisteners.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const { update, modalOpen, openModal, closeModal, checkManually } = useUpdateChecker();

  const themeMenuItems = [
    { type: "group" as const, label: "亮色主题", children: getThemesByCategory("light").map(t => ({
      key: t.key,
      label: <span className="flex items-center gap-2">
        <span className="flex gap-1">{t.colors.slice(0,3).map((c,i) => <span key={i} style={{width:10,height:10,borderRadius:3,background:c,display:'inline-block'}} />)}</span>
        {t.label}
      </span>,
    }))},
    { type: "group" as const, label: "暗色主题", children: getThemesByCategory("dark").map(t => ({
      key: t.key,
      label: <span className="flex items-center gap-2">
        <span className="flex gap-1">{t.colors.slice(0,3).map((c,i) => <span key={i} style={{width:10,height:10,borderRadius:3,background:c,display:'inline-block'}} />)}</span>
        {t.label}
      </span>,
    }))},
  ];

  function handleThemeSelect({ key }: { key: string }) {
    const mode = key as ThemeMode;
    if (mode.startsWith("light")) {
      setLightTheme(mode);
      setThemeCategory("light");
    } else {
      setDarkTheme(mode);
      setThemeCategory("dark");
    }
  }

  const handleGlobalKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      setPaletteOpen((prev) => !prev);
    }
    if (e.key === "F1") {
      e.preventDefault();
      setShortcutsOpen((prev) => !prev);
    }
    if (e.key === "Escape" && focusMode) {
      setFocusMode(false);
    }
    if (e.key === "F11") {
      e.preventDefault();
      setFocusMode(!focusMode);
    }
    // Alt + ←/→ 历史后退/前进
    if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      navigate(-1);
    }
    if (e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      navigate(1);
    }
    // Ctrl/Cmd + N 新建笔记
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      openCreateModal();
    }
  }, [focusMode, setFocusMode, navigate, openCreateModal]);

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [handleGlobalKeyDown]);

  return (
    <Layout style={{ height: "100vh", position: "relative" }}>
      {activeTheme === "dark-starry" && <StarryBackground />}
      {!focusMode && (
        <Sider
          collapsed={sidebarCollapsed}
          collapsedWidth={60}
          width={220}
          style={{
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            // Mac 上 titleBarStyle: "Overlay" 使系统红黄绿按钮悬浮在窗口左上角，
            // 给 Sider 顶部留出高度避免按钮压住菜单项
            paddingTop: IS_MAC ? 28 : 0,
          }}
        >
          <Sidebar />
        </Sider>
      )}
      <Layout>
        {!focusMode && (
        <Header
          style={{
            padding: 0,
            height: 48,
            lineHeight: "48px",
            display: "flex",
            alignItems: "center",
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: HEADER_LEFT_PADDING }}>
            <Button
              type="text"
              icon={
                sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />
              }
              onClick={toggleSidebar}
            />
            <Tooltip title="后退 (Alt+←)">
              <Button
                type="text"
                icon={<ArrowLeft size={16} />}
                onClick={() => navigate(-1)}
              />
            </Tooltip>
            <Tooltip title="前进 (Alt+→)">
              <Button
                type="text"
                icon={<ArrowRight size={16} />}
                onClick={() => navigate(1)}
              />
            </Tooltip>
          </div>
          <DragRegion />
          <div style={{ display: "flex", alignItems: "center" }}>
            <UpdateBadge update={update} onClick={openModal} />
            <Tooltip title="搜索 (Ctrl+K)">
              <Button
                type="text"
                icon={<Search size={16} />}
                onClick={() => setPaletteOpen(true)}
              />
            </Tooltip>
            <Dropdown menu={{ items: themeMenuItems, onClick: handleThemeSelect, selectedKeys: [activeTheme] }} trigger={["click"]}>
              <Tooltip title="切换主题">
                <Button type="text" icon={<Palette size={16} />} />
              </Tooltip>
            </Dropdown>
            <Button
              type="text"
              icon={<SettingOutlined />}
              onClick={() => navigate("/settings")}
              title="设置"
            />
            <Tooltip title={alwaysOnTop ? "取消置顶" : "窗口置顶"}>
              <Button
                type="text"
                icon={alwaysOnTop ? <PushpinFilled /> : <PushpinOutlined />}
                onClick={() => setAlwaysOnTop(!alwaysOnTop)}
                style={alwaysOnTop ? { color: token.colorPrimary } : undefined}
              />
            </Tooltip>
            {!IS_MAC && <WindowControls />}
          </div>
        </Header>
        )}
        {!focusMode && <TabBar />}
        <Content
          style={{
            padding: focusMode ? 0 : 24,
            overflow: "auto",
          }}
        >
          <Outlet />
        </Content>
      </Layout>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenShortcuts={() => { setPaletteOpen(false); setShortcutsOpen(true); }}
      />
      <ShortcutsPanel open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CreateNoteModal open={createModalOpen} onClose={closeCreateModal} />
      <UpdateModal open={modalOpen} onClose={closeModal} update={update} />
      <ExitConfirmListener />
    </Layout>
  );
}
