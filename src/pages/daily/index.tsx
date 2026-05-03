import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button,
  DatePicker,
  Input,
  Space,
  Divider,
  Badge,
  message,
  Spin,
  theme as antdTheme,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Save,
  Sparkles,
} from "lucide-react";
import { CloseCircleFilled } from "@ant-design/icons";
import { dailyApi, noteApi } from "@/lib/api";
import { MicButton } from "@/components/MicButton";
import { TiptapEditor } from "@/components/editor";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useAppStore } from "@/store";
import { useAllFeaturesEnabled } from "@/hooks/useFeatureEnabled";
import { PlanTodayModal } from "@/components/ai/PlanTodayModal";
import { NoteAiDrawer } from "@/components/ai/NoteAiDrawer";
import type { Note } from "@/types";


/** 格式化日期为中文显示 */
function formatDateCN(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 获取今天日期字符串 */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** HH:mm 格式化保存时间 */
function formatSavedAt(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function DailyPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // URL 是 date 的真相源；缺省时用今天，同时补写进 URL 让 SidePanel 高亮今天
  const urlDate = searchParams.get("date");
  const date = urlDate ?? todayStr();

  useEffect(() => {
    if (!urlDate) {
      navigate(`/daily?date=${todayStr()}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlDate]);

  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [showPlanModal, setShowPlanModal] = useState(false);
  // 与 notes/editor 一致：选段触发「问 AI」时打开伴生抽屉，把选段当引用挂上
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [aiSelection, setAiSelection] = useState<string | undefined>(undefined);
  // 相邻"真实存在"的日记日期（跳过空白日）；按当前 date 拉
  const [neighbors, setNeighbors] = useState<{ prev: string | null; next: string | null }>({
    prev: null,
    next: null,
  });
  // DatePicker 弹窗里"哪些天有日记"，按月缓存（key="YYYY-MM"）
  // 用 Map 而不是平铺 Set：避免跨月切换重复请求
  const [datesByMonth, setDatesByMonth] = useState<Map<string, Set<string>>>(
    () => new Map(),
  );
  // 正在加载的月份集合（去重并发请求；失败会从这里删除允许重试）
  const loadingMonthsRef = useRef<Set<string>>(new Set());
  const { token } = antdTheme.useToken();

  const isToday = date === todayStr();
  // "AI 规划今日"按钮依赖 ai + tasks 两个模块同时启用（按钮产物是任务，靠 AI 生成）
  const planTodayAvailable = useAllFeaturesEnabled(["ai", "tasks"]);

  // 让自动保存的 save 闭包能拿到最新 note / date
  const noteRef = useRef<Note | null>(note);
  noteRef.current = note;
  const dateRef = useRef(date);
  dateRef.current = date;

  const loadDaily = useCallback(async (d: string) => {
    setLoading(true);
    try {
      const n = await dailyApi.get(d);
      if (n) {
        setNote(n);
        setTitle(n.title);
        setContent(n.content);
      } else {
        // 该日期还没有日记，仅设置默认标题，不创建数据库记录
        setNote(null);
        setTitle(`${d} 的日记`);
        setContent("");
      }
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDaily(date);
  }, [date, loadDaily]);

  // 拉相邻日记日期：按真实存在的日记跳，跳过空白日
  useEffect(() => {
    let cancelled = false;
    dailyApi
      .getNeighbors(date)
      .then(([prev, next]) => {
        if (!cancelled) setNeighbors({ prev, next });
      })
      .catch(() => {
        if (!cancelled) setNeighbors({ prev: null, next: null });
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  /**
   * 加载某月有日记的日期集合（DatePicker 弹窗里的圆点标识）。
   * - 已加载 / 加载中 → 直接返回不重复请求
   * - 失败 → 从 loadingMonthsRef 里删除允许重试；不打扰用户（picker 仅缺圆点不影响选日）
   */
  const ensureMonthLoaded = useCallback(async (year: number, month: number) => {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (loadingMonthsRef.current.has(key)) return;
    loadingMonthsRef.current.add(key);
    try {
      const list = await dailyApi.listDates(year, month);
      setDatesByMonth((prev) => {
        const next = new Map(prev);
        next.set(key, new Set(list));
        return next;
      });
    } catch (e) {
      console.warn("[daily] listDates 失败:", e);
      loadingMonthsRef.current.delete(key);
    }
  }, []);

  // 当前 date 改变 → 预加载该月，让 picker 一打开就能看到圆点
  // 同时也加载相邻月份的日期数据（用户翻月时常会看上下月，预热避免延迟）
  useEffect(() => {
    const d = dayjs(date);
    void ensureMonthLoaded(d.year(), d.month() + 1);
    // SidePanel / 自动保存创建新日记 后 bumpNotesRefresh 会触发本组件重渲染，
    // 但缓存仍在；用 notesRefresh 作 effect 触发器在新建日记后强制 reload 当前月
  }, [date, ensureMonthLoaded]);

  // 当 SidePanel 提示「笔记列表需要刷新」时（自动保存新建了日记），
  // 清掉当前月份缓存让下一次 picker 打开重拉
  const notesRefreshTick = useAppStore((s) => s.notesRefreshTick);
  useEffect(() => {
    if (notesRefreshTick === 0) return; // 初始化跳过
    setDatesByMonth(new Map());
    loadingMonthsRef.current.clear();
    const d = dayjs(date);
    void ensureMonthLoaded(d.year(), d.month() + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesRefreshTick]);

  /**
   * 自动保存：内容变化后 1.2s 防抖入库。
   *
   * 创建策略：
   *  - 还没 DB 记录 & 内容为空 → 什么都不做（避免空草稿污染数据库）
   *  - 还没 DB 记录 & 内容非空 → getOrCreate 建记录再 update
   *  - 已有记录 → 直接 update（包括删到空，允许保存）
   */
  const autoSave = useAutoSave({
    value: { title, content },
    enabled: !loading,
    save: async ({ title: t, content: c }) => {
      const d = dateRef.current;
      let current = noteRef.current;
      if (!current) {
        if (c.trim().length === 0) return;
        current = await dailyApi.getOrCreate(d);
        setNote(current);
        noteRef.current = current;
        // 新建了一条日记 → 通知 SidePanel 重拉本月日期列表
        useAppStore.getState().bumpNotesRefresh();
      }
      await noteApi.update(current.id, { title: t, content: c });
    },
  });

  // Ctrl/Cmd + S → 立即保存（跳过防抖）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "s"
      ) {
        e.preventDefault();
        void autoSave.flush();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [autoSave]);

  // 切日期前先把当前日期未保存的内容落库，避免跨日期丢失
  async function goToDate(d: string) {
    await autoSave.flush();
    navigate(`/daily?date=${d}`);
  }

  function renderStatus() {
    switch (autoSave.status) {
      case "saving":
        return <Badge status="processing" text="保存中..." />;
      case "dirty":
        return <Badge status="warning" text="编辑中" />;
      case "saved":
        return (
          <Badge
            status="success"
            text={
              autoSave.lastSavedAt
                ? `已保存 ${formatSavedAt(autoSave.lastSavedAt)}`
                : "已保存"
            }
          />
        );
      case "error":
        return (
          <span
            className="cursor-pointer"
            style={{ color: "#ff4d4f", fontSize: 13 }}
            onClick={() => void autoSave.flush()}
            title={autoSave.error ?? ""}
          >
            ⚠ 保存失败，点击重试
          </span>
        );
      default:
        return null;
    }
  }

  return (
    <div className="editor-page">
      {/* 顶部工具栏 */}
      <div className="editor-topbar">
        <Space align="center">
          <Calendar size={18} />
          <span style={{ fontWeight: 600, fontSize: 15 }}>每日笔记</span>
          <Divider
            type="vertical"
            style={{ height: 18, margin: "0 8px" }}
          />
          <Button
            size="small"
            icon={<ChevronLeft size={14} />}
            // 跳到上一篇真实存在的日记，跳过空白日（更符合"翻日记本"直觉）
            onClick={() => neighbors.prev && goToDate(neighbors.prev)}
            disabled={!neighbors.prev}
            title={neighbors.prev ? `上一篇：${formatDateCN(neighbors.prev)}` : "没有更早的日记"}
          />
          <DatePicker
            value={dayjs(date)}
            onChange={(d) => d && goToDate(d.format("YYYY-MM-DD"))}
            allowClear={false}
            variant="borderless"
            size="small"
            format={(v) => formatDateCN(v.format("YYYY-MM-DD"))}
            // 未来日期不能选（日记是对过去/当下的记录）
            disabledDate={(d) => d.isAfter(dayjs().endOf("day"))}
            style={{ fontWeight: 600, padding: "0 4px" }}
            // 用户在日选模式下翻月 → 拉新月份的"有日记"日期集合
            onPanelChange={(d, mode) => {
              if (mode === "date") {
                void ensureMonthLoaded(d.year(), d.month() + 1);
              }
            }}
            // 给"有日记"的日期单元格加底部圆点（与 Apple Calendar / Notion 一致）
            cellRender={(current, info) => {
              if (info.type !== "date") return info.originNode;
              const d = current as Dayjs;
              const monthKey = d.format("YYYY-MM");
              const dateStr = d.format("YYYY-MM-DD");
              const hasDaily =
                datesByMonth.get(monthKey)?.has(dateStr) ?? false;
              if (!hasDaily) return info.originNode;
              return (
                // paddingBottom 撑开外层给圆点专属空间；不依赖负 bottom（被 cell 容器裁切风险）
                <div style={{ position: "relative", paddingBottom: 8 }}>
                  {info.originNode}
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: "50%",
                      bottom: 1,
                      transform: "translateX(-50%)",
                      width: 4,
                      height: 4,
                      borderRadius: "50%",
                      background: token.colorPrimary,
                      pointerEvents: "none",
                    }}
                  />
                </div>
              );
            }}
          />
          <Button
            size="small"
            icon={<ChevronRight size={14} />}
            onClick={() => neighbors.next && goToDate(neighbors.next)}
            disabled={!neighbors.next}
            title={neighbors.next ? `下一篇：${formatDateCN(neighbors.next)}` : "没有更晚的日记"}
          />
          {!isToday && (
            <Button size="small" onClick={() => goToDate(todayStr())}>
              今天
            </Button>
          )}
          {renderStatus()}
        </Space>
        <Space align="center">
          {isToday && planTodayAvailable && (
            <Button
              icon={<Sparkles size={14} />}
              onClick={() => setShowPlanModal(true)}
              title="AI 根据今日/昨日笔记 + 待办，给出 3~7 条今日建议"
            >
              AI 规划今日
            </Button>
          )}
          <Button
            type="primary"
            icon={<Save size={16} />}
            onClick={() => void autoSave.flush()}
            loading={autoSave.status === "saving"}
            disabled={
              autoSave.status === "saved" || autoSave.status === "idle"
            }
          >
            保存
          </Button>
        </Space>
      </div>

      <PlanTodayModal
        open={showPlanModal}
        onClose={() => setShowPlanModal(false)}
        onSaved={() => {
          // 有了新待办，刷一下侧边栏紧急待办计数
          useAppStore.getState().refreshTaskStats();
        }}
      />

      {/* 可滚动的编辑主体 */}
      <div className="editor-body">
        <div className="editor-content-area">
          {loading ? (
            <div className="flex items-center justify-center flex-1">
              <Spin size="large" />
            </div>
          ) : (
            <>
              {/* 标题：用 position:relative 父级 + 绝对定位 mic / clear 模拟 suffix。
                  不直接用 antd Input.suffix / allowClear——两者都会包一层
                  .ant-input-affix-wrapper 把 borderless 大标题撑成白底大框。 */}
              <div
                style={{ position: "relative", marginBottom: 12 }}
              >
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="日记标题"
                  variant="borderless"
                  className="editor-title"
                  style={{ paddingRight: 64 }}
                />
                <div
                  style={{
                    position: "absolute",
                    right: 4,
                    top: "50%",
                    transform: "translateY(-50%)",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {title && (
                    // 与 antd allowClear 视觉一致：CloseCircleFilled 灰色实心圆 ×，hover 加深
                    <CloseCircleFilled
                      onClick={() => setTitle("")}
                      title="清空"
                      style={{
                        cursor: "pointer",
                        fontSize: 14,
                        color: "rgba(0, 0, 0, 0.25)",
                        transition: "color 0.2s",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as unknown as HTMLElement).style.color =
                          "rgba(0, 0, 0, 0.45)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as unknown as HTMLElement).style.color =
                          "rgba(0, 0, 0, 0.25)";
                      }}
                    />
                  )}
                  <MicButton
                    stripTrailingPunctuation
                    onTranscribed={(text) =>
                      setTitle((prev) => (prev ? `${prev} ${text}` : text))
                    }
                  />
                </div>
              </div>

              {/* 内容编辑区 */}
              <TiptapEditor
                content={content}
                onChange={setContent}
                placeholder="写点什么..."
                noteId={note?.id}
                // 拖/粘贴图片 / 问 AI 时若日记还没创建，按需建档（无需用户手动"保存"）
                ensureNoteId={async () => {
                  const n = await ensureDailyNote();
                  return n.id;
                }}
                onAskAi={async (selected) => {
                  // 与 notes/editor.tsx 行为一致：选段挂到抽屉的"引用 chip"，
                  // 输入框留空给用户写问题。日记还没建档时先按 date 懒建。
                  try {
                    await ensureDailyNote();
                    setAiSelection(selected);
                    setAiDrawerOpen(true);
                  } catch (e) {
                    message.error(`打开 AI 失败：${e}`);
                  }
                }}
              />
            </>
          )}
        </div>
      </div>
      {/* 伴生 AI 抽屉：仅在日记 note 已存在时挂载（NoteAiDrawer 需要确切 noteId） */}
      {note && (
        <NoteAiDrawer
          noteId={note.id}
          open={aiDrawerOpen}
          onClose={() => setAiDrawerOpen(false)}
          pendingSelection={aiSelection}
        />
      )}
    </div>
  );

  /** 取或懒建当天日记（noteRef + state 双写，兼顾闭包内立即可见和 React 重渲染） */
  async function ensureDailyNote(): Promise<Note> {
    if (noteRef.current) return noteRef.current;
    const created = await dailyApi.getOrCreate(dateRef.current);
    setNote(created);
    noteRef.current = created;
    useAppStore.getState().bumpNotesRefresh();
    return created;
  }
}
