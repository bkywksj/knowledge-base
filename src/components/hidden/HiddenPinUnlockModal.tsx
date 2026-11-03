import { useEffect, useRef, useState } from "react";
import { Button, Modal, Input, Alert, message } from "antd";
import type { InputRef } from "antd";
import { Lock } from "lucide-react";
import { hiddenPinApi } from "@/lib/api";
import { useAppStore } from "@/store";

interface Props {
  open: boolean;
  /** 校验通过时回调（也会自动 markHiddenUnlocked + 关闭 Modal） */
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * 隐藏笔记 PIN 解锁弹窗。
 * 校验逻辑全在后端：错误次数限制、锁定提示都来自 invoke 抛出的字符串。
 */
export function HiddenPinUnlockModal({ open, onSuccess, onCancel }: Props) {
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(false);
  const inputRef = useRef<InputRef>(null);
  const markHiddenUnlocked = useAppStore((s) => s.markHiddenUnlocked);

  // 打开时自动聚焦 + 清空上次输入 + 拉提示
  useEffect(() => {
    if (open) {
      setPin("");
      setErrorMsg(null);
      setShowHint(false);
      // 等 Modal 渲染完再 focus（antd Modal 有动画）
      const t = setTimeout(() => inputRef.current?.focus(), 100);
      // 异步拉取提示，没有则什么也不显示
      hiddenPinApi
        .getHint()
        .then((h) => setHint(h && h.trim() ? h : null))
        .catch(() => setHint(null));
      return () => clearTimeout(t);
    }
  }, [open]);

  async function handleSubmit() {
    if (!pin.trim()) {
      setErrorMsg("请输入 PIN");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await hiddenPinApi.verify(pin);
      markHiddenUnlocked();
      message.success("已解锁");
      onSuccess();
    } catch (e) {
      setErrorMsg(String(e));
      setPin("");
      // 失败后重新聚焦方便重试
      setTimeout(() => inputRef.current?.focus(), 50);
    } finally {
      setSubmitting(false);
    }
  }

  // v4 原型 .modal：居中卡片 —— 锁图标块 · 标题 · 说明 · 大号 PIN 输入 · 取消 / 解锁。
  // PIN 长度 4~64 位不固定，不做原型的 4 个圆点格，改成居中加宽字距的密码框
  return (
    <Modal
      open={open}
      footer={null}
      closable={false}
      centered
      onCancel={onCancel}
      destroyOnHidden
      mask={{ closable: false }}
      width={400}
      className="kb-pin-modal"
    >
      <div className="kb-pin">
        <span className="kb-pin-ico">
          <Lock size={22} />
        </span>
        <h3>输入 PIN 解锁隐藏笔记</h3>
        <p>输入后 10 分钟内无需重复验证 · PIN 在 设置 → 隐藏笔记 PIN 中设置</p>
        <Input.Password
          ref={inputRef}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onPressEnter={handleSubmit}
          placeholder="请输入 PIN"
          autoComplete="off"
          maxLength={64}
          size="large"
          className="kb-pin-input"
        />
        {/* 密码提示：默认收起，点"忘记 PIN？"才展开，避免有人在屏幕旁瞥见 */}
        {hint && !showHint && (
          <a
            onClick={(e) => {
              e.preventDefault();
              setShowHint(true);
            }}
            className="kb-pin-hint-link"
          >
            忘记 PIN？查看提示
          </a>
        )}
        {hint && showHint && (
          <Alert
            type="info"
            showIcon
            style={{ width: "100%" }}
            message={<span style={{ fontSize: 13 }}>提示：{hint}</span>}
          />
        )}
        {errorMsg && <Alert type="error" message={errorMsg} showIcon style={{ width: "100%" }} />}
        <div className="kb-pin-actions">
          <Button size="large" onClick={onCancel}>
            取消
          </Button>
          <Button type="primary" size="large" loading={submitting} onClick={() => void handleSubmit()}>
            解锁
          </Button>
        </div>
      </div>
    </Modal>
  );
}
