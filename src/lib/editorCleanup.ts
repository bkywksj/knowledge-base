/**
 * 编辑器「格式规整」的文本清洗规则 —— 纯函数层（不依赖 ProseMirror / React）
 *
 * 场景：从网页、Word、微信、PDF 里复制过来的内容，常常带一堆空段落、
 * 行首尾空格、中英文挤在一起。用户反馈里说的"一键应用模版格式"，
 * 落到实处就是这套清洗（模板样式绑定是另一回事，成本高收益低，没做）。
 *
 * 只放"给一段纯文本 → 返回清洗后文本"的规则；删空段落、清除内联样式这类
 * 需要操作文档结构的动作，在调用方用一次 ProseMirror transaction 完成
 * （保证 Ctrl+Z 能整体撤销）。
 */

/** 中日韩文字（含中文标点不算，标点旁不该补空格） */
const CJK = "\\u4e00-\\u9fa5\\u3040-\\u30ff\\u3400-\\u4dbf";

/**
 * 中英文之间补一个空格（`知识库v1.2` → `知识库 v1.2`）。
 * 已经有空格的不会重复补——正则要求两侧字符直接相邻。
 */
export function addCjkLatinSpacing(text: string): string {
  return text
    .replace(new RegExp(`([${CJK}])([A-Za-z0-9])`, "g"), "$1 $2")
    .replace(new RegExp(`([A-Za-z0-9])([${CJK}])`, "g"), "$1 $2");
}

/** 去掉首尾空白，包括全角空格 U+3000 和不换行空格 U+00A0 */
export function trimEdges(text: string): string {
  return text.replace(/^[\s　 ]+|[\s　 ]+$/g, "");
}

/**
 * 压缩段内连续空白为单个空格；全角空格 / 不换行空格一并归一。
 * 不动换行符——换行在 ProseMirror 里是独立节点，不会出现在 text node 内。
 */
export function squeezeSpaces(text: string): string {
  return text.replace(/[ \t　 ]{2,}/g, " ");
}

/** 一段文本是否只剩空白（判断"空段落"用） */
export function isBlankText(text: string): boolean {
  return trimEdges(text).length === 0;
}

/** 可选的文本清洗规则 */
export interface TextCleanupRules {
  /** 去首尾空白 */
  trim?: boolean;
  /** 压缩段内连续空格 */
  squeeze?: boolean;
  /** 中英文之间补空格 */
  cjkSpacing?: boolean;
}

/**
 * 按勾选的规则清洗一段文本。顺序固定：先压缩、再补空格、最后去首尾
 * （补空格可能在首尾产生空白，所以 trim 放最后）。
 */
export function cleanText(text: string, rules: TextCleanupRules): string {
  let out = text;
  if (rules.squeeze) out = squeezeSpaces(out);
  if (rules.cjkSpacing) out = addCjkLatinSpacing(out);
  if (rules.trim) out = trimEdges(out);
  return out;
}
