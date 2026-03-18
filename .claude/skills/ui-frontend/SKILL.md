---
name: ui-frontend
description: |
  React 前端 UI 组件开发技能,指导 Tauri 桌面应用的界面开发。

  触发场景:
  - 需要开发 React 页面或组件
  - 需要选择和使用 UI 组件库
  - 需要处理表单、表格、弹窗等常见 UI
  - 需要实现响应式布局

  触发词: UI、组件、页面、前端、界面、表单、表格、弹窗、布局、样式、React
---

# React 前端 UI 开发

## 概述

Tauri 桌面应用的前端运行在系统 WebView 中,使用 React 19 + TypeScript 5.8 + Ant Design + TailwindCSS 4 开发。与 Web 应用的主要区别是:窗口大小可控、无需考虑 SEO、可调用系统 API。

### 前端项目结构

```
src/
├── components/
│   ├── layout/
│   │   ├── AppLayout.tsx        # 主布局（Ant Design Layout）
│   │   └── Sidebar.tsx          # 侧边栏导航
│   └── ui/
│       └── ErrorBoundary.tsx    # 错误边界
├── hooks/
│   └── useCommand.ts           # invoke 封装
├── lib/
│   └── api/
│       └── index.ts            # API 类型安全封装
├── pages/
│   ├── home/index.tsx           # 首页
│   ├── settings/index.tsx       # 设置页
│   └── about/index.tsx          # 关于页
├── store/
│   └── index.ts                # Zustand 全局状态
├── styles/
│   └── global.css              # TailwindCSS
├── types/
│   └── index.ts                # TS 类型
├── App.tsx                      # 根组件（ConfigProvider + Router）
├── Router.tsx                   # React Router 配置
└── main.tsx                     # 入口
```

### 当前技术栈

| 技术 | 用途 |
|------|------|
| **Ant Design** | UI 组件库（Layout/Form/Table 等） |
| **TailwindCSS 4** | 原子化 CSS 样式 |
| **React Router** | 客户端路由 |
| **Zustand** | 全局状态管理 |

---

## UI 组件库（已选用 Ant Design）

项目已集成 **Ant Design** 作为主要 UI 组件库,配合 **TailwindCSS 4** 做原子化样式补充。

| 关键组件 | 用途 | 参考文件 |
|---------|------|---------|
| `Layout / Sider / Content` | 主布局 | `src/components/layout/AppLayout.tsx` |
| `Menu` | 侧边栏导航 | `src/components/layout/Sidebar.tsx` |
| `ConfigProvider` | 全局主题配置 | `src/App.tsx` |
| `Form / Input / Select` | 表单 | 各页面组件 |
| `Table` | 数据表格 | 各页面组件 |
| `Modal / message` | 弹窗/消息 | 各页面组件 |

---

## 组件开发模式

### 基础组件模板

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  title: string;
}

function FeaturePage({ title }: Props) {
  const [data, setData] = useState<DataType[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<DataType[]>("get_data");
      setData(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="loading">加载中...</div>;
  if (error) return <div className="error">错误: {error}</div>;

  return (
    <div className="page">
      <h1>{title}</h1>
      <div className="content">
        {data.map(item => (
          <div key={item.id}>{item.name}</div>
        ))}
      </div>
    </div>
  );
}

export default FeaturePage;
```

### 表单组件

```tsx
import { useState, FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";

interface FormData {
  name: string;
  email: string;
  description: string;
}

function CreateForm() {
  const [form, setForm] = useState<FormData>({
    name: "", email: "", description: ""
  });

  function handleChange(field: keyof FormData, value: string) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await invoke("create_item", { input: form });
      setForm({ name: "", email: "", description: "" });
    } catch (e) {
      alert(`保存失败: ${e}`);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label>
        名称
        <input value={form.name} onChange={e => handleChange("name", e.target.value)} required />
      </label>
      <label>
        邮箱
        <input type="email" value={form.email} onChange={e => handleChange("email", e.target.value)} />
      </label>
      <label>
        描述
        <textarea value={form.description} onChange={e => handleChange("description", e.target.value)} />
      </label>
      <button type="submit">保存</button>
    </form>
  );
}
```

### 列表 + CRUD 页面

```tsx
function ItemList() {
  const [items, setItems] = useState<Item[]>([]);
  const [editing, setEditing] = useState<Item | null>(null);

  useEffect(() => { loadItems(); }, []);

  async function loadItems() {
    const list = await invoke<Item[]>("list_items");
    setItems(list);
  }

  async function deleteItem(id: number) {
    if (!confirm("确认删除?")) return;
    await invoke("delete_item", { id });
    await loadItems();
  }

  return (
    <div>
      <table>
        <thead>
          <tr><th>ID</th><th>名称</th><th>操作</th></tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={item.id}>
              <td>{item.id}</td>
              <td>{item.name}</td>
              <td>
                <button onClick={() => setEditing(item)}>编辑</button>
                <button onClick={() => deleteItem(item.id)}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

---

## 桌面应用 UI 注意事项

| 注意事项 | 说明 |
|---------|------|
| 窗口大小 | 默认 800x600,可在 tauri.conf.json 配置 |
| 无滚动条 | 桌面应用通常避免页面级滚动 |
| 系统菜单 | 可通过 Tauri Menu API 实现原生菜单 |
| 拖拽区域 | 使用 `data-tauri-drag-region` 创建可拖拽标题栏 |
| 快捷键 | 可通过 Tauri 全局快捷键 API 注册 |
| 深色模式 | 使用 CSS `prefers-color-scheme` 媒体查询 |

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 使用 `window.alert()` | 使用自定义弹窗组件或 Tauri dialog 插件 |
| 使用 `window.open()` | 使用 Tauri 窗口 API 或 opener 插件 |
| 不考虑深色模式 | 使用 CSS 变量 + prefers-color-scheme |
| 使用绝对像素布局 | 使用 flexbox/grid 响应式布局 |
| 组件过大不拆分 | 按功能拆分为 < 200 行的小组件 |
