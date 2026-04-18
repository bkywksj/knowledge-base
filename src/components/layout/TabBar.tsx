import { useNavigate, useLocation } from "react-router-dom";
import { useCallback, useEffect } from "react";
import { theme as antdTheme, Dropdown, type MenuProps } from "antd";
import { X, FileText } from "lucide-react";
import { useTabsStore } from "@/store/tabs";

export function TabBar() {
  const { tabs, activeId, closeTab, closeOtherTabs, closeTabsToRight } =
    useTabsStore();
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = antdTheme.useToken();

  const handleSelect = useCallback(
    (id: number) => {
      navigate(`/notes/${id}`);
    },
    [navigate],
  );

  const handleClose = useCallback(
    (id: number, e?: React.MouseEvent) => {
      e?.stopPropagation();
      const wasActive = activeId === id;
      // 关闭的路径是当前正在查看的 → 需要跳转
      const isViewing =
        wasActive && location.pathname === `/notes/${id}`;
      const nextActive = closeTab(id);
      if (isViewing) {
        if (nextActive !== null) navigate(`/notes/${nextActive}`);
        else navigate("/notes");
      }
    },
    [activeId, closeTab, navigate, location.pathname],
  );

  // Ctrl+W 关闭当前活跃 tab
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "w" && activeId !== null) {
        e.preventDefault();
        handleClose(activeId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, handleClose]);

  if (tabs.length === 0) return null;

  const menuFor = (id: number): MenuProps["items"] => [
    { key: "close", label: "关闭" },
    { key: "close-others", label: "关闭其他", disabled: tabs.length === 1 },
    {
      key: "close-right",
      label: "关闭右侧",
      disabled: tabs.findIndex((t) => t.id === id) >= tabs.length - 1,
    },
  ];

  function onMenuClick(id: number, key: string) {
    if (key === "close") handleClose(id);
    else if (key === "close-others") closeOtherTabs(id);
    else if (key === "close-right") closeTabsToRight(id);
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 36,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        overflowX: "auto",
        overflowY: "hidden",
        flexShrink: 0,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        return (
          <Dropdown
            key={tab.id}
            menu={{
              items: menuFor(tab.id),
              onClick: ({ key }) => onMenuClick(tab.id, key),
            }}
            trigger={["contextMenu"]}
          >
            <div
              onClick={() => handleSelect(tab.id)}
              onAuxClick={(e) => {
                // 鼠标中键关闭
                if (e.button === 1) {
                  e.preventDefault();
                  handleClose(tab.id);
                }
              }}
              title={tab.title}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "0 10px 0 12px",
                height: "100%",
                cursor: "pointer",
                borderRight: `1px solid ${token.colorBorderSecondary}`,
                background: isActive
                  ? token.colorBgElevated
                  : "transparent",
                color: isActive ? token.colorText : token.colorTextSecondary,
                fontSize: 13,
                whiteSpace: "nowrap",
                maxWidth: 200,
                position: "relative",
                userSelect: "none",
              }}
            >
              {isActive && (
                <span
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 2,
                    background: token.colorPrimary,
                  }}
                />
              )}
              <FileText size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  fontWeight: isActive ? 500 : 400,
                }}
              >
                {tab.title || "未命名"}
                {tab.dirty ? " •" : ""}
              </span>
              <button
                type="button"
                onClick={(e) => handleClose(tab.id, e)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  border: "none",
                  background: "transparent",
                  borderRadius: 4,
                  cursor: "pointer",
                  color: token.colorTextTertiary,
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = token.colorFillSecondary;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <X size={12} />
              </button>
            </div>
          </Dropdown>
        );
      })}
    </div>
  );
}
