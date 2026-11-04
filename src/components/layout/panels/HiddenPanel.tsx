import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { theme as antdTheme, message } from "antd";
import { Folder as FolderIcon, FolderX, Layers, Check } from "lucide-react";
import { folderApi, hiddenApi } from "@/lib/api";
import type { Folder } from "@/types";

/**
 * HiddenPanel —— "隐藏笔记"视图的侧边栏。
 *
 * 设计：扁平的目录列表（不展示子目录层级），每项 = 一个含隐藏笔记的目录。
 * 选中态走 URL：`/hidden`（全部）/ `/hidden?folder=uncategorized` / `/hidden?folder=N`。
 *
 * 点哪一项 → 主区按目录过滤；查询时只看当前目录的隐藏笔记，不递归子目录。
 */

type FolderEntry = {
  /** "all" / "uncategorized" / 数字 id 字符串 */
  key: string;
  label: string;
  icon: React.ReactNode;
};

export function HiddenPanel() {
  const { token } = antdTheme.useToken();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const selectedKey = searchParams.get("folder") ?? "all";

  // 全文件夹 id→name 映射，用来给 listFolderIds 拿到的 id 反查名字
  const [folderMap, setFolderMap] = useState<Map<number, string>>(new Map());
  // 后端返回的"含隐藏笔记的 folder ids"（null = 未分类）
  const [hiddenFolderIds, setHiddenFolderIds] = useState<(number | null)[]>([]);

  async function loadFolderIds() {
    try {
      const ids = await hiddenApi.listFolderIds();
      setHiddenFolderIds(ids);
    } catch (e) {
      message.error(`加载目录失败: ${e}`);
    }
  }

  useEffect(() => {
    folderApi
      .list()
      .then((list: Folder[]) => {
        const map = new Map<number, string>();
        function flatten(flist: Folder[]) {
          for (const f of flist) {
            map.set(f.id, f.name);
            if (f.children?.length) flatten(f.children);
          }
        }
        flatten(list);
        setFolderMap(map);
      })
      .catch((e) => console.warn("[hidden-panel] 加载文件夹失败:", e));
    void loadFolderIds();
  }, []);

  // 监听全局取消隐藏后的刷新提示（与主区共享重算时机）
  // 这里简单点：每次 URL 切换都重拉一次目录 ids，确保删空的目录会消失
  useEffect(() => {
    void loadFolderIds();
  }, [searchParams.toString()]);

  const entries = useMemo<FolderEntry[]>(() => {
    const list: FolderEntry[] = [
      { key: "all", label: "全部隐藏笔记", icon: <Layers size={14} /> },
    ];
    let hasUncategorized = false;
    const namedIds: number[] = [];
    for (const id of hiddenFolderIds) {
      if (id === null) hasUncategorized = true;
      else namedIds.push(id);
    }
    if (hasUncategorized) {
      list.push({
        key: "uncategorized",
        label: "未分类",
        icon: <FolderX size={14} />,
      });
    }
    namedIds
      .map((id) => ({ id, name: folderMap.get(id) ?? `(已删除 #${id})` }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh"))
      .forEach(({ id, name }) =>
        list.push({
          key: String(id),
          label: name,
          icon: <FolderIcon size={14} />,
        }),
      );
    return list;
  }, [hiddenFolderIds, folderMap]);

  function handleSelect(key: string) {
    if (key === "all") {
      navigate("/hidden");
    } else {
      navigate(`/hidden?folder=${encodeURIComponent(key)}`);
    }
  }

  return (
    <div
      className="flex flex-col h-full"
      style={{ overflow: "hidden" }}
      // 本面板纯目录导航 + 无 input → 顶层兜底吞 WebView 默认菜单
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 视图标题（原型 .ph：与其他面板同款，只有标题） */}
      <div className="kb-ph">
        <span className="kb-ph-title">隐藏笔记</span>
      </div>

      {/* 扁平目录列表 */}
      <div
        className="flex-1 overflow-auto"
        style={{ minHeight: 0, padding: "2px 8px 8px" }}
      >
        {/* 行样式复用待办面板 .kb-tp-row（原型 .row：30 高、选中白底 + 深一档描边） */}
        {entries.map((entry, i) => {
          const active = selectedKey === entry.key;
          return (
            <Fragment key={entry.key}>
              {/* 原型：「全部隐藏笔记」下面是「文件夹」小节 */}
              {i === 1 && <div className="kb-tp-sec">文件夹</div>}
              <div
                onClick={() => handleSelect(entry.key)}
                className={active ? "kb-tp-row is-active" : "kb-tp-row"}
              >
                <span className="kb-tp-ic" style={active ? { color: "var(--kb-primary)" } : undefined}>
                  {entry.icon}
                </span>
                <span className="kb-tp-lb">{entry.label}</span>
                {active && <Check size={12} strokeWidth={3} />}
              </div>
            </Fragment>
          );
        })}

        {entries.length === 1 && (
          <div
            className="text-center py-6"
            style={{ color: token.colorTextQuaternary, fontSize: 12 }}
          >
            还没有隐藏的笔记
          </div>
        )}
      </div>
    </div>
  );
}
