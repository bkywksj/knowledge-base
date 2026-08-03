import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * 白板字体离线化。
 *
 * Excalidraw 默认从 CDN（esm.sh）拉字体，而本应用是**离线优先的桌面应用**、
 * CSP 又只放行 `font-src 'self' data:` —— 不自托管的话白板文字会全部退化成
 * 系统字体（中文尤其明显：Xiaolai 手写体没了）。
 *
 * 这里在 Vite 启动/构建前把 `dist/prod/fonts` 同步到 `public/excalidraw/fonts`，
 * 配合 main.tsx 里的 `window.EXCALIDRAW_ASSET_PATH = "/excalidraw/"` 使用。
 * 产物不入 git（见 .gitignore），每次装完依赖自动重建，避免 14MB 二进制进仓库。
 */
function excalidrawAssetsPlugin() {
  const srcDir = path.resolve(
    __dirname,
    "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
  );
  const destDir = path.resolve(__dirname, "public/excalidraw/fonts");

  // ⚠️ 手写递归复制，**不要**用 fs.cpSync：
  // 在本项目的 Windows + Node 组合下，对这批字体（234 个文件 / 14MB）调 cpSync
  // 会让整个 Node 进程直接崩掉（退出码 3221226505 = STATUS_STACK_BUFFER_OVERRUN，
  // 无异常可捕获），连带 vite build 一起死。copyFileSync 逐个复制则完全正常。
  const copyDir = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, entry.name);
      const d = path.join(to, entry.name);
      if (entry.isDirectory()) copyDir(s, d);
      else fs.copyFileSync(s, d);
    }
  };

  return {
    name: "kb-excalidraw-assets",
    buildStart() {
      if (!fs.existsSync(srcDir)) {
        // 依赖没装全时不要炸掉整个构建，只提示；白板会退化成系统字体
        console.warn("[excalidraw] 未找到字体源目录，跳过同步:", srcDir);
        return;
      }
      // 幂等：目标已存在且顶层字体族数量一致就跳过（14MB 拷贝不必每次都做）
      if (
        fs.existsSync(destDir) &&
        fs.readdirSync(destDir).length === fs.readdirSync(srcDir).length
      ) {
        return;
      }
      fs.rmSync(destDir, { recursive: true, force: true });
      copyDir(srcDir, destDir);
      console.log("[excalidraw] 字体已同步到 public/excalidraw/fonts");
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), excalidrawAssetsPlugin()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },

  // Excalidraw（白板）要求：它的产物用了 "arbitrary module namespace identifier
  // names"（`export { x as "y" }`），esbuild 预打包必须 es2022 才认，否则 dev 直接
  // 报解析错误。只影响 optimizeDeps 阶段，跟下面 build.target 的老 WebView 兼容互不冲突
  // （build 时 esbuild 会把这个语法降级掉）。
  optimizeDeps: {
    esbuildOptions: { target: "es2022" },
  },

  // Excalidraw 内部读 process.env.IS_PREACT 判断运行时；Vite 默认把 process 剥掉，
  // 不注入会在运行时抛 "process is not defined" 让整个白板挂掉。
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },

  build: {
    // 生产构建优化
    // ⚠️ macOS 12 Monterey 自带 WKWebView = Safari 15.6，不支持 ES2023
    // (Array.findLast / toSorted / toReversed 等)。esnext 不做任何转译，
    // 一旦项目依赖（tiptap 3 / antd 6 / lucide 等）输出 ES2023 语法就会
    // 抛 SyntaxError 让整个 chunk 加载失败 → 白屏。
    // 把 target 限到 safari15 让 esbuild 把 ES2023 降级到 ES2020 兼容代码。
    // chrome88/edge88/firefox88 是 antd 6 官方最低门槛，对齐避免漏网。
    target: ["es2020", "safari15", "chrome88", "edge88", "firefox88"],
    minify: "terser",
    terserOptions: {
      compress: { drop_console: true, drop_debugger: true },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-antd": ["antd", "@ant-design/icons"],
          "vendor-editor": ["@tiptap/react", "@tiptap/starter-kit"],
          // 白板单独切块：Excalidraw 依赖树很重（roughjs / pica / jotai / radix-ui …），
          // 混进主 bundle 会拖慢所有用户的冷启动。配合前端的 React.lazy，
          // 只有真正打开白板的人才会下载这一块。
          "vendor-excalidraw": ["@excalidraw/excalidraw"],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },

  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
