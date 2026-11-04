pub mod callcenter;
pub mod discovery;
pub mod dispatch;
pub mod drivers;
pub mod effects;
pub mod energy;
pub mod hub;
pub mod model;
pub mod music;
pub mod scenes;
pub mod scheduler;
pub mod wall;
pub mod weather;
pub mod web;

use hub::Hub;
use serde_json::Value;
use std::sync::Arc;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

struct AppState {
    hub: Arc<Hub>,
}

/// Every UI action goes through here (and through POST /api/call/{cmd} for the web UI).
#[tauri::command]
async fn call(state: tauri::State<'_, AppState>, cmd: String, args: Option<Value>) -> Result<Value, String> {
    let hub = state.hub.clone();
    let args = args.unwrap_or(Value::Null);
    let args = if args.is_null() { serde_json::json!({}) } else { args };
    tauri::async_runtime::spawn_blocking(move || dispatch::dispatch(&hub, &cmd, args, false))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_fullscreen(window: tauri::WebviewWindow, on: bool) -> Result<bool, String> {
    window.set_fullscreen(on).map_err(|e| e.to_string())?;
    Ok(on)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![call, set_fullscreen])
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app data dir");
            let hub = Hub::new(&dir);
            hub.start();
            web::apply(&hub);

            // Forward hub events to the window.
            let mut rx = hub.bus.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(ev) => {
                            let _ = handle.emit(&format!("hub://{}", ev.name), ev.data);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            continue;
                        }
                        Err(_) => break,
                    }
                }
            });

            let find = MenuItemBuilder::with_id("discover", "Find Devices…")
                .accelerator("CmdOrCtrl+D")
                .build(app)?;
            let kiosk = MenuItemBuilder::with_id("kiosk", "Toggle Screen Mode")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(app)?;
            let devices_menu = SubmenuBuilder::new(app, "Devices")
                .item(&find)
                .item(&kiosk)
                .build()?;
            let app_menu = SubmenuBuilder::new(app, "Lights Studio")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .fullscreen()
                .close_window()
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit, &devices_menu, &window])
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, ev| match ev.id().as_ref() {
                "discover" => {
                    let _ = app.emit("hub://menu", "discover");
                }
                "kiosk" => {
                    let _ = app.emit("hub://menu", "kiosk");
                }
                _ => {}
            });

            app.manage(AppState { hub });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(s) = window.app_handle().try_state::<AppState>() {
                    s.hub.shutdown();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Lights Studio");
}
