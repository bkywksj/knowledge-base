/**
 * 源码模式首次使用提示。
 *
 * 为什么需要：源码模式下 markdown 原文零解析，用户可以写任意 HTML；
 * 但**切回富文本模式并继续编辑**后，正文会经 Tiptap/ProseMirror schema 往返，
 * schema 不认的标签（`<kbd>` / `<audio>` / 自定义 class 的 div 等）会被丢弃。
 *
 * 这个损耗本来就存在（打开任何含此类 HTML 的笔记都会发生），源码模式只是让用户
 * 更容易**主动写出**这类内容，所以有必要说一次，免得辛苦排的版悄无声息地没了。
 *
 * 只弹一次（localStorage 标记），与 externalMdIntro 同策略。
 */
import { notification } from "antd";

const STORAGE_KEY = "source_mode_intro_seen_v1";

export function showSourceModeIntroOnce() {
  try {
    if (localStorage.getItem(STORAGE_KEY) === "1") return;
  } catch {
    // localStorage 不可用（极端情况）→ 跳过提示但不阻塞进入源码模式
    return;
  }
  notification.info({
    message: "已进入源码模式",
    description:
      "这里直接编辑 Markdown 原文，HTML 与 front-matter 原样保留。注意：切回富文本模式后继续编辑，富文本编辑器不支持的 HTML 标签会被规范化掉。只在源码模式里改则不受影响。",
    placement: "bottomRight",
    duration: 10,
  });
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // 写入失败也不影响（下次还会弹，可接受）
  }
}
