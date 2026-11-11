import { useNavigate, useLocation } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { Dropdown, Tooltip, Modal, Button, App as AntdApp, type MenuProps } from "antd";
import { X, ListTree, Plus } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabsStore, type NoteTab } from "@/store/tabs";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { ScrollableTabStrip } from "@/components/ui/ScrollableTabStrip";
import { noteApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { createBlankAndOpen } from "@/lib/noteCreator";
import { targetFromFolderParam } from "@/lib/newNoteTarget";

/**
 * 笔记标签栏。
 * - variant="titlebar"（默认）：嵌在 v4 通栏标题栏里，后退 / 前进之后（原型 .tabs / .tab）；
 *   标签条的空白处可拖动窗口、双击最大化——标签多了会把标题栏的拖动区挤没，这里补上
 * - variant="row"：专注模式（标题栏隐藏）且开了「专注模式保留标签栏」时，单独占一行
 * 样式在 global.css 的 .kb-tabs / .kb-tab
 */
export function TabBar({ variant = "titlebar" }: { variant?: "titlebar" | "row" }) {
  const {
    tabs,
    activeId,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    closeAllTabs,
    getDraft,
    clearDraft,
  } = useTabsStore();
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntdApp.useApp();


  // dirty tab 关闭确认 Modal 的目标 tab；null 表示未弹出
  const [confirmTab, setConfirmTab] = useState<NoteTab | null>(null);
  const [closing, setClosing] = useState(false);

  const handleSelect = useCallback(
    (id: number) => {
      navigate(`/notes/${id}`);
    },
    [navigate],
  );

  /** 真正执行关闭（含路由跳转），调用方需先处理好 dirty */
  const doClose = useCallback(
    (id: number) => {
      const wasActive = activeId === id;
      const isViewing = wasActive && location.pathname === `/notes/${id}`;
      const nextActive = closeTab(id);
      if (isViewing) {
        if (nextActive !== null) navigate(`/notes/${nextActive}`);
        else navigate("/notes");
      }
    },
    [activeId, closeTab, navigate, location.pathname],
  );

  const handleClose = useCallback(
    (id: number, e?: React.MouseEvent) => {
      e?.stopPropagation();
      const tab = tabs.find((t) => t.id === id);
      if (tab?.dirty) {
        // 有未保存内容：弹三选一 Modal
        setConfirmTab(tab);
        return;
      }
      doClose(id);
    },
    [tabs, doClose],
  );

  /** 用户选择"保存并关闭" */
  async function handleSaveAndClose() {
    if (!confirmTab) return;
    const draft = getDraft(confirmTab.id);
    if (!draft || !draft.title.trim()) {
      message.warning("无可保存的草稿（标题为空）");
      return;
    }
    setClosing(true);
    try {
      await noteApi.update(confirmTab.id, { title: draft.title.trim(), content: draft.content });
      // 标题可能被改过，让左侧 NotesPanel / 笔记列表重拉同步新标题
      useAppStore.getState().bumpNotesRefresh();
      clearDraft(confirmTab.id);
      doClose(confirmTab.id);
      setConfirmTab(null);
    } catch (e) {
      message.error(`保存失败：${e}`);
    } finally {
      setClosing(false);
    }
  }

  /** 用户选择"放弃修改并关闭" */
  function handleDiscardAndClose() {
    if (!confirmTab) return;
    clearDraft(confirmTab.id);
    doClose(confirmTab.id);
    setConfirmTab(null);
  }

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

  /** 关闭全部：清空所有 tab；若正在看某笔记则跳回列表。有未保存草稿时先确认。
   *  🔴 必须放在下方 `if (tabs.length === 0) return null` 这个 early return **之前**——
   *  否则无 tab 时提前 return 会跳过这个 useCallback，导致两次渲染 hook 数量不一致
   *  （"Rendered more hooks than during the previous render" 崩溃）。 */
  const handleCloseAll = useCallback(() => {
    const doIt = () => {
      const viewingNote = location.pathname.startsWith("/notes/");
      closeAllTabs();
      if (viewingNote) navigate("/notes");
    };
    const hasDirty = tabs.some((t) => t.dirty);
    if (hasDirty) {
      Modal.confirm({
        title: "关闭全部标签页",
        content: "有标签页存在未保存的修改，关闭全部会丢弃这些草稿。是否继续？",
        okText: "全部关闭",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: doIt,
      });
    } else {
      doIt();
    }
  }, [tabs, closeAllTabs, navigate, location.pathname]);

  if (tabs.length === 0) return null;

  const menuFor = (id: number): MenuProps["items"] => [
    { key: "close", label: "关闭" },
    { key: "close-others", label: "关闭其他", disabled: tabs.length === 1 },
    {
      key: "close-right",
      label: "关闭右侧",
      disabled: tabs.findIndex((t) => t.id === id) >= tabs.length - 1,
    },
    { type: "divider" },
    { key: "close-all", label: "关闭全部", disabled: tabs.length === 0 },
  ];

  function onMenuClick(id: number, key: string) {
    if (key === "close") handleClose(id);
    else if (key === "close-others") closeOtherTabs(id);
    else if (key === "close-right") closeTabsToRight(id);
    else if (key === "close-all") handleCloseAll();
  }

  /** 新建空白笔记：与 Ctrl+N 同一套落点规则（跟随 URL 的 ?folder，没有就用全局默认） */
  function handleNewNote() {
    const target = targetFromFolderParam(new URLSearchParams(location.search).get("folder"));
    void createBlankAndOpen(target.folderId, navigate, { useDefaults: target.useDefaults });
  }

  /** 标签条空白处：单击拖动窗口、双击最大化（只在标题栏形态下，且只响应空白处，不抢标签 / 按钮的点击） */
  function handleStripMouseDown(e: React.MouseEvent) {
    if (variant !== "titlebar" || e.button !== 0) return;
    // 空白处 = 外层自身，或标签条里的容器层（冒泡上来，标签不满时右侧留白落在 scroller 上）
    const t = e.target as HTMLElement;
    if (t !== e.currentTarget && !t.matches(".kb-tabstrip, .kb-tabstrip-scroller, .kb-tabstrip-row")) return;
    try {
      const win = getCurrentWindow();
      if (e.detail === 2) void win.toggleMaximize();
      else void win.startDragging();
    } catch {
      // 非 Tauri 环境（浏览器预览）没有窗口 API，忽略
    }
  }

  return (
    <div
      className={variant === "titlebar" ? "kb-tabs kb-tabs-titlebar" : "kb-tabs kb-tabs-row kb-surface"}
      onMouseDown={handleStripMouseDown}
    >
      {/* 左侧固定：回到笔记列表 */}
      <Tooltip title="笔记列表">
        <button type="button" className="kb-tab-home" onClick={() => navigate("/notes")}>
          <ListTree size={16} />
        </button>
      </Tooltip>

      {/* dirty tab 关闭确认 */}
      <Modal
        open={confirmTab !== null}
        title={confirmTab ? `「${confirmTab.title || "未命名"}」尚未保存` : ""}
        onCancel={() => !closing && setConfirmTab(null)}
        mask={{ closable: !closing }}
        closable={!closing}
        footer={[
          <Button key="discard" danger disabled={closing} onClick={handleDiscardAndClose}>
            放弃修改并关闭
          </Button>,
          <Button key="cancel" disabled={closing} onClick={() => setConfirmTab(null)}>
            取消
          </Button>,
          <Button key="save" type="primary" loading={closing} onClick={handleSaveAndClose}>
            保存并关闭
          </Button>,
        ]}
      >
        <p>关闭此笔记会丢失尚未持久化的修改。请选择操作。</p>
      </Modal>

      {/* 中间可滚动 tab 容器：隐藏滚动条，滚轮横滚 + 两端按需浮出左右箭头 */}
      <ScrollableTabStrip
        className="kb-tabs-scroller"
        activeKey={activeId}
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
              {/* 宽度：禁止收缩 + 下限 140 / 上限 200（原型 200）。标签一多就被压到 minWidth，
                  中文只剩一两个字看不出是哪篇，所以宁可横向滚动（切换 tab 会 scrollIntoView） */}
              <div
                data-strip-key={tab.id}
                onClick={() => handleSelect(tab.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    handleClose(tab.id);
                  }
                }}
                title={tab.title}
                className={isActive ? "kb-tab is-active" : "kb-tab"}
              >
                <FileTypeIcon type={tab.sourceFileType} size={14} />
                <span className="kb-tab-title">{tab.title || "未命名"}</span>
                {/* 未保存：紫色小圆点（代替原来标题后的「•」） */}
                {tab.dirty && <span className="kb-tab-mod" aria-label="未保存" />}
                <button
                  type="button"
                  className="kb-tab-x"
                  onClick={(e) => handleClose(tab.id, e)}
                  aria-label="关闭"
                >
                  <X size={12} />
                </button>
              </div>
            </Dropdown>
          );
        })}
      </ScrollableTabStrip>
      {/* 放在滚动区外面：标签多到横向滚动时「+」也始终可见 */}
      <Tooltip title="新建笔记 (Ctrl+N)">
        <button type="button" className="kb-tab-add" onClick={handleNewNote} aria-label="新建笔记">
          <Plus size={15} />
        </button>
      </Tooltip>
    </div>
  );
}
