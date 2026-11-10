import { useEffect, useState } from "react";
import { Input, Modal } from "antd";

/**
 * 手机端单行输入弹窗：新建文件夹 / 重命名等。
 * 取代 window.prompt —— 系统弹框在安卓 WebView 里样式割裂，也没法预填、没法限长。
 * 空值不能提交；Enter 直接提交；打开时自动聚焦并全选预填内容。
 */
interface Props {
  open: boolean;
  title: string;
  initialValue?: string;
  placeholder?: string;
  okText?: string;
  maxLength?: number;
  onOk: (value: string) => Promise<void> | void;
  onClose: () => void;
}

export function TextPromptModal({ open, title, initialValue = "", placeholder, okText = "确定", maxLength = 100, onOk, onClose }: Props) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  async function submit() {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      await onOk(v);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      okText={okText}
      cancelText="取消"
      onOk={submit}
      onCancel={onClose}
      okButtonProps={{ disabled: !value.trim(), loading: busy }}
      destroyOnHidden
      centered
    >
      <Input
        autoFocus
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.target.select()}
        onPressEnter={submit}
        // 16px：iOS 输入框字号小于 16 会在聚焦时自动放大页面
        style={{ fontSize: 16 }}
      />
    </Modal>
  );
}
