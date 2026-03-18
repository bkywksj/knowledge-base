---
name: file-storage
description: |
  Tauri 文件操作技能,覆盖 Rust std::fs 和 Tauri FS Plugin 的文件读写。

  触发场景:
  - 需要读写本地文件
  - 需要选择文件/目录(对话框)
  - 需要管理应用数据目录
  - 需要处理文件拖放

  触发词: 文件、读写、保存、打开、目录、文件系统、fs、拖放、导入、导出
---

# Tauri 文件操作

## 两种文件操作方式

| 方式 | 技术 | 适用场景 |
|------|------|---------|
| **Rust std::fs** | Rust 标准库 | Rust Command 中操作文件 |
| **Tauri FS Plugin** | @tauri-apps/plugin-fs | 前端直接操作文件(需权限) |

---

## 方式 1: Rust 文件操作(推荐)

### 读写文件

```rust
use std::fs;
use std::path::PathBuf;

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| format!("写入失败: {}", e))
}

#[tauri::command]
fn read_json_file<T: serde::de::DeserializeOwned>(path: String) -> Result<T, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into())
        .collect();
    Ok(names)
}
```

### 应用数据目录

```rust
#[tauri::command]
fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into())
        .map_err(|e| e.to_string())
}
```

---

## 方式 2: Tauri FS Plugin

### 安装

```bash
# Cargo.toml
tauri-plugin-fs = "2"
# package.json
pnpm add @tauri-apps/plugin-fs
```

### Capabilities 权限

```json
{
  "permissions": [
    "fs:default",
    "fs:allow-read-text-file",
    "fs:allow-write-text-file",
    "fs:allow-exists",
    "fs:allow-mkdir"
  ]
}
```

### TypeScript 使用

```typescript
import { readTextFile, writeTextFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";

// 读取文件
const content = await readTextFile("config.json", { baseDir: BaseDirectory.AppData });

// 写入文件
await writeTextFile("output.txt", "Hello World", { baseDir: BaseDirectory.AppData });

// 检查文件存在
const fileExists = await exists("config.json", { baseDir: BaseDirectory.AppData });
```

---

## 文件对话框

### 安装 Dialog 插件

```bash
tauri-plugin-dialog = "2"
pnpm add @tauri-apps/plugin-dialog
```

### 打开/保存对话框

```typescript
import { open, save } from "@tauri-apps/plugin-dialog";

// 选择文件
const selected = await open({
  multiple: false,
  filters: [{ name: "Text", extensions: ["txt", "md"] }],
});
if (selected) {
  const content = await invoke<string>("read_text_file", { path: selected });
}

// 保存文件
const savePath = await save({
  defaultPath: "output.txt",
  filters: [{ name: "Text", extensions: ["txt"] }],
});
if (savePath) {
  await invoke("write_text_file", { path: savePath, content: "data" });
}
```

---

## 常见路径 API

```typescript
import { appDataDir, appConfigDir, homeDir, desktopDir } from "@tauri-apps/api/path";

const dataDir = await appDataDir();    // 应用数据目录
const configDir = await appConfigDir(); // 应用配置目录
const home = await homeDir();          // 用户主目录
const desktop = await desktopDir();    // 桌面目录
```

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 硬编码路径 `"C:\\Users\\..."` | 使用 Tauri path API |
| 前端直接用 fs 不声明权限 | 在 capabilities 中声明 fs 权限 |
| 不处理文件不存在 | 先 exists() 检查或 catch 错误 |
| 路径拼接用字符串 | 使用 `std::path::PathBuf` (Rust) 或 `join()` (TS) |
