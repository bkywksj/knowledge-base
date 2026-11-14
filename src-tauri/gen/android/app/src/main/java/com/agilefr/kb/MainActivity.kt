package com.agilefr.kb

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * 开了 edge-to-edge 后网页会画到系统导航栏底下。前端靠 env(safe-area-inset-bottom) 让位，
   * 但 Android WebView 对三键导航栏报的是 0，底部 Tab 栏整条被导航键盖住。
   *
   * 这里在原生层给内容区补上导航栏的留白（横屏时导航栏在侧边，左右一起补），
   * 网页不再延伸到导航栏底下，所有页面一次生效。状态栏仍交给前端的
   * env(safe-area-inset-top) 处理，那边一直是好的。
   *
   * 🔴 键盘（IME）也必须在这里让：targetSdk 35+ 开了 edge-to-edge 后 adjustResize 不再缩 WebView，
   * visualViewport 也不变，前端 useKeyboardInset 恒为 0 —— 待办新建面板、编辑器格式条全被键盘盖住，
   * 正文也滚不上来（用户反馈截图）。这里底部留白取「导航栏 / 键盘」较大者，键盘弹出时 WebView 真实变矮，
   * 所有 fixed 底部面板自动贴在键盘上方；前端 hook 此时自然算出 0，不会重复垫高。
   *
   * 🔴 留白加在 Activity 根内容视图（android.R.id.content）上，不是 webView.parent：
   * 本回调触发时 WebView 还没挂到父容器上，parent 为 null —— 旧写法在这里直接 return，
   * 留白和下面的 JS 接口都没生效（2026-11-10 真机实测：WebView 高度等于整屏）。
   */
  override fun onWebViewCreate(webView: WebView) {
    // JS 接口只对之后加载的页面生效，必须在页面加载前注册，放最前面
    webView.addJavascriptInterface(SystemBarsBridge(), "KbSystemBars")

    val content = findViewById<View>(android.R.id.content) ?: return
    // 导航栏区域透出来的是这块底色，和底部 Tab 栏同色；切主题后由前端经 KbSystemBars 改成当前主题色
    content.setBackgroundColor(Color.WHITE)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
      // 键盘高度从屏幕底边量起、已含导航栏，取较大者而不是相加
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(nav.left, 0, nav.right, maxOf(nav.bottom, ime.bottom))
      // 导航栏已经由这里让开了，往下传给 WebView 时把这部分清零：否则手势导航下
      // WebView 仍报 env(safe-area-inset-bottom)=16，前端 Tab 栏再垫一次，底部空出两份（真机实测）。
      // 键盘同理清零：新版 WebView 会按 IME inset 再缩一次可视视口，前端会重复垫高
      WindowInsetsCompat.Builder(insets)
        .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.NONE)
        .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
        .build()
    }
    ViewCompat.requestApplyInsets(content)
  }

  /**
   * 给前端用的系统栏接口（src/lib/systemBars.ts）。只做两件事，不碰任何数据：
   * - 导航栏留白的底色跟着主题走（原来写死白色，深色主题下屏幕底部一条白边）
   * - 状态栏 / 导航栏图标深浅跟着主题走（深色主题下系统默认的深色图标看不见）
   */
  private inner class SystemBarsBridge {
    @JavascriptInterface
    fun set(colorHex: String, dark: Boolean) {
      runOnUiThread {
        try {
          findViewById<View>(android.R.id.content)?.setBackgroundColor(Color.parseColor(colorHex))
        } catch (_: IllegalArgumentException) {
          // 颜色串不认识就保持原样，不影响图标深浅
        }
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
      }
    }
  }
}
