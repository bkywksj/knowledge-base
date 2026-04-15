import { useRef, useState, useEffect, useCallback } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Layout, Button, theme as antdTheme, Tooltip, Dropdown } from "antd";
import { MenuFoldOutlined, MenuUnfoldOutlined, SettingOutlined } from "@ant-design/icons";
import { Search, Palette } from "lucide-react";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { useAppStore } from "@/store";
import { getThemesByCategory } from "@/theme/tokens";
import type { ThemeMode } from "@/theme/tokens";
import { Sidebar } from "./Sidebar";
import { WindowControls } from "./WindowControls";
import { CommandPalette } from "@/components/ui/CommandPalette";
import { ShortcutsPanel } from "@/components/ui/ShortcutsPanel";
import { StarryBackground } from "@/components/ui/StarryBackground";

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
  const {
    sidebarCollapsed, toggleSidebar,
    themeCategory,
    lightTheme, darkTheme,
    setLightTheme, setDarkTheme,
    setThemeCategory,
    focusMode, setFocusMode,
  } = useAppStore();
  const activeTheme = themeCategory === "light" ? lightTheme : darkTheme;
  const { token } = antdTheme.useToken();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
  }, [focusMode, setFocusMode]);

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
            <WindowControls />
          </div>
        </Header>
        )}
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
    </Layout>
  );
}
