use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{AutoLaunchManager, MacosLauncher};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// sidecar 子进程句柄（全局：信号处理线程与 Tauri 状态都能触达）。
static CHILD: OnceLock<Mutex<Option<CommandChild>>> = OnceLock::new();

/// SIGTERM/SIGINT 已触发标记：信号线程收割后调用 app.exit 前置位，防止重复。
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
struct AppPaths {
    data_dir: PathBuf,
    migrations_dir: PathBuf,
    dist_dir: PathBuf,
}

struct PortState(u16);
struct AppPathsState(AppPaths);

const PORT_RANGE: u16 = 20; // 7842..7862 依次探测

/// 找一个空闲本机端口：从 7842 起（与开发态默认端口一致）。
fn pick_port() -> Option<u16> {
    for off in 0..PORT_RANGE {
        let port = 7842 + off;
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

/// 与服务端 config.ts defaultDataDir 同源的数据目录约定（两处改动必须同步）：
/// macOS ~/Library/Application Support/noidle-resume；
/// Windows %APPDATA%\noidle-resume；Linux $XDG_DATA_HOME/noidle-resume。
#[cfg(target_os = "windows")]
fn default_data_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| {
        std::env::var("USERPROFILE")
            .map(|home| {
                PathBuf::from(home)
                    .join("AppData")
                    .join("Roaming")
                    .to_string_lossy()
                    .into_owned()
            })
            .unwrap_or_else(|_| "C:\\ProgramData".into())
    });
    PathBuf::from(base).join("noidle-resume")
}

#[cfg(target_os = "macos")]
fn default_data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("noidle-resume")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_data_dir() -> PathBuf {
    let base = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        format!("{home}/.local/share")
    });
    PathBuf::from(base).join("noidle-resume")
}

/// 轮询 /api/v1/health 直到服务就绪（最多 20s；bun 冷启动 1-2s 内完成）。
fn wait_healthy(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let req = format!(
        "GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    while Instant::now() < deadline {
        if let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", port)) {
            let _ = s.write_all(req.as_bytes());
            let mut buf = String::new();
            if s.read_to_string(&mut buf).is_ok() && buf.contains("200") {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

fn read_token(data_dir: &PathBuf) -> Option<String> {
    std::fs::read_to_string(data_dir.join("token.txt"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 收割 sidecar；返回是否确有子进程被杀。
fn reap_child() -> bool {
    let Some(cell) = CHILD.get() else {
        return false;
    };
    let child = cell.lock().unwrap().take();
    match child {
        Some(c) => {
            let _ = c.kill();
            true
        }
        None => false,
    }
}

/// SIGTERM/SIGINT：收割 sidecar 后退出（launchd/killall 的退出路径）。
/// Windows 无 Unix 信号：退出统一走托盘「退出」/关窗/壳进程消亡路径（下方 cfg 门）。
#[cfg(unix)]
fn install_signal_handler() {
    std::thread::spawn(|| {
        let signals = signal_hook::consts::TERM_SIGNALS;
        let mut signals = match signal_hook::iterator::Signals::new(signals) {
            Ok(s) => s,
            Err(_) => return,
        };
        for _sig in signals.forever() {
            if SHUTTING_DOWN.swap(true, Ordering::SeqCst) {
                continue; // 已在退出流程中
            }
            reap_child();
            std::process::exit(0);
        }
    });
}

#[cfg(not(unix))]
fn install_signal_handler() {}

fn spawn_server(app: &AppHandle, port: u16, paths: &AppPaths) -> Result<(), String> {
    let sidecar = app
        .shell()
        .sidecar("noidle-server")
        .map_err(|e| format!("定位 sidecar 失败: {e}"))?
        .env("CAR_PORT", port.to_string())
        .env("CAR_DATA_DIR", paths.data_dir.to_string_lossy().to_string())
        .env(
            "CAR_MIGRATIONS_DIR",
            paths.migrations_dir.to_string_lossy().to_string(),
        )
        .env("CAR_DIST_DIR", paths.dist_dir.to_string_lossy().to_string());
    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("启动 sidecar 失败: {e}"))?;
    *CHILD
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap() = Some(child);
    // sidecar 崩溃则随壳退出，避免留下无壳孤儿服务
    std::thread::spawn(move || {
        while let Some(ev) = tauri::async_runtime::block_on(rx.recv()) {
            if let CommandEvent::Terminated(status) = ev {
                if SHUTTING_DOWN.load(Ordering::SeqCst) {
                    return; // 正常退出路径，不告警
                }
                eprintln!("sidecar 意外退出: {status:?}");
                std::process::exit(1);
            }
        }
    });
    Ok(())
}

/// 菜单事件：开管理页 / 复制令牌 / 退出。
fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let port: u16 = app.state::<PortState>().0;
    let paths = app.state::<AppPathsState>().0.clone();
    match event.id().as_ref() {
        "open" => open_dashboard(app, port),
        "browser" => {
            let url = format!("http://127.0.0.1:{port}/");
            let _ = app.opener().open_url(url, None::<&str>);
        }
        "copy_token" => match read_token(&paths.data_dir) {
            Some(t) => {
                let _ = app.clipboard().write_text(t);
            }
            None => {
                let _ = app
                    .opener()
                    .open_url(format!("http://127.0.0.1:{port}/"), None::<&str>);
            }
        },
        "quit" => {
            SHUTTING_DOWN.store(true, Ordering::SeqCst);
            reap_child();
            app.exit(0);
        }
        _ => {}
    }
}

/// 打开（或唤出）管理窗口：内嵌本地服务的 Web 界面。
/// 关窗只是隐藏（on_window_event 拦截 CloseRequested），应用留在托盘。
/// 窗口必须在主线程创建（健康检查线程等后台调用经 run_on_main_thread 派发）。
fn open_dashboard(app: &AppHandle, port: u16) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(w) = app.get_webview_window("dashboard") {
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        // 免登录：壳持有令牌，经 #token= 传给前端令牌门（hash 不发往服务端，用后即清）
        let mut url_s = format!("http://127.0.0.1:{port}/");
        let paths = app.state::<AppPathsState>().0.clone();
        if let Some(t) = read_token(&paths.data_dir) {
            url_s.push_str("#token=");
            url_s.push_str(&t);
        }
        let url: tauri::Url = url_s.parse().unwrap();
        let builder = WebviewWindowBuilder::new(&app, "dashboard", WebviewUrl::External(url))
            .title("NoIdle Resume")
            // 默认窗口 ~1060×740（2026-10-25 用户定案：原 1280×860 打开过大）
            .inner_size(1060.0, 740.0)
            .min_inner_size(960.0, 620.0)
            .theme(Some(tauri::Theme::Dark));
        // 红绿灯叠入内容区是 macOS 专属 API；Windows 用系统标准标题栏
        #[cfg(target_os = "macos")]
        let builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            // 红绿灯下移+左移:tao 的 y 是灯下方的余量,灯心 ≈ y-4;取 24 与 .side-top
            // 三键(高 52px 条内垂直居中,中心 y=26)横向对齐
            .traffic_light_position(tauri::LogicalPosition::new(20.0, 24.0));
        if let Err(e) = builder.build() {
            eprintln!("打开管理窗口失败: {e}");
        }
    });
}

pub fn run() {
    let port = pick_port().unwrap_or(7842);
    let data_dir = default_data_dir();
    install_signal_handler();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(PortState(port))
        .setup(move |app| {
            // 常规应用:Dock 显示 N 图标、⌘Tab 可切;关窗=隐藏,点 Dock 图标唤回(见 Reopen)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            let resource_dir = app.path().resource_dir()?;
            let paths = AppPaths {
                data_dir: data_dir.clone(),
                migrations_dir: resource_dir.join("migrations"),
                dist_dir: resource_dir.join("dist"),
            };
            app.manage(AppPathsState(paths.clone()));

            spawn_server(app.handle(), port, &paths)?;

            // 服务就绪后自动弹出管理窗口（首次启动即见界面）
            std::thread::spawn({
                let app = app.handle().clone();
                move || {
                    if wait_healthy(port, Duration::from_secs(20)) {
                        open_dashboard(&app, port);
                    } else {
                        eprintln!("sidecar 健康检查超时（端口 {port}）");
                    }
                }
            });

            // 托盘
            let open = MenuItemBuilder::with_id("open", "打开管理窗口").build(app)?;
            let browser = MenuItemBuilder::with_id("browser", "在浏览器打开").build(app)?;
            let copy_token = MenuItemBuilder::with_id("copy_token", "复制访问令牌").build(app)?;
            let autostart_item = tauri::menu::CheckMenuItemBuilder::with_id("autostart", "登录时启动")
                .checked(app.state::<AutoLaunchManager>().is_enabled().unwrap_or(false))
                .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&open)
                .item(&browser)
                .item(&copy_token)
                .item(&autostart_item)
                .separator()
                .item(&quit)
                .build()?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("NoIdle Resume")
                .menu(&menu)
                .show_menu_on_left_click(false) // 左键开窗口，右键出菜单
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        open_dashboard(tray.app_handle(), tray.app_handle().state::<PortState>().0);
                    }
                })
                .on_menu_event(|app, event| {
                    // 自启项：勾选态由 CheckMenuItem 自身切换，这里同步开/关
                    if event.id().as_ref() == "autostart" {
                        let m = app.state::<AutoLaunchManager>();
                        let enabled = m.is_enabled().unwrap_or(false);
                        let _ = if enabled { m.disable() } else { m.enable() };
                        return;
                    }
                    on_menu_event(app, event);
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 = 隐藏：应用继续留在菜单栏，左键托盘图标秒开
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 初始化失败")
        .run(move |app, event| {
            match event {
                tauri::RunEvent::Exit => {
                    reap_child();
                }
                // 常规应用:关窗=隐藏,点 Dock 图标把管理页调回前台
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => open_dashboard(app, port),
                _ => {}
            }
        });
}
