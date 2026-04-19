import { useNavigate, useLocation } from "react-router-dom";
import { useCallback, useEffect, useRef } from "react";
import { theme as antdTheme, Dropdown, Tooltip, type MenuProps } from "antd";
import { X, FileText, FileType, ListTree } from "lucide-react";
import { useTabsStore } from "@/store/tabs";

export function TabBar() {
  const { tabs, activeId, closeTab, closeOtherTabs, closeTabsToRight } =
    useTabsStore();
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = antdTheme.useToken();

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<number, HTMLDivElement>>(new Map());

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
      const isViewing =
        wasActive && location.pathname === `/notes/${id}`;
      const nextActive = closeTab(id);
      tabRefs.current.delete(id);
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

  // 激活的 tab 超出可视区时自动滚入视界
  useEffect(() => {
    if (activeId === null) return;
    const el = tabRefs.current.get(activeId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }, [activeId, tabs.length]);

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
        alignItems: "flex-end",
        height: 38,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgLayout,
        flexShrink: 0,
        paddingLeft: 4,
      }}
    >
      {/* 左侧固定：回到笔记列表 */}
      <Tooltip title="笔记列表">
        <button
          type="button"
          onClick={() => navigate("/notes")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 28,
            marginBottom: 4,
            marginRight: 4,
            border: "none",
            background: "transparent",
            borderRadius: 6,
            cursor: "pointer",
            color: token.colorTextSecondary,
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = token.colorFillSecondary;
            e.currentTarget.style.color = token.colorText;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = token.colorTextSecondary;
          }}
        >
          <ListTree size={16} />
        </button>
      </Tooltip>

      {/* 中间可滚动 tab 容器 */}
      <div
        ref={scrollerRef}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "flex-end",
          gap: 2,
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none", // Firefox
          minWidth: 0,
        }}
        className="tabbar-scroller"
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
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                onClick={() => handleSelect(tab.id)}
                onAuxClick={(e) => {
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
                  padding: "0 8px 0 12px",
                  height: 28,
                  marginBottom: 4,
                  cursor: "pointer",
                  background: "transparent",
                  color: isActive ? token.colorPrimary : token.colorTextSecondary,
                  fontSize: 13,
                  whiteSpace: "nowrap",
                  maxWidth: 200,
                  minWidth: 100,
                  borderRadius: 8,
                  border: `1px solid ${isActive ? token.colorPrimary : "transparent"}`,
                  userSelect: "none",
                  transition: "background 0.15s ease, color 0.15s ease, border-color 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = token.colorFillQuaternary;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = "transparent";
                  }
                }}
              >
                {(() => {
                  const t = tab.sourceFileType;
                  if (t === "pdf") {
                    return (
                      <FileText
                        size={13}
                        style={{ flexShrink: 0, color: "#D4380D" }}
                      />
                    );
                  }
                  if (t === "docx" || t === "doc") {
                    return (
                      <FileType
                        size={13}
                        style={{ flexShrink: 0, color: "#1677FF" }}
                      />
                    );
                  }
                  return (
                    <FileText
                      size={13}
                      style={{ flexShrink: 0, opacity: isActive ? 0.9 : 0.7 }}
                    />
                  );
                })()}
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
                    e.stopPropagation();
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
    </div>
  );
}
