package com.agilefr.kb

import android.content.Context
import android.net.wifi.WifiManager

/**
 * Wi-Fi 组播锁 —— 从 Rust 侧经 JNI 调用（见 `services/lan_discovery.rs` 的 multicast_lock 模块）。
 *
 * 局域网同步在电脑换了 IP 后用 mDNS 找电脑：电脑的回应是发往 224.0.0.251 的组播包，
 * 而 Android 的 Wi-Fi 为省电默认丢弃组播，不持有 MulticastLock 就一个包也收不到。
 * 只在查找那几秒里持有，用完立刻放掉（长期持有费电）。
 *
 * 锁是引用计数的单例：两次查找并发时各拿各放，最后一个放完才真正释放。
 * 方法都是 @JvmStatic，并在 proguard-rules.pro 里 keep（R8 看不见 JNI 调用，不 keep 会被删掉）。
 * 需要 CHANGE_WIFI_MULTICAST_STATE 权限（普通权限，装上即授予，不弹框）。
 */
object MulticastHelper {
  private var lock: WifiManager.MulticastLock? = null

  /** 返回空串 = 成功；否则是错误说明 */
  @JvmStatic
  @Synchronized
  fun acquire(context: Context): String {
    return try {
      val l = lock ?: run {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        wifi.createMulticastLock("kb-lan-discovery").apply { setReferenceCounted(true) }
      }
      lock = l
      l.acquire()
      ""
    } catch (e: Exception) {
      e.message ?: e.toString()
    }
  }

  @JvmStatic
  @Synchronized
  fun release() {
    try {
      lock?.let { if (it.isHeld) it.release() }
    } catch (_: Exception) {
      // 引用计数已归零时再放会抛 RuntimeException，忽略
    }
  }
}
