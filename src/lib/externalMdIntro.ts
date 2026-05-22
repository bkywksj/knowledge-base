/**
 * Q-003：外部 .md 打开 UX 引导
 *
 * 用户反馈："不导入直接打开 .md 编辑保存后，关掉再从系统快捷菜单打开，没原来的保存信息"——
 * 实际后端 commit 51fee11 起已做"加入本地库 + 写回原文件"双向同步，但用户没收到任何说明，
 * 误以为编辑是"临时打开未保存到本地"。
 *
 * 修复策略：首次打开外部 .md 时弹一次 notification 说明行为；
 * 标记位 localStorage，永久不再重复（用户改主意可手动清理 localStorage 触发再弹一次）。
 */
import { notification } from "antd";

const STORAGE_KEY = "external_md_intro_seen_v1";

export function showExternalMdIntroOnce() {
  try {
    if (localStorage.getItem(STORAGE_KEY) === "1") return;
  } catch {
    // localStorage 不可用（极端情况）→ 跳过引导但不阻塞主流程
    return;
  }
  notification.info({
    message: "已加入本地知识库",
    description:
      "这条笔记已纳入应用数据库。编辑保存后会自动写回原 .md 文件，下次从系统打开同一文件会复用这条笔记，编辑内容不会丢。",
    placement: "bottomRight",
    duration: 8,
  });
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // 写入失败也不影响（下次还会弹，可接受）
  }
}
