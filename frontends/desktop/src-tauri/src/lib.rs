use std::process::{Command, Child, Stdio};
use std::io::{BufRead, BufReader};
use std::sync::Mutex;
use std::net::TcpStream;
use std::time::{Duration, Instant};
use std::thread;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const BRIDGE_PORT: u16 = 14168;
const CONDUCTOR_PORT: u16 = 8900;

static BRIDGE_PROCESS: Mutex<Option<Child>> = Mutex::new(None);
static SPAWNED_BRIDGE: Mutex<bool> = Mutex::new(false);

/// Get project root (parent of frontends/)
fn project_root() -> PathBuf {
    std::env::current_exe()
        .expect("cannot get exe path")
        .parent().expect("cannot get exe dir")   // frontends/
        .parent().expect("cannot get project root") // project root
        .to_path_buf()
}

fn find_bridge_script() -> PathBuf {
    // exe is at frontends/GenericAgent.exe
    // bridge is at frontends/desktop_bridge.py
    std::env::current_exe()
        .expect("cannot get exe path")
        .parent().expect("cannot get exe dir")
        .join("desktop_bridge.py")
}

/// Directory next to which a self-contained bundle keeps its runtime/ folder.
/// Windows: the exe's folder. Linux: the .AppImage's folder ($APPIMAGE) when launched as an
/// AppImage (current_exe would otherwise point inside the read-only squashfs mount).
/// macOS portable package: the folder containing GenericAgent.app and runtime/.
fn bundle_anchor_dir() -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        if let Some(p) = std::env::var_os("APPIMAGE") {
            if let Some(d) = PathBuf::from(p).parent() {
                return Some(d.to_path_buf());
            }
        }
    }

    let exe = std::env::current_exe().ok()?;

    #[cfg(target_os = "macos")]
    {
        // current_exe() inside a bundle is:
        //   <package>/GenericAgent.app/Contents/MacOS/GenericAgent
        // The portable runtime sits next to the .app:
        //   <package>/runtime/app/agentmain.py
        let mut d = exe.parent();
        while let Some(dir) = d {
            if dir.extension().and_then(|s| s.to_str()) == Some("app") {
                if let Some(parent) = dir.parent() {
                    return Some(parent.to_path_buf());
                }
            }
            d = dir.parent();
        }
    }

    Some(exe.parent()?.to_path_buf())
}

/// Embedded interpreter inside the bundle's runtime/python (base python, before venv).
fn bundle_python() -> Option<PathBuf> {
    let root = bundle_root()?;
    #[cfg(windows)]
    let p = root.join("python").join("python.exe");
    #[cfg(not(windows))]
    let p = root.join("python").join("bin").join("python3");
    if p.exists() { Some(p) } else { None }
}

/// Prepared virtualenv interpreter inside the bundle's runtime/app/.venv.
fn bundle_venv_python() -> Option<PathBuf> {
    let root = bundle_root()?;
    #[cfg(windows)]
    let candidates = [root.join("app").join(".venv").join("Scripts").join("python.exe")];
    #[cfg(not(windows))]
    let candidates = [
        root.join("app").join(".venv").join("bin").join("python"),
        root.join("app").join(".venv").join("bin").join("python3"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// Find python executable:
/// 1. The prepared bundle virtualenv (runtime/app/.venv) so bridge deps are available.
/// 2. The embedded bundle python (runtime/python) for first-run fallback.
/// 3. .portable/uv-python/ 下找 python.exe (Windows) 或 python3 (Unix)
/// 4. Fallback to system PATH
fn find_python() -> String {
    if let Some(p) = bundle_venv_python() {
        return p.to_string_lossy().to_string();
    }
    if let Some(p) = bundle_python() {
        return p.to_string_lossy().to_string();
    }
    let root = project_root();
    let portable_python_dir = root.join(".portable").join("uv-python");

    if portable_python_dir.exists() {
        // uv installs python like: uv-python/cpython-3.12.x-windows-x86_64/python.exe
        // We need to search for python.exe inside subdirectories
        if let Ok(entries) = std::fs::read_dir(&portable_python_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    #[cfg(windows)]
                    {
                        let py = path.join("python.exe");
                        if py.exists() {
                            return py.to_string_lossy().to_string();
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        let py = path.join("bin").join("python3");
                        if py.exists() {
                            return py.to_string_lossy().to_string();
                        }
                    }
                }
            }
        }
    }

    // Fallback: system PATH
    #[cfg(windows)]
    { "python".to_string() }
    #[cfg(not(windows))]
    { "python3".to_string() }
}

/// Find the project directory (folder containing agentmain.py).
/// Bundle layout: <exe dir>/runtime/app/agentmain.py. Dev layout: walk up from the exe.
fn find_project_dir() -> Option<String> {
    // Bundle layout: source tucked under <anchor>/runtime/app/
    if let Some(anchor) = bundle_anchor_dir() {
        let app = anchor.join("runtime").join("app");
        if app.join("agentmain.py").exists() {
            return Some(app.to_string_lossy().to_string());
        }
    }

    // Dev/source layout: walk up to 8 levels from the exe location.
    let exe = std::env::current_exe().ok()?;
    let mut dir = Some(exe.parent()?);
    for _ in 0..8 {
        match dir {
            Some(d) => {
                if d.join("agentmain.py").exists() {
                    return Some(d.to_string_lossy().to_string());
                }
                dir = d.parent();
            }
            None => break,
        }
    }
    None
}

/// Settings file path: ~/.ga_desktop_settings.json
fn settings_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ga_desktop_settings.json")
}

/// True when this binary is running from inside a macOS .app bundle (packaged build).
/// Used to refuse stale ~/.ga_desktop_settings.json that could point at an old checkout
/// when App Translocation hides our own runtime/ from current_exe().
#[cfg(target_os = "macos")]
fn running_inside_app_bundle() -> bool {
    std::env::current_exe()
        .ok()
        .map(|p| {
            p.components().any(|c| {
                c.as_os_str().to_string_lossy().ends_with(".app")
            })
        })
        .unwrap_or(false)
}

/// Read config from settings file, or auto-discover and save.
/// Self-contained bundles always prefer their own runtime/app over stale user settings,
/// otherwise an old ~/.ga_desktop_settings.json can silently point the UI at a different checkout.
pub fn get_or_discover_config() -> (String, String) {
    let path = settings_path();

    if bundle_root().is_some() {
        let python = find_python();
        let project = find_project_dir().unwrap_or_default();
        if !python.is_empty() && !project.is_empty() {
            let json = serde_json::json!({
                "python_path": python,
                "project_dir": project
            });
            let _ = std::fs::write(&path, serde_json::to_string_pretty(&json).unwrap());
            return (python, project);
        }
    }

    // Try reading existing settings.
    // On macOS, a packaged .app must never trust ~/.ga_desktop_settings.json: App
    // Translocation can run the bundle from a random read-only copy where bundle_root()
    // fails to see our own runtime/, and an old settings file would then silently point
    // the bridge at a previously installed checkout. In that case fall through to
    // auto-discovery (which still resolves the bundle via .app-relative search below).
    #[cfg(target_os = "macos")]
    let trust_settings = !running_inside_app_bundle();
    #[cfg(not(target_os = "macos"))]
    let trust_settings = true;

    if trust_settings && path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                let python = val.get("python_path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let project = val.get("project_dir")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !python.is_empty() && !project.is_empty() {
                    return (python, project);
                }
            }
        }
    }

    // Auto-discover
    let python = find_python();
    let project = find_project_dir().unwrap_or_default();

    // Save discovered config
    if !python.is_empty() && !project.is_empty() {
        let json = serde_json::json!({
            "python_path": python,
            "project_dir": project
        });
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&json).unwrap());
    }

    (python, project)
}

/// Self-contained bundle support dir: holds python/, wheels/, install_windows.ps1 and app/.
/// Typical portable layout keeps only the exe (+README) at the top level and tucks everything
/// else under <exe dir>/runtime/. Returns None when this is not a bundle (e.g. dev build).
fn bundle_root() -> Option<PathBuf> {
    let runtime = bundle_anchor_dir()?.join("runtime");
    if runtime.join("app").join("agentmain.py").exists() {
        return Some(runtime);
    }
    None
}

/// venv python created by the offline prepare step.
fn venv_python(project_dir: &Path) -> PathBuf {
    #[cfg(windows)]
    { project_dir.join(".venv").join("Scripts").join("python.exe") }
    #[cfg(not(windows))]
    { project_dir.join(".venv").join("bin").join("python") }
}

/// True when this is a self-contained bundle whose python env has not been prepared yet
/// (embedded python present but app/.venv missing). project_dir must be the app/ folder.
fn needs_first_run_prepare(project_dir: &str) -> bool {
    if project_dir.is_empty() { return false; }
    bundle_python().is_some() && !venv_python(Path::new(project_dir)).exists()
}

/// Run the offline prepare (install_windows.ps1 -Mode PrepareOnly) using bundled python + wheels.
/// Streams the script's stdout and forwards GAPROGRESS markers to `report(pct, message)`.
/// Blocking; intended to run on a background thread. Writes ~/.ga_desktop_settings.json.
fn run_offline_prepare(project_dir: &str, report: &dyn Fn(i32, &str)) -> Result<(), String> {
    let root = bundle_root().ok_or("cannot locate bundle root")?;
    let wheels = root.join("wheels");

    #[cfg(windows)]
    let (script, py) = (
        root.join("install_windows.ps1"),
        root.join("python").join("python.exe"),
    );
    #[cfg(target_os = "macos")]
    let (script, py) = (
        root.join("install_macos.sh"),
        root.join("python").join("bin").join("python3"),
    );
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let (script, py) = (
        root.join("install_linux.sh"),
        root.join("python").join("bin").join("python3"),
    );

    if !script.exists() || !py.exists() || !wheels.exists() {
        return Err(format!("prepare resources missing under {:?}", root));
    }

    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("powershell.exe");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .arg("-PythonPath").arg(&py)
            .arg("-ProjectDir").arg(project_dir)
            .arg("-WheelDir").arg(&wheels)
            .arg("-ExtraPipPackages").arg("fastapi uvicorn websockets")
            .args(["-Mode", "PrepareOnly", "-SkipNpmInstall"]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("bash");
        c.arg(&script)
            .arg("--python-path").arg(&py)
            .arg("--project-dir").arg(project_dir)
            .arg("--wheel-dir").arg(&wheels)
            .arg("--extra-packages").arg("fastapi uvicorn websockets")
            .args(["--mode", "PrepareOnly"]);
        c
    };

    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("failed to launch prepare: {}", e))?;

    // Forward the script's ASCII progress keys to the loading window, which localizes them
    // (window.gaProgress maps key -> zh/en by navigator.language).
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().flatten() {
            if let Some(key) = line.trim().strip_prefix("GAPROGRESS|") {
                match key.trim() {
                    "venv" => report(15, "venv"),
                    "deps" => report(45, "deps"),
                    "done" => report(90, "done"),
                    _ => {}
                }
            }
        }
    }

    let status = child.wait().map_err(|e| format!("prepare wait failed: {}", e))?;
    if !status.success() {
        return Err(format!("prepare exited with status {:?}", status.code()));
    }
    Ok(())
}

fn is_port_open(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    let Ok(sock_addr) = addr.parse() else {
        return false;
    };
    TcpStream::connect_timeout(&sock_addr, Duration::from_millis(300)).is_ok()
}

fn blocked_ports_label() -> Option<String> {
    let mut busy = Vec::new();
    if is_port_open(BRIDGE_PORT) {
        busy.push(format!("{} (bridge)", BRIDGE_PORT));
    }
    if is_port_open(CONDUCTOR_PORT) {
        busy.push(format!("{} (conductor)", CONDUCTOR_PORT));
    }
    if busy.is_empty() {
        None
    } else {
        Some(busy.join(", "))
    }
}

fn ensure_ports_free_for_start() -> Result<(), String> {
    if let Some(ports) = blocked_ports_label() {
        Err(format!(
            "端口已被占用：{}。请先结束旧的 desktop_bridge / conductor 进程。",
            ports
        ))
    } else {
        Ok(())
    }
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if is_port_open(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn request_bridge_shutdown() {
    use std::io::{Read, Write};
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", BRIDGE_PORT).parse().unwrap(),
        Duration::from_millis(800),
    ) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let req = b"POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let _ = stream.write_all(req);
    let _ = stream.read(&mut [0u8; 512]);
}

fn stop_spawned_bridge() {
    if !*SPAWNED_BRIDGE.lock().unwrap() {
        return;
    }
    request_bridge_shutdown();
    thread::sleep(Duration::from_millis(450));
    if let Some(mut child) = BRIDGE_PROCESS.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *SPAWNED_BRIDGE.lock().unwrap() = false;
}

fn mark_bridge_spawned(child: Child) {
    *BRIDGE_PROCESS.lock().unwrap() = Some(child);
    *SPAWNED_BRIDGE.lock().unwrap() = true;
}

fn spawn_bridge(py: &str, project_dir: &PathBuf) -> Result<(), String> {
    ensure_ports_free_for_start()?;
    let script = project_dir.join("frontends").join("desktop_bridge.py");
    if !script.exists() {
        return Err(format!("desktop_bridge.py not found at {:?}", script));
    }

    let mut cmd = Command::new(py);
    cmd.arg(&script).current_dir(project_dir);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let child = cmd.spawn().map_err(|e| format!("Failed to spawn bridge: {}", e))?;
    eprintln!("[tauri] started bridge PID={}", child.id());
    mark_bridge_spawned(child);
    Ok(())
}

fn show_port_busy(handle: &tauri::AppHandle, ports: &str) {
    let encoded: String = ports.chars().map(|c| match c {
        ' ' => "%20".to_string(),
        '(' => "%28".to_string(),
        ')' => "%29".to_string(),
        ',' => "%2C".to_string(),
        _ => c.to_string(),
    }).collect();
    let url = tauri::Url::parse(&format!("port_busy.html?ports={}", encoded)).unwrap();
    let handle = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("main") {
            let _ = w.navigate(url);
            let _ = w.show();
            let _ = w.set_focus();
        }
    });
}

/// True when required ports are taken. Shows port_busy on the main window when blocked.
fn ports_blocked_or_show(handle: &tauri::AppHandle) -> bool {
    if let Some(ports) = blocked_ports_label() {
        eprintln!("[tauri] ports blocked: {}", ports);
        show_port_busy(handle, &ports);
        true
    } else {
        false
    }
}

fn open_bridge_ui(handle: &tauri::AppHandle, dev_mode: bool) {
    let handle = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("main") {
            if let Ok(url) = tauri::Url::parse(&format!("http://127.0.0.1:{}/", BRIDGE_PORT)) {
                let _ = w.navigate(url);
            }
            if dev_mode {
                w.open_devtools();
            } else {
                let _ = w.eval(r#"
                    document.addEventListener('keydown', function(e) {
                        if (e.key === 'F12' || e.key === 'F5' ||
                            (e.ctrlKey && e.key === 'r') ||
                            (e.ctrlKey && e.shiftKey && e.key === 'I')) {
                            e.preventDefault();
                        }
                    });
                    document.addEventListener('contextmenu', function(e) {
                        e.preventDefault();
                    });
                "#);
            }
            let _ = w.show();
            let _ = w.set_focus();
        }
        if let Some(sw) = handle.get_webview_window("setup") {
            let _ = sw.hide();
        }
    });
}

#[tauri::command]
fn start_bridge_with_config(app_handle: tauri::AppHandle, python_path: String, project_dir: String) -> Result<(), String> {
    let path = settings_path();
    let obj = serde_json::json!({"python_path": python_path, "project_dir": project_dir});
    std::fs::write(&path, serde_json::to_string_pretty(&obj).unwrap())
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    let dir = PathBuf::from(&project_dir);
    if let Err(e) = spawn_bridge(&python_path, &dir) {
        let _ = ports_blocked_or_show(&app_handle);
        return Err(e);
    }

    if !wait_for_port(BRIDGE_PORT, Duration::from_secs(20)) {
        if ports_blocked_or_show(&app_handle) {
            return Err("Bridge ports in use".into());
        }
        return Err("Bridge did not become ready within 20s".into());
    }

    open_bridge_ui(&app_handle, false);

    Ok(())
}

#[tauri::command]
fn get_config() -> (String, String) {
    get_or_discover_config()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let no_autostart = args.iter().any(|a| a == "--no-autostart");
    let dev_mode = args.iter().any(|a| a == "--dev");

    let port_blocked = blocked_ports_label();
    let project_dir = find_project_dir().unwrap_or_default();
    let needs_prepare = needs_first_run_prepare(&project_dir);

    let mut spawned_bridge = false;
    if port_blocked.is_none() && !no_autostart && !needs_prepare {
        let (py_str, dir_str) = get_or_discover_config();
        let dir = PathBuf::from(&dir_str);
        if !py_str.is_empty() {
            match spawn_bridge(&py_str, &dir) {
                Ok(()) => spawned_bridge = true,
                Err(e) => eprintln!("[tauri] early bridge spawn failed: {}", e),
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![start_bridge_with_config, get_config])
        .setup(move |app| {
            // Show the loading window immediately so the first-run prepare isn't a blank screen.
            // The window starts on loading.html (a local page), so no "connection refused" flash.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }

            let handle = app.handle().clone();
            let project_dir = project_dir.clone();
            let port_blocked_setup = port_blocked.clone();
            thread::spawn(move || {
                let mut spawned_bridge = spawned_bridge;

                if let Some(ports) = &port_blocked_setup {
                    show_port_busy(&handle, ports);
                    return;
                }

                // Progress reporter: push status into the loading window (window.gaProgress).
                let main_win = handle.get_webview_window("main");
                let report = |pct: i32, msg: &str| {
                    if let Some(w) = &main_win {
                        let js = format!(
                            "window.gaProgress && window.gaProgress({}, {})",
                            pct,
                            serde_json::to_string(msg).unwrap_or_else(|_| "\"\"".to_string())
                        );
                        let _ = w.eval(&js);
                    }
                };

                // First-run (self-contained bundle): prepare the embedded python env offline,
                // then start the bridge with the freshly created venv.
                if needs_prepare {
                    report(5, "start");
                    if let Err(e) = run_offline_prepare(&project_dir, &report) {
                        eprintln!("[tauri] first-run prepare failed: {}", e);
                        if let Some(sw) = handle.get_webview_window("setup") { let _ = sw.show(); }
                        if let Some(mw) = handle.get_webview_window("main") { let _ = mw.hide(); }
                        return;
                    }
                    report(95, "starting");
                    if ports_blocked_or_show(&handle) {
                        return;
                    }
                    let (py_str, dir_str) = get_or_discover_config();
                    let dir = PathBuf::from(&dir_str);
                    match spawn_bridge(&py_str, &dir) {
                        Ok(()) => spawned_bridge = true,
                        Err(e) => {
                            eprintln!("[tauri] bridge spawn after prepare failed: {}", e);
                            if ports_blocked_or_show(&handle) {
                                return;
                            }
                        }
                    }
                }

                // First run (prepare) and cold bridge start may take a while; allow up to 60s.
                let wait = if needs_prepare || spawned_bridge {
                    Duration::from_secs(60)
                } else {
                    Duration::from_secs(2)
                };
                let bridge_ready = wait_for_port(BRIDGE_PORT, wait);

                if bridge_ready && spawned_bridge {
                    open_bridge_ui(&handle, dev_mode);
                } else if ports_blocked_or_show(&handle) {
                    // port_busy.html shown — do not attach to an orphan bridge.
                } else {
                    // Bridge never came up -> let the user fix paths in the setup window.
                    let handle = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if let Some(sw) = handle.get_webview_window("setup") {
                            if dev_mode {
                                let _ = sw.open_devtools();
                            }
                            let _ = sw.show();
                            let _ = sw.set_focus();
                        }
                        if let Some(mw) = handle.get_webview_window("main") {
                            let _ = mw.hide();
                        }
                    });
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let label = window.label();
                if label == "main" {
                    stop_spawned_bridge();
                    window.app_handle().exit(0);
                } else if label == "setup" {
                    // Setup closed -> exit if main is not visible
                    if let Some(main_win) = window.app_handle().get_webview_window("main") {
                        if !main_win.is_visible().unwrap_or(false) {
                            window.app_handle().exit(0);
                        }
                    } else {
                        window.app_handle().exit(0);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
