pub mod acp;
pub mod agents;
pub mod commands;
pub mod settings;
pub mod sidecar;
pub mod system;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // State dibangun di `setup`, bukan sebelum `Builder`, karena
        // `AppState` butuh `AppHandle` untuk mengemisikan event ke webview.
        .setup(|app| {
            let state = commands::AppState::new(app.handle().clone());

            // Pengaturan tersimpan harus sudah berlaku **sebelum** sesi pertama
            // dibuat. Yang dijaga di sini adalah pengguna yang **menyalakan**
            // mode itu pada peluncuran lalu: memuatnya terlambat berarti
            // permintaan izin pertama tetap ditanyakan padahal ia sudah memilih
            // untuk tidak ditanya lagi.
            //
            // Arah kegagalannya memang jatuh ke sisi aman — yang terjadi cuma
            // dialog yang seharusnya tidak muncul, bukan persetujuan yang
            // seharusnya tidak diberikan — jadi ini soal menepati pilihan
            // pengguna, bukan penjaga keamanan. Ditulis apa adanya supaya tidak
            // ada yang mengira urutan ini menahan sesuatu yang berbahaya.
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
            commands::connect_agent,
            commands::disconnect_agent,
            commands::set_agent_model,
            commands::send_prompt,
            commands::cancel_turn,
            commands::answer_permission,
            commands::get_full_permissions,
            commands::set_full_permissions,
            commands::get_app_settings,
            commands::save_app_settings,
            commands::add_workspace,
            system::get_provider_accounts,
            system::open_provider_login,
            system::get_midscene_config,
            system::save_midscene_config,
            system::clear_midscene_api_key,
            system::test_midscene_connection,
            system::detect_browsers,
            system::validate_browser_executable,
            system::get_macos_permissions,
            system::open_permission_settings,
            system::request_macos_permission,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // `App::run` exits the process directly, so shutdown work placed after it
    // would never execute. Close the ACP transport while Tauri still owns its
    // async runtime; `AppState::shutdown` is idempotent because this event may
    // follow an explicit workspace disconnect.
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            tauri::async_runtime::block_on(handle.state::<commands::AppState>().shutdown());
        }
    });
}
