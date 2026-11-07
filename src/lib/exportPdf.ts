/**
 * R-005：HTML 字符串 → 系统打印对话框 → 用户另存为 PDF。
 *
 * 为什么用 iframe 而不是 window.open / 新窗口：
 *   - window.open 会弹一个新的 webview 窗口，体验突兀且 Tauri 多窗口管理麻烦
 *   - 主窗口 window.print() 会打整个 React 应用 DOM，不是笔记 HTML
 *   - hidden iframe 是浏览器原生支持的打印目标（contentWindow.print），
 *     用户只看到打印对话框，不会看到 iframe 本身
 *
 * 工作流：
 *   1. 创建 hidden iframe，srcdoc 写入 HTML
 *   2. 等 iframe load 事件（HTML 已 inline base64，无网络等待）
 *   3. iframe.contentWindow.print() 触发原生对话框
 *   4. afterprint / focus / visibilitychange / 轮询焦点 任一命中后清理 iframe
 *
 * 跨平台：WebView2 / WKWebView / WebKitGTK 都支持 contentWindow.print 与原生
 * "另存为 PDF" 选项，无需额外权限。
 */

const PRINT_FRAME_ID_PREFIX = "kb-pdf-print-frame-";

/**
 * 把 HTML 字符串作为 PDF 打印源。
 *
 * @param html 完整的 HTML 文档字符串（必须是 self-contained，图片已 inline）
 * @param title 用作打印对话框默认文件名（浏览器会自动 sanitize）
 * @returns Promise，在打印对话框关闭且 iframe 清理完成后 resolve
 */
export function printHtmlAsPdf(html: string, title: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 进场先清掉可能残留的旧打印 iframe：上一次打印若收尾信号丢失，
    // 旧 iframe 会一直挂在主文档里拖慢/卡死渲染，多次打印叠加更严重。打印前统一清场。
    document
      .querySelectorAll(`iframe[id^="${PRINT_FRAME_ID_PREFIX}"]`)
      .forEach((el) => {
        try {
          el.parentNode?.removeChild(el);
        } catch {
          /* ignore */
        }
      });

    const iframe = document.createElement("iframe");
    iframe.id = `${PRINT_FRAME_ID_PREFIX}${Date.now()}`;
    iframe.setAttribute("aria-hidden", "true");
    // ⚠ 关键 1：iframe 必须有**真实布局尺寸**，否则 Chromium/WebView2 打印 0×0 iframe 时
    // 布局视口塌成 0、分页计算失效。用 A4@96dpi 宽度（794px）作内容布局宽，再用
    // left:-99999px 移出视口隐藏。不能用 width:0、display:none、visibility:hidden（都会破坏渲染）。
    // ⚠ 关键 2：高度**不能**锁死成一页高（1123px）——WebView2 打印 iframe 时只渲染 iframe
    // 元素视口内的内容，固定一页高 → 超出部分被裁掉 → 「只能打印第一页」。这里初始给一页高
    // 兜底布局，onload 后再撑满到内容 scrollHeight，让打印引擎拿到整篇文档去分页。
    iframe.style.cssText =
      "position:fixed;left:-99999px;top:0;width:794px;height:1123px;border:0;background:#fff;pointer-events:none;";

    let cleaned = false;
    let settled = false;
    let printStartedAt = 0;
    let pollTimer: number | null = null;
    let forceCleanupTimer: number | null = null;

    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener("focus", onMainFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange, true);
      if (pollTimer != null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      if (forceCleanupTimer != null) {
        window.clearTimeout(forceCleanupTimer);
        forceCleanupTimer = null;
      }
      // 先把大 iframe 缩回极小并清空内容，再移除节点。
      // 原因：问题现场是「关闭打印后主页面持续卡顿」——根因不是打印本身，而是超高 iframe
      // 残留在主文档里继续参与布局/内存占用。即使 removeChild 在某些内核里延后，
      // 先 shrink + blank 也能立刻解除主窗负担。
      try {
        iframe.style.width = "1px";
        iframe.style.height = "1px";
        iframe.srcdoc = "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>";
        iframe.src = "about:blank";
      } catch {
        /* ignore */
      }
      try {
        iframe.parentNode?.removeChild(iframe);
      } catch {
        /* ignore */
      }
    };

    const finish = () => {
      cleanup();
      settle();
    };

    // 主窗 focus 兜底：打印对话框是模态系统窗口，关闭后 Tauri 主 WebView 往往重新获得焦点。
    // 但 WebView2 的 focus/afterprint 都不稳定，所以它只是一个信号源，不再是唯一兜底。
    const onMainFocus = () => {
      // 某些内核会在 print() 调起瞬间也抖一次 focus；加最小时间窗，避免过早清掉 iframe。
      if (Date.now() - printStartedAt < 300) return;
      setTimeout(finish, 150);
    };

    // 某些系统打印 UI 不会触发 focus，但会让页面在对话框关闭后从 hidden 回到 visible。
    const onVisibilityChange = () => {
      if (document.hidden) return;
      if (Date.now() - printStartedAt < 300) return;
      setTimeout(finish, 150);
    };

    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) {
        cleanup();
        reject(new Error("iframe contentWindow 不可用"));
        return;
      }

      // 设置 iframe document.title 让打印对话框默认文件名跟随笔记标题
      try {
        if (iframe.contentDocument) {
          iframe.contentDocument.title = title;
        }
      } catch {
        /* 跨域情况下访问会抛错，忽略：srcdoc 同源所以一般不会进 catch */
      }

      // ⚠ 多页修复核心：把 iframe 元素高度撑满到内容全高，否则 WebView2 只渲染初始视口
      // 那一页高的内容、其余被裁 →「只能打印第一页」。onload 此刻 srcdoc 子资源（含 data:
      // base64 图片）已加载，scrollHeight 可准确反映整篇全高。
      try {
        const doc = win.document;
        // 测高前先解除文档根/体自身可能继承的 height:100% / overflow:hidden
        // （打印 HTML 注入了应用壳层 global.css 的 html,body,#root 规则）。否则 scrollHeight
        // 会被 clamp 成一屏高，下面的撑高失效。CSS 已兜底，这里 JS 再兜一层确保测高准确。
        if (doc.documentElement) {
          doc.documentElement.style.height = "auto";
          doc.documentElement.style.overflow = "visible";
        }
        if (doc.body) {
          doc.body.style.height = "auto";
          doc.body.style.overflow = "visible";
        }
        const fullHeight = Math.max(
          doc.documentElement?.scrollHeight || 0,
          doc.body?.scrollHeight || 0,
        );
        if (fullHeight > 0) {
          iframe.style.height = `${fullHeight}px`;
        }
      } catch {
        /* 测高失败就保留初始高度，graceful 降级 */
      }

      // 信号 1：afterprint 事件在用户关闭打印对话框后触发（无论确认还是取消）
      const onAfterPrint = () => {
        win.removeEventListener("afterprint", onAfterPrint);
        setTimeout(finish, 150);
      };
      win.addEventListener("afterprint", onAfterPrint);
      // 信号 2：主窗重新获得焦点
      window.addEventListener("focus", onMainFocus);
      // 信号 3：页面从 hidden 回到 visible
      document.addEventListener("visibilitychange", onVisibilityChange, true);

      try {
        // 关键调用：必须先 focus 再 print，否则部分浏览器会忽略
        win.focus();
        printStartedAt = Date.now();
        win.print();
      } catch (e) {
        cleanup();
        reject(e);
        return;
      }

      // 信号 4：轮询 document.hasFocus() / hidden 状态。
      // 这是给 WebView2 的保底：有些机器 afterprint 不触发、focus 也不稳定，但对话框关闭后
      // 页面状态会恢复为「可见 + 有焦点」。一旦命中就立即清理残留 iframe。
      pollTimer = window.setInterval(() => {
        if (cleaned) return;
        if (Date.now() - printStartedAt < 500) return;
        if (!document.hidden && document.hasFocus()) {
          finish();
        }
      }, 500);

      // 信号 5：绝对兜底超时。即便所有事件都丢了，也不能把超高 iframe 永久留在主页面里。
      forceCleanupTimer = window.setTimeout(() => {
        if (!cleaned) finish();
      }, 10_000);
    };

    iframe.onerror = (e) => {
      cleanup();
      reject(e);
    };

    // srcdoc 设值后浏览器会异步加载并触发 onload
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}
