---
name: i18n-development
description: |
  Tauri 国际化开发技能，使用 react-i18next 实现多语言支持。

  触发场景：
  - 需要为应用添加多语言支持
  - 需要管理翻译资源文件
  - 需要实现语言切换功能
  - 需要格式化日期/数字/货币

  触发词：国际化、i18n、多语言、翻译、语言切换、本地化、l10n
---

# Tauri 国际化开发

## 安装 react-i18next

```bash
pnpm add i18next react-i18next i18next-browser-languagedetector
```

---

## 配置

### i18n.ts

```typescript
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import zhCN from "./locales/zh-CN.json";
import enUS from "./locales/en-US.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      "zh-CN": { translation: zhCN },
      "en-US": { translation: enUS },
    },
    fallbackLng: "zh-CN",
    interpolation: { escapeValue: false },
  });

export default i18n;
```

### 翻译文件

```json
// locales/zh-CN.json
{
  "app": {
    "title": "我的应用",
    "welcome": "欢迎，{{name}}！"
  },
  "menu": {
    "file": "文件",
    "edit": "编辑",
    "help": "帮助"
  },
  "action": {
    "save": "保存",
    "cancel": "取消",
    "delete": "删除",
    "confirm": "确认"
  }
}
```

```json
// locales/en-US.json
{
  "app": {
    "title": "My App",
    "welcome": "Welcome, {{name}}!"
  },
  "menu": {
    "file": "File",
    "edit": "Edit",
    "help": "Help"
  },
  "action": {
    "save": "Save",
    "cancel": "Cancel",
    "delete": "Delete",
    "confirm": "Confirm"
  }
}
```

---

## 使用

### 在组件中使用

```tsx
import { useTranslation } from "react-i18next";

function Header() {
  const { t, i18n } = useTranslation();

  return (
    <header>
      <h1>{t("app.title")}</h1>
      <p>{t("app.welcome", { name: "Alice" })}</p>
      <select
        value={i18n.language}
        onChange={(e) => i18n.changeLanguage(e.target.value)}
      >
        <option value="zh-CN">中文</option>
        <option value="en-US">English</option>
      </select>
    </header>
  );
}
```

### 在 main.tsx 中初始化

```tsx
import "./i18n"; // 在 App 之前导入

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 硬编码中文字符串 | 使用 `t("key")` 引用翻译 |
| 翻译 key 用中文 | 使用英文点分 key `app.title` |
| 不提取公共翻译 | 按模块组织翻译文件 |
| 日期格式硬编码 | 使用 Intl API 格式化 |
