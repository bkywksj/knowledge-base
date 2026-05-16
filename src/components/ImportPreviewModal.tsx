import { useMemo, useState } from "react";
import { Modal, Radio, Checkbox, Typography, List, Tag, Collapse, Tooltip } from "antd";
import { NotebookText, Folder as FolderIcon, AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";

import type { ImportConflictPolicy, ScannedFile } from "@/types";

const { Text } = Typography;

interface Props {
  open: boolean;
  /** 扫描到的所有文件（含分桶信息） */
  files: ScannedFile[];
  /** 扫描根路径（仅用于标题展示，如 "D:/笔记归档"） */
  rootPath: string;
  /** 默认是否勾选"保留原目录文件夹"。默认 false：直接导入子内容，不在目标下多包一层源根目录 */
  defaultPreserveRoot?: boolean;
  onCancel: () => void;
  /** 用户点击"开始导入"时回调，带上选择的 policy + preserveRoot */
  onConfirm: (opts: {
    policy: ImportConflictPolicy;
    preserveRoot: boolean;
  }) => void;
}

/**
 * 导入预览弹窗
 *
 * 展示扫描结果的三桶统计（全新 / 已导入过 / 可能重复），让用户选择
 * 冲突策略（跳过 / 创建副本），然后确认导入。
 */
export function ImportPreviewModal({
  open,
  files,
  rootPath,
  defaultPreserveRoot = false,
  onCancel,
  onConfirm,
}: Props) {
  const [policy, setPolicy] = useState<ImportConflictPolicy>("skip");
  const [preserveRoot, setPreserveRoot] = useState(defaultPreserveRoot);

  const stats = useMemo(() => {
    const news: ScannedFile[] = [];
    const paths: ScannedFile[] = [];
    const fuzzies: ScannedFile[] = [];
    for (const f of files) {
      if (f.match_kind === "path") paths.push(f);
      else if (f.match_kind === "fuzzy") fuzzies.push(f);
      else news.push(f);
    }
    return { news, paths, fuzzies };
  }, [files]);

  const conflictCount = stats.paths.length + stats.fuzzies.length;

  const rootName = rootPath.split(/[\\/]/).filter(Boolean).pop() ?? "导入";

  return (
    <Modal
      open={open}
      title="导入 Markdown"
      width={520}
      okText="开始导入"
      cancelText="取消"
      onCancel={onCancel}
      onOk={() => onConfirm({ policy, preserveRoot })}
      okButtonProps={{ disabled: files.length === 0 }}
    >
      <div className="text-[13px] leading-7">
        <div className="mb-3">
          扫描 <Text code>{rootPath}</Text> 完成
        </div>

        {/* T-009: OB 兼容能力告知卡 */}
        <div
          className="mb-3 px-3 py-2 rounded text-[12px] leading-[22px]"
          style={{
            background: "var(--color-bg-subtle, #f6f9ff)",
            border: "1px solid var(--color-border-subtle, #e0e7ff)",
          }}
        >
          <div className="flex items-center gap-1.5 font-medium mb-0.5">
            <Sparkles size={12} className="text-violet-500" />
            <span>已自动启用 Obsidian 仓库兼容</span>
          </div>
          <div className="opacity-75">
            跳过 <Text code style={{ fontSize: 11 }}>.obsidian</Text> /{" "}
            <Text code style={{ fontSize: 11 }}>.trash</Text> 等隐藏目录 · 解析
            笔记头部 <Text code style={{ fontSize: 11 }}>tags:</Text> 字段 +
            正文行内 <Text code style={{ fontSize: 11 }}>#标签</Text> 自动建标签
            （含嵌套 <Text code style={{ fontSize: 11 }}>#工作/周报</Text>）·
            复制 <Text code style={{ fontSize: 11 }}>attachments/</Text>{" "}
            <Text code style={{ fontSize: 11 }}>assets/</Text>{" "}
            <Text code style={{ fontSize: 11 }}>images/</Text> 里的图片 ·
            保留 <Text code style={{ fontSize: 11 }}>[[wiki-link]]</Text>{" "}
            （Ctrl+点击跳转）
          </div>
        </div>

        {/* 三桶统计 */}
        <div className="flex flex-col gap-1 mb-4 px-3 py-2 bg-[var(--color-bg-subtle,#fafafa)] rounded">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-emerald-500" />
            <span>全新</span>
            <strong className="ml-auto">{stats.news.length} 篇</strong>
          </div>
          <div className="flex items-center gap-2">
            <NotebookText size={14} className="text-sky-500" />
            <Tooltip title="这些文件按原路径匹配到了已有笔记（上次导入过）">
              <span>已导入过</span>
            </Tooltip>
            <strong className="ml-auto">{stats.paths.length} 篇</strong>
          </div>
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-500" />
            <Tooltip title="路径不同但标题+内容与已有笔记一致，可能是用户搬动过文件">
              <span>可能重复</span>
            </Tooltip>
            <strong className="ml-auto">{stats.fuzzies.length} 篇</strong>
          </div>
        </div>

        {/* 冲突策略 */}
        {conflictCount > 0 && (
          <div className="mb-3">
            <div className="mb-1.5 font-medium">遇到已存在的文件怎么办？</div>
            <Radio.Group
              value={policy}
              onChange={(e) => setPolicy(e.target.value as ImportConflictPolicy)}
            >
              <div className="flex flex-col gap-1">
                <Radio value="skip">
                  跳过
                  <Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                    （推荐）
                  </Text>
                </Radio>
                <Radio value="duplicate">
                  创建副本
                  <Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                    标题加 <Text code style={{ fontSize: 11 }}>(2)</Text> 新建
                  </Text>
                </Radio>
              </div>
            </Radio.Group>
            <div className="mt-2 text-xs text-[var(--color-text-tertiary,#9ca3af)]">
              需要覆盖现有笔记？请直接在应用内编辑 —— 避免误操作丢失数据。
            </div>
          </div>
        )}

        {/* 是否保留源根目录这一层 */}
        <div className="mb-2">
          <Checkbox
            checked={preserveRoot}
            onChange={(e) => setPreserveRoot(e.target.checked)}
          >
            <span>
              保留原目录文件夹
              <Text code style={{ fontSize: 11, margin: "0 4px" }}>
                {rootName}
              </Text>
              <Text type="secondary" style={{ marginLeft: 4, fontSize: 12 }}>
                勾选则在目标下多包一层；不勾选则直接导入其内部内容（子文件夹层级始终保留）
              </Text>
            </span>
          </Checkbox>
        </div>

        {/* 详细列表（折叠） */}
        {conflictCount > 0 && (
          <Collapse
            size="small"
            ghost
            items={[
              {
                key: "details",
                label: (
                  <span className="text-xs">
                    查看冲突明细（{conflictCount} 篇）
                  </span>
                ),
                children: (
                  <List
                    size="small"
                    dataSource={[...stats.paths, ...stats.fuzzies]}
                    style={{ maxHeight: 200, overflowY: "auto" }}
                    renderItem={(f) => (
                      <List.Item className="!py-1">
                        <div className="flex items-center gap-2 text-xs w-full min-w-0">
                          {f.match_kind === "path" ? (
                            <Tag color="blue" style={{ margin: 0, fontSize: 10 }}>
                              已导入
                            </Tag>
                          ) : (
                            <Tag color="gold" style={{ margin: 0, fontSize: 10 }}>
                              可能重复
                            </Tag>
                          )}
                          <span className="truncate flex-1" title={f.path}>
                            {f.relative_dir && (
                              <>
                                <FolderIcon
                                  size={11}
                                  className="inline mr-0.5 opacity-60"
                                />
                                <span className="opacity-60 mr-1">
                                  {f.relative_dir}/
                                </span>
                              </>
                            )}
                            {f.name}
                          </span>
                        </div>
                      </List.Item>
                    )}
                  />
                ),
              },
            ]}
          />
        )}
      </div>
    </Modal>
  );
}
