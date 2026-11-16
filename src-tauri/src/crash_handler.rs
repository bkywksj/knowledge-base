//! 全局 panic 兜底处理。
//!
//! 历史问题：release 构建启用 `windows_subsystem = "windows"`（无控制台），且入口此前没有
//! 安装 panic hook —— 任何 panic（尤其 `setup` 失败后经 `run().expect()` 触发的那个）都会让
//! 进程"窗口闪一下就消失"，既不输出到控制台、也不写进 tauri-plugin-log 的日志文件，导致
//! 线上闪退完全无法定位。
//!
//! 本模块在进程最早期安装 panic hook，做三件事，且**刻意不依赖 tauri / 任何插件**
//! （panic 可能发生在插件初始化之前，或崩溃时插件状态已不可用）：
//!   1. 把崩溃详情（时间 / 版本 / 线程 / panic 信息 / 源码位置 / 调用栈）写到独立崩溃日志文件；
//!   2. 输出到 stderr（dev 控制台 / 命令行启动时可见）；
//!   3. Windows 下弹一个原生 `MessageBoxW`，告知用户崩溃发生 + 日志位置（杜绝静默闪退）。

use std::cell::Cell;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// 防止 hook 自身再 panic 造成无限递归（写盘 / 弹窗内部万一失败时）。
static IN_HOOK: AtomicBool = AtomicBool::new(false);

/// 是否已经用 [`show_startup_notice`] 向用户解释过这次启动为什么失败。
///
/// 置位后 [`report_fatal`] 直接不做事 —— 否则用户会连吃两个弹窗：
/// 先一个"数据库版本过高，请升级应用"，紧接着一个"程序遇到问题需要关闭，很抱歉"，
/// 后者还会往 crash 目录写一份没意义的崩溃日志。
///
/// 为什么会连着弹：`setup` 里返回 Err 会一路冒泡成 `run()` 的 Err，
/// 而 `lib.rs` 末尾对 `run()` 失败是无差别 `report_fatal` 的。
/// 把"已经解释过了"这件事记在本模块，比让每个调用方自己记得跳过更可靠。
static NOTICE_SHOWN: AtomicBool = AtomicBool::new(false);

thread_local! {
    /// 本线程当前是否处于"预期 panic 会被 catch_unwind 接住"的区域。
    /// 为 true 时，全局 panic hook 只降级为一条 warn 日志，**不弹崩溃对话框、不写 crash 日志**——
    /// 因为这类 panic（如 pdf-extract 对不支持资源直接 `panic!`）已由上层兜底恢复，并非真崩溃。
    static EXPECTED_PANIC: Cell<bool> = const { Cell::new(false) };
}

/// 在"预期 panic 可被接住"的语义下执行 `f`：期间**本线程**发生的 panic 不会触发崩溃弹窗 /
/// crash 日志（hook 只记一条 warn），并被 `catch_unwind` 接住，以 `Err` 返回。
///
/// 用于像 `pdf-extract` 这类"用 `panic!` 表达未实现 / 不支持"、且已由上层（PDFium fallback 等）
/// 兜底的第三方调用——避免一份坏 PDF 触发的可恢复 panic 弹出吓人的"程序需要关闭"对话框。
///
/// 说明：全局 panic hook 在 panic 展开的**最开始**就执行，**早于** `catch_unwind` 捕获；
/// 因此必须用这个线程级标志显式告诉 hook“这个 panic 是预期可恢复的”。用 thread-local 而非全局
/// 标志，保证只静默**当前线程**该区域内的 panic，不误伤其它线程的真实崩溃。
pub fn catch_expected_panic<F, T>(f: F) -> std::thread::Result<T>
where
    F: FnOnce() -> T,
{
    let prev = EXPECTED_PANIC.with(|c| c.replace(true));
    // AssertUnwindSafe：调用方负责保证 f 捕获的状态在 panic 后不会被以不一致状态复用。
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    // 还原为进入前的值（支持嵌套调用）。此时 hook 已在 catch_unwind 内部跑完。
    EXPECTED_PANIC.with(|c| c.set(prev));
    result
}

/// 安装全局 panic hook。
///
/// - `crash_dir`：崩溃日志写入目录（约定 `<app_data_dir>/crash`），首次写入时按需创建。
/// - 应在进程**最早期**调用（`run()` 第一行）；在此之前发生的 panic 不会被本 hook 接管。
pub fn install(crash_dir: PathBuf) {
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 预期可恢复 panic（catch_expected_panic 区域内，如 pdf-extract 兜底）：
        // 只降级为一条 warn 日志，绝不弹崩溃对话框 / 不写 crash 日志——它会被上层 catch_unwind
        // 接住，应用并不会真的崩溃。放在最前面，避免为可恢复 panic 白跑 force_capture 回溯。
        if EXPECTED_PANIC.with(|c| c.get()) {
            let payload = info.payload();
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "<无法识别的 panic 负载>".to_string());
            let loc = info
                .location()
                .map(|l| format!("{}:{}", l.file(), l.line()))
                .unwrap_or_else(|| "<未知位置>".to_string());
            log::warn!("已捕获可恢复 panic（catch_unwind 兜底，非崩溃）: {msg} @ {loc}");
            return;
        }

        // 已经用 show_startup_notice 把原因讲清楚了 → 这次 panic 只是"启动失败"的传导，
        // 不该再弹一个"程序遇到问题，很抱歉"、也不该写 crash 日志。
        //
        // 为什么 panic hook 也要判：Tauri 在 `setup` 返回 Err 时是直接 `expect` 的
        // （tauri/src/app.rs "Failed to setup app"），走的是 panic 而非我们自己的
        // report_fatal —— 只堵后者会漏。
        if NOTICE_SHOWN.load(Ordering::SeqCst) {
            log::info!("启动失败原因已通过提示对话框告知用户，跳过崩溃弹窗");
            return;
        }

        // 重入保护：hook 内部若再 panic，直接返回，避免递归爆栈。
        if IN_HOOK.swap(true, Ordering::SeqCst) {
            return;
        }

        let report = build_report(info);

        // 1) stderr（dev 模式 / 从命令行启动时可直接看到）
        eprintln!("\n===== 知识库 崩溃 =====\n{report}\n=======================");

        // 2) 写独立崩溃日志（忽略一切写盘错误：hook 里绝不能再失败）
        let saved_path = write_report(&crash_dir, &report);

        // 3) Windows 原生错误对话框（绝不静默闪退的最后一道用户可见提示）
        #[cfg(windows)]
        show_native_dialog(&report, saved_path.as_deref());
        #[cfg(not(windows))]
        let _ = saved_path;

        // 4) 跑回原 hook（保留默认 backtrace 打印等行为）
        prev_hook(info);

        IN_HOOK.store(false, Ordering::SeqCst);
    }));
}

/// 主动上报一条致命错误（非 panic 路径，如 Tauri `run()` 返回 `Err`）：写日志 + 弹对话框。
/// 与 panic hook 共用同一套落盘 / 弹窗逻辑，保证两条退出路径表现一致。
pub fn report_fatal(crash_dir: PathBuf, message: &str) {
    // 已经用 show_startup_notice 讲清楚原因了，别再叠一个"程序遇到问题"吓用户
    if NOTICE_SHOWN.load(Ordering::SeqCst) {
        log::info!("[crash] 启动失败原因已通过提示对话框告知用户，跳过崩溃上报: {message}");
        return;
    }
    let when = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f %z")
        .to_string();
    let report = format!(
        "时间: {when}\n版本: {version}\n类型: 启动/运行致命错误\n信息: {message}\n",
        version = env!("CARGO_PKG_VERSION"),
    );

    eprintln!("\n===== 知识库 启动失败 =====\n{report}\n===========================");
    let saved_path = write_report(&crash_dir, &report);

    #[cfg(windows)]
    show_native_dialog(&report, saved_path.as_deref());
    #[cfg(not(windows))]
    let _ = saved_path;
}

/// 启动期的**非崩溃**告知弹窗：数据完好、只是这次起不来（如数据库版本高于应用）。
///
/// 单独开一个而不是复用 [`report_fatal`]：那个会写一份 crash 报告、文案是
/// "程序遇到问题需要关闭"，用在这里既误导用户（以为软件坏了），
/// 也会往 crash 目录堆无意义的文件。
pub fn show_startup_notice(title: &str, body: &str) {
    NOTICE_SHOWN.store(true, Ordering::SeqCst);
    eprintln!("
===== 知识库 无法启动 =====
{body}
===========================");
    #[cfg(windows)]
    show_native_notice(title, body);
    #[cfg(not(windows))]
    let _ = title;
}

/// 同 [`show_startup_notice`]，但多一个「打开链接」的选择：用户选了就用系统默认浏览器打开 `url`。
///
/// 用于"装新版就能好"的场景（如数据库版本高于应用）：用户回退了系统 / 装回旧版时
/// 手边往往没有新安装包，点一下直达下载页比手抄网址快得多（用户反馈）。
///
/// - `link_label`：确认按钮的文字（macOS / Linux 可自定义按钮文字；Windows 的 MessageBoxW
///   只有「是 / 否」，由调用方在正文里写清楚点哪个）。
/// - 正文里调用方应同时写上网址：按钮打不开浏览器时用户还能抄 / 复制。
/// - 三端都**只用系统自带能力**（MessageBoxW / osascript / zenity·kdialog），不依赖 tauri 插件：
///   这里处于 setup 阶段、event loop 还没跑起来，插件的对话框要等主线程循环才会弹出，
///   而调用方紧接着就 `exit(1)` 了。
pub fn show_startup_notice_with_link(title: &str, body: &str, link_label: &str, url: &str) {
    NOTICE_SHOWN.store(true, Ordering::SeqCst);
    eprintln!("
===== 知识库 无法启动 =====
{body}
===========================");
    if cfg!(test) {
        return;
    }
    if ask_open_link(title, body, link_label) {
        open_url(url);
    }
}

/// 弹「打开链接 / 关闭」二选一框，返回用户是否选了打开。
#[cfg(windows)]
fn ask_open_link(title: &str, body: &str, _link_label: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONWARNING, MB_SETFOREGROUND, MB_SYSTEMMODAL, MB_YESNO,
    };

    let w_title = to_wide(title);
    let w_body = to_wide(body);
    // SAFETY: 两个宽字符串均以 NUL 结尾且存活到调用结束；hwnd 传 null 表示无父窗口。
    let ret = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            w_body.as_ptr(),
            w_title.as_ptr(),
            MB_YESNO | MB_ICONWARNING | MB_SYSTEMMODAL | MB_SETFOREGROUND,
        )
    };
    ret == IDYES
}

/// macOS：osascript 的 `display dialog` 是系统自带的，按钮文字可自定义。
/// 用户点了哪个按钮从 stdout 的 `button returned:…` 读出来。
#[cfg(target_os = "macos")]
fn ask_open_link(title: &str, body: &str, link_label: &str) -> bool {
    let script = format!(
        "display dialog \"{}\" with title \"{}\" buttons {{\"关闭\", \"{}\"}} \
         default button 2 with icon caution",
        applescript_escape(body),
        applescript_escape(title),
        applescript_escape(link_label),
    );
    match std::process::Command::new("osascript").arg("-e").arg(&script).output() {
        Ok(out) => {
            out.status.success() && String::from_utf8_lossy(&out.stdout).contains(link_label)
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Linux：没有统一的原生对话框，依次试 zenity（GNOME 系）和 kdialog（KDE 系），
/// 两个都没装就只剩上面那行 stderr —— 至少不比之前差。
/// 二者都是「确认按钮退出码 0」。
#[cfg(all(unix, not(target_os = "macos")))]
fn ask_open_link(title: &str, body: &str, link_label: &str) -> bool {
    use std::process::Command;
    // --no-markup：正文里有路径，可能带 `&` `<` 之类，别被当成 Pango 标记吃掉
    let zenity = Command::new("zenity")
        .args(["--question", "--no-markup", "--title", title, "--text", body])
        .args(["--ok-label", link_label, "--cancel-label", "关闭"])
        .status();
    if let Ok(status) = zenity {
        return status.success();
    }
    let kdialog = Command::new("kdialog")
        .args(["--title", title, "--yes-label", link_label, "--no-label", "关闭"])
        .args(["--warningyesno", body])
        .status();
    matches!(kdialog, Ok(status) if status.success())
}

/// 用系统默认浏览器打开网址。打不开不报错：正文里已经写了网址，用户可以自己复制。
#[cfg(windows)]
fn open_url(url: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let w_op = to_wide("open");
    let w_url = to_wide(url);
    // SAFETY: 宽字符串均以 NUL 结尾且存活到调用结束；其余指针参数按文档允许为 null。
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            w_op.as_ptr(),
            w_url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }
}

#[cfg(not(windows))]
fn open_url(url: &str) {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    // 不等子进程：调用方马上就要 exit(1)，浏览器由系统接管，不随本进程退出
    let _ = std::process::Command::new(opener).arg(url).spawn();
}

/// 组装崩溃报告文本。
fn build_report(info: &std::panic::PanicHookInfo<'_>) -> String {
    // panic payload 文本（&str / String 两种常见形态）
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "<无法识别的 panic 负载>".to_string());

    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "<未知位置>".to_string());

    let thread = std::thread::current();
    let thread_name = thread.name().unwrap_or("<unnamed>").to_string();

    let when = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f %z")
        .to_string();

    // force_capture：即使未设置 RUST_BACKTRACE 也捕获。release 已 strip，符号可能缺失，
    // 但 panic 信息与源码位置（编译进二进制的字符串）仍然可靠。
    let backtrace = std::backtrace::Backtrace::force_capture();

    format!(
        "时间: {when}\n\
         版本: {version}\n\
         线程: {thread_name}\n\
         位置: {location}\n\
         信息: {message}\n\
         调用栈:\n{backtrace}\n",
        version = env!("CARGO_PKG_VERSION"),
    )
}

/// 把报告追加写入 `<crash_dir>/crash-YYYYMMDD.log`，返回写入的文件路径（失败返回 None）。
fn write_report(crash_dir: &Path, report: &str) -> Option<PathBuf> {
    // 目录按需创建；失败就直接放弃写盘（仍有 stderr + 对话框兜底）。
    let _ = std::fs::create_dir_all(crash_dir);

    let date = chrono::Local::now().format("%Y%m%d").to_string();
    let path = crash_dir.join(format!("crash-{date}.log"));

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    file.write_all("\n---------- 崩溃记录 ----------\n".as_bytes())
        .ok()?;
    file.write_all(report.as_bytes()).ok()?;
    let _ = file.flush();
    Some(path)
}

/// Windows 原生错误对话框：用 Win32 `MessageBoxW`，不依赖 tauri dialog 插件
/// （panic 时 event loop / 插件可能已不可用）。
#[cfg(windows)]
fn show_native_dialog(report: &str, saved_path: Option<&Path>) {
    // 测试进程里绝不弹模态框：MessageBoxW 会一直阻塞到有人点「确定」，
    // 本机跑 cargo test 是莫名其妙卡住，CI 上就是挂到超时被杀。
    if cfg!(test) {
        return;
    }
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_SYSTEMMODAL,
    };

    // 取 report 里"位置 / 信息"两行做摘要，避免对话框过长；取不到则回退展示前 4 行。
    let mut summary: String = report
        .lines()
        .filter(|l| l.starts_with("位置:") || l.starts_with("信息:"))
        .collect::<Vec<_>>()
        .join("\n");
    if summary.trim().is_empty() {
        summary = report.lines().take(4).collect::<Vec<_>>().join("\n");
    }

    let log_hint = match saved_path {
        Some(p) => format!("崩溃日志已保存到：\n{}", p.display()),
        None => "（崩溃日志写入失败，请从命令行启动查看输出）".to_string(),
    };

    let body = format!(
        "知识库遇到问题需要关闭，很抱歉。\n\n\
         {summary}\n\n\
         {log_hint}\n\n\
         如果反复出现，请把上面的崩溃日志文件发给开发者协助排查。"
    );

    let w_title = to_wide("知识库 - 程序遇到问题");
    let w_body = to_wide(&body);
    // SAFETY: 两个宽字符串均以 NUL 结尾且存活到调用结束；hwnd 传 null 表示无父窗口。
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            w_body.as_ptr(),
            w_title.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SYSTEMMODAL | MB_SETFOREGROUND,
        );
    }
}

/// 与 [`show_native_dialog`] 同机制，但用「警告」图标 + 原样展示正文
/// —— 这类情况不是崩溃，不该套那套"很抱歉/请把日志发给开发者"的文案。
#[cfg(windows)]
fn show_native_notice(title: &str, body: &str) {
    // 同 show_native_dialog：测试进程里不弹模态框，否则 cargo test 会卡死
    if cfg!(test) {
        return;
    }
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_SYSTEMMODAL,
    };

    let w_title = to_wide(title);
    let w_body = to_wide(body);
    // SAFETY: 两个宽字符串均以 NUL 结尾且存活到调用结束；hwnd 传 null 表示无父窗口。
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            w_body.as_ptr(),
            w_title.as_ptr(),
            MB_OK | MB_ICONWARNING | MB_SYSTEMMODAL | MB_SETFOREGROUND,
        );
    }
}

/// UTF-8 → 以 NUL 结尾的 UTF-16（Win32 宽字符 API 所需）。
#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 已经用 `show_startup_notice` 解释过原因后，`report_fatal` 必须彻底闭嘴：
    /// 不弹第二个"程序遇到问题"、也不往 crash 目录写日志。
    ///
    /// 断言落在「有没有写出 crash 文件」而不是「有没有弹窗」—— 弹窗在测试里没法断言，
    /// 而写文件是同一条早退分支之后的第一个副作用，能真实反映有没有走进去。
    ///
    /// ⚠️ 本用例会把进程级的 `NOTICE_SHOWN` 置位。目前全项目只有 `report_fatal`
    /// 读它，不会干扰其它用例；将来若有别的读取方，这里要改成可注入的形式。
    #[test]
    fn report_fatal_stays_silent_after_startup_notice() {
        let dir = std::env::temp_dir().join(format!(
            "kb-crash-silent-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        NOTICE_SHOWN.store(true, Ordering::SeqCst);
        report_fatal(dir.clone(), "这条不该被写出去");

        let written = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(written, 0, "已提示过用户时不该再写崩溃日志");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
