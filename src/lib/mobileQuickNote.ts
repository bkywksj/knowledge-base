import { dailyApi, noteApi } from "@/lib/api";
import { escapeHtml } from "@/lib/quickNote";
import { todayYmd } from "@/lib/utils";

/**
 * 「快速记一笔」：追加到今天的日记末尾，每条带 `[HH:mm]` 时间戳。
 *
 * 写法与 PC 首页 handleQuickSaveNote 完全一致（`<p><strong>[HH:mm]</strong> 内容</p>`），
 * 两端记出来的日记格式相同，同步后互相看不出差别。今天还没有日记就先建一篇。
 * 手机端不带图片（PC 那边的粘贴图片入口手机上没有）。
 *
 * @returns 今天日记的 id（调用方可据此跳转）
 */
export async function appendQuickNoteToDaily(text: string): Promise<number> {
  const body = text.trim();
  if (!body) throw new Error("内容为空");
  const daily = await dailyApi.getOrCreate(todayYmd());
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const block = `<p><strong>[${hhmm}]</strong> ${escapeHtml(body).replace(/\n/g, "<br>")}</p>`;
  await noteApi.update(daily.id, {
    title: daily.title,
    content: (daily.content || "") + block,
    folder_id: daily.folder_id,
  });
  return daily.id;
}
