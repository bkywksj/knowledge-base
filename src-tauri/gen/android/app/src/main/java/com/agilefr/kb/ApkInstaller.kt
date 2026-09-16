package com.agilefr.kb

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

/**
 * APK 安装器 —— 从 Rust 侧经 JNI 调用（见 `commands/mobile_update.rs` 的 android_jni 模块）。
 *
 * ## 为什么不用 tauri-plugin-opener
 *
 * opener 的 Android 实现（OpenerPlugin.kt）只发 `Intent(ACTION_VIEW, uri)` +
 * `FLAG_ACTIVITY_NEW_TASK`，缺了安装 APK 必需的两样：
 *   1. `setDataAndType(uri, "application/vnd.android.package-archive")`
 *      —— 只给 data 不给 MIME，系统不知道该交给包安装器
 *   2. `FLAG_GRANT_READ_URI_PERMISSION`
 *      —— content:// URI 不授权，安装器读不到文件直接失败
 * 所以这段必须自己写。
 *
 * ## 为什么参数收 Context 而不是 Activity
 *
 * Rust 侧的 Activity 句柄来自 `ndk_context::android_context().context()`，它的契约
 * 只保证是个 `android.content.Context`（具体是 Activity 还是 Application Context 由
 * 宿主决定）。声明成 Activity 一旦拿到的是 Application Context 就 ClassCastException，
 * 收 Context 则两种都能跑 —— 代价是 `startActivity` 必须自带 `FLAG_ACTIVITY_NEW_TASK`
 * （从非 Activity Context 启动 Activity 的硬性要求），下面已经加了。
 *
 * ## 方法都是 @JvmStatic
 *
 * JNI 调静态方法（CallStaticObjectMethod）比先取实例再找字段简单得多。
 *
 * ## 🔴 必须配 ProGuard keep 规则，否则 release 包运行时必挂
 *
 * release 构建 `isMinifyEnabled = true`，R8 的静态分析看不见 JNI 反射调用，会把本类
 * 三个方法当成死代码 shrink 掉。更阴的是 wry 自带的 `proguard-wry.pro` 有一条
 * `-keep class com.agilefr.kb.* { native <methods>; }` —— 它保住了**类名**，却只
 * keep native 方法，这三个普通静态方法照删。结果就是运行时 `loadClass` 成功、
 * `call_static_method` 抛 NoSuchMethodError，报错信息完全看不出根因。
 * 规则写在 `app/proguard-rules.pro`，改本类方法签名时记得同步。
 *
 * 排查手法：看 `app/build/outputs/mapping/universalRelease/mapping.txt`，
 * 若 `com.agilefr.kb.ApkInstaller -> ...:` 行下方没有任何方法映射行，就是被 shrink 了。
 *
 * 🔴 本文件是**手写**的，不在 `generated/` 目录下。`pnpm tauri android init` 会重新
 * 生成 gen/android 的模板文件，本文件因不在模板清单里通常不会被删，但
 * **AndroidManifest 的 REQUEST_INSTALL_PACKAGES 权限、FileProvider 声明，以及
 * proguard-rules.pro 里的 keep 规则都可能被覆盖**，init 之后务必回头补这三处。
 */
object ApkInstaller {

    /**
     * 拉起系统安装器安装指定 APK。
     *
     * @param context 应用 Context（Rust 侧从 ndk_context 取）
     * @param apkPath APK 绝对路径，必须落在 FileProvider 声明的路径内
     *                （file_paths.xml 的 cache-path，即 app 的 cacheDir）
     * @return 空串 = 已拉起安装器；非空 = 错误信息（Rust 侧原样返回给前端）
     */
    @JvmStatic
    fun install(context: Context, apkPath: String): String {
        return try {
            val file = File(apkPath)
            if (!file.exists()) return "APK 文件不存在: $apkPath"
            if (file.length() <= 0L) return "APK 文件为空: $apkPath"

            // authorities 必须与 AndroidManifest 里 provider 的 android:authorities 完全一致
            // （那边写的是 ${applicationId}.fileprovider，applicationId = com.agilefr.kb）
            val uri: Uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file,
            )

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                // 授权安装器读这个 content:// URI —— 少了它必然失败
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                // 从非 Activity Context 启动 Activity 的硬性要求
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            ""
        } catch (e: Exception) {
            "拉起安装器失败: ${e.message}"
        }
    }

    /**
     * Android 8.0+ 装未知来源应用需要 REQUEST_INSTALL_PACKAGES 权限 + 用户在设置里给
     * 本应用单独开「允许安装未知应用」。这里只做查询，由前端决定是否引导。
     *
     * @return true = 已获授权（或系统低于 8.0 不需要授权）
     */
    @JvmStatic
    fun canRequestInstall(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            true
        }
    }

    /**
     * 跳到本应用的「允许安装未知应用」设置页，让用户手动打开开关。
     * 系统不允许应用自己授予这个权限，只能引导。
     *
     * @return 空串 = 已跳转；非空 = 错误信息
     */
    @JvmStatic
    fun openInstallPermissionSettings(context: Context): String {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${context.packageName}"),
                ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
                context.startActivity(intent)
            }
            ""
        } catch (e: Exception) {
            "打开权限设置页失败: ${e.message}"
        }
    }
}
