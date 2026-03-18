---
name: performance-doctor
description: |
  Tauri 性能诊断技能，覆盖 Rust 编译优化、前端性能和应用体积优化。

  触发场景：
  - 应用启动慢或运行卡顿
  - 需要优化 Rust 编译时间
  - 需要减小安装包体积
  - 需要分析前端渲染性能

  触发词：性能、优化、慢、卡顿、编译时间、体积、内存、CPU、profiling、启动速度
---

# Tauri 性能诊断

## 性能维度

| 维度 | 典型问题 | 工具 |
|------|---------|------|
| **Rust 编译时间** | 首次编译 5-15 分钟 | `cargo build --timings` |
| **应用启动速度** | 窗口打开慢 | Tauri DevTools |
| **前端渲染** | UI 卡顿/不流畅 | Chrome DevTools Performance |
| **内存使用** | 内存持续增长 | 任务管理器 / Chrome DevTools Memory |
| **安装包体积** | 包太大 | `cargo bloat` / Vite 分析 |

---

## Rust 编译优化

### 加速开发编译

```toml
# src-tauri/Cargo.toml

# 开发模式优化（减少编译时间）
[profile.dev]
opt-level = 0           # 不优化（编译最快）
incremental = true      # 增量编译

# 仅优化依赖（不优化本地代码，加快重编译）
[profile.dev.package."*"]
opt-level = 2

# 发布模式优化（最小体积 + 最佳性能）
[profile.release]
opt-level = "z"         # 最小体积
lto = true              # 链接时优化
codegen-units = 1       # 单代码生成单元
strip = true            # 剥离调试信息
panic = "abort"         # panic 时直接 abort
```

### 减少编译时间

```toml
# .cargo/config.toml（项目级）
[build]
# 使用 mold 链接器（Linux）
# rustflags = ["-C", "link-arg=-fuse-ld=mold"]

# 使用 lld 链接器（Windows）
# rustflags = ["-C", "link-arg=-fuse-ld=lld"]
```

---

## 前端性能优化

### React 优化

```tsx
// 1. useMemo 缓存计算
const filteredItems = useMemo(() =>
  items.filter(item => item.name.includes(search)),
  [items, search]
);

// 2. useCallback 缓存回调
const handleClick = useCallback((id: number) => {
  invoke("delete_item", { id });
}, []);

// 3. React.memo 避免不必要的重渲染
const ListItem = React.memo(({ item }: { item: Item }) => (
  <div>{item.name}</div>
));

// 4. 虚拟列表（大量数据）
// pnpm add @tanstack/react-virtual
import { useVirtualizer } from "@tanstack/react-virtual";
```

### Vite 构建优化

```typescript
// vite.config.ts
export default defineConfig({
  build: {
    minify: "terser",
    terserOptions: {
      compress: { drop_console: true },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
        },
      },
    },
  },
});
```

---

## 安装包体积优化

### 分析体积

```bash
# Rust 依赖体积
cargo install cargo-bloat
cd src-tauri && cargo bloat --release

# 前端依赖体积
pnpm add -D rollup-plugin-visualizer
```

### 优化策略

| 策略 | 效果 | 方法 |
|------|------|------|
| Rust LTO + strip | -30~50% | Cargo.toml profile.release |
| 前端 tree-shaking | -10~20% | Vite 自动处理 |
| 移除 console.log | -1~5% | terser drop_console |
| 压缩图标 | -1~3% | 使用优化后的 PNG/ICO |
| UPX 压缩 | -30~50% | `upx --best target/release/app` |

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 不配置 release profile | 添加 LTO + strip + opt-level |
| 同步 Command 做耗时操作 | 使用 async Command 或 tokio::spawn |
| 大列表不用虚拟化 | 100+ 项使用 @tanstack/react-virtual |
| 不分析打包体积 | 使用 cargo bloat + Vite 分析器 |
| 每次 invoke 都建新连接 | 复用 State 中的数据库连接 |
