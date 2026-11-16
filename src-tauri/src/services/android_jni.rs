//! Rust 调 Android 应用自有 Kotlin 类的公共件（`com.agilefr.kb.*`）。
//!
//! 🔴 核心坑：`attach_current_thread` 出来的线程用的是**系统 ClassLoader**，
//! `find_class("com/agilefr/kb/Xxx")` 必然 ClassNotFoundException
//! （系统 ClassLoader 看不到应用自己的 dex）。必须借 Context 的 ClassLoader
//! 反射 `loadClass` 才能拿到应用类 —— 这是 Rust 调 Android 自有类的标准做法。
//!
//! 被调的 Kotlin 方法都要在 proguard-rules.pro 里 keep，否则 release 包里会被 R8 删掉。

use jni::objects::{JClass, JObject, JValue};
use jni::JavaVM;

/// 拿到 (JavaVM, Context)。Context 由 ndk_context 提供，tao 在启动时塞进去。
pub fn vm_and_context() -> Result<(JavaVM, *mut std::ffi::c_void), String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("取 JavaVM 失败: {e}"))?;
    Ok((vm, ctx.context()))
}

/// 借 Context 的 ClassLoader 加载应用自有类（绕开系统 ClassLoader 看不见 dex 的问题）
pub fn load_app_class<'a>(
    env: &mut jni::JNIEnv<'a>,
    context: &JObject<'a>,
    class_name: &str,
) -> Result<JClass<'a>, String> {
    let loader = env
        .call_method(context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .map_err(|e| format!("取 ClassLoader 失败: {e}"))?
        .l()
        .map_err(|e| format!("ClassLoader 返回值异常: {e}"))?;
    let name = env.new_string(class_name).map_err(|e| format!("构造类名字符串失败: {e}"))?;
    let class_obj = env
        .call_method(&loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[JValue::Object(&name)])
        .map_err(|e| format!("loadClass({class_name}) 失败: {e}"))?
        .l()
        .map_err(|e| format!("loadClass 返回值异常: {e}"))?;
    Ok(JClass::from(class_obj))
}
