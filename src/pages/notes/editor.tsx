import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  Input,
  Button,
  Space,
  Typography,
  Spin,
  Popconfirm,
  TreeSelect,
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
import { ArrowLeft, Save, Trash2, Pin, FolderOpen, Tags, Link2, Share, Maximize2, Minimize2, FileText as FileTextIcon, ChevronRight, ChevronDown, CornerUpLeft, Folder as FolderIcon, Eye, EyeOff, Lock, Unlock, MessageSquare, ListTree, Network, ExternalLink, BookOpen, FilePen, Presentation, Printer } from "lucide-react";
import { CloseCircleFilled } from "@ant-design/icons";
import { useAppStore } from "@/store";
import { useTabsStore } from "@/store/tabs";
import { noteApi, tagApi, folderApi, linkApi, exportApi, sourceFileApi, vaultApi, sourceWritebackApi } from "@/lib/api";
import { printHtmlAsPdf } from "@/lib/exportPdf";
import { printEditorContent, copyEditorContentForWord } from "@/lib/printNote";
import { VaultModal } from "@/components/vault/VaultModal";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { relativeTime, stripHtml } from "@/lib/utils";
import { buildTagTreeSelectData } from "@/lib/tagTree";
import { TiptapEditor } from "@/components/editor";
import { EditorOutline } from "@/components/editor/EditorOutline";
import { EditorStats } from "@/components/editor/EditorStats";
import { TagColorPicker } from "@/components/TagColorPicker";
import { MicButton } from "@/components/MicButton";
import { NoteAiDrawer } from "@/components/ai/NoteAiDrawer";
import { MindMapView } from "@/components/notes/MindMapView";
import { SlideshowView } from "@/components/notes/SlideshowView";
import type { Note, Tag, Folder, NoteLink } from "@/types";
import { accelToKeys, findShortcut } from "@/lib/shortcuts/registry";

const { Text } = Typography;

// 当前 webview 的 label。同一 webview 内不变，模块级常量即可。
// popout 窗口的 label 形如 `popout-note-{id}`（由 popout_window.rs 创建），主窗口是 "main"。
const CURRENT_WINDOW_LABEL = (() => {
  try { return getCurrentWindow().label; }
  catch { return ""; }
})();
const IS_POPOUT_WINDOW = CURRENT_WINDOW_LABEL.startsWith("popout-");

/** 去 markdown 转义：把 `\X`（X 为非字母数字）中的 `\` 丢弃。
 *
 * 与 Rust 侧 `database/links.rs::unescape_md` **对齐**，二者必须同步演进。
 * 用途：Tiptap markdown 序列化（尤其在 TaskItem 里）会把 `[[Title]]` 写成
 * `\[\[Title\]\]`、`[[A_B]]` 写成 `[[A\_B]]`，不反转义就匹配不到 wiki-link。
 * 保留 `\n` 等真正的字母转义不变（避免误伤代码块/正则字面量）。
 */
function unescapeMd(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      // 非字母数字（含中日韩等 unicode 字母）→ 吃掉 `\`，保留下一个字符
      // 用正则替代 isAlphanumeric，覆盖 unicode（Markdown 转义只对 ASCII 标点生效，
      // 中文不会被转义，所以 \[ \( \* 这类是关键场景）
      if (!/[A-Za-z0-9]/.test(next)) {
        out += next;
        i++;
        continue;
      }
    }
    out += s[i];
  }
  return out;
}

/** 从 HTML / Markdown 内容中提取 wiki 链接（带 markdown 反转义）。
 *
 * 识别两种形式：
 *   - `[[标题]]`       → `{ title: "标题", id: null }`     旧 / 手敲形式
 *   - `[[标题|123]]`   → `{ title: "标题", id: 123 }`      候选下拉选中后的形式，ID 稳定锚点
 *
 * 保存反链时优先用 `id`，没有 `id` 才走 `findIdByTitle` 模糊查（详见保存逻辑）。
 * 同名笔记重名 / 改名后旧引用失效的问题都由 ID 锚点解决。
 */
function extractWikiLinks(
  content: string,
): Array<{ title: string; id: number | null }> {
  // 先 stripHtml（兼容 HTML），再 unescapeMd（兼容 markdown 序列化形式）
  const text = unescapeMd(stripHtml(content));
  // 标题段排除 `|`，让 ID 独立捕获；ID 必须纯数字（用户标题里可能有 `|`，不能误识别）
  const regex = /\[\[([^\[\]\n|]+)(?:\|(\d+))?\]\]/g;
  const seen = new Set<string>();
  const out: Array<{ title: string; id: number | null }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const title = match[1].trim();
    if (!title) continue;
    const id = match[2] ? Number(match[2]) : null;
    // 去重键：title + id（同名既有带 ID 又有不带 ID 的会保留两条，建边优先 ID）
    const key = `${title.toLowerCase()}|${id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, id });
  }
  return out;
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
  editor,
  onTagsChange,
  onFolderChange,
  onCreateTag,
  onChangeTagColor,
}: {
  noteTags: Tag[];
  allTags: Tag[];
  folders: Folder[];
  folderId: number | null;
  editor: any | null;
  onTagsChange: (tagIds: number[]) => void;
  onFolderChange: (folderId: number | null) => void;
  onCreateTag: (name: string) => Promise<void>;
  onChangeTagColor: (tagId: number, color: string | null) => Promise<void>;
}) {
  const [tagSearch, setTagSearch] = useState("");
  // 树形 treeData：复用左侧 TagsPanel 的同款 helper（value=数字 id，title=标签名）
  const tagTreeData = useMemo(() => buildTagTreeSelectData(allTags), [allTags]);

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
          {/* TreeSelect 把扁平 Select 升级为层级选择：复用 TagsPanel 的同款 treeData，
              用 multiple 模式（非 treeCheckable）保持 value=number[] 兼容上层 onTagsChange 签名。
              wrapper div 上的 onKeyDown 兜底回车快速创建——TreeSelect 内部 input 没有
              暴露 onInputKeyDown，靠事件冒泡到 wrapper 监听。 */}
          <div
            onKeyDown={async (e) => {
              if (e.key === "Enter" && showCreate) {
                e.preventDefault();
                e.stopPropagation();
                await onCreateTag(trimmedSearch);
                setTagSearch("");
              }
            }}
            style={{ minWidth: 160, maxWidth: 240 }}
          >
          <TreeSelect
            multiple
            size="small"
            placeholder={
              allTags.length === 0
                ? "输入标签名后回车创建"
                : "+ 添加 / 搜索 / 新建"
            }
            style={{ width: "100%" }}
            value={selectedTagIds}
            onChange={(val) => onTagsChange(val as number[])}
            treeData={tagTreeData}
            treeDefaultExpandAll
            maxTagCount={0}
            maxTagPlaceholder={`+ 添加`}
            popupMatchSelectWidth={260}
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
            treeNodeFilterProp="title"
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

      {/* 字数统计：放在元数据栏末尾（与文件夹/标签同行），shrink-0 防被标签挤掉 */}
      {editor && (
        <div className="shrink-0 flex items-center gap-2">
          <Divider type="vertical" style={{ height: 20, margin: 0 }} />
          <EditorStats editor={editor} />
        </div>
      )}
    </div>
  );
}

/**
 * 标题粘贴清洗（仅压空白）：把换行 / Tab / 全角空格 / 连续空格等所有空白压成
 * 单个普通空格并去首尾空白；不动其它符号（引号 / 书名号 / 日期等照旧保留）。
 * JS 的 `\s` 已覆盖 \n \r \t  (nbsp) 　(全角空格) 等，单条正则即可。
 * 用途：从网页/来源复制标题时常连带把后面的来源、日期、乱七八糟的空白一起粘进来。
 */
function sanitizeTitlePaste(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * 编辑器滚动位置缓存（按 noteId）——内容锚点式，抗图片 / 公式渐进布局。
 *
 * 为什么不用纯像素 scrollTop：切回笔记时 TipTap 会 setContent 重建正文，图片(kb-asset://)、
 * 公式、视频等异步渐进布局，恢复那一刻 scrollHeight 常还没到位；且目标位置「上方」的图片加载
 * 后会把内容整体下移 → 同一像素值对应的内容变了（用户反馈"有时位置不一样"）。改为记录视口顶部
 * 所在的「顶层块（段落 / 标题 / 图片…）序号 + 该块顶到视口顶的偏移」，切回后把同一个块滚回原偏移，
 * 跟着内容走。top 像素值仅作 .ProseMirror 尚未就绪时的兜底。放模块级以跨组件重挂载存活。
 */
interface EditorScrollAnchor {
  /** 视口顶部所在的顶层块在 .ProseMirror 子节点中的序号 */
  index: number;
  /** 该块顶边相对滚动容器顶边的偏移（通常 ≤ 0：已滚入该块内部多少像素） */
  delta: number;
  /** 兜底：离开时的绝对 scrollTop（.ProseMirror 不可用时用） */
  top: number;
}
const editorScrollPositions = new Map<number, EditorScrollAnchor>();

/** 取 .ProseMirror 的顶层块子节点（正文各段落 / 标题 / 图片等）。 */
function getEditorBlocks(container: HTMLElement): HTMLElement[] {
  const pm = container.querySelector<HTMLElement>(".ProseMirror");
  if (!pm) return [];
  return Array.from(pm.children) as HTMLElement[];
}

/** 记录当前视口顶部对应的内容锚点（离开笔记前调用）。 */
function captureEditorScrollAnchor(container: HTMLElement): EditorScrollAnchor {
  const top = container.scrollTop;
  const blocks = getEditorBlocks(container);
  const cTop = container.getBoundingClientRect().top;
  // 第一个「底边已越过视口顶」的块 = 视口顶部所在（或紧邻其下）的块
  for (let i = 0; i < blocks.length; i++) {
    const r = blocks[i].getBoundingClientRect();
    if (r.bottom - cTop > 0) {
      return { index: i, delta: r.top - cTop, top };
    }
  }
  return { index: Math.max(0, blocks.length - 1), delta: 0, top };
}

/**
 * 按锚点把对应块滚回原偏移。返回 true=已按锚点定位成功；false=正文还没渲染出块（需重试）。
 */
function applyEditorScrollAnchor(
  container: HTMLElement,
  anchor: EditorScrollAnchor,
): boolean {
  const pm = container.querySelector<HTMLElement>(".ProseMirror");
  if (!pm || pm.children.length === 0) {
    // 正文尚未渲染出任何块：先用像素兜底占位，返回 false 让调用方继续重试锚点
    container.scrollTop = anchor.top;
    return false;
  }
  // 直接按 index 取块，避免每次 Array.from(pm.children) 的 O(N) 构建
  const block = pm.children.item(
    Math.min(anchor.index, pm.children.length - 1),
  ) as HTMLElement | null;
  if (!block) {
    container.scrollTop = anchor.top;
    return false;
  }
  // 先读后写，位移 < 1px 不写 —— 减少无谓的 scrollTop 写入与后续布局失效
  const cTop = container.getBoundingClientRect().top;
  const adjust = block.getBoundingClientRect().top - cTop - anchor.delta;
  if (Math.abs(adjust) >= 1) container.scrollTop += adjust;
  return true;
}

function DesktopNoteEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // 搜索结果点进笔记时携带的关键词（?q=）：传给编辑器自动定位首个命中
  const [searchParams] = useSearchParams();
  const initialSearch = (searchParams.get("q") ?? "").trim() || undefined;
  // 上下文感知的 message / notification（避免静态方法丢主题、偶发不显示）
  const { message, notification } = AntdApp.useApp();
  const { focusMode, setFocusMode } = useAppStore();
  // 阅读模式：初值跟全局默认（设置页可改），每篇笔记独立 state，切笔记不残留上一篇状态
  const defaultViewMode = useAppStore((s) => s.defaultViewMode);
  const [readingMode, setReadingMode] = useState<boolean>(defaultViewMode === "read");
  const { openTab, updateTabTitle, setTabDirty, setDraft, getDraft, clearDraft } = useTabsStore();
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** 思维导图视图：在编辑器右侧以 flex 分栏方式渲染（不是浮层） */
  const [mindMapOpen, setMindMapOpen] = useState(false);
  /** 幻灯片演示模式：fixed 全屏覆盖，按 `<hr>` 分页 */
  const [slideshowOpen, setSlideshowOpen] = useState(false);
  /** 思维导图分栏宽度（像素，持久化到 localStorage 跨笔记记忆） */
  const [mindMapWidth, setMindMapWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("editor.mindMapWidth"));
    return Number.isFinite(saved) && saved >= 320 ? saved : 480;
  });
  // latest 字段：handleMove 写入最新宽度，handleUp 关闭时读出落库（避免闭包陷阱）
  const splitterDragRef = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);

  /** 右侧大纲宽度（像素，持久化到 localStorage；双击分隔条还原到默认） */
  const OUTLINE_DEFAULT_WIDTH = 170;
  const [outlineWidth, setOutlineWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("editor.outlineWidth"));
    return Number.isFinite(saved) && saved >= 140 ? saved : OUTLINE_DEFAULT_WIDTH;
  });
  const outlineDragRef = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);

  // 标签状态
  const [noteTags, setNoteTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);

  // 文件夹状态（保留原始树形结构供 FolderPathEditor 的面包屑 / TreeSelect 使用）
  const [folders, setFolders] = useState<Folder[]>([]);

  // 反向链接状态
  const [backlinks, setBacklinks] = useState<NoteLink[]>([]);

  // 导出菜单受控状态：让 Ctrl+Shift+E 可以唤起这个 Dropdown
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // 大纲：editor 实例（来自 TiptapEditor 的 onEditorReady 回调）+ 滚动容器 ref
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [editorInstance, setEditorInstance] = useState<any | null>(null);
  const editorBodyRef = useRef<HTMLDivElement | null>(null);
  // 当前活跃笔记 id：loadData 开头写入，后台元数据加载回来时比对，防止快速切笔记
  // 时旧请求结果覆盖新笔记（竞态守卫）。
  const loadSeqRef = useRef<number>(-1);

  // Ctrl/Cmd+A 全选笔记内容。
  // 默认情况下焦点未落到 ProseMirror 编辑器时（比如刚打开笔记还没点入正文），
  // WebView 会触发原生"选中整个文档"行为，把侧栏 / 工具栏 / 元属性区都选上。
  // 这里仅在事件来源是 body 或编辑器主体内部（且不在 input/textarea/contenteditable
  // 上）时拦截，转发到 editor.commands.selectAll —— 弹窗 / Modal / Select 等
  // 由 Ant Design portal 挂到 body 末尾的元素不会被 editorBodyRef.contains 命中,
  // 仍走原生默认行为，互不干扰。
  useEffect(() => {
    if (!editorInstance) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key !== "a" && e.key !== "A") return;

      const target = e.target as HTMLElement | null;
      if (!target) return;

      const tag = target.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (target.isContentEditable) return; // ProseMirror 自身已在 PM keymap 处理

      const insideEditorBody = !!editorBodyRef.current?.contains(target);
      if (target !== document.body && !insideEditorBody) return;

      e.preventDefault();
      editorInstance.chain().focus().selectAll().run();
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [editorInstance]);
  const outlineVisible = useAppStore((s) => s.outlineVisible);
  const toggleOutline = useAppStore((s) => s.toggleOutline);
  // 大纲停靠位置（'right' 默认 / 'left'）。影响 grid 列序 + 拖拽方向 + 面板内边距/分隔线方向。
  const outlinePosition = useAppStore((s) => s.outlinePosition);
  // 阅读列宽（px，0=不限制）。隐藏大纲时把大纲腾出的横向空间补给正文，避免两侧空白过大。
  const editorReadingWidth = useAppStore((s) => s.editorReadingWidth);
  const autoSaveEnabled = useAppStore((s) => s.autoSaveEnabled);
  const autoSaveDelay = useAppStore((s) => s.autoSaveDelay);
  /**
   * 最近一次"自动保存"完成的时间戳（毫秒）。
   * 仅自动保存（debounce 触发的 silent save）写入；手动保存按钮 / Ctrl+S 不写，
   * 因为手动保存已有 toast 反馈，无需顶部"已自动保存 N 秒前"的二次提示。
   * 切笔记 / 卸载组件后重置，避免显示上一篇笔记的时间戳。
   */
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<number | null>(null);
  /** 自动保存触发的"保存中"瞬时标记（区别于手动保存的 saving，只用于顶部提示文案） */
  const [autoSaving, setAutoSaving] = useState(false);
  /**
   * 思维导图打开时自动暂时隐藏大纲——三栏（编辑器+大纲+导图）会挤压编辑可读宽度。
   * 不动用户在 store 里的偏好；mindMapOpen 切回 false 后大纲自动恢复。
   */
  const effectiveOutlineVisible = outlineVisible && !mindMapOpen;

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

  // 切到不同笔记时重置阅读模式为全局默认（避免上一篇手动切换的状态残留到下一篇）
  useEffect(() => {
    setReadingMode(defaultViewMode === "read");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  // 恢复某篇笔记的滚动位置（在其正文加载完成后调用，见 loadData）。
  // 用内容锚点定位。为避免卡顿：不再用 ResizeObserver 高频 reassert（那会在图片/公式渐进
  // 布局期把「读 getBoundingClientRect → 写 scrollTop」放大成布局抖动），改为在切换后离散地
  // 校正少数几次（首帧 + 80/200/450/800ms），覆盖本地图片渐进加载窗口，成本极低。
  // loadSeqRef 守卫：期间用户又切走则放弃；用户一动即停，绝不和用户操作打架。
  const restoreScrollForNote = useCallback((targetId: number) => {
    const el = editorBodyRef.current;
    if (!el) return;
    const anchor = editorScrollPositions.get(targetId);
    // 无记录（首次打开该笔记）→ 回到顶部，不做后续校正
    if (!anchor) {
      el.scrollTop = 0;
      return;
    }

    let stopped = false;
    const timers: number[] = [];

    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const t of timers) clearTimeout(t);
      el.removeEventListener("wheel", onUserScroll);
      el.removeEventListener("touchmove", onUserScroll);
      el.removeEventListener("keydown", onUserScroll);
    };

    // 用户一旦主动滚动 / 翻页，立即停止自动校正。只监听 wheel/touchmove/keydown（用户输入）——
    // 我们自己的程序化 scrollTop 修改不触发这三者，不会误判为"用户滚动"而自我取消。
    function onUserScroll() {
      stop();
    }

    const correctOnce = () => {
      if (stopped) return;
      if (loadSeqRef.current !== targetId) {
        stop(); // 已切到别的笔记
        return;
      }
      const node = editorBodyRef.current;
      if (!node) {
        stop();
        return;
      }
      applyEditorScrollAnchor(node, anchor);
    };

    el.addEventListener("wheel", onUserScroll, { passive: true });
    el.addEventListener("touchmove", onUserScroll, { passive: true });
    el.addEventListener("keydown", onUserScroll);

    // 首帧再校正：restoreScrollForNote 在 loadData 里同步调用时 React/TipTap 尚未把新正文提交到
    // DOM，推迟到下一帧才作用在新内容上；随后几次定时校正吸收图片渐进布局带来的高度变化。
    requestAnimationFrame(() => {
      if (stopped) return;
      correctOnce();
      for (const d of [80, 200, 450, 800]) {
        timers.push(window.setTimeout(correctOnce, d));
      }
      timers.push(window.setTimeout(stop, 1000)); // 收尾：撤监听
    });
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    loadSeqRef.current = noteId; // 标记当前活跃笔记，供后台元数据加载做竞态守卫
    try {
      // ── 关键路径：只等「笔记正文」这一条主键查询 ──
      // 旧实现把 noteApi.get 和 tagApi.list()/folderApi.list()（全局列表，随库规模
      // 增长变慢）捆在同一个 Promise.all，5 条全 resolve 才放行渲染 → 正文被无关的
      // 全局元数据查询阻塞，打开变卡。拆开后：正文一拿到立刻显示，元数据后台补。
      const noteData = await noteApi.get(noteId);
      setNote(noteData);
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
      // 正文已就绪，立即放行渲染（编辑器先挂起来）。
      setLoading(false);
      // 正文就绪后恢复上次浏览的滚动位置（切回同一篇笔记不再回到开头）
      restoreScrollForNote(noteId);

      // ── 次要元数据：标签 / 文件夹 / 笔记标签 / 反链 ──
      // 非关键路径，后台并行加载；失败只告警不影响正文。竞态由 cancelled 守卫拦截，
      // 避免快速切笔记时旧请求回来覆盖新笔记的元数据。
      void Promise.all([
        tagApi.list(),
        folderApi.list(),
        tagApi.getNoteTags(noteId),
        linkApi.getBacklinks(noteId),
      ])
        .then(([tags, folderTree, existingTags, links]) => {
          if (loadSeqRef.current !== noteId) return; // 已切到别的笔记，丢弃旧结果
          setAllTags(tags);
          setFolders(folderTree);
          setNoteTags(existingTags);
          setBacklinks(links);
        })
        .catch((e) => {
          console.warn("[editor] 加载笔记元数据失败:", e);
        });
    } catch (e) {
      message.error(String(e));
      navigate("/notes");
      setLoading(false);
    }
  }, [noteId, navigate, openTab, getDraft, clearDraft, setTabDirty, restoreScrollForNote]);

  useEffect(() => {
    if (id) loadData();
  }, [id, loadData]);

  // ── 保持浏览位置（A/B 之 B）：切 tab / 跳转离开当前笔记前，记下滚动位置 ──
  // cleanup 用「离开的那篇」noteId 闭包执行，此刻内容尚未被下一篇替换，scrollTop 真实有效。
  useEffect(() => {
    return () => {
      const el = editorBodyRef.current;
      if (el && Number.isFinite(noteId)) {
        editorScrollPositions.set(noteId, captureEditorScrollAnchor(el));
      }
    };
  }, [noteId]);


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

  // 跨窗口同步：另一个 webview（主窗 ↔ popout）保存了同一 id 的笔记后，
  // 这里通过 Tauri 全局事件 `note:updated` 收到通知。Zustand store 是 per-webview 的，
  // 没法跨进程同步，所以走 Tauri 事件桥。
  // 冲突保护：当前 buffer dirty 时不强制覆盖，弹 notification 让用户决定。
  useEffect(() => {
    if (!noteId) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ id: number; sourceLabel: string }>("note:updated", async (e) => {
      if (cancelled) return;
      const payload = e.payload;
      if (payload.id !== noteId) return;
      if (payload.sourceLabel === CURRENT_WINDOW_LABEL) return; // 自己触发的，忽略

      const reload = async () => {
        try {
          const fresh = await noteApi.get(noteId);
          if (cancelled) return;
          setNote(fresh);
          setTitle(fresh.title);
          setContent(fresh.content);
          setDirty(false);
          setTabDirty(noteId, false);
          clearDraft(noteId);
        } catch {
          // 拉失败就不动 buffer
        }
      };

      if (dirtyRef.current) {
        notification.warning({
          key: `note-updated-${noteId}`,
          message: "其他窗口已更新此笔记",
          description: "另一个窗口刚刚保存了内容。当前窗口有未保存修改——加载新版本会丢弃这些修改。",
          btn: (
            <Button
              size="small"
              type="primary"
              onClick={() => {
                notification.destroy(`note-updated-${noteId}`);
                void reload();
              }}
            >
              覆盖加载
            </Button>
          ),
          duration: 0, // 永不自动消失
        });
      } else {
        await reload();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [noteId, notification, setTabDirty, clearDraft]);
  // 用 ref 镜像最新 title / note，避免把它们写进 effect deps 触发循环
  const titleRef = useRef(title);
  useEffect(() => { titleRef.current = title; }, [title]);
  const noteRef = useRef<Note | null>(note);
  useEffect(() => { noteRef.current = note; }, [note]);

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
        const prevTitle = noteRef.current?.title;
        setNote(fresh);
        // 标题同步策略（修复侧栏改名 → 编辑器 unmount 把旧 title 写回 DB 的 bug）：
        // - 外部把 title 改了（fresh.title !== prevTitle）
        // - 本地用户没在编辑器里改过 title（titleRef === prevTitle）
        // 两者都满足 ⇒ 安全同步本地输入框；任一不满足 ⇒ 保留本地，让用户保存自然胜出。
        // 不再用 dirty 兜底——dirty 可能由正文编辑触发，与 title 是否被改无关。
        if (fresh.title !== prevTitle && titleRef.current === prevTitle) {
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
    // 标题是否被改动：保存后用来决定要不要 bump 侧栏笔记缓存。
    // tabs overlay 已覆盖渲染，但用户关 tab 后侧栏回退到 note.title（DB 缓存里的旧值）→
    // 需要 bumpNotesRefresh 让 NotesPanel 重拉 notesByFolder / uncategorizedNotes，
    // 把 DB 真值灌进缓存。仅在 title 真变化时 bump：避免内容自动保存频繁触发侧栏闪烁。
    const prevTitle = note?.title ?? "";
    const nextTitle = title.trim();
    try {
      const updated = await noteApi.update(noteId, {
        title: nextTitle,
        content,
        folder_id: note?.folder_id,
      });
      setNote(updated);
      setDirty(false);
      setTabDirty(noteId, false);
      updateTabTitle(noteId, updated.title);
      // 内容已落库，清掉草稿快照
      clearDraft(noteId);

      if (updated.title !== prevTitle) {
        useAppStore.getState().bumpNotesRefresh();
      }

      // 解析 wiki 链接并同步反链
      // 优先级：[[标题|ID]] 显式 ID → 直接用；否则按标题模糊查 ID（旧 / 手敲形式）
      const wikiRefs = extractWikiLinks(content);
      const missing: string[] = [];
      if (wikiRefs.length > 0) {
        const targetIdSet = new Set<number>();
        for (const ref of wikiRefs) {
          if (ref.id != null) {
            // 显式 ID 锚点：标题改了 / 重名都不影响（稳定锚点的核心价值）
            targetIdSet.add(ref.id);
            continue;
          }
          try {
            const id = await linkApi.findIdByTitle(ref.title);
            if (id != null) {
              targetIdSet.add(id);
            } else {
              missing.push(ref.title);
            }
          } catch {
            missing.push(ref.title);
          }
        }
        await linkApi.syncLinks(noteId, [...targetIdSet]).catch(() => {});
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
            // 原文件丢失/移走/网盘断开 — 给用户两个选择，避免每次保存都弹同样的提示
            Modal.confirm({
              title: "外部 .md 原文件已不可访问",
              content: (
                <div>
                  <p style={{ marginBottom: 4 }}>找不到原文件：</p>
                  <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
                    {r.file_path}
                  </p>
                  <p style={{ marginTop: 8 }}>
                    你的修改已保存到本地数据库。可选择<strong>解除关联</strong>把这条笔记降级为纯本地笔记（之后不再弹此提示），或<strong>稍后再说</strong>等原文件恢复后继续双向同步。
                  </p>
                </div>
              ),
              okText: "解除关联",
              okButtonProps: { danger: true },
              cancelText: "稍后再说",
              onOk: async () => {
                try {
                  await sourceWritebackApi.clearLink(noteId);
                  setNote((prev) =>
                    prev ? { ...prev, source_file_path: null, source_file_type: null } : prev,
                  );
                  message.success("已解除外部 .md 关联，本笔记不再触发写回");
                } catch (err) {
                  message.error(`解除关联失败: ${err}`);
                }
              },
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

  // 自动保存：开关开启时，dirty 后停止输入达 autoSaveDelay 毫秒触发一次静默保存。
  // - 闭包陷阱用 ref 隔离：依赖只放触发条件（dirty / autoSaveEnabled / 防抖键），
  //   handleSave 自身在 ref 里；否则每次 setNote/setDraft 都会重置 timer 永远不触发。
  // - 防抖键 = title + content 摘要长度，用户每打一个字 effect 重跑，timer 重置。
  // - 切笔记 / 卸载时清掉 timer 并重置 lastAutoSavedAt，避免新笔记复用旧时间戳。
  const autoSaveTriggerRef = useRef<() => Promise<void>>(async () => {});
  autoSaveTriggerRef.current = async () => {
    setAutoSaving(true);
    try {
      await handleSave(true);
      setLastAutoSavedAt(Date.now());
    } finally {
      setAutoSaving(false);
    }
  };
  useEffect(() => {
    if (!autoSaveEnabled) return;
    if (!dirty) return;
    if (!title.trim()) return;
    const timer = setTimeout(() => {
      void autoSaveTriggerRef.current();
    }, autoSaveDelay);
    return () => clearTimeout(timer);
  }, [autoSaveEnabled, autoSaveDelay, dirty, title, content]);

  // 切换到不同笔记时，清掉上一篇笔记的"已自动保存"时间戳，避免视觉残留
  useEffect(() => {
    setLastAutoSavedAt(null);
    setAutoSaving(false);
  }, [noteId]);

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

  // Ctrl+Shift+E / Cmd+Shift+E 唤起导出菜单（toggle，再按一次关闭）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setExportMenuOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // R-006 Ctrl+Alt+E / Cmd+Alt+E 直接导出当前笔记为 Markdown（与 Shift+E 打开菜单区分）
  // 用 ref 避开闭包陷阱：onKey 在 useEffect 闭包内捕获了挂载时的 handleExportNote，
  // 但 handleExportNote 引用的 noteId / title 在每次渲染都是新的 → 直接捕获会用旧值
  const exportNoteRef = useRef<typeof handleExportNote>(handleExportNote);
  exportNoteRef.current = handleExportNote;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        void exportNoteRef.current();
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

  /** Ctrl/Cmd + 点击 wiki 链接时跳转到对应笔记
   *
   * - `wikiId` 传入时（`[[标题|ID]]` 锚点形式）→ 直接按 ID 跳，跳过所有标题查找逻辑。
   *   标题改了 / 同名重名都不影响精准跳转。这是 ID 锚点的核心价值。
   * - 仅 `wikiTitle`（旧 / 手敲 `[[标题]]` 形式）→ 走原来的精确 + 模糊匹配 + 消歧路径。
   */
  async function handleWikiLinkClick(wikiTitle: string, wikiId?: number) {
    try {
      // 显式 ID 锚点路径：直接按 ID 跳
      if (wikiId != null && Number.isFinite(wikiId)) {
        const target = await noteApi.get(wikiId).catch(() => null);
        if (target) {
          await ensureSavedBeforeNavigate();
          navigate(`/notes/${target.id}`);
          return;
        }
        // ID 指向已删除 / 不可见笔记 → fallback 到按标题模糊查（让用户至少看到相近的）
        message.warning(`原链接笔记已不存在，按标题「${wikiTitle}」尝试模糊查找`);
      }

      const results = await linkApi.searchTargets(wikiTitle, 20);
      const exactMatches = results.filter((r) => r.title === wikiTitle);

      // 精确命中 1 条：直接跳
      if (exactMatches.length === 1) {
        await ensureSavedBeforeNavigate();
        navigate(`/notes/${exactMatches[0].id}`);
        return;
      }

      // 精确命中多条：弹消歧 Modal
      if (exactMatches.length > 1) {
        const notes = await Promise.all(
          exactMatches.map((r) => noteApi.get(r.id).catch(() => null)),
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
        navigate(`/notes/${results[0].id}`);
        message.info(`未找到同名笔记，跳转到相近的「${results[0].title}」`);
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

  /** 主动解除外部 .md 双向同步关联（用户在 UI 上点击；与 Missing Modal 走同一后端 Command） */
  function handleUnlinkSourceMd() {
    Modal.confirm({
      title: "解除与外部 .md 的双向同步？",
      content: (
        <div>
          <p style={{ marginBottom: 4 }}>当前关联的原文件：</p>
          <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
            {note?.source_file_path}
          </p>
          <p style={{ marginTop: 8 }}>
            解除后这条笔记降级为纯本地笔记，保存时<strong>不再写回</strong>原 .md 文件。原文件本身不会被删除。
          </p>
        </div>
      ),
      okText: "解除关联",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await sourceWritebackApi.clearLink(noteId);
          setNote((prev) =>
            prev ? { ...prev, source_file_path: null, source_file_type: null } : prev,
          );
          message.success("已解除外部 .md 关联");
        } catch (err) {
          message.error(`解除关联失败: ${err}`);
        }
      },
    });
  }

  async function handleExportNote() {
    const parentDir = await openDialog({
      directory: true,
      title: "选择导出目录",
    });
    if (!parentDir) return;
    try {
      // 单文件模式：不生成文件夹，图片/附件 base64 内嵌进 .md，直接产出一个 {标题}.md
      const result = await exportApi.exportSingle(noteId, parentDir as string, true);
      // 通过 Modal.success 给两个明确的后续操作按钮
      Modal.success({
        title: "导出成功",
        content: (
          <div>
            <p style={{ marginBottom: 4 }}>
              {result.assets_copied > 0
                ? `已导出单文件 .md（含 ${result.assets_copied} 个内嵌图片/附件），文件：`
                : "已导出单文件 .md，文件："}
            </p>
            <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
              {result.file_path}
            </p>
          </div>
        ),
        okText: "打开所在文件夹",
        onOk: () => revealItemInDir(result.file_path).catch(() => {}),
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
                  : "") +
                (result.attachmentsCopied > 0
                  ? `，附件 ${result.attachmentsCopied} 个（已放到同名 .attachments 文件夹）`
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
                  : "") +
                (result.attachmentsInlined > 0
                  ? `，内嵌附件 ${result.attachmentsInlined} 个` +
                    (result.attachmentsMissing > 0
                      ? `（${result.attachmentsMissing} 个缺失）`
                      : "")
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

  /** R-005 导出为 PDF — 复用 HTML 导出渲染管线，前端 iframe 触发系统打印对话框，
   *  用户在对话框选 "Microsoft Print to PDF" / "另存为 PDF" 完成保存。 */
  async function handleExportPdf() {
    const hide = message.loading("正在准备 PDF 打印…", 0);
    try {
      const html = await exportApi.renderHtmlForPdf(noteId);
      hide();
      // 提示用户打印对话框流程，避免误以为应用卡住
      message.info("请在打印对话框中选择「另存为 PDF」", 3);
      const safeName = title.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
      await printHtmlAsPdf(html, safeName);
    } catch (e) {
      hide();
      message.error(`导出 PDF 失败: ${e}`);
    }
  }

  /** R-005b 所见即所得打印：克隆编辑器实时 DOM + 应用同款 CSS → 系统打印对话框。
   *  与 handleExportPdf 不同——不经 markdown 重渲，打印出来 = 屏幕上看到的排版。
   *  对话框里可选真实打印机出纸，或「另存为 PDF」。 */
  async function handlePrint() {
    if (!editorInstance) {
      message.warning("编辑器尚未就绪，请稍候再试");
      return;
    }
    const hide = message.loading("正在准备打印…", 0);
    try {
      await printEditorContent(editorInstance, title);
      hide();
      message.info("请在打印对话框中选择打印机，或「另存为 PDF」", 3);
    } catch (e) {
      hide();
      message.error(`打印失败: ${e}`);
    }
  }

  /** #12 复制为 Word：把当前笔记复制成富文本（图片 base64 内嵌），
   *  直接粘进 Word / WPS / 邮件即所见即所得，不再出现大量空行 / 排版乱。 */
  async function handleCopyForWord() {
    if (!editorInstance) {
      message.warning("编辑器尚未就绪，请稍候再试");
      return;
    }
    const hide = message.loading("正在复制为富文本…", 0);
    try {
      await copyEditorContentForWord(editorInstance, title);
      hide();
      message.success("已复制为富文本，可直接粘贴到 Word / WPS / 邮件");
    } catch (e) {
      hide();
      message.error(`复制失败: ${e}`);
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
      // 通知侧边栏 NotesPanel 重拉「未分类」+「目标文件夹」笔记列表，
      // 否则在编辑器里改完目录，左侧侧边栏对应位置不会出现这条笔记
      useAppStore.getState().bumpNotesRefresh();
      useAppStore.getState().bumpFoldersRefresh();
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
    // 序列化结果与当前内容完全一致 → 本次 onUpdate 不是真实编辑，不标记 dirty。
    // 典型来源：图片 NodeView（ImageResize）挂载后回写 containerStyle/wrapperStyle 等
    // 样式属性触发 onUpdate，但这些属性不参与 markdown 序列化，getMarkdown 输出不变。
    // 之前无条件 setDirty 导致"打开含图片的笔记、没做任何修改就提示未保存"。
    // 注意：真实编辑时 val 必然 !== content，照常走 dirty 分支，不受影响。
    if (val === content) return;
    setContent(val);
    setDirty(true);
    setTabDirty(noteId, true);
  }

  // spinner 只在「冷启动首次加载」（还没有任何笔记内容）时整屏显示。
  // 切换已打开的 tab 时 note 仍是上一篇（非空）→ 不闪 spinner，编辑器保持挂载、
  // 正文就绪后原地替换 + 恢复滚动位置，消除"重新加载"观感。
  if (loading && !note) {
    return (
      <div className="editor-page">
        <div className="flex items-center justify-center flex-1">
          <Spin size="large" />
        </div>
      </div>
    );
  }

  return (
    <div className="editor-page">
      {/* 顶部工具栏 */}
      <div className="editor-topbar">
        {/* 左侧：返回按钮 + 右边小字（更新时间 / 保存状态 上下堆叠）
            原方案是同一行 Space，"更新于 XX 分钟前 未保存"会把按钮挤到换行；
            改成竖向堆叠后整个左侧组宽度变窄，按钮全部回到一行 */}
        <div className="editor-topbar__left">
          <Button
            icon={<ArrowLeft size={16} />}
            onClick={() => {
              if (window.history.length > 1) {
                navigate(-1);
              } else {
                navigate("/notes");
              }
            }}
          >
            返回
          </Button>
          {(note || autoSaving || dirty || (autoSaveEnabled && lastAutoSavedAt)) && (
            <div className="editor-topbar__meta">
              {note && (
                <Text type="secondary" style={{ fontSize: 11, lineHeight: 1.2 }}>
                  更新于 {relativeTime(note.updated_at)}
                </Text>
              )}
              {/* 保存状态提示：优先级 自动保存中 > 未保存 > 已自动保存（沿用旧逻辑） */}
              {autoSaving ? (
                <Text type="secondary" style={{ fontSize: 11, lineHeight: 1.2 }}>
                  自动保存中…
                </Text>
              ) : dirty ? (
                <Text type="warning" style={{ fontSize: 11, lineHeight: 1.2 }}>
                  未保存
                </Text>
              ) : autoSaveEnabled && lastAutoSavedAt ? (
                <Text type="secondary" style={{ fontSize: 11, lineHeight: 1.2 }}>
                  已自动保存 {relativeTime(new Date(lastAutoSavedAt).toISOString())}
                </Text>
              ) : null}
            </div>
          )}
        </div>
        <Space align="center">
          <Tooltip title={readingMode ? "切换到编辑模式" : "切换到阅读模式（隐藏工具栏，不可编辑）"}>
            <Button
              type={readingMode ? "primary" : "default"}
              icon={readingMode ? <BookOpen size={16} /> : <FilePen size={16} />}
              onClick={() => setReadingMode((v) => !v)}
            />
          </Tooltip>
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
          <Tooltip
            title={
              mindMapOpen
                ? "思维导图打开期间大纲已暂时隐藏（关闭导图后恢复）"
                : outlineVisible
                  ? "隐藏大纲"
                  : "显示大纲"
            }
          >
            <Button
              type={effectiveOutlineVisible ? "primary" : "default"}
              icon={<ListTree size={16} />}
              onClick={toggleOutline}
              disabled={mindMapOpen}
            />
          </Tooltip>
          <Tooltip title="思维导图（只读视图）">
            <Button
              icon={<Network size={16} />}
              onClick={() => setMindMapOpen(true)}
            />
          </Tooltip>
          <Tooltip title="幻灯片演示（用 --- 分页）">
            <Button
              icon={<Presentation size={16} />}
              onClick={() => setSlideshowOpen(true)}
            />
          </Tooltip>
          {/* popout 窗口里再点这个按钮没有意义（同 id 只会前置已存在窗口），直接隐藏 */}
          {!IS_POPOUT_WINDOW && (
            <Tooltip title="新窗口打开">
              <Button
                icon={<ExternalLink size={16} />}
                onClick={async () => {
                  if (!noteId) return;
                  // 弹新窗口前先把未保存内容落库，避免 pop-out 看到老版本
                  if (dirty) await handleSave(true);
                  try {
                    await noteApi.openInNewWindow(noteId);
                  } catch (e) {
                    message.error(`打开新窗口失败：${e}`);
                  }
                }}
              />
            </Tooltip>
          )}
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
          {!readingMode && (
            <Button
              type="primary"
              icon={<Save size={16} />}
              loading={saving}
              onClick={() => handleSave()}
              disabled={!dirty}
            >
              保存
            </Button>
          )}
          {note?.source_file_path && (
            note?.source_file_type === "md" ? (
              // 外部 .md 双向同步关联：主按钮用系统应用打开，下拉菜单提供"解除关联"
              <Space.Compact>
                <Tooltip title="用系统默认应用打开原始 .md 文件">
                  <Button
                    icon={<FileTextIcon size={16} />}
                    onClick={handleOpenSourceFile}
                  >
                    MD
                  </Button>
                </Tooltip>
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      {
                        key: "open",
                        label: "用系统应用打开",
                        onClick: () => void handleOpenSourceFile(),
                      },
                      { type: "divider" },
                      {
                        key: "unlink",
                        label: "解除外部 .md 关联",
                        danger: true,
                        onClick: handleUnlinkSourceMd,
                      },
                    ],
                  }}
                >
                  <Button icon={<ChevronDown size={14} />} title="更多操作" />
                </Dropdown>
              </Space.Compact>
            ) : (
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
            )
          )}
          {/* R-005b 打印：所见即所得，克隆编辑器实时 DOM + 应用同款 CSS → 系统打印对话框 */}
          <Tooltip title="打印 / 打印成 PDF（所见即所得）">
            <Button icon={<Printer size={16} />} onClick={() => void handlePrint()} />
          </Tooltip>
          {/* T-020 导出按钮：默认导出 Markdown；右侧下拉可选 Word / HTML（Ctrl+Shift+E 唤起菜单） */}
          {(() => {
            const exportAccel = accelToKeys(
              findShortcut("editor.exportMenu")?.defaultAccel ?? "CommandOrControl+Shift+E",
            ).join("+");
            return (
              <Space.Compact>
                <Tooltip title="导出为 Markdown">
                  <Button
                    icon={<Share size={16} />}
                    onClick={handleExportNote}
                  />
                </Tooltip>
                <Dropdown
                  trigger={["click"]}
                  open={exportMenuOpen}
                  onOpenChange={setExportMenuOpen}
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
                        key: "copy-word",
                        label: "复制为 Word（富文本，可直接粘贴）",
                        onClick: () => void handleCopyForWord(),
                      },
                      {
                        key: "html",
                        label: "导出为 HTML (单文件)",
                        onClick: () => void handleExportHtml(),
                      },
                      {
                        key: "print",
                        label: "打印 / 打印成 PDF（所见即所得）",
                        onClick: () => void handlePrint(),
                      },
                      {
                        key: "pdf",
                        label: "导出为 PDF (旧版排版)",
                        onClick: () => void handleExportPdf(),
                      },
                    ],
                  }}
                >
                  <Tooltip title={`更多导出格式 (${exportAccel})`}>
                    <Button icon={<ChevronDown size={14} />} />
                  </Tooltip>
                </Dropdown>
              </Space.Compact>
            );
          })()}
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

      {/* 编辑器 + 思维导图 横向分栏容器（mindMapOpen=true 时变两栏，否则编辑器独占） */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "row",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
      {/* 可滚动的编辑主体 */}
      <div
        className="editor-body"
        ref={editorBodyRef}
        data-outline={effectiveOutlineVisible ? "on" : undefined}
        data-outline-pos={effectiveOutlineVisible ? outlinePosition : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          ...(effectiveOutlineVisible && {
            // 覆盖 CSS 里固定的 200px：左置时 大纲列 | 6px 分隔 | 1fr；右置时反之。
            // DOM 顺序固定为 内容→分隔条→大纲，左置时由 CSS order 调换视觉次序。
            gridTemplateColumns:
              outlinePosition === "left"
                ? `${outlineWidth}px 6px minmax(0, 1fr)`
                : `minmax(0, 1fr) 6px ${outlineWidth}px`,
          }),
        }}
      >
        <div
          className="editor-content-area"
          style={
            // 隐藏大纲 + 设了阅读列宽时：把大纲列(含 6px 分隔条)腾出的宽度补给正文，
            // 让编辑区随之变宽、收窄两侧空白。readingWidth=0(不限制)时不覆盖，沿用铺满逻辑。
            !effectiveOutlineVisible && editorReadingWidth > 0
              ? { maxWidth: editorReadingWidth + outlineWidth + 6 }
              : undefined
          }
        >
          {/* 标题：用 position:relative 父级 + 绝对定位 mic / clear 模拟 suffix。
              不直接用 antd Input.suffix / allowClear——两者都会包一层
              .ant-input-affix-wrapper 把 borderless 大标题撑成白底大框。 */}
          <div style={{ position: "relative" }}>
            <Input
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              onPaste={(e) => {
                // 仅清洗空白：去换行/Tab/多余空格，免得从来源复制标题时把日期/来源
                // 连带的杂乱空白塞进标题。无可清洗的空白则放行原生粘贴，保留光标行为。
                const raw = e.clipboardData.getData("text");
                const cleaned = sanitizeTitlePaste(raw);
                if (cleaned === raw) return;
                e.preventDefault();
                const el = e.currentTarget;
                const start = el.selectionStart ?? title.length;
                const end = el.selectionEnd ?? title.length;
                const next = title.slice(0, start) + cleaned + title.slice(end);
                handleTitleChange(next);
                // 受控组件重渲染后再把光标还原到插入末尾
                requestAnimationFrame(() => {
                  const pos = start + cleaned.length;
                  try {
                    el.setSelectionRange(pos, pos);
                  } catch {
                    /* 元素可能已卸载，忽略 */
                  }
                });
              }}
              onPressEnter={(e) => {
                // 填完标题回车 → 焦点跳到正文末尾，直接接着写（阅读模式不抢焦点）
                e.preventDefault();
                if (!readingMode && editorInstance) {
                  editorInstance.chain().focus("end").run();
                }
              }}
              placeholder="笔记标题"
              variant="borderless"
              className="editor-title"
              style={{ paddingRight: 64 }}
            />
            <div
              style={{
                position: "absolute",
                right: 4,
                top: "50%",
                transform: "translateY(-50%)",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {title && (
                // 与 antd allowClear 视觉一致：CloseCircleFilled 灰色实心圆 ×，hover 加深
                <CloseCircleFilled
                  onClick={() => handleTitleChange("")}
                  title="清空"
                  style={{
                    cursor: "pointer",
                    fontSize: 14,
                    color: "rgba(0, 0, 0, 0.25)",
                    transition: "color 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as unknown as HTMLElement).style.color =
                      "rgba(0, 0, 0, 0.45)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as unknown as HTMLElement).style.color =
                      "rgba(0, 0, 0, 0.25)";
                  }}
                />
              )}
              <MicButton
                stripTrailingPunctuation
                onTranscribed={(text) =>
                  handleTitleChange(title ? `${title} ${text}` : text)
                }
              />
            </div>
          </div>

          {/* 文件夹 + 标签元数据 */}
          <div className="editor-meta">
            <MetaBar
              noteTags={noteTags}
              allTags={allTags}
              folders={folders}
              folderId={note?.folder_id ?? null}
              editor={editorInstance}
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
            readingMode={readingMode}
            initialSearch={initialSearch}
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

        {/* 大纲左侧拖拽分隔条：6px 宽，col-resize；与思维导图分隔条同模式：
            mousedown 进入拖拽态 → 全局 mousemove 调宽 → mouseup 解绑落库 */}
        {effectiveOutlineVisible && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整大纲宽度（双击还原默认）"
            className="editor-outline-splitter"
            onMouseDown={(e) => {
              e.preventDefault();
              outlineDragRef.current = {
                startX: e.clientX,
                startWidth: outlineWidth,
                latest: outlineWidth,
              };
              const handleMove = (ev: MouseEvent) => {
                const ref = outlineDragRef.current;
                if (!ref) return;
                // 右置：分隔条在大纲左缘，鼠标向左 → 变宽（startX - X）；
                // 左置：分隔条在大纲右缘，鼠标向右 → 变宽（X - startX）。方向相反。
                const delta =
                  outlinePosition === "left"
                    ? ev.clientX - ref.startX
                    : ref.startX - ev.clientX;
                const next = Math.max(140, Math.min(480, ref.startWidth + delta));
                ref.latest = next;
                setOutlineWidth(next);
              };
              const handleUp = () => {
                window.removeEventListener("mousemove", handleMove);
                window.removeEventListener("mouseup", handleUp);
                const ref = outlineDragRef.current;
                if (ref) {
                  localStorage.setItem("editor.outlineWidth", String(ref.latest));
                  outlineDragRef.current = null;
                }
              };
              window.addEventListener("mousemove", handleMove);
              window.addEventListener("mouseup", handleUp);
            }}
            onDoubleClick={() => {
              setOutlineWidth(OUTLINE_DEFAULT_WIDTH);
              localStorage.setItem(
                "editor.outlineWidth",
                String(OUTLINE_DEFAULT_WIDTH),
              );
            }}
          />
        )}

        {/* 右侧大纲面板：sticky 跟随滚动；用户偏好关闭 / 思维导图打开 时自隐 */}
        {effectiveOutlineVisible && (
          <aside className="editor-outline-aside">
            <EditorOutline
              editor={editorInstance}
              scrollRoot={editorBodyRef.current}
              onHide={toggleOutline}
            />
          </aside>
        )}
      </div>

      {/* 思维导图分栏拖拽手柄：6px 宽，col-resize；onMouseDown 进入拖拽态，
          全局 mousemove 调宽度，mouseup 解绑并落库 */}
      {mindMapOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整思维导图宽度"
          onMouseDown={(e) => {
            e.preventDefault();
            splitterDragRef.current = {
              startX: e.clientX,
              startWidth: mindMapWidth,
              latest: mindMapWidth,
            };
            const handleMove = (ev: MouseEvent) => {
              const ref = splitterDragRef.current;
              if (!ref) return;
              // 向左拖 → 导图变宽（鼠标 X 减小）；反之变窄
              const delta = ref.startX - ev.clientX;
              const next = Math.max(320, Math.min(1200, ref.startWidth + delta));
              ref.latest = next;
              setMindMapWidth(next);
            };
            const handleUp = () => {
              window.removeEventListener("mousemove", handleMove);
              window.removeEventListener("mouseup", handleUp);
              const ref = splitterDragRef.current;
              if (ref) {
                localStorage.setItem("editor.mindMapWidth", String(ref.latest));
                splitterDragRef.current = null;
              }
            };
            window.addEventListener("mousemove", handleMove);
            window.addEventListener("mouseup", handleUp);
          }}
          style={{
            width: 6,
            cursor: "col-resize",
            background: "transparent",
            flexShrink: 0,
          }}
          className="hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors"
        />
      )}

      {/* 思维导图分栏：仅 mindMapOpen 时挂载 */}
      {mindMapOpen && (
        <div
          style={{
            width: mindMapWidth,
            flexShrink: 0,
            minWidth: 320,
            height: "100%",
          }}
        >
          <MindMapView
            open={mindMapOpen}
            onClose={() => setMindMapOpen(false)}
            markdown={content}
            title={title}
            noteId={Number.isFinite(noteId) ? noteId : null}
            variant="embed"
          />
        </div>
      )}
      </div>

      {/* 幻灯片演示：fixed 全屏覆盖，按 <hr> 分页 */}
      <SlideshowView
        open={slideshowOpen}
        onClose={() => setSlideshowOpen(false)}
        html={content}
        title={title}
      />

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

import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileNoteEditor } from "./MobileNoteEditor";

export default function NoteEditorPage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileNoteEditor /> : <DesktopNoteEditorPage />;
}
