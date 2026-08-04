/**
 * 「临时文件」列表弹层。
 *
 * ## 为什么是弹层而不是侧栏树节点
 *
 * 临时笔记（`is_scratch=1`）**不属于文件夹体系** —— 不能拖进拖出、不参与排序、
 * 不参与「未分类」那套虚拟节点逻辑。硬塞进笔记树要接上拖拽落点 / 右键菜单 /
 * 排序等一整套触点，收益却只是"能翻到它"。
 *
 * 而实际使用频率也支持轻量方案：用户打开一份外部 .md 改完就走，
 * 偶尔才需要"我昨天那份临时文件哪去了"。一个按需拉起的列表正好。
 *
 * ## 能做什么
 *
 * - 点条目 → 跳转编辑（编辑器里有「转为正式笔记」的提示条）
 * - 转为正式笔记 → 清掉 is_scratch，立刻回到主列表 / 搜索 / 双链
 * - 显示原文件路径 —— 临时文件的身份就是"某个外部 .md"，路径比标题更能认出它
 */
import { useCallback, useEffect, useState } from "react";
import { Modal, List, Button, Empty, Typography, message, Tooltip, Pagination } from "antd";
import { FileText, BookOpen } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { noteApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Note } from "@/types";

const { Text } = Typography;

const PAGE_SIZE = 20;

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ScratchFilesModal({ open, onClose }: Props) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const r = await noteApi.listScratch(p, PAGE_SIZE);
      setItems(r.items);
      setTotal(r.total);
    } catch (e) {
      message.error(`加载临时文件失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // 每次打开都重拉：期间用户可能在别处新开了临时文件或把某条转正了
    setPage(1);
    void load(1);
  }, [open, load]);

  async function handleConvert(note: Note) {
    try {
      await noteApi.setScratch(note.id, false);
      message.success(`「${note.title || "未命名"}」已转为正式笔记`);
      // 主列表此前过滤掉了这条，转正后要让侧栏立刻能看到
      useAppStore.getState().bumpNotesRefresh();
      // 当前页可能因此空掉；停留在同一页重拉即可（后端会返回该页最新内容）
      void load(page);
    } catch (e) {
      message.error(`转换失败: ${e}`);
    }
  }

  function handleOpen(note: Note) {
    onClose();
    navigate(`/notes/${note.id}`);
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      title="临时文件"
      destroyOnHidden
    >
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          以「临时编辑」方式打开的外部 .md。改动照常保存回原文件，
          但不出现在笔记列表 / 搜索 / 双向链接中。
        </Text>
      </div>

      {!loading && items.length === 0 ? (
        <Empty
          description="还没有临时文件"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ padding: "24px 0" }}
        />
      ) : (
        <>
          <List
            loading={loading}
            dataSource={items}
            size="small"
            style={{ maxHeight: "50vh", overflow: "auto" }}
            renderItem={(note) => (
              <List.Item
                actions={[
                  <Tooltip
                    key="convert"
                    title="清除临时标记，让它回到笔记列表与搜索结果"
                  >
                    <Button
                      size="small"
                      type="link"
                      icon={<BookOpen size={13} />}
                      onClick={() => void handleConvert(note)}
                    >
                      转为正式笔记
                    </Button>
                  </Tooltip>,
                ]}
              >
                <List.Item.Meta
                  avatar={<FileText size={16} style={{ marginTop: 4, opacity: 0.6 }} />}
                  title={
                    <a onClick={() => handleOpen(note)}>{note.title || "未命名"}</a>
                  }
                  description={
                    <Text
                      type="secondary"
                      style={{ fontSize: 11, wordBreak: "break-all" }}
                    >
                      {/* 临时文件的身份是"某个外部 .md"，路径比标题更能认出它 */}
                      {note.source_file_path || "（已解除外部关联）"}
                    </Text>
                  }
                />
              </List.Item>
            )}
          />
          {total > PAGE_SIZE && (
            <div style={{ textAlign: "right", marginTop: 12 }}>
              <Pagination
                size="small"
                current={page}
                pageSize={PAGE_SIZE}
                total={total}
                showSizeChanger={false}
                onChange={(p) => {
                  setPage(p);
                  void load(p);
                }}
              />
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
