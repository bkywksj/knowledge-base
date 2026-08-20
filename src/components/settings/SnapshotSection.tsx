/**
 * 历史版本用量与清理。
 *
 * 快照是"悄悄攒数据"的功能：每条笔记留最近 30 份，白板尤其大（一份几十 KB 起步），
 * 重度使用下库会稳步变大而用户看不见。这个区块给他一个交代 ——
 * 占了多少、是哪几条笔记占的、怎么清。
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Empty,
  InputNumber,
  List,
  Popconfirm,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
  App as AntdApp,
} from "antd";
import { History, RotateCcw, Trash2 } from "lucide-react";
import { snapshotApi } from "@/lib/api";
import type { SnapshotUsage } from "@/types";

const { Text } = Typography;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function SnapshotSection() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();

  const [usage, setUsage] = useState<SnapshotUsage | null>(null);
  const [loading, setLoading] = useState(false);
  /** 「只保留最近 N 天」的天数。30 天覆盖绝大多数"想找回上个月那版"的诉求 */
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsage(await snapshotApi.usage());
    } catch (e) {
      message.error(`读取历史版本用量失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 清理动作统一走这里：执行 → 报告删了多少 → 刷新用量 */
  const runClear = useCallback(
    async (fn: () => Promise<number>, label: string) => {
      try {
        const n = await fn();
        message.success(n > 0 ? `${label}：已清理 ${n} 份` : `${label}：没有可清理的`);
        await load();
      } catch (e) {
        message.error(`${label}失败: ${e}`);
      }
    },
    [message, load],
  );

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <History size={16} />
          历史版本
        </span>
      }
      extra={
        <Button
          size="small"
          icon={<RotateCcw size={14} />}
          onClick={() => void load()}
          loading={loading}
        >
          刷新
        </Button>
      }
      style={{ marginTop: 16 }}
    >
      <Text type="secondary" style={{ fontSize: 13 }}>
        保存笔记、白板自动保存、同步拉取覆盖本地之前，都会自动留一份旧内容，
        误删误改可以在笔记 / 白板页的「历史版本」里找回。每条笔记保留最近 30 份。
      </Text>

      {loading && !usage ? (
        <div className="flex justify-center py-6">
          <Spin />
        </div>
      ) : (
        <>
          <div className="flex gap-8 mt-4">
            <Statistic title="已保存版本" value={usage?.total_count ?? 0} suffix="份" />
            <Statistic
              title="占用空间"
              value={fmtBytes(usage?.total_bytes ?? 0)}
            />
          </div>

          {/* 占用最大的笔记：用户要清理时最想看的就是这几条 */}
          <div className="mt-4">
            <Text strong style={{ fontSize: 13 }}>
              占用最大的笔记
            </Text>
            {!usage || usage.top_notes.length === 0 ? (
              <Empty
                className="my-4"
                description="还没有历史版本"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : (
              <List
                size="small"
                className="mt-2"
                dataSource={usage.top_notes}
                renderItem={(item) => (
                  <List.Item
                    actions={[
                      <Popconfirm
                        key="clear"
                        title="清掉这条笔记的历史版本？"
                        description="只删历史版本，笔记本身不受影响。"
                        okText="清理"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() =>
                          void runClear(
                            () => snapshotApi.clearNote(item.note_id),
                            "清理该笔记",
                          )
                        }
                      >
                        <Button type="text" size="small" danger icon={<Trash2 size={14} />} />
                      </Popconfirm>,
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <a
                          onClick={() =>
                            navigate(
                              item.note_type === "whiteboard"
                                ? `/whiteboard/${item.note_id}`
                                : `/notes/${item.note_id}`,
                            )
                          }
                        >
                          {item.title || "未命名"}
                          {item.note_type === "whiteboard" && (
                            <Tag className="ml-2">白板</Tag>
                          )}
                        </a>
                      }
                      description={
                        <span style={{ fontSize: 12 }}>
                          {item.count} 份 · {fmtBytes(item.byte_size)}
                        </span>
                      }
                    />
                  </List.Item>
                )}
              />
            )}
          </div>

          <Space className="mt-4" wrap>
            <span style={{ fontSize: 13 }}>只保留最近</span>
            <InputNumber
              size="small"
              min={1}
              max={365}
              value={days}
              onChange={(v) => typeof v === "number" && setDays(v)}
              style={{ width: 72 }}
            />
            <span style={{ fontSize: 13 }}>天</span>
            <Popconfirm
              title={`清理 ${days} 天前的历史版本？`}
              description="所有笔记里更早的版本都会被删除，笔记本身不受影响。"
              okText="清理"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() =>
                void runClear(
                  () => snapshotApi.clearOlderThan(days),
                  `清理 ${days} 天前`,
                )
              }
            >
              <Button size="small">清理更早的</Button>
            </Popconfirm>

            <Popconfirm
              title="清空全部历史版本？"
              description="所有笔记与白板的历史版本都会删除且无法找回；笔记本身不受影响。"
              okText="全部清空"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void runClear(() => snapshotApi.clearAll(), "清空全部")}
            >
              <Button size="small" danger icon={<Trash2 size={14} />}>
                清空全部
              </Button>
            </Popconfirm>
          </Space>
        </>
      )}
    </Card>
  );
}
