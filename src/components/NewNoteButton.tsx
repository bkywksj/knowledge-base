import { useState } from "react";
import { Button, Dropdown, Space, message, type MenuProps } from "antd";
import type { SizeType } from "antd/es/config-provider/SizeContext";
import { useNavigate } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Plus,
  ChevronDown,
  LayoutTemplate,
  FolderOpen,
  PenTool,
} from "lucide-react";

import { FileTypeIcon } from "./FileTypeIcon";
import { TemplatePickerModal } from "./TemplatePickerModal";
import { ImportPreviewModal } from "./ImportPreviewModal";
import { importApi } from "@/lib/api";
import { beginTrackedImportJob } from "@/lib/importJob";
import { useAppStore } from "@/store";
import type { ScannedFile } from "@/types";
import {
  createBlankAndOpen,
  createWhiteboardAndOpen,
  importPdfsFlow,
  importTextFlow,
  importWordFlow,
} from "@/lib/noteCreator";

interface Props {
  /** 创建/导入时归入的文件夹 id；顶层创建传 null */
  folderId?: number | null;
  /**
   * 是否套用全局「默认文件夹 / 默认标签」偏好。
   *
   * 不传时按老规则推断（`folderId == null` 就套）。但光看 folderId 分不出
   * 「没有上下文」和「用户明确选了未分类」—— 后者的 folderId 也是 null，
   * 却不该被默认文件夹劫持。这种场景显式传 false，见 lib/newNoteTarget.ts。
   */
  useDefaults?: boolean;
  /** 侧边栏折叠态：只显示 + 图标，不带下拉 */
  collapsed?: boolean;
  /** 块级占满父容器宽度（首页/笔记页大按钮用） */
  block?: boolean;
  /** 主按钮文字，默认"新建笔记" */
  label?: string;
  /** 外层样式扩展 */
  style?: React.CSSProperties;
  /** 按钮尺寸（透传给内部 Button），默认 middle；首页大按钮用 large */
  size?: SizeType;
}

/**
 * "+ 新建笔记"分段按钮：主按钮直接创建空白笔记并跳转编辑器，
 * 右侧 ▼ 下拉承载"从模板 / 导入 MD / PDF / Word"的次要入口。
 *
 * 取代了旧的 CreateNoteModal（Tab 切换式）—— 常用路径 1 次点击可达，
 * 模板/导入仍然发现性足够。
 */
export function NewNoteButton({
  folderId = null,
  useDefaults,
  collapsed = false,
  block = false,
  label = "新建笔记",
  style,
  size,
}: Props) {
  const navigate = useNavigate();
  const [templateOpen, setTemplateOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<{
    files: ScannedFile[];
    rootPath: string;
    folderId: number | null;
  } | null>(null);

  // 有 folderId 就遵循上下文；没有则套全局默认。
  // 调用方能区分「未选中」和「明确选了未分类」时，用 useDefaults 显式覆盖。
  const handleCreate = () =>
    createBlankAndOpen(folderId, navigate, {
      useDefaults: useDefaults ?? folderId == null,
    });

  // 选目录 → 扫描 → 弹 ImportPreviewModal。与 NotesPanel.handleImportMdFolder 同源。
  // Why: 文件夹导入要让用户选副本策略 + 是否保留根目录层级，所以单独走 Modal 流，
  // 不能像 importTextFlow 那样"选完直接建"。
  async function handleImportMdFolder() {
    try {
      const picked = await openDialog({
        directory: true,
        title: "选择要导入的 Markdown 文件夹",
      });
      if (!picked || Array.isArray(picked)) return;
      const rootPath = picked;
      const hide = message.loading("扫描中…", 0);
      let files: ScannedFile[];
      try {
        files = await importApi.scan(rootPath);
      } catch (e) {
        hide();
        message.error(`扫描失败: ${e}`);
        return;
      }
      hide();
      if (files.length === 0) {
        message.info("该文件夹下没有 .md 文件");
        return;
      }
      setImportPreview({ files, rootPath, folderId });
    } catch (e) {
      message.error(`选择目录失败: ${e}`);
    }
  }

  const menuItems: MenuProps["items"] = [
    {
      key: "template",
      label: "从模板…",
      icon: <LayoutTemplate size={14} />,
      onClick: () => setTemplateOpen(true),
    },
    {
      key: "whiteboard",
      label: "新建白板",
      icon: <PenTool size={14} />,
      onClick: () => createWhiteboardAndOpen(folderId, navigate),
    },
    { type: "divider" },
    {
      key: "import-text",
      label: "导入 Markdown / TXT…",
      icon: <FileTypeIcon type="md" size={14} />,
      onClick: () => importTextFlow(folderId, navigate),
    },
    {
      key: "import-md-folder",
      label: "导入 Markdown 文件夹 / Obsidian Vault…",
      icon: <FolderOpen size={14} />,
      onClick: () => {
        void handleImportMdFolder();
      },
    },
    {
      key: "import-pdf",
      label: "导入 PDF…",
      icon: <FileTypeIcon type="pdf" size={14} />,
      onClick: () => importPdfsFlow(folderId, navigate),
    },
    {
      key: "import-docx",
      label: "导入 Word…",
      icon: <FileTypeIcon type="docx" size={14} />,
      onClick: () => importWordFlow(folderId, navigate),
    },
  ];

  // 折叠态：只显示单图标按钮（下拉菜单在折叠态占地方也没意义）
  if (collapsed) {
    return (
      <>
        <Button
          type="primary"
          icon={<Plus size={16} />}
          onClick={handleCreate}
          title="新建笔记 (Ctrl+N)"
          style={style}
        />
        <TemplatePickerModal
          open={templateOpen}
          folderId={folderId}
          onClose={() => setTemplateOpen(false)}
        />
      </>
    );
  }

  return (
    <>
      <Space.Compact style={block ? { width: "100%", ...style } : style}>
        <Button
          type="primary"
          size={size}
          icon={<Plus size={14} />}
          onClick={handleCreate}
          title="新建笔记 (Ctrl+N)"
          style={block ? { flex: 1 } : undefined}
        >
          {label}
        </Button>
        <Dropdown
          menu={{ items: menuItems }}
          trigger={["click"]}
          placement="bottomRight"
        >
          <Button
            type="primary"
            size={size}
            icon={<ChevronDown size={14} />}
            title="更多创建方式"
          />
        </Dropdown>
      </Space.Compact>
      <TemplatePickerModal
        open={templateOpen}
        folderId={folderId}
        onClose={() => setTemplateOpen(false)}
      />
      {importPreview && (
        <ImportPreviewModal
          open
          files={importPreview.files}
          rootPath={importPreview.rootPath}
          onCancel={() => setImportPreview(null)}
          onConfirm={async ({ policy, preserveRoot, dailyMode }) => {
            const { files, rootPath, folderId: targetFolderId } = importPreview;
            setImportPreview(null);
            const paths = files.map((f) => f.path);
            const job = await beginTrackedImportJob(
              "Markdown / 文本",
              paths.length,
              "import:progress",
            );
            try {
              const result = await importApi.importSelected(
                paths,
                targetFolderId,
                rootPath,
                preserveRoot,
                policy,
                dailyMode,
              );
              job.finish(result.imported, result.errors.length);
              const parts: string[] = [];
              if (result.imported > 0) parts.push(`导入 ${result.imported} 篇`);
              if (result.duplicated > 0) parts.push(`副本 ${result.duplicated} 篇`);
              if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 篇`);
              if (result.tags_attached && result.tags_attached > 0) {
                parts.push(`关联标签 ${result.tags_attached} 条`);
              }
              if (result.attachments_copied && result.attachments_copied > 0) {
                parts.push(`复制图片 ${result.attachments_copied} 张`);
              }
              if (result.daily_marked && result.daily_marked > 0) {
                parts.push(`日记 ${result.daily_marked} 天`);
              }
              if (parts.length > 0) message.success(parts.join("，"));
              // 同一天多篇时只认领了第一篇，提示用户可以去合并
              if (result.daily_extra_notes && result.daily_extra_notes > 0) {
                message.info(
                  `有 ${result.daily_extra_notes} 篇与已有日记同一天，仍是普通笔记；` +
                    `可在日记页用「整理历史日记」合并进当天`,
                  6,
                );
              }
              const missCount = result.attachments_missing?.length ?? 0;
              if (missCount > 0) {
                message.warning(
                  `${missCount} 张图片在 vault 里找不到，已保留原引用`,
                );
                console.warn(
                  "[import] 缺失图片清单:",
                  result.attachments_missing,
                );
              }
              if (result.errors.length > 0) {
                message.warning(
                  `${result.errors.length} 个文件失败，详见控制台`,
                );
                console.warn("[import] 失败明细:", result.errors);
              }
              useAppStore.getState().bumpNotesRefresh();
              useAppStore.getState().bumpFoldersRefresh();
            } catch (e) {
              job.cancel();
              message.error(`导入失败: ${e}`);
            }
          }}
        />
      )}
    </>
  );
}
