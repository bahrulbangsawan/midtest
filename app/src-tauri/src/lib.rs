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
            let state = commands::AppState::new(app.handle().clone());

            // Pengaturan tersimpan harus sudah berlaku **sebelum** sesi pertama
            // dibuat, kalau tidak permintaan izin pertama akan tetap membuka
            // dialog meskipun pengguna sudah mematikannya sejak peluncuran lalu.
            //
            // Kegagalan menentukan direktori config sengaja tidak menjatuhkan
            // start: nilai bawaannya adalah "bertanya", yaitu sisi yang aman.
            match app.path().app_config_dir() {
                Ok(dir) => state
                    .ctx()
                    .set_full_permissions(settings::load(&dir).full_permissions),
                Err(error) => {
                    eprintln!("failed to resolve app config dir, using defaults: {error}");
                }
            }

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::connect_agent,
            commands::send_prompt,
            commands::answer_permission,
            commands::get_full_permissions,
            commands::set_full_permissions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
