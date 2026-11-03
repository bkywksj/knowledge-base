import { useEffect, useRef, useState } from "react";
import { Input, Button, Alert, theme as antdTheme } from "antd";
import type { InputRef } from "antd";
import { Lock, ShieldCheck } from "lucide-react";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { appLockApi } from "@/lib/api";
import { useAppStore } from "@/store";
import { WindowControls } from "@/components/layout/WindowControls";

// macOS 用系统 overlay 红黄绿按钮（见 AppLayout 同款判断），不自绘 WindowControls，
// 仅留出左侧拖拽区即可。非 Mac 自绘最小化/最大化/关闭，避免无边框窗口锁屏时无法操作。
const IS_MAC =
  typeof navigator !== "undefined" && /Mac OS X|Macintosh/.test(navigator.userAgent);

/**
 * 应用启动锁 —— 全屏锁屏页（软锁 / 全局进入密码）。
 *
 * 由 AppLockGate 在 appLocked 时整页替换主内容渲染，因此笔记内容根本不进 DOM，
 * 真正"挡顺手翻"。校验逻辑全在后端：错误次数限制、锁定冷却提示都来自 invoke 抛出的字符串。
 *
 * 窗口是无边框（decorations:false），所以这里必须自带：
 * - 顶部 data-tauri-drag-region 拖拽条（锁屏时也能挪动窗口）
 * - WindowControls（忘记密码时仍能最小化 / 关闭窗口，不至于卡死）
 */
export function AppLockScreen() {
  const { token } = antdTheme.useToken();
  const unlockApp = useAppStore((s) => s.unlockApp);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(false);
  /** 闲置自动锁定分钟数：0 = 没开，底部那行说明就不显示 */
  const [autoMinutes, setAutoMinutes] = useState(0);
  const inputRef = useRef<InputRef>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    appLockApi
      .getHint()
      .then((h) => setHint(h && h.trim() ? h : null))
      .catch(() => setHint(null));
    appLockApi
      .status()
      .then((st) => setAutoMinutes(st.autoLockMinutes ?? 0))
      .catch(() => setAutoMinutes(0));
    return () => clearTimeout(t);
  }, []);

  async function handleSubmit() {
    if (!password.trim()) {
      setErrorMsg("请输入进入密码");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await appLockApi.verify(password);
      setPassword("");
      unlockApp();
    } catch (e) {
      setErrorMsg(String(e));
      setPassword("");
      setTimeout(() => inputRef.current?.focus(), 50);
    } finally {
      setSubmitting(false);
    }
  }

  // v4 原型 lock：渐变底 · 品牌 Logo · 「Knowledge Base 已锁定」· 带锁图标的密码框 · 渐变解锁 · 自动锁定说明
  return (
    <div className="kb-lock">
      {/* 顶部可拖拽条 + 窗口控制（无边框窗口锁屏时仍可移动/关闭） */}
      <div
        data-tauri-drag-region
        className="kb-lock-drag"
        style={{ paddingLeft: IS_MAC ? 80 : 12 }}
      >
        {!IS_MAC && <WindowControls />}
      </div>

      {/* 居中解锁卡片 */}
      <div className="kb-lock-center">
        <div className="kb-lock-box">
          <span className="kb-lock-logo">
            <BrandLogo size={88} />
          </span>
          <h2>Knowledge Base 已锁定</h2>
          <p>输入密码解锁</p>

          <Input.Password
            ref={inputRef}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onPressEnter={handleSubmit}
            placeholder="请输入进入密码"
            autoComplete="off"
            maxLength={64}
            size="large"
            disabled={submitting}
            prefix={<Lock size={15} style={{ color: token.colorTextTertiary }} />}
            className="kb-lock-input"
          />

          <Button
            type="primary"
            block
            size="large"
            loading={submitting}
            onClick={handleSubmit}
            className="kb-lock-btn"
          >
            解锁
          </Button>

          {autoMinutes > 0 && (
            <div className="kb-lock-foot">
              <ShieldCheck size={13} />
              闲置 {autoMinutes} 分钟自动锁定 · 可在设置中修改
            </div>
          )}

          {/* 密码提示：默认收起，点"忘记密码？"才展开，避免旁人瞥见 */}
          {hint && !showHint && (
            <a
              onClick={(e) => {
                e.preventDefault();
                setShowHint(true);
              }}
              style={{ fontSize: 12, alignSelf: "center" }}
            >
              忘记密码？查看提示
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
          {errorMsg && (
            <Alert type="error" showIcon style={{ width: "100%" }} message={errorMsg} />
          )}
        </div>
      </div>
    </div>
  );
}
