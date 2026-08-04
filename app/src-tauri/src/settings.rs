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
    std::fs::write(dir.join(FILE_NAME), raw)
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
}
