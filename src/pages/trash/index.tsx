import { useState, useEffect } from "react";
import {
  Table,
  Button,
  Typography,
  Space,
  Popconfirm,
  Modal,
  message,
} from "antd";
import { Trash2, RotateCcw, AlertTriangle } from "lucide-react";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { trashApi } from "@/lib/api";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Note, PageResult } from "@/types";

const { Title, Text } = Typography;

/** 相对时间格式化 */
function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  return dateStr.slice(0, 10);
}

export default function TrashPage() {
  const [data, setData] = useState<PageResult<Note>>({
    items: [],
    total: 0,
    page: 1,
    page_size: 20,
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadTrash(1);
  }, []);

  async function loadTrash(page: number) {
    setLoading(true);
    try {
      const result = await trashApi.list(page, 20);
      setData(result);
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleRestore(id: number) {
    try {
      await trashApi.restore(id);
      message.success("恢复成功");
      loadTrash(data.page);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handlePermanentDelete(id: number) {
    try {
      await trashApi.permanentDelete(id);
      message.success("已永久删除");
      loadTrash(data.page);
    } catch (e) {
      message.error(String(e));
    }
  }

  function handleEmptyTrash() {
    Modal.confirm({
      title: "清空回收站",
      icon: <AlertTriangle size={20} style={{ color: "#ff4d4f", marginRight: 8 }} />,
      content: "此操作将永久删除回收站中的所有笔记，且不可恢复。确定继续？",
      okText: "确认清空",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          const count = await trashApi.empty();
          message.success(`已清空 ${count} 篇笔记`);
          loadTrash(1);
        } catch (e) {
          message.error(String(e));
        }
      },
    });
  }

  function handleTableChange(pagination: TablePaginationConfig) {
    loadTrash(pagination.current ?? 1);
  }

  const columns: ColumnsType<Note> = [
    {
      title: "标题",
      dataIndex: "title",
      key: "title",
      ellipsis: true,
    },
    {
      title: "删除时间",
      dataIndex: "updated_at",
      key: "updated_at",
      width: 120,
      render: (val: string) => (
        <Text type="secondary" style={{ fontSize: 13 }}>
          {relativeTime(val)}
        </Text>
      ),
    },
    {
      title: "操作",
      key: "action",
      width: 160,
      render: (_: unknown, record: Note) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<RotateCcw size={14} />}
            onClick={() => handleRestore(record.id)}
          >
            恢复
          </Button>
          <Popconfirm
            title="确认永久删除？"
            description="此操作不可恢复"
            onConfirm={() => handlePermanentDelete(record.id)}
          >
            <Button type="link" danger size="small" icon={<Trash2 size={14} />}>
              永久删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="max-w-4xl mx-auto">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <Title level={3} style={{ margin: 0 }}>
          <span className="flex items-center gap-2">
            <Trash2 size={22} />
            回收站
          </span>
        </Title>
        {data.items.length > 0 && (
          <Button danger onClick={handleEmptyTrash}>
            清空回收站
          </Button>
        )}
      </div>

      {/* 表格 */}
      {data.total > 0 || loading ? (
        <>
          <Table
            columns={columns}
            dataSource={data.items}
            rowKey="id"
            loading={loading}
            onChange={handleTableChange}
            pagination={{
              current: data.page,
              pageSize: data.page_size,
              total: data.total,
              showTotal: (total) => `共 ${total} 篇`,
              showSizeChanger: false,
            }}
          />
          <div className="mt-2">
            <Text type="secondary" style={{ fontSize: 12 }}>
              提示: 回收站中的笔记将在30天后自动永久删除
            </Text>
          </div>
        </>
      ) : (
        <EmptyState description="回收站为空" />
      )}
    </div>
  );
}
