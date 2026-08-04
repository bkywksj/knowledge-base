/**
 * 打开外部 .md 时的方式选择（加入知识库 / 临时编辑）。
 *
 * ## 为什么要问
 *
 * 外部 .md 打开后会入库 —— 这换来了写回原文件、外部改动冲突检测、下次打开复用
 * 同一条笔记等能力。但用户拿本应用改一份别处的 README / 稿子时，并不希望它混进
 * 自己的笔记列表和搜索结果。
 *
 * 之前只在首次打开时弹一条说明（`externalMdIntro.ts`）解释"为什么入库了"，
 * 这解决不了诉求 —— 用户要的不是解释，是**能选**。
 *
 * ## 两个选项的真实差别
 *
 * 只差"进不进默认视图"这一件事。两者都入库、都写回原文件、都能双向同步；
 * 临时编辑只是打上 `is_scratch` 标记，被主列表 / 搜索 / 双链 / RAG 过滤掉，
 * 之后随时可以在「临时文件」里转成正式笔记。
 *
 * ## 记住选择
 *
 * 每次都问会烦，所以带"记住我的选择"。记住后写 localStorage 不再弹窗，
 * 用户可在设置页改回"每次询问"（`clearOpenMdPreference`）。
 * 不放 Zustand：这是打开文件时的一次性决策，没有组件需要订阅它。
 */
import { Modal } from "antd";

const PREF_KEY = "open_md_mode";

/** 打开方式：进知识库 / 临时编辑 */
export type OpenMdMode = "library" | "scratch";

/** 读已记住的偏好；返回 null 表示"每次询问" */
export function getOpenMdPreference(): OpenMdMode | null {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "library" || v === "scratch" ? v : null;
  } catch {
    return null;
  }
}

/** 清除偏好，恢复"每次询问"（设置页用） */
export function clearOpenMdPreference() {
  try {
    localStorage.removeItem(PREF_KEY);
  } catch {
    // localStorage 不可用时本来也读不到偏好，等价于"每次询问"，无需处理
  }
}

/**
 * 写死偏好（之后不再弹窗）。
 *
 * 两个调用方：弹窗里勾了"记住我的选择"，以及设置页直接指定默认方式。
 */
export function setOpenMdPreference(mode: OpenMdMode) {
  try {
    localStorage.setItem(PREF_KEY, mode);
  } catch {
    // 记不住就下次再问一遍，不影响本次打开
  }
}

/**
 * 决定这次以什么方式打开外部 .md。已记住偏好则直接返回，不弹窗。
 *
 * 弹窗刻意关掉了 ESC / 点遮罩关闭：这两个动作没有合理的默认语义 ——
 * 当成"临时编辑"会让用户莫名其妙丢失笔记归属，当成"取消打开"又和用户
 * 刚刚双击文件的意图矛盾。所以只留两个明确按钮，必须选一个。
 */
export function resolveOpenMdMode(fileName: string): Promise<OpenMdMode> {
  const remembered = getOpenMdPreference();
  if (remembered) return Promise.resolve(remembered);

  return new Promise((resolve) => {
    // 勾选状态用闭包变量而非 React state：这是命令式 Modal，没有组件生命周期可挂
    let remember = false;
    const finish = (mode: OpenMdMode) => {
      if (remember) setOpenMdPreference(mode);
      resolve(mode);
    };

    Modal.confirm({
      title: `以什么方式打开「${fileName}」？`,
      width: 540,
      icon: null,
      maskClosable: false,
      keyboard: false,
      content: (
        <div className="space-y-3 pt-1">
          <div>
            <div className="font-medium">加入知识库</div>
            <div className="text-xs opacity-65">
              参与全文搜索、双向链接、AI 问答，出现在笔记列表里。
            </div>
          </div>
          <div>
            <div className="font-medium">临时编辑</div>
            <div className="text-xs opacity-65">
              只当 Markdown 编辑器用：不进笔记列表 / 搜索 / 双链。
              编辑后<strong>同样会保存回原文件</strong>，之后可在「临时文件」里转为正式笔记。
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs pt-1 cursor-pointer">
            <input
              type="checkbox"
              onChange={(e) => {
                remember = e.target.checked;
              }}
            />
            记住我的选择（之后不再询问，可在设置里改回）
          </label>
        </div>
      ),
      okText: "加入知识库",
      cancelText: "临时编辑",
      onOk: () => finish("library"),
      onCancel: () => finish("scratch"),
    });
  });
}
