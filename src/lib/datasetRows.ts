/**
 * 数据集行数据的解析（P1-3b）。
 *
 * 后端 `preview_dataset_rows` 返回的是**每行一个 JSON 字符串**
 * （`{"列名": "值"}`），而不是二维数组 —— 这样列顺序只由后端的
 * `dataset_fields` 一处决定，前端不用再维护一份。
 */

/** 一行数据：列名 → 单元格文本 */
export type DatasetRow = Record<string, string>;

/**
 * 把后端返回的 JSON 字符串数组解析成行对象。
 *
 * **逐行 try**：单行数据坏掉（理论上不该发生，但库被外部工具改过就可能）
 * 不该让整页表格空掉 —— 坏行退化成空行，其余照常显示。
 */
export function parseDatasetRows(raw: string[]): DatasetRow[] {
  return raw.map((line) => {
    try {
      const v = JSON.parse(line);
      // 防御非对象（null / 数组 / 字符串）：那些解析出来会让 antd Table 渲染崩
      return v && typeof v === "object" && !Array.isArray(v)
        ? (v as DatasetRow)
        : {};
    } catch {
      return {};
    }
  });
}
