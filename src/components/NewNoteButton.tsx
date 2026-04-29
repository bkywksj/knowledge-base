import { useState } from "react";
import { Button, Dropdown, Space, type MenuProps } from "antd";
import type { SizeType } from "antd/es/config-provider/SizeContext";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  ChevronDown,
  LayoutTemplate,
} from "lucide-react";

import { FileTypeIcon } from "./FileTypeIcon";
import { TemplatePickerModal } from "./TemplatePickerModal";
import {
  createBlankAndOpen,
  importPdfsFlow,
  importTextFlow,
  importWordFlow,
} from "@/lib/noteCreator";

interface Props {
  /** 创建/导入时归入的文件夹 id；顶层创建传 null */
  folderId?: number | null;
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
  collapsed = false,
  block = false,
  label = "新建笔记",
  style,
  size,
}: Props) {
  const navigate = useNavigate();
  const [templateOpen, setTemplateOpen] = useState(false);

  // 没有文件夹上下文时（顶部+按钮 / 首页大按钮）套用全局默认；
  // 有 folderId（NotesPanel 文件夹下嵌入）就遵循上下文
  const handleCreate = () =>
    createBlankAndOpen(folderId, navigate, { useDefaults: folderId == null });

  const menuItems: MenuProps["items"] = [
    {
      key: "template",
      label: "从模板…",
      icon: <LayoutTemplate size={14} />,
      onClick: () => setTemplateOpen(true),
    },
    { type: "divider" },
    {
      key: "import-text",
      label: "导入 Markdown / TXT…",
      icon: <FileTypeIcon type="md" size={14} />,
      onClick: () => importTextFlow(folderId, navigate),
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
    </>
  );
}
