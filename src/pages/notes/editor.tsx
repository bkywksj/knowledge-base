import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Input,
  Button,
  Space,
  Typography,
  Spin,
  Popconfirm,
  Select,
  Tag as AntTag,
  Divider,
  Tooltip,
  Modal,
  List,
  Popover,
  Tree,
  Badge,
  Dropdown,
  App as AntdApp,
  theme as antdTheme,
} from "antd";
import { ArrowLeft, Save, Trash2, Pin, FolderOpen, Tags, Link2, Share, Maximize2, Minimize2, FileText as FileTextIcon, ChevronRight, ChevronDown, CornerUpLeft, Folder as FolderIcon, Eye, EyeOff, Lock, Unlock, MessageSquare, ListTree } from "lucide-react";
import { useAppStore } from "@/store";
import { useTabsStore } from "@/store/tabs";
import { noteApi, tagApi, folderApi, linkApi, exportApi, sourceFileApi, vaultApi, sourceWritebackApi } from "@/lib/api";
import { VaultModal } from "@/components/vault/VaultModal";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { relativeTime, stripHtml } from "@/lib/utils";
import { TiptapEditor } from "@/components/editor";
import { EditorOutline } from "@/components/editor/EditorOutline";
import { TagColorPicker } from "@/components/TagColorPicker";
import { NoteAiDrawer } from "@/components/ai/NoteAiDrawer";
import type { Note, Tag, Folder, NoteLink } from "@/types";

const { Text } = Typography;

/** 从 HTML 内容中提取 [[笔记标题]] 链接 */
function extractWikiLinks(html: string): string[] {
  const text = stripHtml(html);
  const regex = /\[\[([^\]]+)\]\]/g;
  const titles: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    titles.push(match[1].trim());
  }
  return [...new Set(titles)]; // 去重
}

/** 反向链接面板
 *
 * T-B08: 即使 0 条也显示空态卡片，让用户知道这个区域存在；用 id 锚定，
 * 顶部 Link2 按钮可滚动定位到此处。
 */
function BacklinksPanel({
  backlinks,
  onNavigate,
}: {
  backlinks: NoteLink[];
  onNavigate: (id: number) => void;
}) {
  return (
    <div id="backlinks-panel" className="mt-6 pt-4 border-t border-gray-100">
      <div className="flex items-center gap-2 mb-2">
        <Link2 size={14} className="text-gray-400" />
        <Text type="secondary" style={{ fontSize: 13 }}>
          反向链接 ({backlinks.length})
        </Text>
      </div>
      {backlinks.length === 0 ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          暂无其他笔记链接到这里。在其他笔记中输入 <Text code style={{ fontSize: 11 }}>[[本笔记标题]]</Text> 即可建立反向链接。
        </Text>
      ) : (
        <div className="flex flex-col gap-1">
          {backlinks.map((link) => (
            <div
              key={link.source_id}
              className="flex items-center justify-between px-3 py-2 rounded-md cursor-pointer hover:bg-gray-50"
              onClick={() => onNavigate(link.source_id)}
            >
              <Text style={{ fontSize: 13 }}>{link.source_title}</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {relativeTime(link.updated_at)}
              </Text>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 把树形文件夹映射为 antd Tree 的节点（key = 文件夹 id） */
type FolderTreeNode = {
  key: number;
  title: ReactNode;
  rawTitle: string;
  children?: FolderTreeNode[];
};
function foldersToAntTree(folders: Folder[]): FolderTreeNode[] {
  return folders.map((f) => ({
    key: f.id,
    rawTitle: f.name,
    title: (
      <span className="inline-flex items-center gap-1.5" style={{ fontSize: 13 }}>
        <FolderIcon size={13} style={{ opacity: 0.6 }} />
        {f.name}
      </span>
    ),
    children: f.children?.length ? foldersToAntTree(f.children) : undefined,
  }));
}

/** 收集树里所有节点 id，供 defaultExpandAll 用（antd Tree 的 defaultExpandAll
 *  只在首次挂载生效；这里直接算出全部 key 给 expandedKeys 便于受控展开） */
function collectAllKeys(nodes: FolderTreeNode[]): number[] {
  const out: number[] = [];
  for (const n of nodes) {
    out.push(n.key);
    if (n.children?.length) out.push(...collectAllKeys(n.children));
  }
  return out;
}

/** 根据目标 folderId 从树中回溯，得到祖先链（根 → 子 → … → 目标）
 *  返回 `[{id, name}]` 数组；找不到返回空数组。 */
function buildFolderPath(
  folders: Folder[],
  targetId: number,
): { id: number; name: string }[] {
  for (const f of folders) {
    if (f.id === targetId) {
      return [{ id: f.id, name: f.name }];
    }
    if (f.children?.length) {
      const sub = buildFolderPath(f.children, targetId);
      if (sub.length > 0) {
        return [{ id: f.id, name: f.name }, ...sub];
      }
    }
  }
  return [];
}

/** 面包屑路径 + Popover 里 TreeSelect 编辑的文件夹切换器
 *
 *  - 展示态：`🗂 工作 › 项目A`（未分类则显示"未分类"）
 *  - 点击 → Popover，含 TreeSelect（原生树形展开 + 搜索）和"移到根目录"快捷按钮
 *  - 选中即 onChange + 自动关闭 Popover */
function FolderPathEditor({
  folders,
  folderId,
  onChange,
}: {
  folders: Folder[];
  folderId: number | null;
  onChange: (folderId: number | null) => void;
}) {
  const { token } = antdTheme.useToken();
  const [open, setOpen] = useState(false);
  const path = useMemo(
    () => (folderId != null ? buildFolderPath(folders, folderId) : []),
    [folders, folderId],
  );
  const treeData = useMemo(() => foldersToAntTree(folders), [folders]);
  // 打开时默认展开所有节点，用户进来就能看全
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  useEffect(() => {
    if (open) {
      setExpandedKeys(collectAllKeys(treeData));
    }
  }, [open, treeData]);

  // 默认文件夹偏好（"全局新建笔记"时套用）
  const defaultFolderId = useAppStore((s) => s.defaultFolderId);
  const setDefaultFolderId = useAppStore((s) => s.setDefaultFolderId);
  const defaultFolderName = useMemo(
    () =>
      defaultFolderId != null
        ? buildFolderPath(folders, defaultFolderId)
            .map((f) => f.name)
            .join(" › ")
        : null,
    [folders, defaultFolderId],
  );

  // antd Tree titleRender：标题右侧 hover 出图钉，已默认时常亮主题色
  const renderTreeTitle = (nodeData: { key: React.Key; title?: ReactNode }) => {
    const id = Number(nodeData.key);
    const isDefault = defaultFolderId === id;
    return (
      <div className="kb-folder-tree-row flex items-center justify-between w-full pr-1">
        <span className="truncate">{nodeData.title}</span>
        <Tooltip
          title={isDefault ? "取消默认（新建笔记不再自动归此处）" : "设为默认（新建笔记自动归此处）"}
          mouseEnterDelay={0.4}
        >
          <button
            className={`kb-folder-pin ${isDefault ? "active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              void setDefaultFolderId(isDefault ? null : id);
            }}
            aria-label="设为默认文件夹"
          >
            <Pin
              size={12}
              fill={isDefault ? "currentColor" : "none"}
            />
          </button>
        </Tooltip>
      </div>
    );
  };

  const popoverContent = (
    <div style={{ width: 260 }}>
      <div
        style={{
          fontSize: 11,
          color: token.colorTextTertiary,
          padding: "2px 4px 6px",
          letterSpacing: 0.3,
        }}
      >
        移动到
      </div>
      <div
        style={{
          maxHeight: 280,
          overflowY: "auto",
          margin: "0 -4px",
          padding: "0 4px",
        }}
      >
        {treeData.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "16px 8px",
              color: token.colorTextTertiary,
              fontSize: 12,
            }}
          >
            还没有文件夹
            <br />
            <span style={{ fontSize: 11 }}>到侧边栏的"文件夹"里新建</span>
          </div>
        ) : (
          <Tree
            blockNode
            treeData={treeData}
            selectedKeys={folderId != null ? [folderId] : []}
            expandedKeys={expandedKeys}
            onExpand={(keys) => setExpandedKeys(keys)}
            onSelect={(keys) => {
              if (keys.length > 0) {
                onChange(keys[0] as number);
                setOpen(false);
              }
            }}
            titleRender={renderTreeTitle}
          />
        )}
      </div>
      <Divider style={{ margin: "8px 0" }} />
      <Button
        size="small"
        type="text"
        block
        disabled={folderId == null}
        icon={<CornerUpLeft size={13} />}
        onClick={() => {
          onChange(null);
          setOpen(false);
        }}
        style={{ textAlign: "left", justifyContent: "flex-start" }}
      >
        移到根目录
      </Button>
      {/* 底部脚条：当前默认文件夹 + 一键清除 */}
      <div
        style={{
          marginTop: 6,
          padding: "6px 4px 2px",
          borderTop: `1px dashed ${token.colorBorderSecondary}`,
          fontSize: 11,
          color: token.colorTextTertiary,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <span className="truncate flex items-center gap-1">
          <Pin size={11} style={{ color: token.colorPrimary, flexShrink: 0 }} />
          <span className="truncate">
            默认：
            {defaultFolderName ?? <span style={{ opacity: 0.7 }}>未设置</span>}
          </span>
        </span>
        {defaultFolderId != null && (
          <Button
            type="link"
            size="small"
            style={{ padding: 0, fontSize: 11, height: "auto" }}
            onClick={() => void setDefaultFolderId(null)}
          >
            清除
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomLeft"
      content={popoverContent}
      destroyOnHidden
    >
      <div
        className="inline-flex items-center gap-1 cursor-pointer select-none"
        style={{
          padding: "2px 8px",
          borderRadius: 6,
          fontSize: 13,
          color: token.colorText,
          background: open ? token.colorFillTertiary : "transparent",
          transition: "background-color .15s",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = token.colorFillQuaternary)
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = open
            ? token.colorFillTertiary
            : "transparent")
        }
      >
        <FolderOpen size={14} style={{ color: token.colorTextTertiary }} />
        {path.length === 0 ? (
          <span style={{ color: token.colorTextTertiary }}>未分类</span>
        ) : (
          path.map((seg, idx) => (
            <span key={seg.id} className="inline-flex items-center">
              {idx > 0 && (
                <ChevronRight
                  size={12}
                  style={{ color: token.colorTextQuaternary, margin: "0 2px" }}
                />
              )}
              <span>{seg.name}</span>
            </span>
          ))
        )}
      </div>
    </Popover>
  );
}

/** 标签与文件夹元数据区域 */
function MetaBar({
  noteTags,
  allTags,
  folders,
  folderId,
  onTagsChange,
  onFolderChange,
  onCreateTag,
  onChangeTagColor,
}: {
  noteTags: Tag[];
  allTags: Tag[];
  folders: Folder[];
  folderId: number | null;
  onTagsChange: (tagIds: number[]) => void;
  onFolderChange: (folderId: number | null) => void;
  onCreateTag: (name: string) => Promise<void>;
  onChangeTagColor: (tagId: number, color: string | null) => Promise<void>;
}) {
  const [tagSearch, setTagSearch] = useState("");
  const tagOptions = allTags.map((t) => ({
    label: t.name,
    value: t.id,
  }));

  const selectedTagIds = noteTags.map((t) => t.id);
  const trimmedSearch = tagSearch.trim();
  const exactExists = allTags.some((t) => t.name === trimmedSearch);
  const showCreate = trimmedSearch.length > 0 && !exactExists;

  // 默认标签偏好（"全局新建笔记"自动附加）
  const defaultTagIds = useAppStore((s) => s.defaultTagIds);
  const setDefaultTagIds = useAppStore((s) => s.setDefaultTagIds);
  const defaultTagNames = useMemo(
    () =>
      defaultTagIds
        .map((id) => allTags.find((t) => t.id === id)?.name)
        .filter((n): n is string => !!n),
    [defaultTagIds, allTags],
  );
  // 当前选中和默认是否一致——决定"设为默认"按钮是否可用
  const sameAsDefault = useMemo(() => {
    if (selectedTagIds.length !== defaultTagIds.length) return false;
    const a = [...selectedTagIds].sort();
    const b = [...defaultTagIds].sort();
    return a.every((v, i) => v === b[i]);
  }, [selectedTagIds, defaultTagIds]);

  return (
    <div className="flex items-center gap-3 py-2 flex-wrap">
      {/* 文件夹路径面包屑（点击切换目录） */}
      <FolderPathEditor
        folders={folders}
        folderId={folderId}
        onChange={onFolderChange}
      />

      <Divider orientation="vertical" style={{ height: 20 }} />

      {/* 标签管理 */}
      <div className="flex items-center gap-1 flex-1 min-w-0">
        <Tags size={14} className="text-gray-400 shrink-0" />
        <div className="flex items-center gap-1 flex-wrap flex-1">
          {noteTags.map((tag) => (
            <Popover
              key={tag.id}
              trigger="click"
              placement="bottom"
              title="调整颜色"
              content={
                <TagColorPicker
                  value={tag.color}
                  allowClear
                  onChange={(c) => onChangeTagColor(tag.id, c)}
                />
              }
            >
              <AntTag
                closable
                color={tag.color ?? undefined}
                style={{ cursor: "pointer" }}
                onClose={(e) => {
                  // 阻止 Popover 触发 + close 走 onTagsChange
                  e.stopPropagation();
                  onTagsChange(selectedTagIds.filter((id) => id !== tag.id));
                }}
              >
                {tag.name}
              </AntTag>
            </Popover>
          ))}
          <Select
            mode="multiple"
            size="small"
            placeholder={
              allTags.length === 0
                ? "输入标签名后回车创建"
                : "+ 添加 / 搜索 / 新建"
            }
            style={{ minWidth: 160, maxWidth: 240 }}
            value={selectedTagIds}
            onChange={onTagsChange}
            options={tagOptions}
            maxTagCount={0}
            maxTagPlaceholder={`+ 添加`}
            popupMatchSelectWidth={240}
            notFoundContent={
              trimmedSearch
                ? null
                : <div style={{ padding: "8px 12px", fontSize: 12, color: "#999" }}>
                    输入标签名后从下方点击创建
                  </div>
            }
            showSearch
            // searchValue 受控，便于在创建标签后清空输入框
            searchValue={tagSearch}
            onSearch={setTagSearch}
            filterOption={(input, option) =>
              String(option?.label ?? "")
                .toLowerCase()
                .includes(input.toLowerCase())
            }
            onInputKeyDown={async (e) => {
              // 回车直接创建（当输入不存在时）
              if (e.key === "Enter" && showCreate) {
                e.preventDefault();
                e.stopPropagation();
                await onCreateTag(trimmedSearch);
                setTagSearch("");
              }
            }}
            popupRender={(menu) => (
              <>
                {menu}
                {showCreate && (
                  <>
                    <Divider style={{ margin: "4px 0" }} />
                    <div
                      onMouseDown={(e) => {
                        // 阻止 Select 抢走焦点 + 关闭
                        e.preventDefault();
                        e.stopPropagation();
                        onCreateTag(trimmedSearch);
                        setTagSearch("");
                      }}
                      style={{
                        padding: "6px 12px",
                        cursor: "pointer",
                        fontSize: 13,
                        color: "var(--ant-color-primary, #1677ff)",
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background =
                          "var(--ant-control-item-bg-hover, #f5f5f5)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = "transparent")
                      }
                    >
                      + 创建标签「{trimmedSearch}」
                    </div>
                  </>
                )}
                {/* 默认标签管理脚条：把当前选中保存为默认 / 清除 */}
                <Divider style={{ margin: "4px 0" }} />
                <div
                  onMouseDown={(e) => e.preventDefault()}
                  style={{
                    padding: "6px 12px 8px",
                    fontSize: 11,
                    color: "var(--ant-color-text-tertiary, #999)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <div className="flex items-center gap-1 truncate">
                    <Pin size={11} style={{ flexShrink: 0 }} />
                    <span className="truncate">
                      默认：
                      {defaultTagNames.length > 0
                        ? defaultTagNames.join("、")
                        : <span style={{ opacity: 0.7 }}>未设置</span>}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0, fontSize: 11, height: "auto" }}
                      disabled={selectedTagIds.length === 0 || sameAsDefault}
                      onClick={() => void setDefaultTagIds(selectedTagIds)}
                    >
                      把当前选中设为默认
                    </Button>
                    {defaultTagIds.length > 0 && (
                      <Button
                        type="link"
                        size="small"
                        style={{ padding: 0, fontSize: 11, height: "auto" }}
                        onClick={() => void setDefaultTagIds([])}
                      >
                        清除
                      </Button>
                    )}
                  </div>
                </div>
              </>
            )}
          />
        </div>
      </div>
    </div>
  );
}

export default function NoteEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // 上下文感知的 message / notification（避免静态方法丢主题、偶发不显示）
  const { message, notification } = AntdApp.useApp();
  const { focusMode, setFocusMode } = useAppStore();
  const { openTab, updateTabTitle, setTabDirty, setDraft, getDraft, clearDraft } = useTabsStore();
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // 标签状态
  const [noteTags, setNoteTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);

  // 文件夹状态（保留原始树形结构供 FolderPathEditor 的面包屑 / TreeSelect 使用）
  const [folders, setFolders] = useState<Folder[]>([]);

  // 反向链接状态
  const [backlinks, setBacklinks] = useState<NoteLink[]>([]);

  // 大纲：editor 实例（来自 TiptapEditor 的 onEditorReady 回调）+ 滚动容器 ref
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [editorInstance, setEditorInstance] = useState<any | null>(null);
  const editorBodyRef = useRef<HTMLDivElement | null>(null);
  const outlineVisible = useAppStore((s) => s.outlineVisible);
  const toggleOutline = useAppStore((s) => s.toggleOutline);

  // 同名消歧 Modal 状态
  const [disambigOpen, setDisambigOpen] = useState(false);
  const [disambigItems, setDisambigItems] = useState<Note[]>([]);
  const [disambigTitle, setDisambigTitle] = useState("");

  // 右侧 AI 抽屉（方案 A：编辑笔记时不离页问 AI；伴生对话存到 ai_conversations）
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  // 选段触发（方案 C）：携带的选中文本，抽屉里展示为引用 chip 而不是塞输入框
  const [aiSelection, setAiSelection] = useState<string | undefined>(undefined);

  // PDF 预览 Modal 状态
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string>("");
  /** PDF 原文件绝对路径（供 Modal 里"用系统应用打开"兜底按钮调 openPath） */
  const [pdfPreviewAbsPath, setPdfPreviewAbsPath] = useState<string>("");
  /** PDF 预览 Modal 是否最大化（全屏铺满） */
  const [pdfPreviewMaximized, setPdfPreviewMaximized] = useState(false);

  const noteId = Number(id);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [noteData, tags, folderTree, existingTags, links] = await Promise.all([
        noteApi.get(noteId),
        tagApi.list(),
        folderApi.list(),
        tagApi.getNoteTags(noteId),
        linkApi.getBacklinks(noteId),
      ]);
      setNote(noteData);
      setAllTags(tags);
      setNoteTags(existingTags);
      setFolders(folderTree);
      setBacklinks(links);
      openTab({
        id: noteData.id,
        title: noteData.title,
        sourceFileType: noteData.source_file_type,
      });

      // 如果 store 里有未保存的草稿（上次切 tab/跳转 wiki 时缓存），优先恢复
      const draft = getDraft(noteId);
      if (draft && (draft.title !== noteData.title || draft.content !== noteData.content)) {
        setTitle(draft.title);
        setContent(draft.content);
        setDirty(true);
        // store dirty 保持 true（关闭 tab / 退出时确认提示能命中）
        setTabDirty(noteId, true);
      } else {
        setTitle(noteData.title);
        setContent(noteData.content);
        setDirty(false);
        // 草稿已和 DB 一致（其他场景 clear 漏了），主动清掉
        if (draft) clearDraft(noteId);
      }
    } catch (e) {
      message.error(String(e));
      navigate("/notes");
    } finally {
      setLoading(false);
    }
  }, [noteId, navigate, openTab, getDraft, clearDraft, setTabDirty]);

  useEffect(() => {
    if (id) loadData();
  }, [id, loadData]);

  // 订阅全局 folders/tags tick：侧边栏/标签页 CRUD 后局部刷新下拉选项，
  // 无需关闭重开 tab。用 ref 跳过首次渲染，避免与 loadData 重复请求。
  const foldersTick = useAppStore((s) => s.foldersRefreshTick);
  const tagsTick = useAppStore((s) => s.tagsRefreshTick);
  const notesTick = useAppStore((s) => s.notesRefreshTick);
  const skipFoldersInit = useRef(true);
  const skipTagsInit = useRef(true);
  const skipNotesInit = useRef(true);
  useEffect(() => {
    if (skipFoldersInit.current) {
      skipFoldersInit.current = false;
      return;
    }
    folderApi
      .list()
      .then((folderTree) => setFolders(folderTree))
      .catch(() => {
        // 刷新失败不打断当前编辑，下次打开时 loadData 会再拉
      });
  }, [foldersTick]);
  useEffect(() => {
    if (skipTagsInit.current) {
      skipTagsInit.current = false;
      return;
    }
    tagApi.list().then(setAllTags).catch(() => {});
  }, [tagsTick]);

  // 笔记自身 tick：侧边栏改名 / 外部更新时同步 title 输入框 + meta，
  // 但用户在编辑（dirty）时不动 title 字段，避免冲掉未保存的修改。
  // 用 ref 跳首次（与 loadData 重复）+ ref 读 dirty/title 避免循环依赖。
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    if (skipNotesInit.current) {
      skipNotesInit.current = false;
      return;
    }
    if (!noteId) return;
    let cancelled = false;
    noteApi
      .get(noteId)
      .then((fresh) => {
        if (cancelled) return;
        setNote(fresh);
        if (!dirtyRef.current) {
          setTitle(fresh.title);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [notesTick, noteId]);

  /**
   * 保存当前笔记。
   * silent=true 用于"跳转前自动保存"场景：不弹"保存成功"toast，避免干扰用户操作；
   *             但若有未匹配的 wiki 链接仍会弹 warning（这种信息必须告知）。
   */
  async function handleSave(silent = false) {
    if (!title.trim()) {
      if (!silent) message.warning("标题不能为空");
      return;
    }
    setSaving(true);
    try {
      const updated = await noteApi.update(noteId, {
        title: title.trim(),
        content,
        folder_id: note?.folder_id,
      });
      setNote(updated);
      setDirty(false);
      setTabDirty(noteId, false);
      updateTabTitle(noteId, updated.title);
      // 内容已落库，清掉草稿快照
      clearDraft(noteId);

      // 解析 [[]] 链接并同步
      const wikiTitles = extractWikiLinks(content);
      const missing: string[] = [];
      if (wikiTitles.length > 0) {
        const targetIds: number[] = [];
        for (const t of wikiTitles) {
          try {
            const id = await linkApi.findIdByTitle(t);
            if (id != null) {
              targetIds.push(id);
            } else {
              missing.push(t);
            }
          } catch {
            missing.push(t);
          }
        }
        await linkApi.syncLinks(noteId, targetIds).catch(() => {});
      } else {
        await linkApi.syncLinks(noteId, []).catch(() => {});
      }

      if (missing.length > 0) {
        notification.warning({
          message: `已保存，但 ${missing.length} 个 wiki 链接未能匹配到笔记`,
          description: (
            <div>
              <ul style={{ margin: "4px 0 8px", paddingLeft: 20, maxHeight: 160, overflow: "auto" }}>
                {missing.map((t) => (
                  <li key={t} style={{ fontSize: 12, wordBreak: "break-all" }}>
                    <code>[[{t}]]</code>
                  </li>
                ))}
              </ul>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                <code>[[标题]]</code> 必须是<strong>完整且精确</strong>的笔记标题（忽略首尾空白和大小写），不支持通配符 / 省略号。建议正文里输入 <code>[[</code> 从自动补全菜单选择。
              </div>
            </div>
          ),
          duration: 10,
          placement: "topRight",
        });
      } else if (!silent) {
        message.success("保存成功");
      }

      // 外部 .md 双向同步：若该笔记是从 .md 文件打开来的，把当前内容写回原文件
      if (updated.source_file_type === "md" && updated.source_file_path) {
        try {
          const r = await sourceWritebackApi.writeBack(noteId, false);
          if (r.kind === "conflict") {
            // 弹 Modal 让用户选；选"覆盖外部"再调一次 force=true
            Modal.confirm({
              title: "原文件被外部改过",
              content: (
                <div>
                  <p style={{ marginBottom: 4 }}>检测到原文件在本应用之外被修改：</p>
                  <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
                    {r.file_path}
                  </p>
                  <p style={{ marginTop: 8 }}>选择"覆盖外部"会用本应用里的内容覆盖磁盘文件；选"取消"则保留外部修改，本应用的修改仅停留在数据库里。</p>
                </div>
              ),
              okText: "覆盖外部",
              okButtonProps: { danger: true },
              cancelText: "取消",
              onOk: async () => {
                try {
                  await sourceWritebackApi.writeBack(noteId, true);
                  message.success("已覆盖原文件");
                } catch (err) {
                  message.error(`写回失败: ${err}`);
                }
              },
            });
          } else if (r.kind === "missing") {
            notification.warning({
              message: "原文件已不可访问",
              description: "本应用与外部 .md 的双向同步暂时中断，但你的修改已保存到本地数据库。",
              duration: 6,
            });
          } else if (r.kind === "ok" && r.assets_copied > 0 && !silent) {
            message.info(`已同步原文件，新插入 ${r.assets_copied} 个图片复制到旁侧 .assets/`);
          }
        } catch (err) {
          // 写回失败不阻塞保存主流程，只静默记日志
          console.warn("[writeback] failed:", err);
        }
      }
    } catch (e) {
      message.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  /**
   * 跳转前保护：若当前有未保存修改，先静默保存再跳转，避免内容被新页面 loadData 覆盖丢失。
   * 用于所有 navigate 到其他笔记/路由的场景（wiki 链接点击、消歧选择、模糊匹配等）。
   */
  async function ensureSavedBeforeNavigate() {
    if (dirty && title.trim()) {
      await handleSave(true);
    }
  }

  // dirty 时把 (title, content) 节流写入 store 草稿。
  // 用途：editor unmount 后（切 tab / 跳 wiki）下次回来能恢复；关 tab / 退出时能批量持久化。
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      setDraft(noteId, { title, content });
    }, 400);
    return () => clearTimeout(t);
  }, [dirty, title, content, noteId, setDraft]);

  // unmount 时强制 flush 一次 draft（防止 400ms debounce 未触发的最后输入丢失）
  // 用 ref 捕获最新 state，避免闭包陷阱
  const flushRef = useRef<{ dirty: boolean; title: string; content: string }>({
    dirty: false, title: "", content: "",
  });
  flushRef.current = { dirty, title, content };
  useEffect(() => {
    return () => {
      const f = flushRef.current;
      if (f.dirty && f.title.trim()) {
        setDraft(noteId, { title: f.title, content: f.content });
      }
    };
  }, [noteId, setDraft]);

  // unmount 时同步把最新内容 fire-and-forget 入库（兜底：点侧边栏换路由 / 关 Tab 等
  // 场景 ensureSavedBeforeNavigate 没覆盖的路径，避免用户切其他功能后内容只活在 store
  // 草稿里、关 app 就丢。组件已卸载无法 await，但 Tauri 进程还在跑，IPC 能完成落库。
  const dbSaveOnUnmountRef = useRef<{
    dirty: boolean;
    title: string;
    content: string;
    folderId: number | null | undefined;
  }>({ dirty: false, title: "", content: "", folderId: null });
  dbSaveOnUnmountRef.current = {
    dirty,
    title,
    content,
    folderId: note?.folder_id,
  };
  useEffect(() => {
    return () => {
      const s = dbSaveOnUnmountRef.current;
      if (!s.dirty || !s.title.trim()) return;
      noteApi
        .update(noteId, {
          title: s.title.trim(),
          content: s.content,
          folder_id: s.folderId,
        })
        .then(() => {
          // 入库成功 → 清掉 store 草稿 & dirty 标记
          useTabsStore.getState().clearDraft(noteId);
          useTabsStore.getState().setTabDirty(noteId, false);
        })
        .catch(() => {
          // 入库失败时 store 里的 draft 保留，下次打开能恢复
        });
    };
  }, [noteId]);

  // Ctrl+S / Cmd+S 保存：用 ref 避免 useEffect 每次渲染都 re-subscribe
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = handleSave;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function handleDelete() {
    try {
      await noteApi.delete(noteId);
      message.success("删除成功");
      useTabsStore.getState().closeTab(noteId);
      useAppStore.getState().bumpNotesRefresh();
      navigate("/notes");
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleTogglePin() {
    try {
      const isPinned = await noteApi.togglePin(noteId);
      setNote((prev) => (prev ? { ...prev, is_pinned: isPinned } : prev));
      message.success(isPinned ? "已置顶" : "已取消置顶");
    } catch (e) {
      message.error(String(e));
    }
  }

  /**
   * T-003: 切换笔记"隐藏"状态。
   * 隐藏后主界面看不到此笔记，但保留在当前编辑器 tab 里以便继续编辑；
   * 取消隐藏立即回到普通可见态。
   */
  async function handleToggleHidden() {
    if (!note) return;
    const next = !note.is_hidden;
    try {
      await noteApi.setHidden(noteId, next);
      setNote((prev) => (prev ? { ...prev, is_hidden: next } : prev));
      message.success(next ? "已隐藏（主界面不可见）" : "已取消隐藏");
    } catch (e) {
      message.error(String(e));
    }
  }

  /**
   * T-007: 切换笔记加密态。
   *
   * 前置：vault 必须已解锁。未解锁时弹 unlock/setup Modal，解锁后用户需再点一次本按钮。
   *
   * 加密时：读当前 content → 后端调 vault 加密 → content 变成 "🔒 已加密..." 占位；
   * 取消加密时：后端解密得到原文并写回 content。
   * 加密/取消后都重新 loadNote() 拿最新态。
   */
  const [vaultModal, setVaultModal] = useState<{
    open: boolean;
    mode: "setup" | "unlock";
  }>({ open: false, mode: "unlock" });

  async function handleToggleEncrypt() {
    if (!note) return;
    // 先确认 vault 状态
    let vs;
    try {
      vs = await vaultApi.status();
    } catch (e) {
      message.error(`读取 vault 状态失败：${e}`);
      return;
    }
    if (vs === "notset") {
      // 首次设置
      setVaultModal({ open: true, mode: "setup" });
      message.info("请先设置主密码，然后再点加密");
      return;
    }
    if (vs === "locked") {
      setVaultModal({ open: true, mode: "unlock" });
      message.info("请先解锁保险库，然后再点加密");
      return;
    }
    // unlocked
    try {
      if (note.is_encrypted) {
        await vaultApi.disableEncrypt(noteId);
        message.success("已取消加密");
      } else {
        // 先把当前编辑器未保存的 content 落库，否则 encrypt_note 读到的是老内容
        if (dirty) await handleSave(true);
        await vaultApi.encryptNote(noteId);
        message.success("已加密（主界面将显示占位文本）");
      }
      // 重新拉笔记以拿到最新 is_encrypted / content 占位符
      const fresh = await noteApi.get(noteId);
      setNote(fresh);
      setContent(fresh.content);
      setTitle(fresh.title);
      setDirty(false);
    } catch (e) {
      message.error(String(e));
    }
  }

  /** Ctrl/Cmd + 点击 [[标题]] 时跳转到对应笔记 */
  async function handleWikiLinkClick(wikiTitle: string) {
    try {
      const results = await linkApi.searchTargets(wikiTitle, 20);
      const exactMatches = results.filter(([, name]) => name === wikiTitle);

      // 精确命中 1 条：直接跳
      if (exactMatches.length === 1) {
        await ensureSavedBeforeNavigate();
        navigate(`/notes/${exactMatches[0][0]}`);
        return;
      }

      // 精确命中多条：弹消歧 Modal
      if (exactMatches.length > 1) {
        const notes = await Promise.all(
          exactMatches.map(([id]) => noteApi.get(id).catch(() => null)),
        );
        const valid = notes.filter((n): n is Note => n !== null);
        if (valid.length === 1) {
          await ensureSavedBeforeNavigate();
          navigate(`/notes/${valid[0].id}`);
          return;
        }
        setDisambigTitle(wikiTitle);
        setDisambigItems(valid);
        setDisambigOpen(true);
        return;
      }

      // 无精确匹配但有模糊匹配：跳转相近的第一条
      if (results.length > 0) {
        await ensureSavedBeforeNavigate();
        navigate(`/notes/${results[0][0]}`);
        message.info(`未找到同名笔记，跳转到相近的「${results[0][1]}」`);
        return;
      }

      message.warning(`未找到笔记「${wikiTitle}」`);
    } catch (e) {
      message.error(`跳转失败: ${e}`);
    }
  }

  async function handleDisambigSelect(targetId: number) {
    setDisambigOpen(false);
    await ensureSavedBeforeNavigate();
    navigate(`/notes/${targetId}`);
  }

  async function handleOpenSourceFile() {
    try {
      const abs = await sourceFileApi.getAbsolutePath(noteId);
      if (!abs) {
        message.warning("原始文件丢失或未关联");
        return;
      }
      // PDF 用内置 iframe Modal 预览；其他类型（Word 等）用系统默认应用打开
      if (note?.source_file_type === "pdf") {
        setPdfPreviewUrl(convertFileSrc(abs));
        setPdfPreviewAbsPath(abs);
        setPdfPreviewOpen(true);
      } else {
        await openPath(abs);
      }
    } catch (e) {
      message.error(`打开失败: ${e}`);
    }
  }

  async function handleExportNote() {
    const parentDir = await openDialog({
      directory: true,
      title: "选择导出目录",
    });
    if (!parentDir) return;
    try {
      const result = await exportApi.exportSingle(noteId, parentDir as string);
      // 通过 Modal.success 给两个明确的后续操作按钮
      Modal.success({
        title: "导出成功",
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              {result.assets_copied > 0
                ? `已导出 .md 与 ${result.assets_copied} 个资产文件，目录：`
                : "已导出 .md，目录："}
            </p>
            <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {result.root_dir}
            </p>
          </div>
        ),
        okText: "打开所在文件夹",
        onOk: () => revealItemInDir(result.root_dir).catch(() => {}),
        closable: true,
      });
    } catch (e) {
      message.error(`导出失败: ${e}`);
    }
  }

  /** T-020: 导出为 Word (.docx) — 用 save dialog 选最终文件路径 */
  async function handleExportWord() {
    const safeName = title.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
    const filePath = await save({
      defaultPath: `${safeName}.docx`,
      filters: [{ name: "Word", extensions: ["docx"] }],
    });
    if (!filePath) return;
    try {
      const result = await exportApi.exportSingleToWord(noteId, filePath);
      Modal.success({
        title: "导出 Word 成功",
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              {`嵌入图片 ${result.imagesEmbedded} 张` +
                (result.imagesMissing > 0
                  ? `（${result.imagesMissing} 张缺失，已用占位符替代）`
                  : "")}
              ，文件：
            </p>
            <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {result.filePath}
            </p>
          </div>
        ),
        okText: "打开所在文件夹",
        onOk: () => revealItemInDir(result.filePath).catch(() => {}),
        closable: true,
      });
    } catch (e) {
      message.error(`导出 Word 失败: ${e}`);
    }
  }

  /** T-020: 导出为 HTML — 单文件，图片内嵌 base64，可独立分享 */
  async function handleExportHtml() {
    const safeName = title.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
    const filePath = await save({
      defaultPath: `${safeName}.html`,
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    });
    if (!filePath) return;
    try {
      const result = await exportApi.exportSingleToHtml(noteId, filePath);
      Modal.success({
        title: "导出 HTML 成功",
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              {`内嵌图片 ${result.imagesInlined} 张` +
                (result.imagesMissing > 0
                  ? `（${result.imagesMissing} 张缺失）`
                  : "")}
              ，文件：
            </p>
            <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {result.filePath}
            </p>
          </div>
        ),
        okText: "打开所在文件夹",
        onOk: () => revealItemInDir(result.filePath).catch(() => {}),
        closable: true,
      });
    } catch (e) {
      message.error(`导出 HTML 失败: ${e}`);
    }
  }

  async function handleTagsChange(newTagIds: number[]) {
    const currentIds = noteTags.map((t) => t.id);
    const toAdd = newTagIds.filter((id) => !currentIds.includes(id));
    const toRemove = currentIds.filter((id) => !newTagIds.includes(id));

    try {
      for (const tagId of toAdd) {
        await tagApi.addToNote(noteId, tagId);
      }
      for (const tagId of toRemove) {
        await tagApi.removeFromNote(noteId, tagId);
      }
      // 刷新笔记标签
      const updatedTags = await tagApi.getNoteTags(noteId);
      setNoteTags(updatedTags);
    } catch (e) {
      message.error(String(e));
    }
  }

  /** 调整单个标签的颜色（点击 tag chip 弹 Popover 触发） */
  async function handleChangeTagColor(tagId: number, color: string | null) {
    try {
      await tagApi.setColor(tagId, color);
      // 本地立即更新当前笔记的标签显示，避免等 refresh
      setNoteTags((prev) =>
        prev.map((t) => (t.id === tagId ? { ...t, color } : t)),
      );
      setAllTags((prev) =>
        prev.map((t) => (t.id === tagId ? { ...t, color } : t)),
      );
      // 通知标签页等其他消费者刷新
      useAppStore.getState().bumpTagsRefresh();
    } catch (e) {
      message.error(String(e));
    }
  }

  /** 在编辑器里直接创建新标签并挂到当前笔记 */
  async function handleCreateTag(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    // 同名已存在 → 直接复用（不重复创建）
    const existing = allTags.find((t) => t.name === trimmed);
    try {
      const tag = existing ?? (await tagApi.create(trimmed));
      if (!existing) {
        setAllTags((prev) => [...prev, tag]);
        // 通知其他消费者（标签页/其他编辑器 tab）刷新标签列表
        useAppStore.getState().bumpTagsRefresh();
      }
      await tagApi.addToNote(noteId, tag.id);
      const updatedTags = await tagApi.getNoteTags(noteId);
      setNoteTags(updatedTags);
      message.success(existing ? `已添加「${trimmed}」` : `已创建并添加「${trimmed}」`);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleFolderChange(folderId: number | null) {
    try {
      await noteApi.moveToFolder(noteId, folderId);
      setNote((prev) => (prev ? { ...prev, folder_id: folderId } : prev));
      message.success("已移动");
    } catch (e) {
      message.error(String(e));
    }
  }

  function handleTitleChange(val: string) {
    setTitle(val);
    setDirty(true);
    setTabDirty(noteId, true);
    updateTabTitle(noteId, val || "未命名");
  }

  function handleContentChange(val: string) {
    setContent(val);
    setDirty(true);
    setTabDirty(noteId, true);
  }

  if (loading) {
    return (
      <div
        className="editor-page"
        style={focusMode ? { margin: 0 } : undefined}
      >
        <div className="flex items-center justify-center flex-1">
          <Spin size="large" />
        </div>
      </div>
    );
  }

  return (
    <div
      className="editor-page"
      // 专注模式下 AppLayout 的 Content padding=0，editor-page 的 margin:-24px
      // 也必须抵消为 0，否则会把 topbar 的左右按钮推到视窗外（修 F11 截断 bug）
      style={focusMode ? { margin: 0 } : undefined}
    >
      {/* 顶部工具栏 */}
      <div className="editor-topbar">
        <Space align="center">
          <Button
            icon={<ArrowLeft size={16} />}
            onClick={() => {
              // 有历史栈（从 /tasks、/search、/daily 等跳进来）就 back
              // 否则回笔记列表作为默认目的地
              if (window.history.length > 1) {
                navigate(-1);
              } else {
                navigate("/notes");
              }
            }}
          >
            返回
          </Button>
          {note && (
            <Text type="secondary">
              更新于 {relativeTime(note.updated_at)}
            </Text>
          )}
          {dirty && <Text type="warning">未保存</Text>}
        </Space>
        <Space align="center">
          <Tooltip title={focusMode ? "退出专注模式 (Esc)" : "专注模式 (F11)"}>
            <Button
              icon={focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              onClick={() => setFocusMode(!focusMode)}
            />
          </Tooltip>
          <Tooltip title={note?.is_pinned ? "取消置顶" : "置顶"}>
            <Button
              type={note?.is_pinned ? "primary" : "default"}
              icon={<Pin size={16} />}
              onClick={handleTogglePin}
            />
          </Tooltip>
          <Tooltip
            title={
              note?.is_hidden
                ? "取消隐藏（回到主列表）"
                : "隐藏此笔记（主列表/搜索/图谱不可见）"
            }
          >
            <Button
              type={note?.is_hidden ? "primary" : "default"}
              icon={note?.is_hidden ? <EyeOff size={16} /> : <Eye size={16} />}
              onClick={handleToggleHidden}
            />
          </Tooltip>
          <Tooltip
            title={
              note?.is_encrypted
                ? "取消加密（恢复为普通笔记）"
                : "加密此笔记（需先设置并解锁主密码）"
            }
          >
            <Button
              type={note?.is_encrypted ? "primary" : "default"}
              icon={note?.is_encrypted ? <Lock size={16} /> : <Unlock size={16} />}
              onClick={handleToggleEncrypt}
            />
          </Tooltip>
          <Tooltip title={outlineVisible ? "隐藏大纲" : "显示大纲"}>
            <Button
              type={outlineVisible ? "primary" : "default"}
              icon={<ListTree size={16} />}
              onClick={toggleOutline}
            />
          </Tooltip>
          <Tooltip
            title={
              backlinks.length > 0
                ? `${backlinks.length} 条反向链接 — 点击滚动到底部查看`
                : "反向链接（暂无）— 点击查看说明"
            }
          >
            <Badge
              count={backlinks.length}
              size="small"
              offset={[-2, 2]}
              color={backlinks.length > 0 ? undefined : "#bfbfbf"}
            >
              <Button
                icon={<Link2 size={16} />}
                onClick={() => {
                  document
                    .getElementById("backlinks-panel")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              />
            </Badge>
          </Tooltip>
          <Button
            type="primary"
            icon={<Save size={16} />}
            loading={saving}
            onClick={() => handleSave()}
            disabled={!dirty}
          >
            保存
          </Button>
          {note?.source_file_path && (
            <Tooltip
              title={
                note?.source_file_type === "pdf"
                  ? "查看原始 PDF"
                  : "用系统默认应用打开原始文件"
              }
            >
              <Button
                icon={<FileTextIcon size={16} />}
                onClick={handleOpenSourceFile}
              >
                {note?.source_file_type === "pdf"
                  ? "PDF"
                  : (note?.source_file_type ?? "源文件").toUpperCase()}
              </Button>
            </Tooltip>
          )}
          {/* T-020 导出按钮：默认导出 Markdown；右侧下拉可选 Word / HTML */}
          <Space.Compact>
            <Tooltip title="导出为 Markdown">
              <Button
                icon={<Share size={16} />}
                onClick={handleExportNote}
              />
            </Tooltip>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  {
                    key: "md",
                    label: "导出为 Markdown",
                    onClick: () => void handleExportNote(),
                  },
                  {
                    key: "docx",
                    label: "导出为 Word (.docx)",
                    onClick: () => void handleExportWord(),
                  },
                  {
                    key: "html",
                    label: "导出为 HTML (单文件)",
                    onClick: () => void handleExportHtml(),
                  },
                ],
              }}
            >
              <Button icon={<ChevronDown size={14} />} title="更多导出格式" />
            </Dropdown>
          </Space.Compact>
          <Tooltip title="问 AI">
            <Button
              icon={<MessageSquare size={16} />}
              onClick={async () => {
                // 先确保未保存内容已落库，否则 AI 拿到的还是老正文
                if (dirty) await handleSave(true);
                setAiSelection(undefined);
                setAiDrawerOpen(true);
              }}
            />
          </Tooltip>
          <Popconfirm title="确认删除此笔记？" onConfirm={handleDelete}>
            <Button danger icon={<Trash2 size={16} />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      </div>

      {/* 可滚动的编辑主体 */}
      <div
        className="editor-body"
        ref={editorBodyRef}
        data-outline={outlineVisible ? "on" : undefined}
      >
        <div className="editor-content-area">
          {/* 标题 */}
          <Input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="笔记标题"
            variant="borderless"
            className="editor-title"
          />

          {/* 文件夹 + 标签元数据 */}
          <div className="editor-meta">
            <MetaBar
              noteTags={noteTags}
              allTags={allTags}
              folders={folders}
              folderId={note?.folder_id ?? null}
              onTagsChange={handleTagsChange}
              onFolderChange={handleFolderChange}
              onCreateTag={handleCreateTag}
              onChangeTagColor={handleChangeTagColor}
            />
          </div>

          {/* 内容编辑区 */}
          <TiptapEditor
            content={content}
            onChange={handleContentChange}
            placeholder="开始写点什么..."
            noteId={noteId}
            onWikiLinkClick={handleWikiLinkClick}
            onAskAi={(selected) => {
              // 选段触发 → 选段挂到抽屉的"引用 chip"，输入框留空给用户写问题
              setAiSelection(selected);
              setAiDrawerOpen(true);
            }}
            onEditorReady={setEditorInstance}
          />

          {/* 反向链接 */}
          <BacklinksPanel
            backlinks={backlinks}
            onNavigate={async (id) => {
              await ensureSavedBeforeNavigate();
              navigate(`/notes/${id}`);
            }}
          />
        </div>

        {/* 右侧大纲面板：sticky 跟随滚动；用户偏好关闭 / heading < 2 时自隐 */}
        {outlineVisible && (
          <aside className="editor-outline-aside">
            <EditorOutline editor={editorInstance} scrollRoot={editorBodyRef.current} />
          </aside>
        )}
      </div>

      {/* PDF 原文件预览 */}
      <Modal
        open={pdfPreviewOpen}
        title={
          <div
            className="flex items-center justify-between"
            style={{ paddingRight: 32, gap: 8 }}
          >
            <span className="truncate" style={{ minWidth: 0 }}>
              {note?.title ? `${note.title} · 原始 PDF` : "原始 PDF"}
            </span>
            <Space size={4}>
              <Tooltip
                title={pdfPreviewMaximized ? "还原窗口" : "最大化"}
              >
                <Button
                  size="small"
                  type="text"
                  icon={
                    pdfPreviewMaximized ? (
                      <Minimize2 size={14} />
                    ) : (
                      <Maximize2 size={14} />
                    )
                  }
                  onClick={() => setPdfPreviewMaximized((v) => !v)}
                />
              </Tooltip>
              {/*
                兜底按钮：部分 WebView2（较老版本 / 更严格的 CSP 配置）会拦截
                iframe 加载 asset: 协议并显示"已阻止此内容"。点这个按钮可
                立即切到系统 PDF 阅读器，避免卡在空白页。
              */}
              <Button
                size="small"
                icon={<FolderOpen size={14} />}
                onClick={async () => {
                  if (!pdfPreviewAbsPath) return;
                  try {
                    await openPath(pdfPreviewAbsPath);
                    setPdfPreviewOpen(false);
                  } catch (e) {
                    message.error(`打开失败: ${e}`);
                  }
                }}
              >
                用系统应用打开
              </Button>
            </Space>
          </div>
        }
        footer={null}
        onCancel={() => {
          setPdfPreviewOpen(false);
          // 下次打开回到默认"大窗口"态，避免总是全屏打扰
          setPdfPreviewMaximized(false);
        }}
        width={pdfPreviewMaximized ? "100vw" : "85vw"}
        style={
          pdfPreviewMaximized
            ? { top: 0, paddingBottom: 0, maxWidth: "100vw", margin: 0 }
            : { top: 30 }
        }
        styles={{
          body: {
            padding: 0,
            height: pdfPreviewMaximized ? "calc(100vh - 56px)" : "78vh",
          },
        }}
        destroyOnHidden
      >
        {pdfPreviewUrl && (
          <iframe
            src={pdfPreviewUrl}
            title="PDF 预览"
            style={{ width: "100%", height: "100%", border: "none" }}
          />
        )}
      </Modal>

      {/* 同名笔记消歧 */}
      <Modal
        open={disambigOpen}
        title={`「${disambigTitle}」存在 ${disambigItems.length} 条同名笔记`}
        footer={null}
        onCancel={() => setDisambigOpen(false)}
        width={520}
      >
        <Text type="secondary" style={{ fontSize: 13 }}>
          请选择要打开的那一条：
        </Text>
        <List
          size="small"
          style={{ marginTop: 12 }}
          dataSource={disambigItems}
          renderItem={(item) => (
            <List.Item
              style={{ cursor: "pointer" }}
              onClick={() => handleDisambigSelect(item.id)}
            >
              <List.Item.Meta
                title={item.title}
                description={
                  <span style={{ fontSize: 12 }}>
                    {item.folder_id ? `文件夹 #${item.folder_id}` : "未分类"}
                    {" · "}
                    更新于 {relativeTime(item.updated_at)}
                  </span>
                }
              />
            </List.Item>
          )}
        />
      </Modal>

      <NoteAiDrawer
        noteId={noteId}
        open={aiDrawerOpen}
        onClose={() => setAiDrawerOpen(false)}
        pendingSelection={aiSelection}
      />

      <VaultModal
        open={vaultModal.open}
        mode={vaultModal.mode}
        onClose={() => setVaultModal((s) => ({ ...s, open: false }))}
        onSuccess={() => {
          message.info("保险库已就绪，再次点击锁图标即可加密此笔记");
        }}
      />
    </div>
  );
}
