/**
 * 笔记类列表的显示密度与每页条数（笔记页 / 回收站 / 隐藏笔记 / 标签页关联笔记 / 搜索页右列共用）。
 *
 * 密度写到 :root 的 data-list-density 上，各列表只靠 CSS 跟着变，不用每个组件都订阅 store。
 * 「宽松」就是改版前的样子，所以 CSS 里只写紧凑和标准两档的覆盖。
 */
export type ListDensity = "compact" | "standard" | "comfortable";

export const LIST_DENSITY_OPTIONS: { value: ListDensity; label: string; hint: string }[] = [
  { value: "compact", label: "紧凑", hint: "只显示标题一行" },
  { value: "standard", label: "标准", hint: "标题 + 摘要，没有摘要时只占一行" },
  { value: "comfortable", label: "宽松", hint: "每行固定两行高" },
];

export const LIST_DENSITY_DEFAULT: ListDensity = "standard";

/** 每页条数可选值；原来默认 12，一屏刚好铺满、翻页太频繁，紧凑后更明显 */
export const LIST_PAGE_SIZE_OPTIONS = [12, 20, 30, 50, 100, 200];
export const LIST_PAGE_SIZE_DEFAULT = 30;

export function sanitizeListDensity(raw: unknown): ListDensity {
  return LIST_DENSITY_OPTIONS.some((o) => o.value === raw)
    ? (raw as ListDensity)
    : LIST_DENSITY_DEFAULT;
}

export function sanitizeListPageSize(raw: unknown): number {
  return typeof raw === "number" && LIST_PAGE_SIZE_OPTIONS.includes(raw)
    ? raw
    : LIST_PAGE_SIZE_DEFAULT;
}

export function applyListDensity(density: ListDensity) {
  document.documentElement.setAttribute("data-list-density", density);
}
