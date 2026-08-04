pub mod acp;
pub mod agents;
pub mod commands;
pub mod settings;
pub mod sidecar;

use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // State dibangun di `setup`, bukan sebelum `Builder`, karena
        // `AppState` butuh `AppHandle` untuk mengemisikan event ke webview.
        .setup(|app| {
            app.manage(commands::AppState::new(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::connect_agent,
            commands::send_prompt,
            commands::answer_permission,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
