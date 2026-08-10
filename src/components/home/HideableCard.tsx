import type { ReactNode } from "react";
import { Card, Button, Tooltip, theme as antdTheme } from "antd";
import type { CardProps } from "antd";
import { Eye, EyeOff } from "lucide-react";
import {
  useHomeWidgetsStore,
  useWidgetBlurred,
  type HomeWidgetKey,
} from "@/store/homeWidgets";

interface Props extends Omit<CardProps, "extra"> {
  /** 持久化用的卡片标识 */
  widgetKey: HomeWidgetKey;
  /** 卡片右上角原有的操作（如「全部 →」）；眼睛按钮插在它左边 */
  extra?: ReactNode;
  children: ReactNode;
}

/**
 * 带「眼睛」开关的首页卡片。
 *
 * 隐藏时**既不塌陷也不留白**：内容原地保留、只叠一层 blur —— 卡片高度不变，
 * 页面布局不会因为遮住一张卡而整体跳动（这正是本项目要的效果，别改成 `display:none`
 * 或折叠，那会让右侧同排卡片的高度跟着抖）。
 *
 * ⚠️ 这是**防肩窥 / 防截图**，不是加密：DOM 里明文仍在，DevTools 能看到。
 * 真要锁内容请走应用锁（`initAppLock`）。
 */
export function HideableCard({ widgetKey, extra, children, ...cardProps }: Props) {
  const { token } = antdTheme.useToken();
  const blurred = useWidgetBlurred(widgetKey);
  const privacyMode = useHomeWidgetsStore((s) => s.privacyMode);
  const toggleBlur = useHomeWidgetsStore((s) => s.toggleBlur);

  // 隐私模式下单卡开关一律禁用：否则「全局遮住」和「这张卡显示」两个意图打架，
  // 用户点了没反应更困惑。禁用 + tooltip 指明退出方式，语义唯一。
  const eyeBtn = (
    <Tooltip
      title={
        privacyMode
          ? "隐私模式已开启（Ctrl/⌘+Shift+H 退出）"
          : blurred
            ? "显示内容"
            : "隐藏内容"
      }
      mouseEnterDelay={0.2}
    >
      {/* disabled 的 antd Button 不派发鼠标事件，Tooltip 要靠外层 span 才触发 */}
      <span style={{ display: "inline-flex" }}>
        <Button
          type="text"
          size="small"
          disabled={privacyMode}
          onClick={() => toggleBlur(widgetKey)}
          icon={blurred ? <EyeOff size={13} /> : <Eye size={13} />}
          style={{
            padding: "0 4px",
            height: 20,
            color: blurred ? token.colorPrimary : token.colorTextTertiary,
          }}
        />
      </span>
    </Tooltip>
  );

  return (
    <Card
      {...cardProps}
      extra={
        <div className="flex items-center gap-0.5">
          {eyeBtn}
          {extra}
        </div>
      }
    >
      <div
        style={{
          position: "relative",
          // blur 半径会让内容边缘往外洇，只在遮住时裁掉。
          // 常态绝不能加：待办卡内部还有滚动区，别给它多一层裁剪语义。
          overflow: blurred ? "hidden" : undefined,
        }}
      >
        <div
          aria-hidden={blurred}
          style={
            blurred
              ? {
                  filter: "blur(6px)",
                  opacity: 0.55,
                  // 必须屏蔽交互：否则会点中模糊层下面的笔记，直接跳走
                  pointerEvents: "none",
                  userSelect: "none",
                }
              : undefined
          }
        >
          {children}
        </div>
        {blurred && (
          // 明确的恢复入口。少了这层，持久化的隐藏状态在重启后会被当成「数据没了」
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ cursor: privacyMode ? "default" : "pointer" }}
            onClick={() => {
              if (!privacyMode) toggleBlur(widgetKey);
            }}
          >
            <span
              style={{
                fontSize: 12,
                padding: "4px 12px",
                borderRadius: 999,
                background: token.colorBgElevated,
                border: `1px solid ${token.colorBorderSecondary}`,
                color: token.colorTextSecondary,
                boxShadow: token.boxShadowTertiary,
                whiteSpace: "nowrap",
              }}
            >
              {privacyMode
                ? "隐私模式 · Ctrl/⌘+Shift+H 退出"
                : "内容已隐藏 · 点击显示"}
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}
