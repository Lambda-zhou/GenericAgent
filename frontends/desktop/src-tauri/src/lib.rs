use std::process::{Command, Child, Stdio};
use std::io::{BufRead, BufReader};
use std::sync::Mutex;
use std::net::TcpStream;
use std::time::{Duration, Instant};
use std::thread;
use std::path::PathBuf;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

static BRIDGE_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

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

/// Find python executable:
/// 1. The embedded bundle python (runtime/python) — deps are installed directly into it
///    (no venv), and its path is resolved relative to the bundle anchor at runtime, so the
///    package stays relocatable (moving the folder doesn't break absolute venv paths).
/// 2. .portable/uv-python/ 下找 python.exe (Windows) 或 python3 (Unix)
/// 3. Fallback to system PATH
fn find_python() -> String {
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

/// Marker written after a successful offline prepare. Lives under runtime/ so it travels
/// with the bundle: a relocated folder stays "prepared" (deps live in the embedded python,
/// which is itself relocatable) and won't re-run prepare.
fn prepared_marker() -> Option<PathBuf> {
    Some(bundle_root()?.join(".prepared"))
}

/// True when this is a self-contained bundle whose python env has not been prepared yet
/// (embedded python present but deps not yet installed into it).
fn needs_first_run_prepare(project_dir: &str) -> bool {
    if project_dir.is_empty() { return false; }
    bundle_python().is_some() && prepared_marker().map(|m| !m.exists()).unwrap_or(false)
}

/// Clear env vars a host launcher injects pointing at its own runtime. The Linux AppImage exports
/// PYTHONHOME/PYTHONPATH (-> bundled python crashes with "No module named 'encodings'") and
/// LD_LIBRARY_PATH (-> wrong shared libs). Our bundled python / prepare / bridge must run clean.
fn sanitize_bundle_env(cmd: &mut Command) {
    cmd.env_remove("PYTHONHOME");
    cmd.env_remove("PYTHONPATH");
    cmd.env_remove("LD_LIBRARY_PATH");
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
            // -NoVenv: install deps straight into the embedded python (no venv) so the
            // bundle is relocatable. See prepared_marker / find_python.
            .args(["-Mode", "PrepareOnly", "-SkipNpmInstall", "-NoVenv"]);
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
            // --no-venv: install deps straight into the embedded python (no venv) so the
            // bundle is relocatable. See prepared_marker / find_python.
            .args(["--mode", "PrepareOnly", "--no-venv"]);
        c
    };

    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    sanitize_bundle_env(&mut cmd);
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
    // Record success so later launches (and relocated copies) skip the prepare step.
    if let Some(marker) = prepared_marker() {
        let _ = std::fs::write(&marker, b"ok\n");
    }
    Ok(())
}

const CONDUCTOR_PORT: u16 = 8900;
const SCHEDULER_LOCK_PORT: u16 = 45762;

fn is_port_open(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    let Ok(sock_addr) = addr.parse() else {
        return false;
    };
    TcpStream::connect_timeout(&sock_addr, Duration::from_millis(300)).is_ok()
}

fn extras_ports_busy_label() -> Option<String> {
    let mut busy = Vec::new();
    if is_port_open(CONDUCTOR_PORT) {
        busy.push(format!("{} (conductor)", CONDUCTOR_PORT));
    }
    if is_port_open(SCHEDULER_LOCK_PORT) {
        busy.push(format!("{} (scheduler)", SCHEDULER_LOCK_PORT));
    }
    if busy.is_empty() {
        None
    } else {
        Some(busy.join(", "))
    }
}

fn alert_extras_ports_busy(win: &tauri::WebviewWindow, ports: &str) {
    let msg = format!(
        "Conductor/Scheduler 端口已被占用：{}\n请结束占用进程后点「确定」重新检测。",
        ports
    );
    let js = format!(
        "alert({})",
        serde_json::to_string(&msg).unwrap_or_else(|_| "\"\"".to_string())
    );
    let _ = win.eval(&js);
}

/// Browser alert on loading.html; re-prompt if ports stay busy after dismiss.
fn wait_until_extras_ports_free(win: Option<&tauri::WebviewWindow>) {
    while let Some(ports) = extras_ports_busy_label() {
        eprintln!("[tauri] extras ports busy: {}", ports);
        if let Some(w) = win {
            alert_extras_ports_busy(w, &ports);
        }
        let wait_start = Instant::now();
        while extras_ports_busy_label().is_some() {
            if wait_start.elapsed() > Duration::from_secs(3) {
                break;
            }
            thread::sleep(Duration::from_millis(300));
        }
    }
}

fn request_stop_extras() {
    use std::io::{Read, Write};
    let Ok(mut stream) = TcpStream::connect_timeout(
        &"127.0.0.1:14168".parse().unwrap(),
        Duration::from_millis(800),
    ) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let req = b"POST /services/stop-extras HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let _ = stream.write_all(req);
    let _ = stream.read(&mut [0u8; 512]);
}

fn request_start_extras() {
    use std::io::{Read, Write};
    let Ok(mut stream) = TcpStream::connect_timeout(
        &"127.0.0.1:14168".parse().unwrap(),
        Duration::from_millis(800),
    ) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let req = b"POST /services/start-extras HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let _ = stream.write_all(req);
    let _ = stream.read(&mut [0u8; 512]);
}

/// GET /services/identity from a running bridge; returns the ga_root it serves (or None
/// when the endpoint is absent — i.e. an older/foreign bridge).
fn bridge_reported_ga_root() -> Option<String> {
    use std::io::{Read, Write};
    let mut stream = TcpStream::connect_timeout(
        &"127.0.0.1:14168".parse().unwrap(),
        Duration::from_millis(800),
    ).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let req = b"GET /services/identity HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    stream.write_all(req).ok()?;
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let body = text.split("\r\n\r\n").nth(1)?;
    let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    v.get("ga_root")?.as_str().map(|s| s.to_string())
}

/// Normalize a path for comparison (canonicalize; fall back to the raw string).
fn norm_path(p: &str) -> String {
    std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string())
}

/// True when the bridge on 14168 belongs to the SAME install as this exe (safe to reuse).
fn bridge_identity_matches(project_dir: &str) -> bool {
    let Some(reported) = bridge_reported_ga_root() else { return false; };
    let (a, b) = (norm_path(&reported), norm_path(project_dir));
    #[cfg(windows)]
    { a.eq_ignore_ascii_case(&b) }
    #[cfg(not(windows))]
    { a == b }
}

/// POST /services/shutdown to ask a running bridge to stop and free port 14168.
fn request_bridge_shutdown() {
    use std::io::{Read, Write};
    let Ok(mut stream) = TcpStream::connect_timeout(
        &"127.0.0.1:14168".parse().unwrap(),
        Duration::from_millis(800),
    ) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let req = b"POST /services/shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let _ = stream.write_all(req);
    let _ = stream.read(&mut [0u8; 512]);
}

/// If a bridge already holds 14168 but belongs to a DIFFERENT install (e.g. an orphaned
/// bridge from a previously downloaded version, or this folder was moved), shut it down and
/// wait for the port to free — otherwise the new exe would load the stale install's UI.
fn takeover_stale_bridge(project_dir: &str) {
    if project_dir.is_empty() || !is_bridge_running() {
        return;
    }
    if bridge_identity_matches(project_dir) {
        return; // same install -> reuse is correct
    }
    eprintln!("[tauri] a different/stale bridge holds 127.0.0.1:14168; taking over");
    request_bridge_shutdown();
    let start = Instant::now();
    while is_bridge_running() && start.elapsed() < Duration::from_secs(10) {
        thread::sleep(Duration::from_millis(200));
    }
}

fn is_bridge_running() -> bool {
    TcpStream::connect(("127.0.0.1", 14168)).is_ok()
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn start_bridge() {
    let script = find_bridge_script();
    if !script.exists() {
        eprintln!("[tauri] bridge script not found: {:?}", script);
        return;
    }

    let python = find_python();
    eprintln!("[tauri] using python: {}", python);

    let show_console = std::env::args().any(|a| a == "--console");

    let mut cmd = Command::new(&python);
    cmd.arg(&script)
       .current_dir(script.parent().unwrap());

    #[cfg(windows)]
    if !show_console {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.spawn() {
        Ok(child) => {
            eprintln!("[tauri] started bridge PID={}", child.id());
            *BRIDGE_PROCESS.lock().unwrap() = Some(child);
        }
        Err(e) => {
            eprintln!("[tauri] failed to start bridge: {} (python={})", e, python);
            return;
        }
    }

    if !wait_for_port(14168, Duration::from_secs(15)) {
        eprintln!("[tauri] WARNING: bridge did not become ready within 15s");
    }
}

fn ensure_bridge_running() {
    if is_bridge_running() {
        eprintln!("[tauri] bridge already running on 127.0.0.1:14168; reusing it");
        return;
    }
    start_bridge();
}

#[tauri::command]
fn start_bridge_with_config(app_handle: tauri::AppHandle, python_path: String, project_dir: String) -> Result<(), String> {
    // Save to settings
    let path = settings_path();
    let obj = serde_json::json!({"python_path": python_path, "project_dir": project_dir});
    std::fs::write(&path, serde_json::to_string_pretty(&obj).unwrap())
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    // Start bridge only if it is not already accepting connections.
    if !is_bridge_running() {
        let py = PathBuf::from(&python_path);
        let dir = PathBuf::from(&project_dir);
        let script = dir.join("frontends").join("desktop_bridge.py");
        if !script.exists() {
            return Err(format!("desktop_bridge.py not found at {:?}", script));
        }

        let mut cmd = Command::new(&py);
        cmd.arg(&script).current_dir(&dir);
        sanitize_bundle_env(&mut cmd);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;
        *BRIDGE_PROCESS.lock().unwrap() = Some(child);
    }

    // Wait for port
    if !wait_for_port(14168, Duration::from_secs(20)) {
        return Err("Bridge did not become ready within 20s".into());
    }

    // Navigate main window to bridge URL after the bridge is ready, then show it.
    if let Some(main_win) = app_handle.get_webview_window("main") {
        let url = tauri::Url::parse("http://127.0.0.1:14168/").unwrap();
        let _ = main_win.navigate(url);
        let _ = main_win.show();
        let _ = main_win.set_focus();
    }
    if let Some(setup_win) = app_handle.get_webview_window("setup") {
        let _ = setup_win.hide();
    }

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

    // Self-contained bundle: detect whether the first-run offline prepare is still needed.
    let project_dir = find_project_dir().unwrap_or_default();
    let needs_prepare = needs_first_run_prepare(&project_dir);

    // Take over a stale/foreign bridge holding port 14168 (orphaned bridge from a previously
    // downloaded version, or a moved folder) before we decide to reuse it — otherwise the new
    // exe would just load the old install's UI from that bridge.
    takeover_stale_bridge(&project_dir);

    let bridge_ok = is_bridge_running();
    let mut spawned_bridge = false;
    // Skip the early spawn when a first-run prepare is required (no venv yet);
    // the setup thread prepares the env first and then starts the bridge.
    if !bridge_ok && !no_autostart && !needs_prepare {
        // Try to start bridge with saved/discovered config
        let (py_str, dir_str) = get_or_discover_config();
        let dir = PathBuf::from(&dir_str);
        let script = dir.join("frontends").join("desktop_bridge.py");
        if script.exists() {
            let mut cmd = Command::new(&py_str);
            cmd.arg(&script).current_dir(&dir);
            sanitize_bundle_env(&mut cmd);
            #[cfg(windows)]
            cmd.creation_flags(0x08000000);
            if let Ok(child) = cmd.spawn() {
                *BRIDGE_PROCESS.lock().unwrap() = Some(child);
                spawned_bridge = true;
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
            thread::spawn(move || {
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
                    if !is_bridge_running() {
                        let (py_str, dir_str) = get_or_discover_config();
                        let dir = PathBuf::from(&dir_str);
                        let script = dir.join("frontends").join("desktop_bridge.py");
                        if script.exists() {
                            let mut cmd = Command::new(&py_str);
                            cmd.arg(&script).current_dir(&dir);
                            sanitize_bundle_env(&mut cmd);
                            #[cfg(windows)]
                            cmd.creation_flags(0x08000000);
                            if let Ok(child) = cmd.spawn() {
                                *BRIDGE_PROCESS.lock().unwrap() = Some(child);
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
                let bridge_ready = wait_for_port(14168, wait);

                if bridge_ready {
                    // The bridge auto-starts conductor + scheduler itself (on_startup), so we do
                    // NOT probe their ports here: that would self-detect the bridge's own
                    // just-started extras and falsely report "ports busy".
                    if !wait_for_port(14168, Duration::from_secs(15)) {
                        eprintln!("[tauri] bridge not reachable before navigate");
                        if let Some(w) = &main_win {
                            let msg = "无法连接 bridge (127.0.0.1:14168)，请关闭程序后重试。";
                            let js = format!(
                                "alert({})",
                                serde_json::to_string(msg).unwrap_or_else(|_| "\"\"".to_string())
                            );
                            let _ = w.eval(&js);
                        }
                        return;
                    }
                    // Navigate to the bridge HTTP only after it is ready.
                    if let Some(w) = handle.get_webview_window("main") {
                        if let Ok(url) = tauri::Url::parse("http://127.0.0.1:14168/") {
                            let _ = w.navigate(url);
                        }
                        if dev_mode {
                            w.open_devtools();
                        } else {
                            // Disable F5/F12/Ctrl+R/right-click in production
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
                    if let Some(sw) = handle.get_webview_window("setup") { let _ = sw.hide(); }
                } else {
                    // Bridge never came up -> let the user fix paths in the setup window.
                    if let Some(sw) = handle.get_webview_window("setup") {
                        if dev_mode { sw.open_devtools(); }
                        let _ = sw.show();
                    }
                    if let Some(mw) = handle.get_webview_window("main") { let _ = mw.hide(); }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let label = window.label();
                if label == "main" {
                    request_stop_extras();
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
