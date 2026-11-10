/**
 * 双链候选框（WikiLinkSuggestion）是否应该弹出。
 *
 * @param typed 从触发符 `[[` 起到光标为止的文字（含 `[[` 本身）
 * @returns true = 用户正在输入双链，弹候选；false = 这对双链已闭合（中间出现过 `]]`），不弹
 *
 * 只判断「结尾是不是 ]]」不够：候选插件开了 allowSpaces，光标停在已闭合双链后面
 * （如 `包含 [[双链]] 与列表。|`）时，会把 `[[` 之后整段都当查询词，候选框凭空弹出。
 */
export function wikiSuggestionAllowed(typed: string): boolean {
  return !typed.includes("]]");
}
