#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "store.json";
const RECENT_KEY: &str = "recentProjects";
const MAX_RECENT: usize = 10;
const SESSION_MARKER: &str = ".session_active";

/// 管理 MCP server 子进程的生命周期
struct SidecarState(Mutex<Option<(Child, u64)>>);

#[derive(Clone, serde::Serialize)]
struct SecondInstancePayload {
    args: Vec<String>,
    cwd: String,
}

/// 检查上次是否非正常退出
fn check_crash_recovery(app: &tauri::AppHandle) -> bool {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return false,
    };
    let marker = data_dir.join(SESSION_MARKER);
    if marker.exists() {
        eprintln!("[crash-recovery] 检测到上次非正常退出，marker 仍然存在");
        return true;
    }
    false
}

/// 标记 session 为活跃
fn mark_session_active(app: &tauri::AppHandle) {
    if let Ok(data_dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&data_dir);
        let marker = data_dir.join(SESSION_MARKER);
        let _ = std::fs::write(&marker, format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)));
    }
}

/// 标记 session 为正常退出
fn mark_session_clean(app: &tauri::AppHandle) {
    if let Ok(data_dir) = app.path().app_data_dir() {
        let marker = data_dir.join(SESSION_MARKER);
        let _ = std::fs::remove_file(marker);
    }
}

fn get_recent(app: &tauri::AppHandle) -> Vec<String> {
    match app.store(STORE_FILE) {
        Ok(store) => store
            .get(RECENT_KEY)
            .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
            .unwrap_or_default(),
        Err(_) => vec![],
    }
}

fn add_recent(app: &tauri::AppHandle, path: String) {
    if let Ok(store) = app.store(STORE_FILE) {
        let mut recent = get_recent(app);
        recent.retain(|p| p != &path);
        recent.insert(0, path);
        recent.truncate(MAX_RECENT);
        store.set(RECENT_KEY, serde_json::json!(recent));
        let _ = store.save();
    }
}

fn menu_event_handler(app: &tauri::AppHandle, id: &str) {
    match id {
        "new_project" => {
            // 打开新建项目对话框
            let result = app.dialog().file().blocking_pick_folder();
            if let Some(path) = result {
                let path_str = path.to_string();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("new-project-folder", path_str);
                }
            }
        }
        "open_project" => {
            let result = app.dialog().file().blocking_pick_folder();
            if let Some(path) = result {
                let path_str = path.to_string();
                add_recent(app, path_str.clone());
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("open-project", path_str);
                }
                let _ = refresh_menu(app);
            }
        }
        "quit" => {
            app.exit(0);
        }
        "reload" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("location.reload()");
            }
        }
        "minimize" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.minimize();
            }
        }
        "fullscreen" => {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(is_fullscreen) = window.is_fullscreen() {
                    let _ = window.set_fullscreen(!is_fullscreen);
                }
            }
        }
        _ if id.starts_with("recent_") && id != "recent_none" => {
            let recent = get_recent(app);
            let idx_str = id.strip_prefix("recent_").unwrap();
            if let Ok(idx) = idx_str.parse::<usize>() {
                if let Some(path) = recent.get(idx) {
                    add_recent(app, path.clone());
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("open-project", path.clone());
                    }
                    let _ = refresh_menu(app);
                }
            }
        }
        _ => {}
    }
}

fn build_recent_submenu(
    app: &tauri::AppHandle,
) -> Result<tauri::menu::Submenu<tauri::Wry>, tauri::Error> {
    let recent = get_recent(app);
    if recent.is_empty() {
        let empty = tauri::menu::MenuItem::with_id(
            app,
            "recent_none",
            "No Recent Projects",
            false,
            None::<&str>,
        )?;
        return SubmenuBuilder::new(app, "Recent")
            .item(&empty)
            .build();
    }

    let mut builder = SubmenuBuilder::new(app, "Recent");
    for (i, path) in recent.iter().take(MAX_RECENT).enumerate() {
        let id = format!("recent_{}", i);
        let display = PathBuf::from(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        let item = tauri::menu::MenuItem::with_id(
            app,
            &id,
            &display,
            true,
            None::<&str>,
        )?;
        builder = builder.item(&item);
    }
    builder.build()
}

fn build_menu(app: &tauri::AppHandle) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let quit = PredefinedMenuItem::quit(app, None)?;
    let about = PredefinedMenuItem::about(app, None, None)?;
    let _separator = PredefinedMenuItem::separator(app)?;

    let app_submenu = SubmenuBuilder::new(app, "UmbraDesign")
        .item(&about)
        .separator()
        .item(&quit)
        .build()?;

    let recent_submenu = build_recent_submenu(app)?;

    let file_submenu = SubmenuBuilder::new(app, "File")
        .text("new_project", "New Project...")
        .text("open_project", "Open Project...")
        .separator()
        .item(&recent_submenu)
        .separator()
        .item(&quit)
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .text("undo", "Undo")
        .text("redo", "Redo")
        .separator()
        .text("cut", "Cut")
        .text("copy", "Copy")
        .text("paste", "Paste")
        .separator()
        .text("select_all", "Select All")
        .build()?;

    let view_submenu = SubmenuBuilder::new(app, "View")
        .text("reload", "Reload")
        .separator()
        .text("minimize", "Minimize")
        .text("fullscreen", "Toggle Fullscreen")
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_submenu, &file_submenu, &edit_submenu, &view_submenu])
        .build()
}

fn refresh_menu(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    let new_menu = build_menu(app)?;
    app.set_menu(new_menu)?;
    Ok(())
}

/// 找到捆绑的 Node.js 或回退到系统 Node
fn find_node_path(app: &tauri::AppHandle) -> Option<String> {
    // 尝试 Tauri 的 sidecar 路径（打包后）
    let resource_dir = app.path().resource_dir().ok()?;
    let bundled_node = resource_dir.join("binaries").join("node");
    if bundled_node.exists() {
        return bundled_node.to_str().map(|s| s.to_string());
    }
    // 开发模式：回退到系统 Node
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let candidate = PathBuf::from(dir).join(node_name);
            if candidate.exists() {
                return candidate.to_str().map(|s| s.to_string());
            }
        }
    }
    None
}

/// 通过 sidecar 的 stdin/stdout 发送一条 MCP JSON-RPC 消息，读取响应
fn send_mcp_message(
    state: &SidecarState,
    method: &str,
    params: serde_json::Value,
    id: u64,
) -> Result<serde_json::Value, String> {
    let mut guard = state.0.lock().unwrap();
    let (child, seq) = guard.as_mut()
        .ok_or("sidecar 未运行")?;
    *seq = id;

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    let request_str = serde_json::to_string(&request).map_err(|e| format!("序列化失败: {}", e))?;

    let stdin = child.stdin.as_mut().ok_or("无法访问 sidecar stdin")?;
    writeln!(stdin, "{}", request_str).map_err(|e| format!("写入 stdin 失败: {}", e))?;

    let stdout = child.stdout.as_mut().ok_or("无法访问 sidecar stdout")?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| format!("读取 stdout 失败: {}", e))?;
        if n == 0 {
            return Err("sidecar stdout 已关闭".to_string());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|e| format!("解析响应失败: {} (原始: {})", e, trimmed))?;

        if response.get("id").and_then(|v| v.as_u64()) == Some(id) {
            if let Some(error) = response.get("error") {
                return Err(format!("MCP 错误: {}", error));
            }
            return Ok(response.get("result").cloned().unwrap_or(serde_json::Value::Null));
        }
    }
}

/// 找到 server/dist/index.js 的绝对路径
fn find_server_script() -> Option<String> {
    let mut current = std::env::current_exe().ok()?;
    for _ in 0..10 {
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
            let candidate = current.join("server").join("dist").join("index.js");
            if candidate.exists() {
                return candidate.to_str().map(|s| s.to_string());
            }
        }
    }
    None
}

/// 启动 MCP server 子进程
#[tauri::command]
fn start_sidecar(
    app: tauri::AppHandle,
    state: State<'_, SidecarState>,
) -> Result<String, String> {
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        return Ok("already_running".to_string());
    }

    let node_path = find_node_path(&app)
        .ok_or_else(|| "找不到 Node.js —— 请先安装 Node.js >= 20".to_string())?;

    let script_path = find_server_script()
        .ok_or_else(|| "找不到 server/dist/index.js —— 请先运行 npm --prefix server run build".to_string())?;

    let result = std::process::Command::new(&node_path)
        .arg(&script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    match result {
        Ok(child) => {
            *guard = Some((child, 0));
            Ok("started".to_string())
        }
        Err(e) => Err(format!("启动失败: {}", e)),
    }
}

/// 停止 MCP server 子进程
#[tauri::command]
fn stop_sidecar(state: State<'_, SidecarState>) -> Result<String, String> {
    let mut guard = state.0.lock().unwrap();
    if let Some((mut child, _)) = guard.take() {
        #[cfg(unix)]
        {
            let pid = child.id();
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            for _ in 0..20 {
                match child.try_wait() {
                    Ok(Some(_)) => return Ok("stopped".to_string()),
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                    Err(_) => break,
                }
            }
        }
        let _ = child.kill();
        Ok("stopped".to_string())
    } else {
        Ok("not_running".to_string())
    }
}

/// 查询 sidecar 状态
#[tauri::command]
fn get_sidecar_status(state: State<'_, SidecarState>) -> Result<serde_json::Value, String> {
    let guard = state.0.lock().unwrap();
    if guard.is_some() {
        Ok(serde_json::json!({
            "status": "running",
        }))
    } else {
        Ok(serde_json::json!({
            "status": "stopped",
        }))
    }
}

/// 创建新项目（通过 sidecar 调用 create_project MCP 工具）
#[tauri::command]
fn create_project_command(
    state: State<'_, SidecarState>,
    name: String,
    dir: String,
    title: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "name": name,
        "dir": dir,
        "title": title.unwrap_or_default(),
        "initGit": true,
    });

    let result = send_mcp_message(
        &state,
        "tools/call",
        serde_json::json!({
            "name": "create_project",
            "arguments": params,
        }),
        1, // 固定 id，因为一次只调用一个工具
    )?;

    Ok(result)
}

/// 列出当前已有的项目
#[tauri::command]
fn list_projects_command(state: State<'_, SidecarState>) -> Result<serde_json::Value, String> {
    let raw = send_mcp_message(
        &state,
        "tools/call",
        serde_json::json!({
            "name": "list_projects",
            "arguments": {},
        }),
        2,
    )?;

    // 解析 MCP 响应格式
    parse_mcp_text(&raw)
}

/// 打开项目 + 启动 HTTP 服务，返回预览所需的 URL 和令牌
#[tauri::command]
fn open_project_command(
    state: State<'_, SidecarState>,
    dir: String,
) -> Result<serde_json::Value, String> {
    eprintln!("[rust] open_project_command: dir={}", dir);

    // 1. 先列出所有项目，找匹配目录的那个
    let list_result = send_mcp_message(
        &state,
        "tools/call",
        serde_json::json!({
            "name": "list_projects",
            "arguments": {},
        }),
        10,
    )?;

    eprintln!("[rust] list_projects raw: {}", serde_json::to_string(&list_result).unwrap_or_default().chars().take(300).collect::<String>());

    // 解析 list_projects 的 MCP 响应
    let projects = parse_mcp_text(&list_result)?;
    eprintln!("[rust] list_projects parsed: {}", serde_json::to_string(&projects).unwrap_or_default().chars().take(300).collect::<String>());

    let project_name = projects.get("data")
        .and_then(|d| d.get("projects"))  // 修复：项目在 data.projects 里，不是 data 本身
        .and_then(|p| p.as_array())
        .and_then(|arr| arr.iter().find(|p| {
            p.get("dir").and_then(|d| d.as_str()) == Some(&dir)
        }))
        .and_then(|p| p.get("name").and_then(|n| n.as_str()))
        .ok_or_else(|| format!("找不到目录对应的项目: {}", dir))?;

    eprintln!("[rust] found project: {}", project_name);

    // 2. 用项目名启动服务
    let params = serde_json::json!({
        "project": project_name,
    });
    let result = send_mcp_message(
        &state,
        "tools/call",
        serde_json::json!({
            "name": "serve_start",
            "arguments": params,
        }),
        11,
    )?;

    Ok(result)
}

/// 解析 MCP 响应中的 text 内容
fn parse_mcp_text(raw: &serde_json::Value) -> Result<serde_json::Value, String> {
    eprintln!("[rust] parse_mcp_text input keys: {:?}", raw.as_object().map(|o| o.keys().collect::<Vec<_>>()));

    let content = raw.get("content")
        .and_then(|c| c.as_array())
        .ok_or_else(|| {
            eprintln!("[rust] parse_mcp_text: no content array found");
            "MCP 响应缺少 content".to_string()
        })?;

    let text = content.first()
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| {
            eprintln!("[rust] parse_mcp_text: no text in content[0]");
            "MCP content 缺少 text".to_string()
        })?;

    eprintln!("[rust] parse_mcp_text text first 200: {}", text.chars().take(200).collect::<String>());

    let result: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| {
            eprintln!("[rust] parse_mcp_text JSON parse error: {}", e);
            format!("解析 MCP text 失败: {}", e)
        })?;

    eprintln!("[rust] parse_mcp_text success, keys: {:?}", result.as_object().map(|o| o.keys().collect::<Vec<_>>()));
    Ok(result)
}

/// 停止项目的 HTTP 服务
#[tauri::command]
fn close_project_command(
    state: State<'_, SidecarState>,
    name: String,
) -> Result<serde_json::Value, String> {
    let result = send_mcp_message(
        &state,
        "tools/call",
        serde_json::json!({
            "name": "serve_stop",
            "arguments": { "project": name },
        }),
        11,
    )?;

    Ok(result)
}

/// 通用 MCP 工具调用（前端可以通过它调任何工具）
#[tauri::command]
fn invoke_mcp_command(
    state: State<'_, SidecarState>,
    tool: String,
    args: serde_json::Value,
    msg_id: u64,
) -> Result<serde_json::Value, String> {
    let result = send_mcp_message(
        &state,
        "tools/call",
        serde_json::json!({
            "name": tool,
            "arguments": args,
        }),
        msg_id,
    )?;

    Ok(result)
}

/// 获取最近打开的项目列表
#[tauri::command]
fn get_recent_projects_command(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let recent = get_recent(&app);
    Ok(serde_json::json!({ "projects": recent }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            println!("[single-instance] {argv:?}, cwd={cwd}");
            let _ = app.emit(
                "single-instance",
                SecondInstancePayload { args: argv, cwd },
            );
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin({
            #[cfg(debug_assertions)]
            {
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build()
            }
            #[cfg(not(debug_assertions))]
            {
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Warn)
                    .build()
            }
        })
        .manage(SidecarState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            start_sidecar,
            stop_sidecar,
            get_sidecar_status,
            create_project_command,
            list_projects_command,
            get_recent_projects_command,
            open_project_command,
            close_project_command,
            invoke_mcp_command,
        ])
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                let id = event.id().0.clone();
                menu_event_handler(app, &id);
            });

            // 崩溃恢复：检查上次是否非正常退出
            if check_crash_recovery(app.handle()) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("crash-recovery-detected", serde_json::json!({
                        "message": "检测到上次非正常退出，未保存的改动可能已丢失",
                    }));
                }
            }

            // 标记 session 为活跃
            mark_session_active(app.handle());

            // 启动时自动启动 sidecar
            let state = app.state::<SidecarState>();
            match start_sidecar(app.handle().clone(), state.clone()) {
                Ok(msg) => println!("[sidecar] {}", msg),
                Err(e) => eprintln!("[sidecar] {}", e),
            }

            Ok(())
        })
        // 正常退出时清理
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                // 清理 session marker
                mark_session_clean(app);
                // 停止 sidecar
                let state = app.state::<SidecarState>();
                match stop_sidecar(state.clone()) {
                    Ok(msg) => println!("[sidecar] {}", msg),
                    Err(e) => eprintln!("[sidecar] {}", e),
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
