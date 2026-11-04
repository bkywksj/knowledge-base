import { useState } from "react";
import { Button, Dropdown, Space, App as AntdApp, type MenuProps } from "antd";
import type { SizeType } from "antd/es/config-provider/SizeContext";
import { CheckSquare, ChevronDown, Sparkles, Target } from "lucide-react";

import { CreateTaskModal } from "@/components/tasks/CreateTaskModal";
import { PlanTodayModal } from "@/components/ai/PlanTodayModal";
import { PlanFromGoalModal } from "@/components/ai/PlanFromGoalModal";
import { aiPlanApi } from "@/lib/api";
import { useAppStore } from "@/store";

interface Props {
  /** 块级占满父容器宽度（首页快捷操作大按钮用） */
  block?: boolean;
  /** 主按钮文字，默认"添加待办" */
  label?: string;
  /** 外层样式扩展 */
  style?: React.CSSProperties;
  /** 按钮尺寸（透传给内部 Button），默认 middle；首页大按钮用 large */
  size?: SizeType;
  /** 保存成功后回调（落库后宿主页可刷新列表/统计） */
  onSaved?: () => void;
  /** 外观：button = 分段按钮（默认）；tile = 首页快捷入口卡片（v4 原型 .qb），主区新建、右侧 ▼ 同一套 AI 入口 */
  variant?: "button" | "tile";
  /** tile 形态右侧的小字数据，如「今日 3 条」 */
  meta?: React.ReactNode;
}

/**
 * "+ 添加待办"分段按钮：主按钮直接弹 CreateTaskModal 加单条，
 * 右侧 ▼ 下拉承载"AI 规划今日 / AI 智能规划"两个 AI 入口。
 *
 * 与 NewNoteButton 同款交互。三个 Modal 内置在组件里，宿主只需挂一次。
 */
export function NewTodoButton({
  block = false,
  label = "添加待办",
  style,
  size,
  onSaved,
  variant = "button",
  meta,
}: Props) {
  const { message } = AntdApp.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [planTodayOpen, setPlanTodayOpen] = useState(false);
  const [planGoalOpen, setPlanGoalOpen] = useState(false);

  const refreshTaskStats = useAppStore((s) => s.refreshTaskStats);

  function handleSaved() {
    refreshTaskStats();
    onSaved?.();
  }

  /** AI 智能规划批量导入后弹撤销 toast（8 秒） */
  function handleGoalSaved(batchId: string, count: number) {
    handleSaved();
    if (!batchId) return;
    message.success({
      content: (
        <span>
          AI 智能规划：已导入 {count} 条待办{" "}
          <a
            style={{ marginLeft: 8 }}
            onClick={async () => {
              try {
                const removed = await aiPlanApi.undoBatch(batchId);
                message.info(`已撤销 ${removed} 条`);
                handleSaved();
              } catch (e) {
                message.error(`撤销失败: ${e}`);
              }
            }}
          >
            撤销整批
          </a>
        </span>
      ),
      duration: 8,
    });
  }

  const menuItems: MenuProps["items"] = [
    {
      key: "plan-today",
      label: "AI 规划今日",
      icon: <Sparkles size={14} />,
      onClick: () => setPlanTodayOpen(true),
    },
    {
      key: "plan-goal",
      label: "AI 智能规划（目标 / Excel）",
      icon: <Target size={14} />,
      onClick: () => setPlanGoalOpen(true),
    },
  ];

  const trigger =
    variant === "tile" ? (
      <div className="kb-qe">
        <button type="button" className="kb-qe-main" onClick={() => setCreateOpen(true)} title="新建一条待办">
          <span className="kb-qe-ico is-ok">
            <CheckSquare size={16} />
          </span>
          <span className="kb-qe-label">{label}</span>
          {meta != null && <span className="kb-qe-meta">{meta}</span>}
        </button>
        <Dropdown menu={{ items: menuItems }} trigger={["click"]} placement="bottomRight">
          <button type="button" className="kb-qe-caret" title="AI 规划入口">
            <ChevronDown size={14} />
          </button>
        </Dropdown>
      </div>
    ) : null;

  return (
    <>
      {trigger ?? (
      <Space.Compact className="kb-split" style={block ? { width: "100%", ...style } : style}>
        <Button
          type="primary"
          size={size}
          icon={<CheckSquare size={14} />}
          onClick={() => setCreateOpen(true)}
          title="新建一条待办"
          style={block ? { flex: 1 } : undefined}
        >
          {label}
        </Button>
        <Dropdown
          menu={{ items: menuItems }}
          trigger={["click"]}
          placement="bottomRight"
        >
          <Button
            type="primary"
            size={size}
            icon={<ChevronDown size={14} />}
            title="AI 规划入口"
          />
        </Dropdown>
      </Space.Compact>
      )}

      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          handleSaved();
        }}
      />
      <PlanTodayModal
        open={planTodayOpen}
        onClose={() => setPlanTodayOpen(false)}
        onSaved={() => handleSaved()}
      />
      <PlanFromGoalModal
        open={planGoalOpen}
        onClose={() => setPlanGoalOpen(false)}
        onSaved={handleGoalSaved}
      />
    </>
  );
}
