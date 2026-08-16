import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  PenLine,
  Layers,
  CheckSquare,
  FileText,
  Sparkles,
  CalendarDays,
  Zap,
  Plus,
  Pin,
} from "lucide-react";
import { systemApi, noteApi, taskApi, cardApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { DashboardStats, DailyWritingStat, Note, Task } from "@/types";
import { relativeTime } from "@/lib/utils";

/**
 * 移动端主页（设计稿：output/UI原型/2026-05-04_知识库移动端App/00-home.html）
 *
 * 内容（自上而下）：
 * 1. 问候 + 头像
 * 2. 4 数据卡（2x2 grid）：今日字数 / 待复习闪卡 / 今日待办 / 笔记总数
 * 3. 快速操作（4 列）：闪念 / 新建 / 今日笔记 / 问 AI
 * 4. 今日待办速览（最多 3 条 + 全部 →）
 * 5. 30 天写作热力图（按 word_count 5 档配色）
 * 6. 最近编辑（最多 2 条 + 全部 →）
 */

interface DashboardData {
  stats: DashboardStats | null;
  recentNotes: Note[];
  todayTasks: Task[];
  dueCardsCount: number;
  trend: DailyWritingStat[];
}

const GREETING_HOURS = [
  { until: 6, text: "夜深了" },
  { until: 11, text: "早上好" },
  { until: 13, text: "中午好" },
  { until: 18, text: "下午好" },
  { until: 24, text: "晚上好" },
];

function getGreeting(): string {
  const h = new Date().getHours();
  return GREETING_HOURS.find((g) => h < g.until)?.text ?? "你好";
}

export function MobileHome() {
  const navigate = useNavigate();
  const dashItems = useAppStore((s) => s.mobileDashboardItems);
  const showItem = (k: string) => dashItems.has(k as never);
  const [data, setData] = useState<DashboardData>({
    stats: null,
    recentNotes: [],
    todayTasks: [],
    dueCardsCount: 0,
    trend: [],
  });

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [stats, notesPage, tasks, dueCards, trend] = await Promise.all([
          systemApi.getDashboardStats(),
          noteApi.list({ page: 1, page_size: 2 }).catch(
            () => ({ items: [], total: 0, page: 1, page_size: 2 }),
          ),
          taskApi.list({ status: 0 }).catch(() => [] as Task[]),
          cardApi.listDue().catch(() => []),
          systemApi.getWritingTrend(30).catch(() => [] as DailyWritingStat[]),
        ]);
        if (!alive) return;
        setData({
          stats,
          recentNotes: notesPage.items ?? [],
          todayTasks: (tasks as Task[]).slice(0, 3),
          dueCardsCount: (dueCards as unknown[]).length,
          trend,
        });
      } catch (e) {
        console.error("[MobileHome] load failed:", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const stats = data.stats;
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} · ${
    ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][today.getDay()]
  }`;

  return (
    // 大屏（平板 / 折叠屏展开 / WSA 大窗口）限宽居中：
    // 不限宽时数据卡会被拉成横跨全屏的长条，一个「0」孤零零挂在最左边。
    <div className="mx-auto w-full max-w-[860px] px-0 py-0 text-slate-800">
      {/* 顶部问候 + 头像 */}
      <div className="flex items-center justify-between bg-white px-5 pt-4 pb-3">
        <div>
          <div className="text-xs text-slate-400">{dateStr}</div>
          <h1 className="mt-1 text-xl font-bold text-slate-900">
            {getGreeting()} ☀️
          </h1>
        </div>
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-[#1677FF] to-blue-700 text-white">
          🦊
        </div>
      </div>

      {/* 4 数据卡：手机 2x2，≥600dp 摊成一行 4 列 */}
      <div className="grid grid-cols-2 gap-2 px-4 pt-3 min-[600px]:grid-cols-4 min-[600px]:gap-3">
        {showItem("today_words") && (
          <button
            onClick={() => navigate("/daily")}
            className="flex flex-col items-start rounded-2xl bg-gradient-to-br from-[#1677FF] to-blue-700 p-4 text-white active:scale-[0.98] transition-transform"
          >
            <div className="flex items-center gap-1.5 text-xs opacity-90">
              <PenLine size={14} /> 今日字数
            </div>
            <div className="mt-1 text-2xl font-bold">{stats?.total_words ?? "—"}</div>
            <div className="mt-0.5 text-[10px] opacity-80">总字数</div>
          </button>
        )}

        {showItem("due_cards") && (
          <button
            onClick={() => navigate("/cards")}
            className="flex flex-col items-start rounded-2xl bg-gradient-to-br from-purple-500 to-purple-700 p-4 text-white active:scale-[0.98] transition-transform"
          >
            <div className="flex items-center gap-1.5 text-xs opacity-90">
              <Layers size={14} /> 待复习闪卡
            </div>
            <div className="mt-1 text-2xl font-bold">{data.dueCardsCount}</div>
            <div className="mt-0.5 text-[10px] opacity-80">
              {data.dueCardsCount > 0 ? "去复习" : "暂无待复习"}
            </div>
          </button>
        )}

        {showItem("today_tasks_card") && (
          <button
            onClick={() => navigate("/tasks")}
            className="flex flex-col items-start rounded-2xl border border-slate-200 bg-white p-4 active:scale-[0.98] transition-transform"
          >
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <CheckSquare size={14} /> 今日待办
            </div>
            <div className="mt-1 text-2xl font-bold text-slate-900">
              {data.todayTasks.length}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-400">待完成</div>
          </button>
        )}

        {showItem("total_notes") && (
          <button
            onClick={() => navigate("/notes")}
            className="flex flex-col items-start rounded-2xl border border-slate-200 bg-white p-4 active:scale-[0.98] transition-transform"
          >
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <FileText size={14} /> 笔记总数
            </div>
            <div className="mt-1 text-2xl font-bold text-slate-900">
              {stats?.total_notes ?? "—"}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-400">
              今日更新 {stats?.today_updated ?? 0}
            </div>
          </button>
        )}
      </div>

      {/* 快速操作 */}
      {showItem("quick_actions") && (
      <div className="px-4 pt-4">
        <div className="mb-2 px-1 text-xs font-medium text-slate-400">
          快速操作
        </div>
        <div className="grid grid-cols-4 gap-2 rounded-2xl bg-white p-3">
          <QuickAction
            icon={<Zap size={20} className="text-amber-600" />}
            bg="bg-amber-100"
            label="闪念"
            onClick={() => navigate("/notes")}
          />
          <QuickAction
            icon={<Plus size={20} className="text-[#1677FF]" />}
            bg="bg-blue-100"
            label="新建"
            onClick={() => navigate("/notes")}
          />
          <QuickAction
            icon={<CalendarDays size={20} className="text-green-600" />}
            bg="bg-green-100"
            label="今日笔记"
            onClick={() => navigate("/daily")}
          />
          <QuickAction
            icon={<Sparkles size={20} className="text-[#FA8C16]" />}
            bg="bg-orange-100"
            label="问 AI"
            onClick={() => navigate("/ai")}
          />
        </div>
      </div>
      )}

      {/* 今日待办速览 */}
      {showItem("today_tasks_list") && (
      <div className="px-4 pt-4">
        <div className="mb-2 flex items-center justify-between px-1 text-xs">
          <span className="font-medium text-slate-400">
            今日待办 · {data.todayTasks.length} 项
          </span>
          <button
            onClick={() => navigate("/tasks")}
            className="text-[#1677FF]"
          >
            全部 →
          </button>
        </div>
        {data.todayTasks.length === 0 ? (
          <EmptyHint
            icon={<CheckSquare size={20} className="text-slate-300" />}
            text="暂无待办，享受当下 ✨"
          />
        ) : (
          <div className="divide-y divide-slate-100 rounded-2xl bg-white">
            {data.todayTasks.map((task) => (
              <button
                key={task.id}
                onClick={() => navigate("/tasks")}
                className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-50"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded"
                  checked={task.status === 1}
                  readOnly
                />
                <span className="flex-1 truncate text-sm text-slate-800">
                  {task.title}
                </span>
                {task.due_date && (
                  <span className="text-[10px] font-medium text-orange-500">
                    {new Date(task.due_date).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      )}

      {/* 30 天写作热力图 */}
      {showItem("heatmap") && (
      <div className="px-4 pt-4">
        <div className="mb-2 flex items-center justify-between px-1 text-xs">
          <span className="font-medium text-slate-400">30 天写作</span>
          <span className="text-slate-400">
            共 {data.trend.reduce((s, d) => s + d.word_count, 0).toLocaleString()} 字
          </span>
        </div>
        <WritingHeatmap trend={data.trend} />
      </div>
      )}

      {/* 最近编辑 */}
      {showItem("recent_notes") && (
      <div className="px-4 pt-4 pb-6">
        <div className="mb-2 flex items-center justify-between px-1 text-xs">
          <span className="font-medium text-slate-400">最近编辑</span>
          <button
            onClick={() => navigate("/notes")}
            className="text-[#1677FF]"
          >
            全部 →
          </button>
        </div>
        {data.recentNotes.length === 0 ? (
          <EmptyHint
            icon={<FileText size={20} className="text-slate-300" />}
            text="还没有笔记，去新建一篇吧"
          />
        ) : (
          <div className="space-y-2">
            {data.recentNotes.map((note) => (
              <button
                key={note.id}
                onClick={() => navigate(`/notes/${note.id}`)}
                className="block w-full rounded-2xl bg-white p-3 text-left active:bg-slate-50"
              >
                <div className="flex items-start gap-2">
                  {note.is_pinned ? (
                    <Pin size={14} className="mt-1 text-amber-500" />
                  ) : (
                    <FileText size={14} className="mt-1 text-slate-400" />
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="truncate text-sm font-medium text-slate-900">
                      {note.title || "未命名笔记"}
                    </h3>
                    {note.content && (
                      <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">
                        {note.content.slice(0, 80)}
                      </p>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-400">
                    {relativeTime(note.updated_at)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function QuickAction({
  icon,
  bg,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  bg: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1.5 py-2 active:scale-95 transition-transform"
    >
      <div
        className={`flex h-11 w-11 items-center justify-center rounded-2xl ${bg}`}
      >
        {icon}
      </div>
      <span className="text-[11px] text-slate-700">{label}</span>
    </button>
  );
}

function EmptyHint({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl bg-white py-8 text-slate-400">
      {icon}
      <span className="text-xs">{text}</span>
    </div>
  );
}

/**
 * 30 天写作热力图（移动端紧凑版）。
 * 把每日字数按 5 档配色：0 / 1-99 / 100-299 / 300-799 / 800+
 * 周日开头，按日期升序铺；最多 5 周满布。
 */
function WritingHeatmap({ trend }: { trend: DailyWritingStat[] }) {
  // 生成最近 30 天的日期序列（含今天）。先把 trend 索引到 Map。
  const map = new Map<string, DailyWritingStat>();
  trend.forEach((t) => map.set(t.date, t));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days: { date: string; word_count: number; isToday: boolean }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    days.push({
      date: key,
      word_count: map.get(key)?.word_count ?? 0,
      isToday: i === 0,
    });
  }

  // 周日 = 0；前面补占位让首列对齐周
  const firstDayOfWeek = new Date(days[0].date).getDay();
  const cells: ({
    date: string;
    word_count: number;
    isToday: boolean;
  } | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
  cells.push(...days);

  return (
    // 限宽 360：格子是 aspect-square，容器一宽格子就等比膨胀成巨型色块。
    // 360 ≈ 手机上该容器的实际宽度，大屏格子尺寸因此与手机保持一致；
    // 手机视口本就窄于此，上限不生效。
    <div className="w-full max-w-[360px] rounded-2xl bg-white p-3">
      {/* 列标 */}
      <div className="mb-1.5 grid grid-cols-7 text-center text-[9px] text-slate-400">
        <div>日</div>
        <div>一</div>
        <div>二</div>
        <div>三</div>
        <div>四</div>
        <div>五</div>
        <div>六</div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((c, idx) => (
          <HeatCell key={idx} cell={c} />
        ))}
      </div>
      {/* 图例 */}
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-slate-400">
        <span>少</span>
        <div className="h-2.5 w-2.5 rounded-sm bg-slate-100" />
        <div className="h-2.5 w-2.5 rounded-sm bg-blue-100" />
        <div className="h-2.5 w-2.5 rounded-sm bg-blue-300" />
        <div className="h-2.5 w-2.5 rounded-sm bg-blue-500" />
        <div className="h-2.5 w-2.5 rounded-sm bg-blue-700" />
        <span>多</span>
      </div>
    </div>
  );
}

function HeatCell({
  cell,
}: {
  cell: { date: string; word_count: number; isToday: boolean } | null;
}) {
  if (!cell) {
    return <div className="aspect-square" />;
  }
  const w = cell.word_count;
  let bg = "bg-slate-100";
  if (w >= 800) bg = "bg-blue-700";
  else if (w >= 300) bg = "bg-blue-500";
  else if (w >= 100) bg = "bg-blue-300";
  else if (w > 0) bg = "bg-blue-100";
  const ring = cell.isToday ? "ring-2 ring-[#1677FF] ring-offset-1" : "";
  return (
    <div
      className={`aspect-square rounded-sm ${bg} ${ring}`}
      title={`${cell.date} · ${w} 字`}
    />
  );
}
