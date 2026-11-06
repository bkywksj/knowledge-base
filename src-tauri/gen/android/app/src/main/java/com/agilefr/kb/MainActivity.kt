package com.agilefr.kb

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
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
   * 这里在原生层给 WebView 外层补上导航栏的留白（横屏时导航栏在侧边，左右一起补），
   * 网页不再延伸到导航栏底下，所有页面一次生效。状态栏仍交给前端的
   * env(safe-area-inset-top) 处理，那边一直是好的。键盘（IME）也不在这里管，
   * 前端 useKeyboardInset 自己处理。
   */
  override fun onWebViewCreate(webView: WebView) {
    val container = webView.parent as? View ?: return
    // 导航栏区域透出来的是这块底色，和底部 Tab 栏同色
    container.setBackgroundColor(Color.WHITE)
    ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
      val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
      view.setPadding(nav.left, 0, nav.right, nav.bottom)
      insets
    }
    ViewCompat.requestApplyInsets(container)
  }
}
