import { useEffect, useRef, useState, type MouseEvent } from "react";
import { App as AntdApp, Button, theme as antdTheme } from "antd";
import { Check, Copy } from "lucide-react";

interface Props {
  /**
   * 要复制的文本。传函数则**点击时才求值**（支持 async），
   * 用于「复制全部子任务」这种需要现拉最新数据的场景。
   */
  text: string | (() => string | Promise<string>);
  /** 悬停提示。全局 GlobalNativeTooltip 会把它升级成深色气泡 */
  title?: string;
  /** 复制成功的 toast 文案；传空串则不弹 toast，只靠图标变勾反馈 */
  successText?: string;
  iconSize?: number;
  className?: string;
}

/**
 * 通用「复制」图标按钮。
 *
 * 点击后图标短暂变 ✓（1.5s）给就地反馈 —— 密集列表里光靠顶部 toast
 * 看不出复制的是哪一条。按钮内部 stopPropagation，嵌在可点击的行/卡片里
 * 不会顺带触发父级的展开或进详情。
 */
export function CopyButton({
  text,
  title = "复制",
  successText = "已复制",
  iconSize = 13,
  className,
}: Props) {
  const { message } = AntdApp.useApp();
  const { token } = antdTheme.useToken();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  async function handleCopy(e: MouseEvent<HTMLElement>) {
    e.stopPropagation();
    try {
      const value = typeof text === "function" ? await text() : text;
      if (!value.trim()) {
        message.info("没有可复制的内容");
        return;
      }
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
      if (successText) message.success(successText);
    } catch (err) {
      message.error(`复制失败：${err}`);
    }
  }

  return (
    <Button
      type="text"
      size="small"
      className={className}
      onClick={handleCopy}
      title={title}
      icon={copied ? <Check size={iconSize} /> : <Copy size={iconSize} />}
      style={{
        flex: "none",
        color: copied ? token.colorSuccess : token.colorTextTertiary,
      }}
    />
  );
}
