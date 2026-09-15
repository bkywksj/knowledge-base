import { Checkbox, Modal, Radio, Segmented, Typography, message } from "antd";
import { useEffect, useState } from "react";

import { folderApi } from "@/lib/api";
import { exportFolderAsTree, exportFolderMerged } from "@/lib/exportActions";
import type { MergeFormat } from "@/types";

export interface ExportFolderTarget {
  /** null = 全库导出 */
  id: number | null;
  name: string;
}

interface Props {
  target: ExportFolderTarget | null;
  onClose: () => void;
}

type Structure = "tree" | "merged";

/**
 * 文件夹导出配置弹窗。
 *
 * 为什么不做成右键子菜单：文件夹导出的选项比单篇多（递归 / 结构 / 格式），
 * 全平铺进右键菜单会撑爆（文件夹菜单本来已有 13 项）。一个菜单项 + 一个弹窗更合适。
 *
 * 两种结构的取舍说明也写在界面上 —— 用户常常分不清"备份"和"交付"该选哪个。
 */
export function ExportFolderModal({ target, onClose }: Props) {
  const [recursive, setRecursive] = useState(true);
  const [structure, setStructure] = useState<Structure>("tree");
  const [format, setFormat] = useState<MergeFormat>("markdown");
  const [stats, setStats] = useState<{ notes: number; dailies: number } | null>(null);
  const [exporting, setExporting] = useState(false);

  // 每次打开都重置成默认值，避免上次的选择“粘”到下一个文件夹上
  useEffect(() => {
    if (!target) return;
    setRecursive(true);
    setStructure("tree");
    setFormat("markdown");
    setStats(null);
    if (target.id == null) return;
    folderApi
      .subtreeStats(target.id)
      .then((s) => setStats({ notes: s.notes, dailies: s.dailies }))
      .catch(() => setStats(null)); // 统计失败不影响导出，只是不显示篇数
  }, [target]);

  async function handleExport() {
    if (!target) return;
    setExporting(true);
    try {
      if (structure === "tree") {
        await exportFolderAsTree(target.id, target.name, recursive);
      } else {
        await exportFolderMerged(target.id, target.name, recursive, format);
      }
      onClose();
    } catch (e) {
      message.error(String(e));
    } finally {
      setExporting(false);
    }
  }

  const scopeHint =
    stats == null
      ? null
      : recursive
        ? `子树内共 ${stats.notes} 篇笔记${stats.dailies > 0 ? ` + ${stats.dailies} 篇日记` : ""}`
        : "仅导出该文件夹的直属笔记";

  return (
    <Modal
      title={target ? `导出文件夹「${target.name}」` : "导出"}
      open={!!target}
      onCancel={onClose}
      onOk={handleExport}
      okText="选择位置并导出"
      confirmLoading={exporting}
      width={520}
      destroyOnHidden
    >
      <div className="flex flex-col gap-4 py-2">
        <Field label="范围">
          <Checkbox checked={recursive} onChange={(e) => setRecursive(e.target.checked)}>
            包含子文件夹
          </Checkbox>
          {scopeHint && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {scopeHint}
            </Typography.Text>
          )}
        </Field>

        <Field label="结构">
          <Radio.Group
            value={structure}
            onChange={(e) => setStructure(e.target.value as Structure)}
          >
            <div className="flex flex-col gap-2">
              <Radio value="tree">
                保留目录结构
                <Hint>多个 .md 文件 + assets/，适合备份与迁移到其他笔记工具</Hint>
              </Radio>
              <Radio value="merged">
                合并为单个文件
                <Hint>带目录和章节层级的一份文档，适合发给别人 / 打印 / 存档</Hint>
              </Radio>
            </div>
          </Radio.Group>
        </Field>

        <Field label="格式">
          {structure === "merged" ? (
            <Segmented
              value={format}
              onChange={(v) => setFormat(v as MergeFormat)}
              options={[
                { label: "Markdown", value: "markdown" },
                { label: "Word (.docx)", value: "word" },
                { label: "HTML", value: "html" },
              ]}
            />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              保留目录结构时固定导出 Markdown；要 Word / HTML 请选「合并为单个文件」。
            </Typography.Text>
          )}
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="w-12 shrink-0 pt-0.5 text-right text-xs opacity-60">{label}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="pl-0 text-xs opacity-55" style={{ lineHeight: 1.6 }}>
      {children}
    </div>
  );
}
