import { Card, Switch, Typography, theme as antdTheme } from "antd";
import {
  Calendar,
  CheckSquare,
  Layers,
  Tags,
  GitBranch,
  Bot,
  Sparkles,
  EyeOff,
  Boxes,
} from "lucide-react";
import { useAppStore, OPTIONAL_VIEWS, type ActiveView } from "@/store";

const { Text } = Typography;

interface ModuleMeta {
  view: ActiveView;
  label: string;
  desc: string;
  icon: React.ReactNode;
}

/**
 * 可选侧栏模块清单。顺序 = 设置页展示顺序。
 *
 * 与 store/OPTIONAL_VIEWS 保持一致；多/少都会触发开发期 console.warn 提示对齐。
 */
const MODULES: ModuleMeta[] = [
  {
    view: "daily",
    label: "每日笔记",
    desc: "按日期写日记 / 工作日志，自带月历与日期跳转",
    icon: <Calendar size={16} />,
  },
  {
    view: "tasks",
    label: "待办",
    desc: "任务管理、紧急提醒、重复任务、日历视图",
    icon: <CheckSquare size={16} />,
  },
  {
    view: "cards",
    label: "卡片复习",
    desc: "FSRS 间隔重复 / 闪卡 / 从批注一键转卡",
    icon: <Layers size={16} />,
  },
  {
    view: "tags",
    label: "标签",
    desc: "标签管理与跨笔记标签视图",
    icon: <Tags size={16} />,
  },
  {
    view: "graph",
    label: "知识图谱",
    desc: "可视化笔记之间的双向链接关系",
    icon: <GitBranch size={16} />,
  },
  {
    view: "ai",
    label: "AI 问答",
    desc: "和 AI 对话，让它读你的笔记给出建议",
    icon: <Bot size={16} />,
  },
  {
    view: "prompts",
    label: "提示词",
    desc: "管理常用 AI 提示词模板",
    icon: <Sparkles size={16} />,
  },
  {
    view: "hidden",
    label: "隐藏笔记",
    desc: "PIN 锁保护的私密笔记空间",
    icon: <EyeOff size={16} />,
  },
];

// 开发期对齐检查：MODULES 与 store.OPTIONAL_VIEWS 字段同步
if (import.meta.env.DEV) {
  const moduleViews = new Set(MODULES.map((m) => m.view));
  const missing = OPTIONAL_VIEWS.filter((v) => !moduleViews.has(v));
  const extra = MODULES.filter((m) => !OPTIONAL_VIEWS.includes(m.view)).map(
    (m) => m.view,
  );
  if (missing.length || extra.length) {
    console.warn(
      "[FeatureModulesSection] 与 store.OPTIONAL_VIEWS 不同步：",
      { missing, extra },
    );
  }
}

export function FeatureModulesSection() {
  const { token } = antdTheme.useToken();
  const enabledViews = useAppStore((s) => s.enabledViews);
  const toggleEnabledView = useAppStore((s) => s.toggleEnabledView);

  return (
    <Card
      id="settings-features"
      title={
        <span className="flex items-center gap-2">
          <Boxes size={16} />
          功能模块
        </span>
      }
    >
      <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
        关闭后侧栏入口隐藏，但功能本身和数据不会被删除——重新开启即可恢复。
        核心模块（首页 / 笔记 / 搜索 / 回收站 / 关于）始终启用，不可关闭。
      </Text>

      {MODULES.map((m, i) => {
        const checked = enabledViews.has(m.view);
        return (
          <div
            key={m.view}
            className="flex items-center justify-between py-2"
            style={{
              borderTop: i === 0 ? undefined : `1px solid ${token.colorBorderSecondary}`,
              paddingTop: i === 0 ? 4 : 12,
            }}
          >
            <div className="flex items-center gap-3">
              <span
                style={{
                  display: "inline-flex",
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: checked
                    ? `${token.colorPrimary}14`
                    : token.colorFillTertiary,
                  color: checked ? token.colorPrimary : token.colorTextTertiary,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {m.icon}
              </span>
              <div>
                <div style={{ fontWeight: 500 }}>{m.label}</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {m.desc}
                </Text>
              </div>
            </div>
            <Switch
              checked={checked}
              onChange={() => toggleEnabledView(m.view)}
            />
          </div>
        );
      })}
    </Card>
  );
}
