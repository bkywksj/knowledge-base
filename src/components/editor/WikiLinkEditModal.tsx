/**
 * 「修改双链指向」弹窗 —— 右键双链 → 修改链接，换成另一篇笔记。
 *
 * 之前只能手动把 `[[旧标题]]` 逐字改成 `[[新标题]]`：既容易打错字，也拿不到 ID 锚点
 * （手敲出来的双链没有 `|123`，目标笔记一改名就断链）。这里选完直接写回
 * `[[新标题|新ID]]`，链接自带稳定锚点。
 */
import { useEffect, useRef, useState } from "react";
import { App as AntdApp, Modal, Select, Spin } from "antd";
import { linkApi } from "@/lib/api";
import type { WikiLinkSuggestItem } from "@/types";

interface Props {
  open: boolean;
  /** 当前双链的标题，用作搜索初值，让用户一眼看到自己在改哪条 */
  currentTitle: string;
  /** 选定新目标：回传标题与笔记 id，由调用方替换文档里的那段文本 */
  onSubmit: (title: string, id: number) => void;
  onCancel: () => void;
}

export function WikiLinkEditModal({
  open,
  currentTitle,
  onSubmit,
  onCancel,
}: Props) {
  const { message } = AntdApp.useApp();
  const [options, setOptions] = useState<WikiLinkSuggestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  // 防竞态：搜索是异步的，慢的请求可能后到，用序号丢弃过期结果
  const seqRef = useRef(0);

  async function search(keyword: string) {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const list = await linkApi.searchTargets(keyword, 20);
      if (seq !== seqRef.current) return; // 已有更新的搜索，丢弃本次
      setOptions(list);
    } catch (e) {
      if (seq === seqRef.current) message.error(`搜索笔记失败：${e}`);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }

  // 打开时用当前标题预搜一次，省得用户从零开始打字
  useEffect(() => {
    if (!open) return;
    setPicked(null);
    void search(currentTitle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentTitle]);

  function handleOk() {
    if (picked == null) {
      message.warning("请先选择要链接到的笔记");
      return;
    }
    const hit = options.find((o) => o.id === picked);
    if (!hit) {
      message.warning("所选笔记已失效，请重新搜索");
      return;
    }
    onSubmit(hit.title, hit.id);
  }

  return (
    <Modal
      open={open}
      title="修改双链指向"
      okText="替换"
      cancelText="取消"
      onOk={handleOk}
      onCancel={onCancel}
      destroyOnHidden
      width={520}
    >
      <div className="mb-2 text-sm text-[var(--ant-color-text-secondary)]">
        当前指向：<span className="font-medium">{currentTitle || "（空）"}</span>
      </div>
      <Select
        showSearch
        autoFocus
        className="w-full"
        placeholder="输入标题关键词搜索笔记"
        value={picked ?? undefined}
        onChange={(v: number) => setPicked(v)}
        onSearch={(v) => void search(v)}
        filterOption={false}
        notFoundContent={loading ? <Spin size="small" /> : "没有匹配的笔记"}
        options={options.map((o) => ({
          value: o.id,
          // 重名时用所在文件夹消歧，与 [[ 候选下拉口径一致
          label: o.folderName ? `${o.title} · ${o.folderName}` : o.title,
        }))}
      />
      <div className="mt-2 text-xs text-[var(--ant-color-text-quaternary)]">
        替换后会写成带 ID 锚点的形式，目标笔记以后改名也不会断链。
      </div>
    </Modal>
  );
}
