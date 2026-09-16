# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ─── App 内更新：APK 安装器（JNI 反射调用，R8 看不见）────────────────────────
#
# 🔴 必须 keep，否则 release 包必然在运行时挂掉。
#
# ApkInstaller 的三个方法只被 Rust 侧经 JNI 反射调用
# （commands/mobile_update.rs 的 android_jni：ClassLoader.loadClass("com.agilefr.kb.ApkInstaller")
#  → call_static_method("install" / "canRequestInstall" / "openInstallPermissionSettings")）。
# R8 的静态分析看不到这条调用链，会判定方法无人引用直接 tree-shake 掉 —— 类壳子还在、
# 方法全没了，运行时 loadClass 能成功但 call_static_method 抛 NoSuchMethodError。
#
# 实证：v0.2.0 首次加这个类时没写本规则，mapping.txt 里
# `com.agilefr.kb.ApkInstaller -> com.agilefr.kb.ApkInstaller:` 下方**零条方法映射**
# （对比同包的 Ipc 有 postMessage 等），dex 里也搜不到 "canRequestInstall" 字符串。
-keep class com.agilefr.kb.ApkInstaller {
    public static <methods>;
}