import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Table,
  Button,
  Input,
  Space,
  Typography,
  message,
  Modal,
  Form,
  Popconfirm,
  Tooltip,
  Card,
  Row,
  Col,
  Segmented,
  Tag,
  Timeline,
  Dropdown,
  List,
  Empty,
  Spin,
  theme as antdTheme,
} from "antd";
import {
  Plus,
  Search,
  Trash2,
  Archive,
  Edit3,
  Share,
  LayoutList,
  LayoutGrid,
  Clock,
  Pin,
  Calendar,
  FileText,
  LayoutTemplate,
  FileUp,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { noteApi, exportApi, templateApi, folderApi, pdfApi, sourceFileApi } from "@/lib/api";
import { importWordFiles } from "@/lib/wordImport";
import { stripHtml, relativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Note, NoteInput, NoteTemplate, PageResult, Folder } from "@/types";

const { Title, Text, Paragraph } = Typography;

type ViewMode = "list" | "card" | "timeline";

/** 将笔记按日期分组 */
function groupByDate(notes: Note[]): Map<string, Note[]> {
  const map = new Map<string, Note[]>();
  for (const note of notes) {
    const date = note.updated_at.slice(0, 10);
    if (!map.has(date)) map.set(date, []);
    map.get(date)!.push(note);
  }
  return map;
}

/** 格式化日期标签 */
function formatDateLabel(dateStr: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (dateStr === today) return "今天";
  if (dateStr === yesterday) return "昨天";
  return dateStr;
}

/** 笔记标签装饰（React.memo 避免重渲染） */
const NoteDecorators = ({ note, warningColor }: { note: Note; warningColor: string }) => (
  <span className="inline-flex items-center gap-1 ml-1">
    {note.is_pinned && <Pin size={11} style={{ color: warningColor }} />}
    {note.is_daily && (
      <Tag color="blue" style={{ fontSize: 10, lineHeight: "14px", padding: "0 3px", margin: 0 }}>
        日记
      </Tag>
    )}
  </span>
);

export default function NoteListPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token } = antdTheme.useToken();

  const [data, setData] = useState<PageResult<Note>>({
    items: [],
    total: 0,
    page: 1,
    page_size: 20,
  });
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState(searchParams.get("keyword") || "");
  const [createOpen, setCreateOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [form] = Form.useForm<NoteInput>();

  const folderId = searchParams.get("folder");

  // 文件夹 id → name 映射（用于显示目录列）
  const [folderMap, setFolderMap] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    folderApi.list().then((folders) => {
      const map = new Map<number, string>();
      function flatten(list: Folder[]) {
        for (const f of list) {
          map.set(f.id, f.name);
          if (f.children?.length) flatten(f.children);
        }
      }
      flatten(folders);
      setFolderMap(map);
    });
  }, []);

  useEffect(() => {
    loadNotes(1);
  }, [folderId]);

  useEffect(() => {
    const kw = searchParams.get("keyword");
    if (kw) {
      setKeyword(kw);
      loadNotes(1, kw);
    }
  }, [searchParams]);

  const loadNotes = useCallback(
    async (page: number, kw?: string) => {
      setLoading(true);
      try {
        const result = await noteApi.list({
          page,
          page_size: viewMode === "timeline" ? 50 : 20,
          keyword: (kw ?? keyword) || undefined,
          folder_id: folderId ? Number(folderId) : undefined,
        });
        setData(result);
      } catch (e) {
        message.error(String(e));
      } finally {
        setLoading(false);
      }
    },
    [viewMode, keyword, folderId],
  );

  const handleCreate = useCallback(
    async (values: NoteInput) => {
      try {
        // 如果当前正在查看某个文件夹，自动将新笔记归入该文件夹
        if (folderId) {
          values.folder_id = Number(folderId);
        }
        const note = await noteApi.create(values);
        message.success("创建成功");
        setCreateOpen(false);
        form.resetFields();
        navigate(`/notes/${note.id}`);
      } catch (e) {
        message.error(String(e));
      }
    },
    [form, navigate, folderId],
  );

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await noteApi.delete(id);
        message.success("删除成功");
        loadNotes(data.page);
      } catch (e) {
        message.error(String(e));
      }
    },
    [data.page, loadNotes],
  );

  const handleExport = useCallback(async (record: Note) => {
    const safeName = record.title.replace(/[/\\:*?"<>|]/g, "_").trim() || "未命名";
    const filePath = await save({
      defaultPath: `${safeName}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!filePath) return;
    try {
      await exportApi.exportSingle(record.id, filePath);
      message.success("导出成功");
    } catch (e) {
      message.error(`导出失败: ${e}`);
    }
  }, []);

  const handleTrashAll = useCallback(() => {
    Modal.confirm({
      title: "全部移到回收站",
      content: `将全部 ${data.total} 篇笔记移到回收站，可在回收站中恢复或彻底删除。`,
      okText: "确认移入回收站",
      cancelText: "取消",
      onOk: async () => {
        try {
          const count = await noteApi.trashAll();
          message.success(`已将 ${count} 篇笔记移到回收站`);
          loadNotes(1);
        } catch (e) {
          message.error(String(e));
        }
      },
    });
  }, [data.total, loadNotes]);

  const openTemplateModal = useCallback(async () => {
    setTemplateOpen(true);
    setTemplatesLoading(true);
    try {
      const list = await templateApi.list();
      setTemplates(list);
    } catch (e) {
      message.error(`加载模板失败: ${e}`);
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const handleImportWord = useCallback(async () => {
    // 先看转换器，决定是否允许 .doc
    const converter = await sourceFileApi.getConverterStatus().catch(() => "none" as const);
    const exts = converter === "none" ? ["docx"] : ["docx", "doc"];
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "Word", extensions: exts }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    if (converter === "none" && paths.some((p) => p.toLowerCase().endsWith(".doc"))) {
      Modal.warning({
        title: ".doc 暂不可用",
        content: "未检测到 LibreOffice 或 Microsoft Office / WPS。安装其一后可导入 .doc。",
      });
      return;
    }
    const hide = message.loading(`正在导入 ${paths.length} 个 Word 文件...`, 0);
    try {
      const results = await importWordFiles(paths);
      const ok = results.filter((r) => r.noteId !== null);
      const fail = results.filter((r) => r.noteId === null);
      hide();
      if (ok.length > 0) message.success(`成功导入 ${ok.length} 个 Word 文件`);
      if (fail.length > 0) {
        Modal.warning({
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
      loadNotes(1);
    } catch (e) {
      hide();
      message.error(`导入失败: ${e}`);
    }
  }, [loadNotes]);

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
      const results = await pdfApi.importPdfs(paths);
      const ok = results.filter((r) => r.noteId !== null);
      const fail = results.filter((r) => r.noteId === null);
      hide();
      if (ok.length > 0) message.success(`成功导入 ${ok.length} 个 PDF`);
      if (fail.length > 0) {
        Modal.warning({
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
      loadNotes(1);
    } catch (e) {
      hide();
      message.error(`导入失败: ${e}`);
    }
  }, [loadNotes]);

  const handleCreateFromTemplate = useCallback(
    async (template: NoteTemplate) => {
      try {
        const note = await noteApi.create({
          title: template.name,
          content: template.content,
          folder_id: folderId ? Number(folderId) : undefined,
        });
        message.success("从模板创建成功");
        setTemplateOpen(false);
        navigate(`/notes/${note.id}`);
      } catch (e) {
        message.error(String(e));
      }
    },
    [folderId, navigate],
  );

  const handleSearch = useCallback(() => {
    loadNotes(1, keyword);
  }, [loadNotes, keyword]);

  const handleTableChange = useCallback(
    (pagination: TablePaginationConfig) => {
      loadNotes(pagination.current ?? 1);
    },
    [loadNotes],
  );

  const handleViewChange = useCallback(
    (v: string) => {
      setViewMode(v as ViewMode);
      if (v === "timeline") {
        loadNotes(1);
      }
    },
    [loadNotes],
  );

  const columns: ColumnsType<Note> = useMemo(
    () => [
      {
        title: "标题",
        dataIndex: "title",
        key: "title",
        ellipsis: true,
        render: (title: string, record: Note) => (
          <span className="flex items-center">
            <a onClick={() => navigate(`/notes/${record.id}`)}>{title}</a>
            <NoteDecorators note={record} warningColor={token.colorWarning} />
          </span>
        ),
      },
      {
        title: "目录",
        dataIndex: "folder_id",
        key: "folder",
        width: 100,
        ellipsis: true,
        render: (fid: number | null) =>
          fid && folderMap.get(fid) ? (
            <a
              onClick={() => navigate(`/notes?folder=${fid}`)}
              style={{ fontSize: 12 }}
            >
              {folderMap.get(fid)}
            </a>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              —
            </Text>
          ),
      },
      {
        title: "字数",
        dataIndex: "word_count",
        key: "word_count",
        width: 70,
        render: (val: number) => (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {val}
          </Text>
        ),
      },
      {
        title: "更新时间",
        dataIndex: "updated_at",
        key: "updated_at",
        width: 110,
        render: (val: string) => (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {relativeTime(val)}
          </Text>
        ),
      },
      {
        title: "操作",
        key: "action",
        width: 120,
        render: (_: unknown, record: Note) => (
          <Space size="small">
            <Tooltip title="编辑">
              <Button
                type="link"
                size="small"
                icon={<Edit3 size={14} />}
                onClick={() => navigate(`/notes/${record.id}`)}
              />
            </Tooltip>
            <Tooltip title="导出">
              <Button
                type="link"
                size="small"
                icon={<Share size={14} />}
                onClick={() => handleExport(record)}
              />
            </Tooltip>
            <Popconfirm title="确认删除此笔记？" onConfirm={() => handleDelete(record.id)}>
              <Tooltip title="删除">
                <Button type="link" danger size="small" icon={<Trash2 size={14} />} />
              </Tooltip>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [navigate, token.colorWarning, handleDelete, handleExport, folderMap],
  );

  // 时间线分组（缓存）
  const dateGroups = useMemo(() => groupByDate(data.items), [data.items]);

  // ─── 虚拟滚动（卡片视图） ────────────────────
  // 将笔记按 3 列分行
  const cardRows = useMemo(() => {
    const rows: Note[][] = [];
    for (let i = 0; i < data.items.length; i += 3) {
      rows.push(data.items.slice(i, i + 3));
    }
    return rows;
  }, [data.items]);

  const cardContainerRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: cardRows.length,
    getScrollElement: () => cardContainerRef.current,
    estimateSize: () => 182, // 170 card + 12 gap
    overscan: 3,
  });

  return (
    <div className="max-w-4xl mx-auto">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <Title level={3} style={{ margin: 0, lineHeight: "32px" }}>
          笔记
        </Title>
        <Space align="center">
          <Segmented
            value={viewMode}
            onChange={handleViewChange}
            options={[
              { value: "list", icon: <LayoutList size={14} />, title: "列表" },
              { value: "card", icon: <LayoutGrid size={14} />, title: "卡片" },
              { value: "timeline", icon: <Clock size={14} />, title: "时间线" },
            ]}
            size="small"
          />
          {data.total > 0 && (
            <Button icon={<Archive size={14} />} onClick={handleTrashAll}>
              全部移到回收站
            </Button>
          )}
          <Dropdown
            menu={{
              items: [
                {
                  key: "blank",
                  icon: <FileText size={14} />,
                  label: "空白笔记",
                  onClick: () => setCreateOpen(true),
                },
                {
                  key: "template",
                  icon: <LayoutTemplate size={14} />,
                  label: "从模板创建",
                  onClick: openTemplateModal,
                },
                { type: "divider" },
                {
                  key: "import-pdf",
                  icon: <FileUp size={14} />,
                  label: "导入 PDF",
                  onClick: handleImportPdfs,
                },
                {
                  key: "import-word",
                  icon: <FileUp size={14} />,
                  label: "导入 Word (.docx / .doc)",
                  onClick: handleImportWord,
                },
              ],
            }}
          >
            <Button type="primary" icon={<Plus size={16} />}>
              新建笔记
            </Button>
          </Dropdown>
        </Space>
      </div>

      {/* 搜索栏 */}
      <Space.Compact className="mb-4" style={{ width: "100%" }}>
        <Input
          placeholder="搜索笔记标题..."
          prefix={<Search size={14} />}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={handleSearch}
          allowClear
        />
        <Button type="primary" onClick={handleSearch}>
          搜索
        </Button>
      </Space.Compact>

      {/* 列表视图 */}
      {viewMode === "list" && (
        <Table
          columns={columns}
          dataSource={data.items}
          rowKey="id"
          loading={loading}
          size="small"
          onChange={handleTableChange}
          pagination={{
            current: data.page,
            pageSize: data.page_size,
            total: data.total,
            showTotal: (total) => `共 ${total} 篇`,
            showSizeChanger: false,
          }}
        />
      )}

      {/* 卡片视图（虚拟滚动） */}
      {viewMode === "card" && (
        <>
          {loading ? (
            <Row gutter={[12, 12]}>
              {[1, 2, 3].map((i) => (
                <Col key={i} span={8}>
                  <Card loading style={{ height: 170 }} />
                </Col>
              ))}
            </Row>
          ) : data.items.length > 0 ? (
            <>
              <div
                ref={cardContainerRef}
                style={{
                  height: Math.min(cardRows.length * 182, 600),
                  overflow: "auto",
                }}
              >
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const row = cardRows[virtualRow.index];
                    return (
                      <div
                        key={virtualRow.key}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <Row gutter={[12, 12]}>
                          {row.map((note) => (
                            <Col key={note.id} xs={24} sm={12} md={8}>
                              <Card
                                hoverable
                                size="small"
                                onClick={() => navigate(`/notes/${note.id}`)}
                                style={{
                                  height: 170,
                                  display: "flex",
                                  flexDirection: "column",
                                  borderLeft: note.is_pinned
                                    ? `3px solid ${token.colorWarning}`
                                    : undefined,
                                }}
                                styles={{
                                  body: {
                                    flex: 1,
                                    overflow: "hidden",
                                    display: "flex",
                                    flexDirection: "column",
                                    padding: "10px 12px",
                                  },
                                }}
                              >
                                <div className="flex items-center gap-1 mb-1">
                                  <Title
                                    level={5}
                                    ellipsis
                                    style={{ marginBottom: 0, fontSize: 13, flex: 1 }}
                                  >
                                    {note.title}
                                  </Title>
                                  <NoteDecorators note={note} warningColor={token.colorWarning} />
                                </div>
                                <Paragraph
                                  type="secondary"
                                  ellipsis={{ rows: 3 }}
                                  style={{ fontSize: 11, flex: 1, marginBottom: 6 }}
                                >
                                  {stripHtml(note.content) || "暂无内容"}
                                </Paragraph>
                                <div className="flex items-center justify-between">
                                  <Text type="secondary" style={{ fontSize: 10 }}>
                                    {relativeTime(note.updated_at)}
                                    {note.word_count > 0 && ` · ${note.word_count} 字`}
                                  </Text>
                                  <Space size={0}>
                                    <Tooltip title="导出">
                                      <Button
                                        type="text"
                                        size="small"
                                        icon={<Share size={11} />}
                                        onClick={(e) => { e.stopPropagation(); handleExport(note); }}
                                        style={{ height: 20, width: 20, padding: 0 }}
                                      />
                                    </Tooltip>
                                    <Popconfirm
                                      title="确认删除？"
                                      onConfirm={(e) => {
                                        e?.stopPropagation();
                                        handleDelete(note.id);
                                      }}
                                    >
                                      <Tooltip title="删除">
                                        <Button
                                          type="text"
                                          danger
                                          size="small"
                                          icon={<Trash2 size={11} />}
                                          onClick={(e) => e.stopPropagation()}
                                          style={{ height: 20, width: 20, padding: 0 }}
                                        />
                                      </Tooltip>
                                    </Popconfirm>
                                  </Space>
                                </div>
                              </Card>
                            </Col>
                          ))}
                        </Row>
                      </div>
                    );
                  })}
                </div>
              </div>

              {data.total > data.page_size && (
                <div className="flex justify-center mt-4">
                  <Button disabled={data.page <= 1} onClick={() => loadNotes(data.page - 1)}>
                    上一页
                  </Button>
                  <Text className="mx-4" style={{ lineHeight: "32px" }}>
                    {data.page} / {Math.ceil(data.total / data.page_size)}
                  </Text>
                  <Button
                    disabled={data.page >= Math.ceil(data.total / data.page_size)}
                    onClick={() => loadNotes(data.page + 1)}
                  >
                    下一页
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState
              description="暂无笔记"
              actionText="创建第一篇笔记"
              onAction={() => setCreateOpen(true)}
            />
          )}
        </>
      )}

      {/* 时间线视图 */}
      {viewMode === "timeline" && (
        <>
          {loading ? (
            <Card loading style={{ height: 200 }} />
          ) : data.items.length > 0 ? (
            <div className="pl-2">
              {Array.from(dateGroups.entries()).map(([date, notes]) => (
                <div key={date} className="mb-5">
                  <div
                    className="flex items-center gap-2 mb-2 pb-1"
                    style={{
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                    }}
                  >
                    <Calendar size={13} style={{ color: token.colorPrimary }} />
                    <Text strong style={{ fontSize: 13, color: token.colorPrimary }}>
                      {formatDateLabel(date)}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {notes.length} 篇
                    </Text>
                  </div>
                  <Timeline
                    items={notes.map((note) => ({
                      color: note.is_pinned ? "gold" : note.is_daily ? "blue" : "gray",
                      children: (
                        <div
                          className="cursor-pointer group -mt-0.5"
                          onClick={() => navigate(`/notes/${note.id}`)}
                        >
                          <div className="flex items-center gap-1.5">
                            <Text
                              style={{ fontSize: 13 }}
                              className="group-hover:text-blue-500 transition-colors"
                            >
                              {note.title}
                            </Text>
                            <NoteDecorators note={note} warningColor={token.colorWarning} />
                            <Text
                              type="secondary"
                              style={{ fontSize: 10, marginLeft: "auto" }}
                            >
                              {note.updated_at.slice(11, 16)}
                            </Text>
                          </div>
                          {note.content && (
                            <Paragraph
                              type="secondary"
                              ellipsis={{ rows: 1 }}
                              style={{
                                fontSize: 11,
                                marginBottom: 0,
                                marginTop: 2,
                              }}
                            >
                              {stripHtml(note.content).slice(0, 100)}
                            </Paragraph>
                          )}
                        </div>
                      ),
                    }))}
                  />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              description="暂无笔记"
              actionText="创建第一篇笔记"
              onAction={() => setCreateOpen(true)}
            />
          )}
        </>
      )}

      {/* 新建笔记弹窗 */}
      <Modal
        title="新建笔记"
        open={createOpen}
        onCancel={() => {
          setCreateOpen(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: "请输入笔记标题" }]}
          >
            <Input placeholder="输入笔记标题" />
          </Form.Item>
          <Form.Item name="content" label="内容" initialValue="">
            <Input.TextArea rows={4} placeholder="输入笔记内容（可选）" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 模板选择弹窗 */}
      <Modal
        title="从模板创建笔记"
        open={templateOpen}
        onCancel={() => setTemplateOpen(false)}
        footer={null}
        width={500}
      >
        {templatesLoading ? (
          <div className="flex justify-center py-8">
            <Spin />
          </div>
        ) : templates.length > 0 ? (
          <List
            dataSource={templates}
            renderItem={(tpl) => (
              <List.Item
                className="cursor-pointer"
                style={{ padding: "10px 12px", borderRadius: 8 }}
                onClick={() => handleCreateFromTemplate(tpl)}
              >
                <List.Item.Meta
                  avatar={
                    <div
                      className="flex items-center justify-center rounded-lg"
                      style={{
                        width: 40,
                        height: 40,
                        background: token.colorPrimaryBg,
                      }}
                    >
                      <LayoutTemplate size={18} style={{ color: token.colorPrimary }} />
                    </div>
                  }
                  title={<span style={{ fontSize: 14 }}>{tpl.name}</span>}
                  description={
                    <span style={{ fontSize: 12 }}>{tpl.description || "无描述"}</span>
                  }
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty description="暂无模板，请在设置中添加" />
        )}
      </Modal>
    </div>
  );
}
