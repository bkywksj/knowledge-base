import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  List,
  Modal,
  Segmented,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
  theme as antdTheme,
} from "antd";
import { RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { inboxApi, pdfApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { InboxItem, InboxKind } from "@/types";

const { Text } = Typography;

/**
 * 各类失败项的展示名。
 *
 * 用中文而不是直接显示 `import_pdf` —— 这个页面是给用户看的。
 */
const KIND_LABEL: Record<InboxKind, string> = {
  import_pdf: "PDF 导入",
  import_word: "Word 导入",
  import_md: "文本导入",
  ocr: "文字识别",
  clip: "网页剪藏",
  dataset: "表格识别",
};

/**
 * 收件箱页面（P1-5）。
 *
 * 导入 / OCR / 剪藏失败的项在这里排队 —— 此前这些失败只在一个弹窗里活一次，
 * 用户关掉就永远找不回来了。
 *
 * 只列**待处理**项：重试成功或用户忽略后直接删行，
 * 所以"列表空了 = 都处理完了"，不需要额外的状态筛选。
 */
export default function InboxPage() {
  const { token } = antdTheme.useToken();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [kind, setKind] = useState<InboxKind | "all">("all");
  const [busyId, setBusyId] = useState<number | null>(null);
  const refreshInboxCount = useAppStore((s) => s.refreshInboxCount);

  const load = useCallback(async () => {
    try {
      setItems(await inboxApi.list());
      // 列表和侧栏徽章共用同一份数据源，一起刷新免得对不上
      await refreshInboxCount();
    } catch (e) {
      message.error(`读取收件箱失败: ${e}`);
      setItems([]);
    }
  }, [refreshInboxCount]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 当前筛选下要展示的条目 */
  const shown = useMemo(
    () => (items ?? []).filter((it) => kind === "all" || it.kind === kind),
    [items, kind],
  );

  /** 每种类型各有多少条 —— 直接从已加载的列表算，不用再请求一次 */
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items ?? []) m.set(it.kind, (m.get(it.kind) ?? 0) + 1);
    return m;
  }, [items]);

  // 筛选到某类型后把它处理完 → 该类型消失，筛选器却还停在上面，
  // 列表就白白显示成空的。自动退回"全部"。
  useEffect(() => {
    if (kind !== "all" && !counts.has(kind)) setKind("all");
  }, [counts, kind]);

  /**
   * 重试一条。
   *
   * 重试动作按 kind 分派：收件箱本身不认识每种失败类型，
   * 靠 `detailJson` 还原上下文后调对应的原有 API（见 inboxApi 注释）。
   * 成功才移除该条 —— 失败的话保留在列表里，用户可以再试或忽略。
   */
  async function handleRetry(item: InboxItem) {
    setBusyId(item.id);
    try {
      const detail = item.detailJson
        ? (JSON.parse(item.detailJson) as { folderId?: number | null })
        : {};

      let ok = false;
      switch (item.kind) {
        case "import_pdf": {
          // 重试时启用 OCR：能走到收件箱的多半是首轮无文字层失败的扫描件
          const r = await pdfApi.importPdfs(
            [item.source],
            detail.folderId ?? null,
            true,
          );
          ok = r.some((x) => x.noteId != null);
          if (!ok) {
            message.warning(`仍然失败：${r[0]?.error ?? "未知原因"}`);
          }
          break;
        }
        default:
          message.info("这类失败暂不支持一键重试，请手动重新操作后忽略此条");
          return;
      }

      if (ok) {
        await inboxApi.remove(item.id);
        message.success("重试成功，已移出收件箱");
        useAppStore.getState().bumpNotesRefresh();
        await load();
      }
    } catch (e) {
      message.error(`重试失败: ${e}`);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDismiss(item: InboxItem) {
    try {
      await inboxApi.remove(item.id);
      await load();
    } catch (e) {
      message.error(`忽略失败: ${e}`);
    }
  }

  function handleClear() {
    const scope = kind === "all" ? "全部" : KIND_LABEL[kind];
    Modal.confirm({
      title: `清空${scope}待处理项？`,
      content: "只是从收件箱移除这些记录，不会删除任何文件或笔记。",
      okText: "清空",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        await inboxApi.clear(kind === "all" ? undefined : kind);
        await load();
        message.success("已清空");
      },
    });
  }

  if (items === null) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: 240 }}>
        <Spin tip="正在读取收件箱..." />
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <Text strong style={{ fontSize: 16 }}>
            收件箱
          </Text>
          <Text type="secondary" className="ml-2" style={{ fontSize: 12 }}>
            导入 / 识别 / 剪藏失败的项在这里排队，可重试或忽略
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="small"
            type="text"
            icon={<RefreshCw size={14} />}
            onClick={load}
            title="重新读取"
          />
          {items.length > 0 && (
            <Button
              size="small"
              type="text"
              danger
              icon={<Trash2 size={14} />}
              onClick={handleClear}
            >
              清空
            </Button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span className="text-xs">
              收件箱是空的
              <br />
              导入或剪藏失败时，失败项会自动出现在这里
            </span>
          }
        />
      ) : (
        <>
          {/* 类型多于一种时才显示筛选，单一类型加个筛选器纯属噪声 */}
          {counts.size > 1 && (
            <Segmented
              size="small"
              className="mb-3"
              value={kind}
              onChange={(v) => setKind(v as InboxKind | "all")}
              options={[
                { value: "all", label: `全部 ${items.length}` },
                ...[...counts.entries()].map(([k, n]) => ({
                  value: k,
                  label: `${KIND_LABEL[k as InboxKind] ?? k} ${n}`,
                })),
              ]}
            />
          )}

          <List
            size="small"
            bordered
            dataSource={shown}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Button
                    key="retry"
                    size="small"
                    type="link"
                    icon={<RotateCcw size={13} />}
                    loading={busyId === item.id}
                    onClick={() => handleRetry(item)}
                  >
                    重试
                  </Button>,
                  <Tooltip key="dismiss" title="从收件箱移除（不删文件）">
                    <Button
                      size="small"
                      type="text"
                      icon={<X size={13} />}
                      onClick={() => handleDismiss(item)}
                    />
                  </Tooltip>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <span className="flex items-center gap-2">
                      <Tag style={{ fontSize: 10, marginInlineEnd: 0 }}>
                        {KIND_LABEL[item.kind] ?? item.kind}
                      </Tag>
                      <span style={{ fontSize: 13 }}>
                        {item.title || item.source.split(/[\\/]/).pop()}
                      </span>
                      {/* 失败过多次说明不是偶发问题，值得让用户注意 */}
                      {item.retryCount > 0 && (
                        <Tooltip title={`这个来源已失败 ${item.retryCount + 1} 次`}>
                          <Tag color="orange" style={{ fontSize: 10, marginInlineEnd: 0 }}>
                            × {item.retryCount + 1}
                          </Tag>
                        </Tooltip>
                      )}
                    </span>
                  }
                  description={
                    <span style={{ fontSize: 12, color: token.colorTextTertiary }}>
                      <span style={{ color: token.colorError }}>{item.reason}</span>
                      <br />
                      <Tooltip title={item.source}>
                        <span className="truncate inline-block max-w-full">
                          {item.source}
                        </span>
                      </Tooltip>
                    </span>
                  }
                />
              </List.Item>
            )}
          />
        </>
      )}
    </div>
  );
}
