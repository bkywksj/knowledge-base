import { Check } from "lucide-react";
import { useAppStore } from "@/store";
import { themes, type ThemeMeta } from "@/theme/tokens";

/**
 * 主题选择区（v4 原型 外观自定义 → 主题）：每个主题一块预览色卡，点击即切换。
 * 与标题栏调色盘菜单的 handleThemeSelect 同一套写法：先记下该类别用哪套主题，再切类别。
 */
export function ThemePicker() {
  const lightTheme = useAppStore((s) => s.lightTheme);
  const darkTheme = useAppStore((s) => s.darkTheme);
  const themeCategory = useAppStore((s) => s.themeCategory);
  const setLightTheme = useAppStore((s) => s.setLightTheme);
  const setDarkTheme = useAppStore((s) => s.setDarkTheme);
  const setThemeCategory = useAppStore((s) => s.setThemeCategory);

  const current = themeCategory === "light" ? lightTheme : darkTheme;

  function pick(t: ThemeMeta) {
    if (t.category === "light") setLightTheme(t.key);
    else setDarkTheme(t.key);
    setThemeCategory(t.category);
  }

  return (
    <div className="kb-theme-pick">
      {themes.map((t) => {
        const [bg, primary, accent, ink] = t.colors;
        const on = t.key === current;
        return (
          <button
            key={t.key}
            type="button"
            className={"kb-theme-tile" + (on ? " is-on" : "")}
            title={t.description}
            onClick={() => pick(t)}
          >
            {/* 预览：底色 + 一张「纸」+ 主色 / 点缀色两条 */}
            <span className="kb-theme-prev" style={{ background: bg }}>
              <i style={{ background: t.category === "light" ? "#fff" : ink, opacity: t.category === "light" ? 1 : 0.08 }} />
              <b style={{ background: `linear-gradient(90deg, ${primary}, ${accent})` }} />
            </span>
            <span className="kb-theme-name">
              {t.label}
              <em>{t.category === "light" ? "亮色" : "暗色"}</em>
              {on && <Check size={13} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
