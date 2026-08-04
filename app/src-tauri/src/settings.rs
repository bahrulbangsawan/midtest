use serde::{Deserialize, Serialize};
use std::path::Path;

/// Persisted user preferences.
///
/// Deliberately tiny and forgiving: a corrupt or missing file falls back to
/// defaults rather than failing startup. A settings file is never worth
/// blocking the app over.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Auto-approve permission requests without asking. Persists across launches,
    /// which is why the UI must show it at all times.
    pub full_permissions: bool,
}

const FILE_NAME: &str = "settings.json";

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
    let temp = dir.join(format!("{}.tmp", FILE_NAME));

    // Write to temp file first to ensure atomicity
    std::fs::write(&temp, raw)?;

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

    fn dir_sementara() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "midscene-settings-{}-{}",
            std::process::id(),
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
        save(&d, &Settings { full_permissions: true }).unwrap();
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
        save(&d, &Settings { full_permissions: true }).unwrap();
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
        std::fs::write(d.join("settings.json"), r#"{"full_permissions": "bukan boolean"}"#).unwrap();
        assert!(!load(&d).full_permissions);
    }

    #[test]
    fn save_tidak_meninggalkan_berkas_tmp() {
        let d = dir_sementara();
        save(&d, &Settings { full_permissions: true }).unwrap();
        let tmp_path = d.join("settings.json.tmp");
        assert!(!tmp_path.exists(), "Temp file should not be left behind after successful save");
    }
}
