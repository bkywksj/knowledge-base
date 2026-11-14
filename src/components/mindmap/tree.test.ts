import { describe, it, expect } from "vitest";
import {
  addChild,
  addSibling,
  indent,
  locate,
  moveNode,
  moveAmongSiblings,
  outdent,
  parseMindMap,
  removeNode,
  serializeMindMap,
  setText,
  toggleTask,
  type MindNode,
} from "./tree";

/** 只看结构：[文字, 子节点…]，忽略 id / kind，断言更好读 */
type Shape = [string, ...Shape[]];
function shape(n: MindNode): Shape {
  return [n.text, ...n.children.map(shape)];
}

/** 解析 → 序列化应原样回来（输入本身就是编辑器的规范格式） */
function roundTrip(md: string) {
  const { root, editable } = parseMindMap(md, "标题");
  expect(editable).toBe(true);
  expect(serializeMindMap(root)).toBe(md);
}

describe("parseMindMap · 层级", () => {
  it("无标题的纯列表：顶层项挂在中心主题下，缩进决定层级", () => {
    const { root } = parseMindMap("- A\n  - A1\n  - A2\n- B\n", "中心");
    expect(shape(root)).toEqual(["中心", ["A", ["A1"], ["A2"]], ["B"]]);
  });

  it("标题下的列表挂在标题下；跳级标题挂到最近的上级", () => {
    const md = "# 一\n\n- x\n\n### 三级\n\n## 二\n";
    const { root } = parseMindMap(md, "中心");
    expect(shape(root)).toEqual(["中心", ["一", ["x"], ["三级"], ["二"]]]);
  });

  it("有序列表缩进 3 格、任务项、空列表项都能解析", () => {
    const { root } = parseMindMap("1. 甲\n   - 甲1\n2. 乙\n- [x] 完成\n- [ ] 未完成\n-\n", "c");
    expect(shape(root)).toEqual(["c", ["甲", ["甲1"]], ["乙"], ["完成"], ["未完成"], [""]]);
    const done = root.children[2].kind;
    expect(done).toEqual({ type: "item", ordered: false, task: true });
  });

  it("「# C#」这类标题结尾的 # 不是闭合标记", () => {
    expect(parseMindMap("# C#\n", "c").root.children[0].text).toBe("C#");
  });

  it("行内格式原样保留", () => {
    expect(parseMindMap("- **粗** [链接](https://a.b)\n", "c").root.children[0].text).toBe(
      "**粗** [链接](https://a.b)",
    );
  });
});

describe("parseMindMap · 可编辑判定", () => {
  it("空笔记、纯大纲可编辑", () => {
    expect(parseMindMap("", "c").editable).toBe(true);
    expect(parseMindMap("# a\n\n- b\n", "c").editable).toBe(true);
  });

  it("编辑器补在末尾的空段落 <p></p> 等空白 HTML 不算正文（实测：编辑器里改一个字就会带上它）", () => {
    // 原样取自编辑器保存的真实内容
    const md = "- 分支一\n  - 子项 A\n- 分支二！\n\n<p></p>";
    const r = parseMindMap(md, "c");
    expect(r.editable).toBe(true);
    expect(shape(r.root)).toEqual(["c", ["分支一", ["子项 A"]], ["分支二！"]]);
    for (const blank of ["<p><br></p>", "<br/>", "&nbsp;", "<P> </P>"]) {
      expect(parseMindMap(`- a\n\n${blank}\n`, "c").editable, blank).toBe(true);
    }
    // 有内容的段落仍然只读
    expect(parseMindMap("- a\n\n<p>正文</p>\n", "c").editable).toBe(false);
  });

  it("出现段落 / 表格 / 代码块就只读，并给出原因", () => {
    for (const md of ["# a\n\n一段正文\n", "| a | b |\n|---|---|\n", "```js\nx\n```\n", "> 引用\n"]) {
      const r = parseMindMap(md, "c");
      expect(r.editable, md).toBe(false);
      expect(r.reason).toContain("编辑会丢掉");
    }
  });

  it("只读时仍解析出大纲部分（只读视图照常显示）", () => {
    const r = parseMindMap("# a\n\n正文\n\n- b\n", "c");
    expect(shape(r.root)).toEqual(["c", ["a", ["b"]]]);
  });
});

describe("serializeMindMap · 往返不变", () => {
  it.each([
    ["纯列表", "- A\n  - A1\n    - A11\n- B\n"],
    ["标题 + 列表", "# 一\n\n- x\n- y\n\n## 二\n\n- z\n"],
    ["有序 + 任务", "1. 甲\n   - 甲1\n2. 乙\n\n# 标题\n\n- [x] 完成\n- [ ] 未完成\n"],
    ["多个一级标题", "# A\n\n# B\n\n## B1\n"],
  ])("%s", (_name, md) => roundTrip(md));

  it("空树输出空串", () => {
    expect(serializeMindMap(parseMindMap("", "c").root)).toBe("");
  });

  it("标题后面跟着的列表项被移到同级标题前面，保证重新解析结构不变", () => {
    const { root } = parseMindMap("# A\n\n- x\n", "c");
    const r = addChild(root, root.id, "尾巴");
    // 中心主题已有标题子节点 → 新节点也是一级标题，排在 A 后面
    expect(serializeMindMap(r!.root)).toBe("# A\n\n- x\n\n# 尾巴\n");
  });

  it("文字里的换行写回时压成一行", () => {
    const { root } = parseMindMap("- a\n", "c");
    const next = setText(root, root.children[0].id, "第一行\n第二行");
    expect(serializeMindMap(next)).toBe("- 第一行 第二行\n");
  });
});

describe("编辑操作", () => {
  const base = () => parseMindMap("- A\n  - A1\n- B\n- C\n", "中心").root;
  const idOf = (root: MindNode, text: string) => {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.text === text) return n.id;
      stack.push(...n.children);
    }
    throw new Error(`没有节点 ${text}`);
  };

  it("加子节点 / 同级节点，并选中新节点；不改原树", () => {
    const root = base();
    const before = serializeMindMap(root);
    const r1 = addChild(root, idOf(root, "A1"), "新")!;
    expect(serializeMindMap(r1.root)).toBe("- A\n  - A1\n    - 新\n- B\n- C\n");
    expect(locate(r1.root, r1.selectId)!.node.text).toBe("新");
    const r2 = addSibling(root, idOf(root, "A"), "并列")!;
    expect(serializeMindMap(r2.root)).toBe("- A\n  - A1\n- 并列\n- B\n- C\n");
    expect(serializeMindMap(root)).toBe(before);
  });

  it("中心主题上加同级 = 加子节点", () => {
    const root = base();
    const r = addSibling(root, root.id, "D")!;
    expect(serializeMindMap(r.root)).toBe("- A\n  - A1\n- B\n- C\n- D\n");
  });

  it("删除带子树的节点，选中前一个同级；中心主题删不掉", () => {
    const root = base();
    const r = removeNode(root, idOf(root, "B"))!;
    expect(serializeMindMap(r.root)).toBe("- A\n  - A1\n- C\n");
    expect(locate(r.root, r.selectId)!.node.text).toBe("A");
    expect(removeNode(root, root.id)).toBeNull();
  });

  it("上移 / 下移，到边界返回 null", () => {
    const root = base();
    expect(serializeMindMap(moveAmongSiblings(root, idOf(root, "C"), -1)!.root)).toBe(
      "- A\n  - A1\n- C\n- B\n",
    );
    expect(moveAmongSiblings(root, idOf(root, "A"), -1)).toBeNull();
  });

  it("降级成上一个同级的子节点、再升级回来", () => {
    const root = base();
    const down = indent(root, idOf(root, "B"))!;
    expect(serializeMindMap(down.root)).toBe("- A\n  - A1\n  - B\n- C\n");
    const up = outdent(down.root, idOf(root, "B"))!;
    expect(serializeMindMap(up.root)).toBe("- A\n  - A1\n- B\n- C\n");
    expect(indent(root, idOf(root, "A"))).toBeNull(); // 没有上一个同级
    expect(outdent(root, idOf(root, "A"))).toBeNull(); // 已在第一层
  });

  it("标题降级到另一个标题下变成下一级标题；挂到列表项下变成列表项", () => {
    const { root } = parseMindMap("# A\n\n# B\n\n## B1\n", "c");
    const r = indent(root, idOf(root, "B"))!;
    expect(serializeMindMap(r.root)).toBe("# A\n\n## B\n\n### B1\n");

    const { root: r2 } = parseMindMap("- x\n\n# H\n", "c");
    // 中心主题下：列表项 x、标题 H；把 H 降级到 x 下面 → 只能是列表项
    const down = indent(r2, idOf(r2, "H"))!;
    expect(serializeMindMap(down.root)).toBe("- x\n  - H\n");
  });

  it("任务项勾选切换，非任务项不受影响", () => {
    const { root } = parseMindMap("- [ ] 待办\n- 普通\n", "c");
    const next = toggleTask(toggleTask(root, root.children[0].id), root.children[1].id);
    expect(serializeMindMap(next)).toBe("- [x] 待办\n- 普通\n");
  });
});

describe("moveNode · 拖放", () => {
  const base = () => parseMindMap("- A\n  - A1\n- B\n- C\n", "中心").root;
  const idOf = (root: MindNode, text: string) => {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.text === text) return n.id;
      stack.push(...n.children);
    }
    throw new Error(`没有节点 ${text}`);
  };

  it("放进另一个节点 = 成为它的最后一个子节点", () => {
    const root = base();
    const r = moveNode(root, idOf(root, "C"), idOf(root, "A"), "inside")!;
    expect(serializeMindMap(r.root)).toBe("- A\n  - A1\n  - C\n- B\n");
    expect(locate(r.root, r.selectId)!.node.text).toBe("C");
  });

  it("放到目标前 / 后：可跨层级", () => {
    const root = base();
    expect(serializeMindMap(moveNode(root, idOf(root, "C"), idOf(root, "A"), "before")!.root)).toBe(
      "- C\n- A\n  - A1\n- B\n",
    );
    expect(serializeMindMap(moveNode(root, idOf(root, "A1"), idOf(root, "B"), "after")!.root)).toBe(
      "- A\n- B\n- A1\n- C\n",
    );
  });

  it("拖到自己 / 自己的子孙、拖中心主题、在中心主题前后放都无效", () => {
    const root = base();
    expect(moveNode(root, idOf(root, "A"), idOf(root, "A"), "inside")).toBeNull();
    expect(moveNode(root, idOf(root, "A"), idOf(root, "A1"), "inside")).toBeNull();
    expect(moveNode(root, root.id, idOf(root, "B"), "inside")).toBeNull();
    expect(moveNode(root, idOf(root, "B"), root.id, "before")).toBeNull();
  });

  it("放回原位（紧挨着自己）不算编辑", () => {
    const root = base();
    expect(moveNode(root, idOf(root, "B"), idOf(root, "C"), "before")).toBeNull();
    expect(moveNode(root, idOf(root, "B"), idOf(root, "A"), "after")).toBeNull();
  });

  it("标题拖进列表项下变成列表项；拖到中心主题下保持标题", () => {
    const { root } = parseMindMap("- x\n\n# H\n\n## H2\n", "c");
    const r = moveNode(root, idOf(root, "H2"), root.id, "inside")!;
    expect(serializeMindMap(r.root)).toBe("- x\n\n# H\n\n# H2\n");
    const r2 = moveNode(root, idOf(root, "H"), idOf(root, "x"), "inside")!;
    expect(serializeMindMap(r2.root)).toBe("- x\n  - H\n    - H2\n");
  });
});
