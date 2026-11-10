/**
 * 手机端插入面板（v4 原型第 05 屏）的分组清单。
 *
 * 插入项本身与 PC 斜杠命令同一份（buildSlashCommandItems），这里只决定「放在哪个分组、格子里叫什么」。
 * 斜杠清单以后新增的项如果没登记到任何分组，单测会报错 —— 防止 PC 加了功能手机上悄悄缺一块。
 *
 * 手机额外项（不在斜杠清单里）：
 * - camera：拍照插图（<input capture>）
 * - attachment：插入附件（PC 在工具栏里，斜杠清单没有）
 * - link：插入链接（同上）
 */

export type MobileInsertGroupKey = "common" | "format" | "block" | "media" | "dataview" | "date";

export interface MobileInsertEntry {
  /** 斜杠命令 key，或手机额外项 key（camera / attachment / link） */
  key: string;
  /** 格子里的短标签；不填用斜杠项标题 */
  label?: string;
}

export interface MobileInsertGroup {
  key: MobileInsertGroupKey;
  label: string;
  entries: MobileInsertEntry[];
}

/** 不在斜杠清单里、由手机编辑页自己实现的插入项 */
export const MOBILE_EXTRA_INSERT_KEYS = ["camera", "attachment", "link"] as const;

/** 斜杠项标题在 4 列格子里放不下时的短名（各分组共用） */
const SHORT: Record<string, string> = {
  wikiLink: "双链笔记",
  mermaid: "流程图",
  video: "本地视频",
  embedVideo: "网络视频",
  "date-today-weekday": "今天+星期",
  "dataview-recent-notes": "最近笔记",
  "dataview-pending-tasks": "未完成任务",
  "dataview-notes-by-tag": "按标签筛笔记",
  "dataview-tasks-by-project": "项目下任务",
};

const e = (key: string, label?: string): MobileInsertEntry => ({ key, label: label ?? SHORT[key] });

export const MOBILE_INSERT_GROUPS: MobileInsertGroup[] = [
  {
    key: "common",
    label: "常用",
    // 与原型 05 屏的 12 格一致
    entries: [
      e("image"),
      e("camera", "拍照"),
      e("table"),
      e("codeBlock"),
      e("wikiLink"),
      e("callout-info", "提示框"),
      e("taskList"),
      e("hr"),
      e("blockMath", "公式"),
      e("mermaid"),
      e("attachment", "附件"),
      e("date-time"),
    ],
  },
  {
    key: "format",
    label: "格式",
    entries: [
      e("paragraph"),
      e("h1"),
      e("h2"),
      e("h3"),
      e("h4"),
      e("blockquote"),
      e("bulletList"),
      e("orderedList"),
      e("taskList"),
      e("link", "链接"),
    ],
  },
  {
    key: "block",
    label: "块",
    entries: [
      e("codeBlock"),
      e("table"),
      e("callout-info"),
      e("callout-tip"),
      e("callout-warning"),
      e("callout-danger"),
      e("toggle"),
      e("columns-2"),
      e("columns-3"),
      e("columns-4"),
      e("blockMath"),
      e("inlineMath"),
      e("mermaid"),
      e("whiteboard"),
      e("hr"),
    ],
  },
  {
    key: "media",
    label: "媒体",
    entries: [e("image"), e("camera", "拍照"), e("video"), e("embedVideo"), e("attachment", "附件")],
  },
  {
    key: "dataview",
    label: "数据视图",
    entries: [e("dataview-recent-notes"), e("dataview-pending-tasks"), e("dataview-notes-by-tag"), e("dataview-tasks-by-project")],
  },
  {
    key: "date",
    label: "日期",
    entries: [e("date-today"), e("date-today-weekday"), e("date-datetime"), e("date-time")],
  },
];

/** 所有分组里登记过的 key（去重） */
export function allMobileInsertKeys(): Set<string> {
  const s = new Set<string>();
  for (const g of MOBILE_INSERT_GROUPS) for (const it of g.entries) s.add(it.key);
  return s;
}
