import { useEffect, useState, useCallback } from "react";
import {
  Modal,
  Segmented,
  Form,
  Input,
  Button,
  message,
  List,
  Card,
  Spin,
  Empty,
  Typography,
  Space,
  Modal as ModalStatic,
} from "antd";
import { useNavigate } from "react-router-dom";
import {
  FileText,
  LayoutTemplate,
  FileUp,
  FileCode,
  FileType,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  noteApi,
  templateApi,
  importApi,
  pdfApi,
  sourceFileApi,
} from "@/lib/api";
import { importWordFiles } from "@/lib/wordImport";
import type { NoteTemplate } from "@/types";

type Mode = "blank" | "template" | "import";

interface Props {
  open: boolean;
  /** 当前查看的文件夹 id（创建时自动归入） */
  folderId?: number | null;
  onClose: () => void;
  /** 创建成功后回调（用于刷新列表） */
  onCreated?: () => void;
}

export function CreateNoteModal({ open, folderId = null, onClose, onCreated }: Props) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("blank");
  const [form] = Form.useForm<{ title: string; content?: string }>();

  // 模板态
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);

  // 打开 Modal 时切回"空白"，加载模板
  useEffect(() => {
    if (!open) return;
    setMode("blank");
    form.resetFields();
    (async () => {
      setTemplatesLoading(true);
      try {
        setTemplates(await templateApi.list());
      } catch (e) {
        message.error(`加载模板失败: ${e}`);
      } finally {
        setTemplatesLoading(false);
      }
    })();
  }, [open, form]);

  // ─── 创建：空白 ─────────────────────────
  const handleCreateBlank = useCallback(
    async (values: { title: string; content?: string }) => {
      try {
        const note = await noteApi.create({
          title: values.title,
          content: values.content || "",
          folder_id: folderId ?? null,
        });
        message.success("创建成功");
        onClose();
        onCreated?.();
        navigate(`/notes/${note.id}`);
      } catch (e) {
        message.error(String(e));
      }
    },
    [folderId, navigate, onClose, onCreated],
  );

  // ─── 创建：从模板 ───────────────────────
  const handleCreateFromTemplate = useCallback(
    async (template: NoteTemplate) => {
      try {
        const note = await noteApi.create({
          title: template.name,
          content: template.content,
          folder_id: folderId ?? null,
        });
        message.success("从模板创建成功");
        onClose();
        onCreated?.();
        navigate(`/notes/${note.id}`);
      } catch (e) {
        message.error(String(e));
      }
    },
    [folderId, navigate, onClose, onCreated],
  );

  // ─── 创建：导入 Markdown ───────────────
  const handleImportMarkdown = useCallback(async () => {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    const hide = message.loading(`正在导入 ${paths.length} 个 Markdown 文件...`, 0);
    try {
      const result = await importApi.importSelected(paths, folderId ?? null);
      hide();
      if (result.imported > 0) {
        message.success(
          `成功导入 ${result.imported} 篇` +
            (result.skipped > 0 ? `，跳过 ${result.skipped} 篇` : ""),
        );
      } else if (result.skipped > 0) {
        message.warning(`全部 ${result.skipped} 篇已跳过`);
      }
      if (result.errors.length > 0) {
        ModalStatic.warning({
          title: `${result.errors.length} 个文件导入失败`,
          content: (
            <List
              size="small"
              dataSource={result.errors}
              renderItem={(err) => (
                <List.Item>
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    {err}
                  </Typography.Text>
                </List.Item>
              )}
            />
          ),
        });
      }
      onClose();
      onCreated?.();
    } catch (e) {
      hide();
      message.error(`导入失败: ${e}`);
    }
  }, [folderId, onClose, onCreated]);

  // ─── 创建：导入 PDF ────────────────────
  const handleImportPdfs = useCallback(async () => {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    const hide = message.loading(`正在导入 ${paths.length} 个 PDF...`, 0);
    try {
      const results = await pdfApi.importPdfs(paths, folderId ?? null);
      const ok = results.filter((r) => r.noteId !== null);
      const fail = results.filter((r) => r.noteId === null);
      hide();
      if (ok.length > 0) message.success(`成功导入 ${ok.length} 个 PDF`);
      if (fail.length > 0) {
        ModalStatic.warning({
          title: `${fail.length} 个 PDF 导入失败`,
          content: (
            <List
              size="small"
              dataSource={fail}
              renderItem={(r) => (
                <List.Item>
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    {r.sourcePath.split(/[\\/]/).pop()}: {r.error}
                  </Typography.Text>
                </List.Item>
              )}
            />
          ),
        });
      }
      onClose();
      onCreated?.();
    } catch (e) {
      hide();
      message.error(`导入失败: ${e}`);
    }
  }, [folderId, onClose, onCreated]);

  // ─── 创建：导入 Word ───────────────────
  const handleImportWord = useCallback(async () => {
    const converter = await sourceFileApi
      .getConverterStatus()
      .catch(() => "none" as const);
    const exts = converter === "none" ? ["docx"] : ["docx", "doc"];
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "Word", extensions: exts }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    if (
      converter === "none" &&
      paths.some((p) => p.toLowerCase().endsWith(".doc"))
    ) {
      ModalStatic.warning({
        title: ".doc 暂不可用",
        content: "未检测到 LibreOffice 或 Microsoft Office / WPS。安装后可导入 .doc。",
      });
      return;
    }
    const hide = message.loading(`正在导入 ${paths.length} 个 Word 文件...`, 0);
    try {
      const results = await importWordFiles(paths, folderId ?? null);
      const ok = results.filter((r) => r.noteId !== null);
      const fail = results.filter((r) => r.noteId === null);
      hide();
      if (ok.length > 0) message.success(`成功导入 ${ok.length} 个 Word 文件`);
      if (fail.length > 0) {
        ModalStatic.warning({
          title: `${fail.length} 个 Word 文件导入失败`,
          content: (
            <List
              size="small"
              dataSource={fail}
              renderItem={(r) => (
                <List.Item>
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    {r.sourcePath.split(/[\\/]/).pop()}: {r.error}
                  </Typography.Text>
                </List.Item>
              )}
            />
          ),
        });
      }
      onClose();
      onCreated?.();
    } catch (e) {
      hide();
      message.error(`导入失败: ${e}`);
    }
  }, [folderId, onClose, onCreated]);

  // ─── 渲染 ──────────────────────────────
  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="新建笔记"
      width={620}
      footer={
        mode === "blank" ? (
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" onClick={() => form.submit()}>
              确定
            </Button>
          </Space>
        ) : null
      }
      destroyOnHidden
    >
      <Segmented<Mode>
        block
        value={mode}
        onChange={(v) => setMode(v as Mode)}
        options={[
          {
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                <FileText size={13} />空白笔记
              </span>
            ),
            value: "blank",
          },
          {
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                <LayoutTemplate size={13} />从模板
              </span>
            ),
            value: "template",
          },
          {
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                <FileUp size={13} />导入文件
              </span>
            ),
            value: "import",
          },
        ]}
        style={{ marginBottom: 16 }}
      />

      {/* 空白笔记 */}
      {mode === "blank" && (
        <Form form={form} layout="vertical" onFinish={handleCreateBlank}>
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: "请输入标题" }]}
          >
            <Input placeholder="输入笔记标题" autoFocus />
          </Form.Item>
          <Form.Item name="content" label="内容">
            <Input.TextArea
              placeholder="输入笔记内容（可选）"
              autoSize={{ minRows: 4, maxRows: 8 }}
            />
          </Form.Item>
        </Form>
      )}

      {/* 从模板 */}
      {mode === "template" && (
        <Spin spinning={templatesLoading}>
          {templates.length === 0 && !templatesLoading ? (
            <Empty description="暂无模板" />
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: 12,
                maxHeight: 400,
                overflowY: "auto",
              }}
            >
              {templates.map((tpl) => (
                <Card
                  key={tpl.id}
                  hoverable
                  size="small"
                  onClick={() => handleCreateFromTemplate(tpl)}
                >
                  <Card.Meta
                    title={tpl.name}
                    description={
                      <span style={{ fontSize: 12 }}>{tpl.description || "无描述"}</span>
                    }
                  />
                </Card>
              ))}
            </div>
          )}
        </Spin>
      )}

      {/* 导入文件 */}
      {mode === "import" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <ImportCard
            icon={<FileCode size={24} />}
            color="#08979C"
            title="导入 Markdown"
            desc=".md / .markdown，每个文件创建一篇笔记"
            onClick={handleImportMarkdown}
          />
          <ImportCard
            icon={<FileText size={24} />}
            color="#D4380D"
            title="导入 PDF"
            desc="抽取正文 + 保留原文件，每个 PDF 一篇笔记"
            onClick={handleImportPdfs}
          />
          <ImportCard
            icon={<FileType size={24} />}
            color="#1677FF"
            title="导入 Word"
            desc=".docx 直接转换；.doc 需装 Office / WPS"
            onClick={handleImportWord}
          />
        </div>
      )}
    </Modal>
  );
}

function ImportCard({
  icon,
  color,
  title,
  desc,
  onClick,
}: {
  icon: React.ReactNode;
  color: string;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <Card hoverable size="small" onClick={onClick} styles={{ body: { padding: 14 } }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ color, flexShrink: 0 }}>{icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{title}</div>
          <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>{desc}</div>
        </div>
      </div>
    </Card>
  );
}
