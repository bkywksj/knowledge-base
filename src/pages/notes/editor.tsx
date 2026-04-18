import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Input,
  Button,
  Space,
  Typography,
  message,
  Spin,
  Popconfirm,
  Select,
  Tag as AntTag,
  Divider,
  Tooltip,
  Modal,
  List,
} from "antd";
import { ArrowLeft, Save, Trash2, Pin, FolderOpen, Tags, Link2, Share, Maximize2, Minimize2, FileText as FileTextIcon } from "lucide-react";
import { useAppStore } from "@/store";
import { useTabsStore } from "@/store/tabs";
import { noteApi, tagApi, folderApi, linkApi, exportApi, pdfApi } from "@/lib/api";
import { save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { relativeTime, stripHtml } from "@/lib/utils";
import { TiptapEditor } from "@/components/editor";
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

/** 反向链接面板 */
function BacklinksPanel({
  backlinks,
  onNavigate,
}: {
  backlinks: NoteLink[];
  onNavigate: (id: number) => void;
}) {
  if (backlinks.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-2">
        <Link2 size={14} className="text-gray-400" />
        <Text type="secondary" style={{ fontSize: 13 }}>
          反向链接 ({backlinks.length})
        </Text>
      </div>
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
    </div>
  );
}

/** 将树形文件夹结构扁平化 */
function flattenFolders(
  folders: Folder[],
  prefix = ""
): { label: string; value: number }[] {
  const result: { label: string; value: number }[] = [];
  for (const folder of folders) {
    const label = prefix ? `${prefix} / ${folder.name}` : folder.name;
    result.push({ label, value: folder.id });
    if (folder.children?.length) {
      result.push(...flattenFolders(folder.children, label));
    }
  }
  return result;
}

/** 标签与文件夹元数据区域 */
function MetaBar({
  noteTags,
  allTags,
  folderOptions,
  folderId,
  onTagsChange,
  onFolderChange,
}: {
  noteTags: Tag[];
  allTags: Tag[];
  folderOptions: { label: string; value: number }[];
  folderId: number | null;
  onTagsChange: (tagIds: number[]) => void;
  onFolderChange: (folderId: number | null) => void;
}) {
  const tagOptions = allTags.map((t) => ({
    label: t.name,
    value: t.id,
  }));

  const selectedTagIds = noteTags.map((t) => t.id);

  return (
    <div className="flex items-center gap-3 py-2 flex-wrap">
      {/* 文件夹选择 */}
      <div className="flex items-center gap-1">
        <FolderOpen size={14} className="text-gray-400 shrink-0" />
        <Select
          size="small"
          placeholder="选择文件夹"
          allowClear
          style={{ minWidth: 140 }}
          value={folderId ?? undefined}
          onChange={(val) => onFolderChange(val ?? null)}
          options={folderOptions}
        />
      </div>

      <Divider type="vertical" style={{ height: 20 }} />

      {/* 标签管理 */}
      <div className="flex items-center gap-1 flex-1 min-w-0">
        <Tags size={14} className="text-gray-400 shrink-0" />
        <div className="flex items-center gap-1 flex-wrap flex-1">
          {noteTags.map((tag) => (
            <AntTag
              key={tag.id}
              closable
              color={tag.color ?? undefined}
              onClose={() => {
                onTagsChange(selectedTagIds.filter((id) => id !== tag.id));
              }}
            >
              {tag.name}
            </AntTag>
          ))}
          <Select
            mode="multiple"
            size="small"
            placeholder="+ 添加标签"
            style={{ minWidth: 120, maxWidth: 200 }}
            value={selectedTagIds}
            onChange={onTagsChange}
            options={tagOptions}
            maxTagCount={0}
            maxTagPlaceholder={`+ 添加`}
            popupMatchSelectWidth={180}
          />
        </div>
      </div>
    </div>
  );
}

export default function NoteEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { focusMode, setFocusMode } = useAppStore();
  const { openTab, updateTabTitle, setTabDirty } = useTabsStore();
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // 标签状态
  const [noteTags, setNoteTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);

  // 文件夹状态
  const [folderOptions, setFolderOptions] = useState<
    { label: string; value: number }[]
  >([]);

  // 反向链接状态
  const [backlinks, setBacklinks] = useState<NoteLink[]>([]);

  // 同名消歧 Modal 状态
  const [disambigOpen, setDisambigOpen] = useState(false);
  const [disambigItems, setDisambigItems] = useState<Note[]>([]);
  const [disambigTitle, setDisambigTitle] = useState("");

  // PDF 预览 Modal 状态
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string>("");

  const noteId = Number(id);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [noteData, tags, folders, existingTags, links] = await Promise.all([
        noteApi.get(noteId),
        tagApi.list(),
        folderApi.list(),
        tagApi.getNoteTags(noteId),
        linkApi.getBacklinks(noteId),
      ]);
      setNote(noteData);
      setTitle(noteData.title);
      setContent(noteData.content);
      setDirty(false);
      setAllTags(tags);
      setNoteTags(existingTags);
      setFolderOptions(flattenFolders(folders));
      setBacklinks(links);
      openTab({ id: noteData.id, title: noteData.title });
    } catch (e) {
      message.error(String(e));
      navigate("/notes");
    } finally {
      setLoading(false);
    }
  }, [noteId, navigate, openTab]);

  useEffect(() => {
    if (id) loadData();
  }, [id, loadData]);

  async function handleSave() {
    if (!title.trim()) {
      message.warning("标题不能为空");
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

      // 解析 [[]] 链接并同步
      const wikiTitles = extractWikiLinks(content);
      if (wikiTitles.length > 0) {
        try {
          const targetIds: number[] = [];
          for (const t of wikiTitles) {
            const results = await linkApi.searchTargets(t, 1);
            const exact = results.find(([, name]) => name === t);
            if (exact) targetIds.push(exact[0]);
          }
          await linkApi.syncLinks(noteId, targetIds);
        } catch {
          // 链接同步失败不影响保存
        }
      } else {
        // 无链接时清空
        await linkApi.syncLinks(noteId, []).catch(() => {});
      }

      message.success("保存成功");
    } catch (e) {
      message.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await noteApi.delete(noteId);
      message.success("删除成功");
      useTabsStore.getState().closeTab(noteId);
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

  /** Ctrl/Cmd + 点击 [[标题]] 时跳转到对应笔记 */
  async function handleWikiLinkClick(wikiTitle: string) {
    try {
      const results = await linkApi.searchTargets(wikiTitle, 20);
      const exactMatches = results.filter(([, name]) => name === wikiTitle);

      // 精确命中 1 条：直接跳
      if (exactMatches.length === 1) {
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
        navigate(`/notes/${results[0][0]}`);
        message.info(`未找到同名笔记，跳转到相近的「${results[0][1]}」`);
        return;
      }

      message.warning(`未找到笔记「${wikiTitle}」`);
    } catch (e) {
      message.error(`跳转失败: ${e}`);
    }
  }

  function handleDisambigSelect(targetId: number) {
    setDisambigOpen(false);
    navigate(`/notes/${targetId}`);
  }

  async function handleOpenPdfPreview() {
    try {
      const abs = await pdfApi.getAbsolutePath(noteId);
      if (!abs) {
        message.warning("原始 PDF 文件丢失或未关联");
        return;
      }
      setPdfPreviewUrl(convertFileSrc(abs));
      setPdfPreviewOpen(true);
    } catch (e) {
      message.error(`预览失败: ${e}`);
    }
  }

  async function handleExportNote() {
    const safeName = title.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
    const filePath = await save({
      defaultPath: `${safeName}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!filePath) return;
    try {
      await exportApi.exportSingle(noteId, filePath);
      message.success("导出成功");
    } catch (e) {
      message.error(`导出失败: ${e}`);
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
        <Space align="center">
          <Button
            icon={<ArrowLeft size={16} />}
            onClick={() => navigate("/notes")}
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
          <Button
            type="primary"
            icon={<Save size={16} />}
            loading={saving}
            onClick={handleSave}
            disabled={!dirty}
          >
            保存
          </Button>
          {note?.pdf_path && (
            <Tooltip title="查看原始 PDF">
              <Button
                icon={<FileTextIcon size={16} />}
                onClick={handleOpenPdfPreview}
              >
                PDF
              </Button>
            </Tooltip>
          )}
          <Tooltip title="导出为 Markdown">
            <Button
              icon={<Share size={16} />}
              onClick={handleExportNote}
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
      <div className="editor-body">
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
              folderOptions={folderOptions}
              folderId={note?.folder_id ?? null}
              onTagsChange={handleTagsChange}
              onFolderChange={handleFolderChange}
            />
          </div>

          {/* 内容编辑区 */}
          <TiptapEditor
            content={content}
            onChange={handleContentChange}
            placeholder="开始写点什么..."
            noteId={noteId}
            onWikiLinkClick={handleWikiLinkClick}
          />

          {/* 反向链接 */}
          <BacklinksPanel
            backlinks={backlinks}
            onNavigate={(id) => navigate(`/notes/${id}`)}
          />
        </div>
      </div>

      {/* PDF 原文件预览 */}
      <Modal
        open={pdfPreviewOpen}
        title={note?.title ? `${note.title} · 原始 PDF` : "原始 PDF"}
        footer={null}
        onCancel={() => setPdfPreviewOpen(false)}
        width="85vw"
        style={{ top: 30 }}
        styles={{ body: { padding: 0, height: "78vh" } }}
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
    </div>
  );
}
