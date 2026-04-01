import { useRef, useState, useEffect, useCallback } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Layout, Button, theme as antdTheme, Tooltip } from "antd";
import { MenuFoldOutlined, MenuUnfoldOutlined, SettingOutlined } from "@ant-design/icons";
import { Sun, Moon, Search } from "lucide-react";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { useAppStore } from "@/store";
import { Sidebar } from "./Sidebar";
import { WindowControls } from "./WindowControls";
import { CommandPalette } from "@/components/ui/CommandPalette";
import { ShortcutsPanel } from "@/components/ui/ShortcutsPanel";

const { Header, Sider, Content } = Layout;

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
  const { sidebarCollapsed, toggleSidebar, theme, toggleTheme, focusMode, setFocusMode } =
    useAppStore();
  const { token } = antdTheme.useToken();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
  }, [focusMode, setFocusMode]);

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [handleGlobalKeyDown]);

  return (
    <Layout style={{ height: "100vh" }}>
      {!focusMode && (
        <Sider
          collapsed={sidebarCollapsed}
          collapsedWidth={60}
          width={220}
          style={{
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
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
            background: token.colorBgContainer,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 16 }}>
            <Button
              type="text"
              icon={
                sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />
              }
              onClick={toggleSidebar}
            />
          </div>
          <DragRegion />
          <div style={{ display: "flex", alignItems: "center" }}>
            <Tooltip title="搜索 (Ctrl+K)">
              <Button
                type="text"
                icon={<Search size={16} />}
                onClick={() => setPaletteOpen(true)}
              />
            </Tooltip>
            <Button
              type="text"
              icon={theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              onClick={toggleTheme}
            />
            <Button
              type="text"
              icon={<SettingOutlined />}
              onClick={() => navigate("/settings")}
              title="设置"
            />
            <WindowControls />
          </div>
        </Header>
        )}
        <Content
          style={{
            padding: focusMode ? 0 : 24,
            overflow: "auto",
            background: token.colorBgLayout,
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
    </Layout>
  );
}
