# /dev - 开发新功能（全栈代码生成）

作为新功能开发助手,引导完成 Tauri 桌面应用的全栈功能开发。

## 核心优势

- 全栈自动生成(Rust 三层架构 + React UI + Capabilities 权限声明)
- 遵循 Tauri 双进程架构(WebView 进程 + Rust Core 进程)
- 类型安全(Rust serde 序列化 + TypeScript 类型对齐)
- 自动处理 Capabilities 权限声明(Tauri 2.x 强制权限模型)
- 错误处理规范(Rust `AppError` enum + 前端统一 API 包装)
- 三层分离(Commands → Services → Database)

---

## 执行流程

### 第一步:询问需求

使用 AskUserQuestion 工具询问:

**问题1:功能信息**
```
请告诉我要开发的功能:
1. **功能名称**?(如:用户管理、数据导入、系统监控、设置页面)
2. **需要哪些系统能力**?(选择适用项)
   - 文件读写(fs 插件)
   - 网络请求(Rust reqwest)
   - 本地数据库(rusqlite - 已集成)
   - 系统通知(notification 插件)
   - 剪贴板(clipboard 插件)
   - 对话框(dialog 插件 — 文件选择/保存/确认框)
   - 系统托盘(tray 插件)
   - 全局快捷键(global-shortcut 插件)
   - 窗口操作(多窗口/窗口控制)
   - Shell 命令执行(shell 插件)
   - 自动更新(updater 插件)
   - 无特殊系统能力(纯前端 UI + 基础 Command)
3. **是否需要持久化数据**?(SQLite 数据库 / Rust 侧 State 管理 / 无)
```

**自动推断配置**:
- 文件操作 → 需要 `fs` 插件 + `dialog` 插件 + 对应 Capabilities
- 网络请求 → 通过 Rust Command 代理(禁止前端直接 fetch 外部 API)
- 数据库 → `rusqlite` 已集成,创建 Service + Database 层
- 系统通知 → `tauri-plugin-notification` + Capabilities 声明
- 持久状态 → `tauri::State<T>` + `Mutex`/`RwLock` 包裹

---

### 第二步:检查功能是否已存在(强制执行)

```bash
# 检查 Rust Command 是否已有相关功能
Grep pattern: "fn {功能相关关键词}" path: src-tauri/src/commands/ output_mode: files_with_matches

# 检查 Rust Service 是否已有相关功能
Grep pattern: "fn {功能相关关键词}" path: src-tauri/src/services/ output_mode: files_with_matches

# 检查前端 API 是否已有相关功能
Grep pattern: "{功能名相关关键词}" path: src/lib/api/ output_mode: files_with_matches

# 检查前端页面是否已有相关功能
Grep pattern: "{功能名相关关键词}" path: src/pages/ output_mode: files_with_matches
```

**如果功能已存在** → 停止全栈生成流程,建议增强现有代码(列出现有文件和扩展建议)
**如果功能未实现** → 继续

---

### 第三步:读取参考代码(强制执行)

```bash
# Rust 后端参考 — 了解三层架构模式
Read src-tauri/src/commands/user.rs      # Command 层示例
Read src-tauri/src/services/user.rs      # Service 层示例
Read src-tauri/src/database/mod.rs       # Database 层示例
Read src-tauri/src/error.rs              # 统一错误处理

# Rust 主入口 — 了解 Builder 配置和 Command 注册
Read src-tauri/src/main.rs
Read src-tauri/src/lib.rs

# 前端参考 — 了解 API 封装和组件结构
Read src/lib/api/index.ts                # API 封装层
Read src/types/index.ts                  # 类型定义
Read src/pages/Users/index.tsx           # 页面组件示例

# 权限声明参考 — 了解已声明的 Capabilities
Read src-tauri/capabilities/default.json

# Tauri 配置参考 — 了解应用配置(窗口/安全/构建)
Read src-tauri/tauri.conf.json

# Rust 依赖参考 — 了解已安装的 crate
Read src-tauri/Cargo.toml
```

**项目已有清晰的模块化结构**:
- `src-tauri/src/commands/` — Command 层(IPC 入口)
- `src-tauri/src/services/` — Service 层(业务逻辑)
- `src-tauri/src/database/` — Database 层(数据持久化)
- `src/pages/` — 前端页面组件
- `src/lib/api/` — 前端 API 封装

---

### 第四步:设计数据结构

定义 Rust 结构体和对应的 TypeScript 类型,确保两端类型对齐:

**Rust 侧(serde 自动序列化/反序列化)**:
```rust
use serde::{Deserialize, Serialize};

/// 功能数据结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct XxxData {
    pub id: i64,
    pub name: String,
    pub status: i32,
    pub created_at: String,
}

/// 功能创建请求(如需独立入参类型)
#[derive(Debug, Deserialize)]
pub struct CreateXxxRequest {
    pub name: String,
    pub status: Option<i32>,
}

/// 功能查询请求(如需分页/过滤)
#[derive(Debug, Deserialize)]
pub struct QueryXxxRequest {
    pub keyword: Option<String>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

/// 功能响应结构(如需分页等封装)
#[derive(Debug, Serialize)]
pub struct XxxListResponse {
    pub items: Vec<XxxData>,
    pub total: usize,
}
```

**TypeScript 侧(与 Rust 类型一一对应)**:
```typescript
// src/types/index.ts 中添加

// 功能数据类型
export interface XxxData {
  id: number;
  name: string;
  status: number;
  createdAt: string;  // Tauri 自动 snake_case → camelCase
}

// 功能创建请求类型
export interface CreateXxxRequest {
  name: string;
  status?: number;
}

// 功能查询请求类型
export interface QueryXxxRequest {
  keyword?: string;
  page?: number;
  pageSize?: number;
}

// 功能响应类型
export interface XxxListResponse {
  items: XxxData[];
  total: number;
}
```

**类型对齐规则**:
| Rust 类型 | TypeScript 类型 | 说明 |
|-----------|----------------|------|
| `String` / `&str` | `string` | 字符串 |
| `i32` / `i64` / `u32` / `u64` | `number` | 数字 |
| `f64` / `f32` | `number` | 浮点数 |
| `bool` | `boolean` | 布尔 |
| `Vec<T>` | `T[]` | 数组 |
| `Option<T>` | `T \| undefined` 或 `T?` | 可选值 |
| `HashMap<K, V>` | `Record<K, V>` | 映射 |
| `()` | `void` | 空返回 |

---

### 第五步:输出生成方案并确认

```markdown
## 代码生成方案

### 功能概述
- **功能名称**:{功能名}
- **系统能力**:{需要的插件/API 列表}
- **持久化方案**:{SQLite / State / 无}

### 文件清单

**Rust 后端(三层架构)**:
1. `src-tauri/src/commands/xxx.rs` — Command 层(IPC 入口,参数验证)
2. `src-tauri/src/services/xxx.rs` — Service 层(业务逻辑)
3. `src-tauri/src/database/xxx.rs` — Database 层(数据持久化,如需数据库)
4. `src-tauri/src/database/mod.rs` — 注册新的 Database 模块
5. `src-tauri/src/lib.rs` — 在 generate_handler![] 中注册新 Command

**React 前端**:
6. `src/types/index.ts` — 添加 TypeScript 类型定义
7. `src/lib/api/index.ts` — 添加 API 封装函数
8. `src/pages/Xxx/index.tsx` — React 页面组件(Ant Design 5 组件)
9. `src/store/xxxStore.ts` — Zustand 状态管理(如需全局状态)

**权限配置**:
10. `src-tauri/capabilities/default.json` — 添加所需插件权限

**依赖更新(如需新插件)**:
11. `src-tauri/Cargo.toml` — 添加 Rust 依赖
12. `package.json` — 添加 @tauri-apps/plugin-* 前端绑定

确认开始生成?
```

> **注意**:三层架构是强制规范:
> - **Command 层**:仅处理 IPC 调用、参数验证、错误转换
> - **Service 层**:业务逻辑、跨模块调用、事务处理
> - **Database 层**:SQL 执行、数据映射、连接池管理

---

### 第六步:自动生成代码

#### 6.1 Rust 后端代码(三层架构)

**1. Command 层** — `src-tauri/src/commands/xxx.rs`

```rust
use crate::error::AppError;
use crate::services::xxx as xxx_service;
use serde::{Deserialize, Serialize};

/// 功能数据结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct XxxData {
    pub id: i64,
    pub name: String,
    pub status: i32,
    pub created_at: String,
}

/// 创建请求
#[derive(Debug, Deserialize)]
pub struct CreateXxxRequest {
    pub name: String,
    pub status: Option<i32>,
}

/// 获取列表 Command
#[tauri::command]
pub async fn get_xxx_list(
    app: tauri::AppHandle,
) -> Result<Vec<XxxData>, AppError> {
    xxx_service::get_list(app).await
}

/// 创建 Command
#[tauri::command]
pub async fn create_xxx(
    app: tauri::AppHandle,
    request: CreateXxxRequest,
) -> Result<XxxData, AppError> {
    // 参数验证
    if request.name.trim().is_empty() {
        return Err(AppError::ValidationError("Name cannot be empty".to_string()));
    }

    xxx_service::create(app, request).await
}

/// 更新 Command
#[tauri::command]
pub async fn update_xxx(
    app: tauri::AppHandle,
    id: i64,
    request: CreateXxxRequest,
) -> Result<XxxData, AppError> {
    if request.name.trim().is_empty() {
        return Err(AppError::ValidationError("Name cannot be empty".to_string()));
    }

    xxx_service::update(app, id, request).await
}

/// 删除 Command
#[tauri::command]
pub async fn delete_xxx(
    app: tauri::AppHandle,
    id: i64,
) -> Result<(), AppError> {
    xxx_service::delete(app, id).await
}

/// 根据 ID 获取 Command
#[tauri::command]
pub async fn get_xxx_by_id(
    app: tauri::AppHandle,
    id: i64,
) -> Result<Option<XxxData>, AppError> {
    xxx_service::get_by_id(app, id).await
}
```

**2. Service 层** — `src-tauri/src/services/xxx.rs`

```rust
use crate::commands::xxx::{CreateXxxRequest, XxxData};
use crate::database::xxx as xxx_db;
use crate::error::AppError;
use tauri::AppHandle;

/// 获取列表(业务逻辑层)
pub async fn get_list(app: AppHandle) -> Result<Vec<XxxData>, AppError> {
    // 可以在此处添加业务逻辑:
    // - 权限检查
    // - 数据过滤
    // - 缓存处理
    // - 跨模块调用

    xxx_db::get_all(&app).await
}

/// 创建(业务逻辑层)
pub async fn create(
    app: AppHandle,
    request: CreateXxxRequest,
) -> Result<XxxData, AppError> {
    // 业务逻辑:
    // - 检查重复
    // - 设置默认值
    // - 触发事件

    let status = request.status.unwrap_or(1);

    xxx_db::create(&app, &request.name, status).await
}

/// 更新(业务逻辑层)
pub async fn update(
    app: AppHandle,
    id: i64,
    request: CreateXxxRequest,
) -> Result<XxxData, AppError> {
    // 检查是否存在
    let existing = xxx_db::get_by_id(&app, id).await?;
    if existing.is_none() {
        return Err(AppError::NotFound(format!("Xxx with id {} not found", id)));
    }

    let status = request.status.unwrap_or(1);
    xxx_db::update(&app, id, &request.name, status).await
}

/// 删除(业务逻辑层)
pub async fn delete(app: AppHandle, id: i64) -> Result<(), AppError> {
    // 业务逻辑:
    // - 检查关联数据
    // - 软删除逻辑
    // - 触发清理事件

    let existing = xxx_db::get_by_id(&app, id).await?;
    if existing.is_none() {
        return Err(AppError::NotFound(format!("Xxx with id {} not found", id)));
    }

    xxx_db::delete(&app, id).await
}

/// 根据 ID 获取(业务逻辑层)
pub async fn get_by_id(
    app: AppHandle,
    id: i64,
) -> Result<Option<XxxData>, AppError> {
    xxx_db::get_by_id(&app, id).await
}
```

**3. Database 层** — `src-tauri/src/database/xxx.rs`

```rust
use crate::commands::xxx::XxxData;
use crate::database::get_connection;
use crate::error::AppError;
use tauri::AppHandle;

/// 获取所有记录
pub async fn get_all(app: &AppHandle) -> Result<Vec<XxxData>, AppError> {
    let conn = get_connection(app)?;

    let mut stmt = conn.prepare(
        "SELECT id, name, status, created_at FROM xxx ORDER BY created_at DESC"
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(XxxData {
            id: row.get(0)?,
            name: row.get(1)?,
            status: row.get(2)?,
            created_at: row.get(3)?,
        })
    })?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }

    Ok(items)
}

/// 根据 ID 获取
pub async fn get_by_id(app: &AppHandle, id: i64) -> Result<Option<XxxData>, AppError> {
    let conn = get_connection(app)?;

    let mut stmt = conn.prepare(
        "SELECT id, name, status, created_at FROM xxx WHERE id = ?"
    )?;

    let mut rows = stmt.query_map([id], |row| {
        Ok(XxxData {
            id: row.get(0)?,
            name: row.get(1)?,
            status: row.get(2)?,
            created_at: row.get(3)?,
        })
    })?;

    if let Some(row) = rows.next() {
        Ok(Some(row?))
    } else {
        Ok(None)
    }
}

/// 创建记录
pub async fn create(
    app: &AppHandle,
    name: &str,
    status: i32,
) -> Result<XxxData, AppError> {
    let conn = get_connection(app)?;

    conn.execute(
        "INSERT INTO xxx (name, status, created_at) VALUES (?, ?, datetime('now'))",
        (name, status),
    )?;

    let id = conn.last_insert_rowid();

    // 返回创建的记录
    get_by_id(app, id).await?.ok_or_else(|| {
        AppError::DatabaseError("Failed to retrieve created record".to_string())
    })
}

/// 更新记录
pub async fn update(
    app: &AppHandle,
    id: i64,
    name: &str,
    status: i32,
) -> Result<XxxData, AppError> {
    let conn = get_connection(app)?;

    conn.execute(
        "UPDATE xxx SET name = ?, status = ? WHERE id = ?",
        (name, status, id),
    )?;

    // 返回更新后的记录
    get_by_id(app, id).await?.ok_or_else(|| {
        AppError::DatabaseError("Failed to retrieve updated record".to_string())
    })
}

/// 删除记录
pub async fn delete(app: &AppHandle, id: i64) -> Result<(), AppError> {
    let conn = get_connection(app)?;

    conn.execute("DELETE FROM xxx WHERE id = ?", [id])?;

    Ok(())
}
```

**4. 注册 Database 模块** — `src-tauri/src/database/mod.rs`

```rust
// 在文件中添加模块声明
pub mod xxx;

// 如果需要数据库表,在 init_database 函数中添加建表 SQL
pub fn init_database(app: &AppHandle) -> Result<(), AppError> {
    let conn = get_connection(app)?;

    // ... 已有表 ...

    // 新增 xxx 表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS xxx (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            status INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        )",
        [],
    )?;

    Ok(())
}
```

**5. 注册 Command** — `src-tauri/src/lib.rs`

```rust
// 在文件顶部添加模块导入
mod commands;
mod services;
mod database;
mod error;

// 在 run 函数中注册 Command
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 其他插件...
        .setup(|app| {
            // 初始化数据库
            database::init_database(&app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 已有 commands...
            commands::xxx::get_xxx_list,
            commands::xxx::create_xxx,
            commands::xxx::update_xxx,
            commands::xxx::delete_xxx,
            commands::xxx::get_xxx_by_id,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

#### 6.2 React 前端代码

**6. TypeScript 类型定义** — `src/types/index.ts`

```typescript
// 在文件中添加新类型

export interface XxxData {
  id: number;
  name: string;
  status: number;
  createdAt: string;
}

export interface CreateXxxRequest {
  name: string;
  status?: number;
}

export interface QueryXxxRequest {
  keyword?: string;
  page?: number;
  pageSize?: number;
}
```

**7. API 封装** — `src/lib/api/index.ts`

```typescript
// 在文件中添加新 API 函数

// Xxx 管理 API
export async function getXxxList(): Promise<XxxData[]> {
  return invoke('get_xxx_list');
}

export async function createXxx(request: CreateXxxRequest): Promise<XxxData> {
  return invoke('create_xxx', { request });
}

export async function updateXxx(id: number, request: CreateXxxRequest): Promise<XxxData> {
  return invoke('update_xxx', { id, request });
}

export async function deleteXxx(id: number): Promise<void> {
  return invoke('delete_xxx', { id });
}

export async function getXxxById(id: number): Promise<XxxData | null> {
  return invoke('get_xxx_by_id', { id });
}
```

**8. Zustand 状态管理(如需全局状态)** — `src/store/xxxStore.ts`

```typescript
import { create } from 'zustand';
import type { XxxData, CreateXxxRequest } from '@/types';
import { getXxxList, createXxx, updateXxx, deleteXxx } from '@/lib/api';

interface XxxState {
  items: XxxData[];
  loading: boolean;
  error: string | null;

  // Actions
  fetchList: () => Promise<void>;
  createItem: (request: CreateXxxRequest) => Promise<void>;
  updateItem: (id: number, request: CreateXxxRequest) => Promise<void>;
  deleteItem: (id: number) => Promise<void>;
  clearError: () => void;
}

export const useXxxStore = create<XxxState>((set, get) => ({
  items: [],
  loading: false,
  error: null,

  fetchList: async () => {
    set({ loading: true, error: null });
    try {
      const items = await getXxxList();
      set({ items, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  createItem: async (request) => {
    set({ loading: true, error: null });
    try {
      await createXxx(request);
      await get().fetchList();
      set({ loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
      throw error;
    }
  },

  updateItem: async (id, request) => {
    set({ loading: true, error: null });
    try {
      await updateXxx(id, request);
      await get().fetchList();
      set({ loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
      throw error;
    }
  },

  deleteItem: async (id) => {
    set({ loading: true, error: null });
    try {
      await deleteXxx(id);
      await get().fetchList();
      set({ loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
```

**9. React 页面组件** — `src/pages/Xxx/index.tsx`

```tsx
import { useEffect, useState } from 'react';
import { Button, Table, Space, Modal, Form, Input, InputNumber, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useXxxStore } from '@/store/xxxStore';
import type { XxxData, CreateXxxRequest } from '@/types';

export default function XxxPage() {
  const { items, loading, error, fetchList, createItem, updateItem, deleteItem, clearError } =
    useXxxStore();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<XxxData | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  useEffect(() => {
    if (error) {
      message.error(error);
      clearError();
    }
  }, [error, clearError]);

  const handleCreate = () => {
    form.resetFields();
    setEditingItem(null);
    setIsModalOpen(true);
  };

  const handleEdit = (record: XxxData) => {
    form.setFieldsValue({
      name: record.name,
      status: record.status,
    });
    setEditingItem(record);
    setIsModalOpen(true);
  };

  const handleDelete = (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除这条记录吗?',
      okText: '确认',
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteItem(id);
          message.success('删除成功');
        } catch (error) {
          message.error(`删除失败: ${error}`);
        }
      },
    });
  };

  const handleModalOk = async () => {
    try {
      const values = await form.validateFields();
      const request: CreateXxxRequest = {
        name: values.name,
        status: values.status,
      };

      if (editingItem) {
        await updateItem(editingItem.id, request);
        message.success('更新成功');
      } else {
        await createItem(request);
        message.success('创建成功');
      }

      setIsModalOpen(false);
      form.resetFields();
    } catch (error) {
      message.error(`操作失败: ${error}`);
    }
  };

  const columns: ColumnsType<XxxData> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 80,
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: number) => (status === 1 ? '启用' : '禁用'),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Space>
          <Button type="link" size="small" onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Button type="link" size="small" danger onClick={() => handleDelete(record.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="p-6">
      <div className="mb-4 flex justify-between items-center">
        <h2 className="text-2xl font-bold">Xxx 管理</h2>
        <Button type="primary" onClick={handleCreate}>
          新建
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={items}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingItem ? '编辑 Xxx' : '新建 Xxx'}
        open={isModalOpen}
        onOk={handleModalOk}
        onCancel={() => setIsModalOpen(false)}
        okText="确认"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item
            label="名称"
            name="name"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="请输入名称" />
          </Form.Item>

          <Form.Item label="状态" name="status" initialValue={1}>
            <InputNumber min={0} max={1} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
```

#### 6.3 权限配置

**10. 更新 Capabilities(如使用了新插件 API)**

```json
// src-tauri/capabilities/default.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    // ← 按需添加新权限
    "fs:default",
    "fs:allow-read-text-file",
    "fs:allow-write-text-file",
    "dialog:default",
    "notification:default"
  ]
}
```

#### 6.4 依赖更新(如需新插件)

**11. Rust 侧添加依赖**

```bash
# 进入 src-tauri 目录添加 Tauri 插件
cd src-tauri && cargo add tauri-plugin-fs tauri-plugin-dialog

# 添加其他 crate(如 reqwest)
cd src-tauri && cargo add reqwest --features json
```

**12. 前端侧添加插件绑定**

```bash
pnpm add @tauri-apps/plugin-fs @tauri-apps/plugin-dialog
```

**13. 在 Builder 中注册插件**

```rust
// src-tauri/src/main.rs 或 lib.rs
tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_fs::init())       // ← 新增
    .plugin(tauri_plugin_dialog::init())   // ← 新增
    // ...
```

---

### 第七步:完成报告

```markdown
## 代码生成完成

### 已完成
- Rust 三层架构实现(Commands → Services → Database)
- Rust 数据结构定义(Serialize/Deserialize)
- Rust 统一错误处理(AppError enum)
- TypeScript 类型定义(与 Rust 对齐)
- 前端 API 封装(统一 invoke 调用)
- Zustand 状态管理(如需全局状态)
- React 页面组件(Ant Design 5 + TailwindCSS 4)
- Capabilities 权限声明更新

### 生成的文件
**Rust 后端(三层架构)**:
- src-tauri/src/commands/xxx.rs — Command 层(IPC 入口)
- src-tauri/src/services/xxx.rs — Service 层(业务逻辑)
- src-tauri/src/database/xxx.rs — Database 层(数据持久化)
- src-tauri/src/database/mod.rs — 注册模块 + 建表 SQL
- src-tauri/src/lib.rs — Command 注册

**React 前端**:
- src/types/index.ts — TypeScript 类型
- src/lib/api/index.ts — API 封装
- src/store/xxxStore.ts — Zustand 状态管理
- src/pages/Xxx/index.tsx — 页面组件

**配置**:
- src-tauri/capabilities/default.json — 权限声明更新

### 后续操作
- **重新运行** `pnpm tauri dev` 使 Rust 代码变更生效
- **如添加了新插件**,需确认 `cargo add` 和 `pnpm add` 已执行
- **如添加了新窗口**,需在 `tauri.conf.json` 的 `app.windows` 中配置
- **如需添加路由**,在前端路由配置中添加页面路由
- 推荐运行 `/check` 检查代码规范
- 推荐运行 `cd src-tauri && cargo clippy` 检查 Rust 代码质量
```

---

## AI 强制执行规则

### 流程控制
1. **仅在第五步确认一次,其他步骤自动执行**
2. **第二步必须检查功能是否存在**(Grep 搜索 Commands/Services/API/Pages)
3. **第三步必须读参考代码**(commands/user.rs / services/user.rs / database/mod.rs / lib/api/index.ts / pages/Users/index.tsx)
4. **禁止多次询问用户确认**(确认后直接生成全部代码)

### Rust 后端规范(三层架构)
5. **必须严格遵循三层架构**:
   - Command 层:IPC 入口、参数验证、错误转换
   - Service 层:业务逻辑、跨模块调用、事务处理
   - Database 层:SQL 执行、数据映射
6. **Command 必须返回 `Result<T, AppError>`**(统一错误处理)
7. **Rust 结构体必须 `#[derive(Debug, Serialize, Deserialize)]`**(serde 序列化必备)
8. **新 Command 必须在 `generate_handler![]` 中注册**(否则前端 invoke 找不到)
9. **禁止在 Command/Service 中直接调用数据库**(必须通过 Database 层)
10. **Database 层函数必须是纯数据操作**(不含业务逻辑)
11. **错误处理必须使用 AppError**(不使用 String,使用 thiserror 定义的枚举)
12. **禁止 `unwrap()` 处理可能失败的操作**(用 `?` 运算符)
13. **禁止在 Command 中 `panic!()`**(会导致应用崩溃)
14. **异步函数使用 `async fn`**(数据库操作、网络请求等)
15. **使用的插件必须在 Builder 中通过 `.plugin()` 注册**

### TypeScript 前端规范
16. **所有 invoke 调用必须封装在 `src/lib/api/index.ts` 中**(不在组件中直接调用)
17. **所有类型必须定义在 `src/types/index.ts` 中**(集中管理)
18. **全局状态使用 Zustand**(不使用 Context API)
19. **路径导入必须使用 `@/` 别名**(不使用相对路径 `../`)
20. **UI 组件使用 Ant Design 5**(不自己写基础组件)
21. **样式使用 TailwindCSS 4 类名**(不写自定义 CSS 文件,除非特殊需求)
22. **使用函数组件 + Hooks**(React 19 推荐模式,禁止 class 组件)
23. **禁止在前端直接访问文件系统**(通过 Tauri FS API 或 Rust Command)
24. **禁止前端直接 fetch 外部 API**(通过 Rust Command 代理请求)
25. **禁止使用 `any` 类型**(TypeScript strict 模式,定义明确接口)
26. **API 函数必须有错误处理**(try-catch 在调用处,不在 API 层吞掉错误)
27. **invoke 命令名使用 snake_case**(与 Rust 函数名一致)

### 权限配置规范
28. **使用的插件 API 必须在 Capabilities 中声明权限**(Tauri 2.x 运行时强制检查)
29. **新插件既要 Rust 侧 `cargo add` 也要前端侧 `pnpm add`**(双端绑定)
30. **禁止在 Capabilities 中声明未使用的权限**(最小权限原则)

### 桌面应用特有规范
31. **禁止涉及 REST API 路由注册**(Tauri 是桌面应用,不是 Web 服务器)
32. **禁止涉及复杂的数据库迁移脚本**(桌面应用数据库随应用管理,建表在 init_database 中)
33. **禁止涉及多租户设计**(桌面应用是单用户本地应用)
34. **禁止涉及菜单 SQL 初始化**(桌面应用无后台管理菜单系统)
35. **禁止涉及 RESTful 路径设计**(通信走 IPC invoke,不是 HTTP)
36. **跨平台路径必须使用 Tauri path API**(禁止硬编码 `C:\\` 或 `/home/`)

### 代码质量规范
37. **SQL 语句必须使用参数化查询**(防止 SQL 注入)
38. **数据库连接必须通过 `get_connection()` 获取**(统一连接管理)
39. **新数据表必须在 `init_database()` 中建表**(确保数据库初始化)
40. **前端组件必须处理 loading 和 error 状态**(用户体验)
41. **删除操作必须有确认对话框**(防止误删)
42. **表单必须有验证规则**(Ant Design Form + rules)
43. **成功/失败操作必须有提示**(message.success / message.error)
