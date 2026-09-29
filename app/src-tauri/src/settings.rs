use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Persisted user preferences.
///
/// The file stays forgiving: new fields have defaults and a corrupt or missing
/// file never blocks startup. Runtime permission state is still owned by
/// `ClientContext`; this struct is only its durable representation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Auto-approve permission requests without asking. Persists across launches,
    /// which is why the UI must show it at all times.
    pub full_permissions: bool,
    /// Workspaces intentionally remain in the list when they are moved or
    /// deleted so the UI can explain the problem and let the user forget or
    /// relocate them instead of silently losing history.
    pub workspaces: Vec<Workspace>,
    pub selected_workspace: Option<String>,
    pub default_provider: String,
    /// Last selected model per provider. Unknown entries are preserved; the
    /// live agent response decides whether they are still available.
    pub selected_models: HashMap<String, String>,
    pub sidebar_collapsed: bool,
    pub ui_scale: UiScale,
    /// Non-secret Midscene VLM overrides. Missing values continue to come from
    /// the repository `.env`; the API key is kept in the macOS Keychain.
    pub midscene: MidsceneSettings,
    /// Browser choice used by the Puppeteer web adapter. A missing executable
    /// path preserves the existing `PUPPETEER_EXECUTABLE_PATH` environment flow.
    pub browser: BrowserSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            full_permissions: false,
            workspaces: Vec::new(),
            selected_workspace: None,
            default_provider: "claude".to_owned(),
            selected_models: HashMap::new(),
            sidebar_collapsed: false,
            ui_scale: UiScale::Comfortable,
            midscene: MidsceneSettings::default(),
            browser: BrowserSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct MidsceneSettings {
    pub base_url: Option<String>,
    pub model_name: Option<String>,
    pub model_family: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct BrowserSettings {
    pub kind: BrowserKind,
    pub executable_path: Option<String>,
}

impl Default for BrowserSettings {
    fn default() -> Self {
        Self {
            kind: BrowserKind::GoogleChrome,
            executable_path: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserKind {
    #[default]
    GoogleChrome,
    Chromium,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Workspace {
    pub path: String,
    pub name: String,
    pub threads: Vec<Thread>,
    pub selected_thread_id: Option<String>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            path: String::new(),
            name: "Workspace".to_owned(),
            threads: Vec::new(),
            selected_thread_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub title: String,
}

impl Default for Thread {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: "New thread".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UiScale {
    Compact,
    #[default]
    Comfortable,
}

const FILE_NAME: &str = "settings.json";
static SAVE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(dir.join(FILE_NAME))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, settings: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let target = dir.join(FILE_NAME);
    // Setiap penyimpanan mendapat file sementara sendiri. Pemanggil Tauri
    // dapat tiba dari beberapa event UI yang berdekatan; satu nama `.tmp`
    // bersama membuat satu writer me-rename file milik writer lain lalu yang
    // kedua gagal dengan `NotFound`.
    let sequence = SAVE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = dir.join(format!(
        ".{FILE_NAME}.{}-{sequence}.tmp",
        std::process::id()
    ));

    // Write to temp file first to ensure atomicity
    if let Err(error) = std::fs::write(&temp, raw) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }

    // Atomic rename: reader sees either old complete file or new complete one, never torn
    match std::fs::rename(&temp, &target) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Clean up temp file on rename failure
            let _ = std::fs::remove_file(&temp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pembeda antar-test di dalam satu proses.
    ///
    /// **Jam bukan sumber keunikan yang sah di sini.** Versi pertama helper ini
    /// membangun nama direktori dari pid + `SystemTime::now().as_nanos()` saja,
    /// dan itu flaky: granularitas jam mesin ini jauh lebih kasar daripada satu
    /// nanodetik — pada pengukuran, 188.877 dari 200.000 pembacaan
    /// `as_nanos()` berturut-turut identik. Dua test yang mulai pada tick yang
    /// sama di thread berbeda mendapat direktori yang **sama**, lalu
    /// `settings.json.tmp` milik test satu menjatuhkan assertion
    /// `!tmp_path.exists()` milik test lain.
    ///
    /// Penghitung atomik menyelesaikannya tanpa bergantung pada resolusi jam:
    /// `fetch_add` menjamin setiap pemanggil dalam proses ini mendapat angka
    /// yang berbeda, titik. pid dan nanodetik dipertahankan hanya sebagai
    /// pembeda antar-*proses* (mis. dua `cargo test` yang jalan bersamaan, atau
    /// sisa direktori dari run sebelumnya yang kebetulan memakai pid yang sama).
    static PEMBEDA: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn dir_sementara() -> std::path::PathBuf {
        let urutan = PEMBEDA.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!(
            "midscene-settings-{}-{}-{}",
            std::process::id(),
            urutan,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn default_mematikan_full_permissions() {
        assert!(!Settings::default().full_permissions);
    }

    #[test]
    fn direktori_kosong_menghasilkan_default() {
        let d = dir_sementara();
        assert!(!load(&d).full_permissions);
    }

    #[test]
    fn simpan_lalu_muat_mengembalikan_nilai_yang_sama() {
        let d = dir_sementara();
        save(
            &d,
            &Settings {
                full_permissions: true,
                ..Settings::default()
            },
        )
        .unwrap();
        assert!(load(&d).full_permissions);
    }

    #[test]
    fn berkas_rusak_jatuh_ke_default_bukan_panik() {
        let d = dir_sementara();
        std::fs::write(d.join("settings.json"), "{ bukan json").unwrap();
        assert!(!load(&d).full_permissions);
    }

    #[test]
    fn save_membuat_direktori_yang_belum_ada() {
        let d = dir_sementara().join("belum").join("ada");
        save(
            &d,
            &Settings {
                full_permissions: true,
                ..Settings::default()
            },
        )
        .unwrap();
        assert!(load(&d).full_permissions);
    }

    #[test]
    fn berkas_kosong_jatuh_ke_default() {
        let d = dir_sementara();
        std::fs::write(d.join("settings.json"), "").unwrap();
        assert!(!load(&d).full_permissions);
    }

    #[test]
    fn json_array_bukan_objek_jatuh_ke_default() {
        let d = dir_sementara();
        std::fs::write(d.join("settings.json"), "[]").unwrap();
        assert!(!load(&d).full_permissions);
    }

    #[test]
    fn field_tipe_salah_jatuh_ke_default() {
        let d = dir_sementara();
        std::fs::write(
            d.join("settings.json"),
            r#"{"full_permissions": "bukan boolean"}"#,
        )
        .unwrap();
        assert!(!load(&d).full_permissions);
    }

    #[test]
    fn save_tidak_meninggalkan_berkas_tmp() {
        let d = dir_sementara();
        save(
            &d,
            &Settings {
                full_permissions: true,
                ..Settings::default()
            },
        )
        .unwrap();
        let leftovers = std::fs::read_dir(&d)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(
            leftovers, 0,
            "Temp file should not be left behind after successful save"
        );
    }

    #[test]
    fn save_serentak_tidak_saling_menghapus_temp_file() {
        let d = std::sync::Arc::new(dir_sementara());
        let writers: Vec<_> = (0..12)
            .map(|number| {
                let d = std::sync::Arc::clone(&d);
                std::thread::spawn(move || {
                    save(
                        &d,
                        &Settings {
                            default_provider: if number % 2 == 0 {
                                "claude".to_owned()
                            } else {
                                "codex".to_owned()
                            },
                            ..Settings::default()
                        },
                    )
                })
            })
            .collect();

        for writer in writers {
            writer
                .join()
                .expect("writer tidak boleh panik")
                .expect("semua save serentak harus berhasil");
        }

        let loaded = load(&d);
        assert!(matches!(
            loaded.default_provider.as_str(),
            "claude" | "codex"
        ));
        let leftovers = std::fs::read_dir(&*d)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0, "tidak boleh ada temp file tertinggal");
    }

    #[test]
    fn preferensi_ui_workspace_thread_dan_model_roundtrip() {
        let d = dir_sementara();
        let mut models = HashMap::new();
        models.insert("claude".to_owned(), "claude-sonnet".to_owned());
        let settings = Settings {
            workspaces: vec![Workspace {
                path: "/tmp/project".to_owned(),
                name: "project".to_owned(),
                threads: vec![Thread {
                    id: "thread-a".to_owned(),
                    title: "Audit UI".to_owned(),
                }],
                selected_thread_id: Some("thread-a".to_owned()),
            }],
            selected_workspace: Some("/tmp/project".to_owned()),
            selected_models: models,
            sidebar_collapsed: true,
            ui_scale: UiScale::Compact,
            midscene: MidsceneSettings {
                base_url: Some("https://openrouter.ai/api/v1".to_owned()),
                model_name: Some("vendor/model".to_owned()),
                model_family: Some("qwen2.5-vl".to_owned()),
            },
            browser: BrowserSettings {
                kind: BrowserKind::Custom,
                executable_path: Some(
                    "/Applications/Browser.app/Contents/MacOS/Browser".to_owned(),
                ),
            },
            ..Settings::default()
        };

        save(&d, &settings).unwrap();
        let loaded = load(&d);
        assert_eq!(loaded.workspaces, settings.workspaces);
        assert_eq!(loaded.selected_workspace, settings.selected_workspace);
        assert_eq!(
            loaded.selected_models.get("claude"),
            Some(&"claude-sonnet".to_owned())
        );
        assert!(loaded.sidebar_collapsed);
        assert_eq!(loaded.ui_scale, UiScale::Compact);
        assert_eq!(loaded.midscene, settings.midscene);
        assert_eq!(loaded.browser, settings.browser);
    }

    #[test]
    fn api_key_tidak_pernah_menjadi_field_settings_json() {
        let serialized = serde_json::to_string(&Settings::default()).unwrap();
        assert!(!serialized.contains("apiKey"));
        assert!(!serialized.contains("MIDSCENE_MODEL_API_KEY"));
    }
}
