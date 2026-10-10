export interface TagNameMatch<T> {
  /** 去掉首尾空白后的名字 */
  name: string;
  /** 库里已有的同名标签 */
  exact: T | undefined;
  /** 输入非空且库里没有同名标签 —— 此时该提供「新建」 */
  canCreate: boolean;
}

/**
 * 在已有标签里按名字找同名标签，决定「选中已有的」还是「新建一个」。
 *
 * 必须与后端判重口径一致：标签名在整个库内**全局唯一**（不管在哪一层），且按字面精确比较、
 * **区分大小写**（`tag_name_taken` 用的是 `name = ?1`）。这里若偷偷做大小写折叠，
 * 用户输入 `AI` 时会把已有的 `ai` 当成同一个，而后端其实认为是两个不同的标签。
 */
export function matchTagByName<T extends { name: string }>(
  tags: T[],
  input: string,
): TagNameMatch<T> {
  const name = input.trim();
  const exact = name ? tags.find((t) => t.name === name) : undefined;
  return { name, exact, canCreate: name.length > 0 && !exact };
}
