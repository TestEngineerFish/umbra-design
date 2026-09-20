#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "store.json";
const RECENT_KEY: &str = "recentProjects";
const MAX_RECENT: usize = 10;

#[derive(Clone, serde::Serialize)]
struct SecondInstancePayload {
    args: Vec<String>,
    cwd: String,
}

/// Read recent projects list from the persistent store
fn get_recent(app: &tauri::AppHandle) -> Vec<String> {
    match app.store(STORE_FILE) {
        Ok(store) => store
            .get(RECENT_KEY)
            .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
            .unwrap_or_default(),
        Err(_) => vec![],
    }
}

/// Add a path to recent projects (dedup + LRU)
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
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("menu-action", "new-project");
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single instance: second launch focuses existing window
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
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            // Menu event handler
            app.on_menu_event(|app, event| {
                let id = event.id().0.clone();
                menu_event_handler(app, &id);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
