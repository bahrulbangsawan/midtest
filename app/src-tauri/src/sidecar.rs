//! Sidecar MCP Midscene: satu entri `mcpServers` yang dikirim bersama
//! `session/new`, bukan proses yang kita jalankan sendiri.
//!
//! Agenlah yang men-spawn proses ini. Itu sebabnya seluruh isi entri harus
//! berupa nilai yang bisa dipahami proses lain: `command` yang bisa dicari di
//! PATH-nya agen, argumen berupa path **absolut**, dan environment yang eksplisit
//! — kita tidak bisa mengandalkan cwd atau env kita sendiri ikut terwariskan.
//!
//! Bentuk API crate yang menentukan modul ini (dibaca dari
//! `agent-client-protocol-schema-1.5.0/src/v1/agent.rs`):
//!
//! * `NewSessionRequest::mcp_servers` bertipe `Vec<McpServer>` (baris 1026).
//! * `McpServer` adalah enum `#[serde(tag = "type", rename_all = "snake_case")]`
//!   dengan varian `Http`, `Sse`, `Acp`, dan `Stdio` (baris 2812–2839).
//! * Varian `Stdio` diberi `#[serde(untagged)]` (baris 2837), jadi justru varian
//!   inilah satu-satunya yang **tidak** membawa diskriminan `type`.
//! * `McpServerStdio` punya `name`, `command: PathBuf`, `args: Vec<String>`,
//!   `env: Vec<EnvVariable>` (baris 3042–3061). `args` dan `env` bukan `Option`
//!   dan tidak punya `skip_serializing_if`, jadi keduanya selalu ikut
//!   terserialisasi — persis yang dituntut skema `codex-acp`, yang mewajibkan
//!   kedua array itu ada walau kosong.

use std::path::Path;

use agent_client_protocol::schema::v1::{EnvVariable, McpServer, McpServerStdio};

/// Nama server MCP ini di mata agen; jadi prefiks nama tool (`midscene__*`).
const SERVER_NAME: &str = "midscene";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RuntimeOverrides {
    pub model_base_url: Option<String>,
    pub model_api_key: Option<String>,
    pub model_name: Option<String>,
    pub model_family: Option<String>,
    pub browser_executable_path: Option<String>,
}

/// Build the stdio MCP entry for the Midscene sidecar.
///
/// The `type` field is deliberately omitted: in both adapters' schemas the
/// stdio variant is the one *without* a type discriminator. Sending
/// `type: "stdio"` was tested and also works on claude-agent-acp 0.64.2, but
/// the omitted form is the canonical shape and is what codex-acp's union
/// expects by construction.
///
/// `root` harus akar runtime yang sudah absolut — sumber opsional untuk `.env`,
/// entry point TypeScript, dan `MIDSCENE_MCP_ROOT`. Data yang dibuat MCP
/// disimpan terpisah lewat `MIDSCENE_MCP_DATA_DIR`, supaya aplikasi terpaket
/// tidak mencoba menulis ke dalam bundle yang read-only.
#[must_use]
pub fn midscene_server(root: &Path) -> McpServer {
    midscene_server_with_overrides(root, &RuntimeOverrides::default())
}

/// Build the sidecar entry while applying settings-owned values as explicit
/// process environment variables. Node gives existing process environment
/// precedence over `--env-file`, so saved desktop settings override `.env`
/// while every omitted value remains environment-compatible.
#[must_use]
pub fn midscene_server_with_overrides(root: &Path, overrides: &RuntimeOverrides) -> McpServer {
    midscene_server_with_runtime(root, root, overrides)
}

/// Build the sidecar entry with distinct code and writable-data roots.
///
/// `data_root` normally is the application's data directory in a packaged
/// build, while development keeps it equal to `root` for backward-compatible
/// scenario locations. The `.env` flag is deliberately omitted when no file
/// exists: Node treats a missing `--env-file` as a fatal startup error even
/// when every required value was supplied by the desktop Settings UI.
#[must_use]
pub fn midscene_server_with_runtime(
    root: &Path,
    data_root: &Path,
    overrides: &RuntimeOverrides,
) -> McpServer {
    let env_file = root.join(".env");
    let entry = root.join("midscene-mcp/src/index.ts");

    let mut environment = vec![
        EnvVariable::new("MIDSCENE_MCP_ROOT", root.display().to_string()),
        EnvVariable::new("MIDSCENE_MCP_DATA_DIR", data_root.display().to_string()),
    ];
    for (name, value) in [
        ("MIDSCENE_MODEL_BASE_URL", overrides.model_base_url.as_ref()),
        ("MIDSCENE_MODEL_API_KEY", overrides.model_api_key.as_ref()),
        ("MIDSCENE_MODEL_NAME", overrides.model_name.as_ref()),
        ("MIDSCENE_MODEL_FAMILY", overrides.model_family.as_ref()),
        (
            "PUPPETEER_EXECUTABLE_PATH",
            overrides.browser_executable_path.as_ref(),
        ),
    ] {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            environment.push(EnvVariable::new(name, value.clone()));
        }
    }

    let mut args = Vec::with_capacity(2);
    if env_file.is_file() {
        args.push(format!("--env-file={}", env_file.display()));
    }
    args.push(entry.display().to_string());

    McpServer::Stdio(
        McpServerStdio::new(SERVER_NAME, "node")
            .args(args)
            .env(environment),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ROOT_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn akar(label: &str) -> PathBuf {
        let counter = TEST_ROOT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "midtest-sidecar-{label}-{}-{counter}",
            std::process::id()
        ));
        std::fs::create_dir_all(root.join("midscene-mcp/src"))
            .expect("akar test harus dapat dibuat");
        root
    }

    #[test]
    fn entri_memakai_varian_stdio() {
        let root = akar("stdio");
        assert!(matches!(midscene_server(&root), McpServer::Stdio(_)));
        std::fs::remove_dir_all(root).expect("akar test harus dapat dibersihkan");
    }

    #[test]
    fn tanpa_dotenv_argumen_memakai_entry_point_saja() {
        let root = akar("tanpa-dotenv");
        let json = serde_json::to_value(midscene_server(&root)).expect("harus terserialisasi");
        let args = json["args"].as_array().expect("args harus array");

        assert_eq!(args.len(), 1);
        assert_eq!(
            args[0],
            root.join("midscene-mcp/src/index.ts").display().to_string()
        );
        assert_eq!(json["command"], "node");
        std::fs::remove_dir_all(root).expect("akar test harus dapat dibersihkan");
    }

    #[test]
    fn dotenv_yang_ada_dikirim_ke_node() {
        let root = akar("dengan-dotenv");
        std::fs::write(root.join(".env"), "MIDSCENE_MODEL_NAME=test\n")
            .expect("dotenv test harus dapat ditulis");

        let json = serde_json::to_value(midscene_server(&root)).expect("harus terserialisasi");
        let args = json["args"].as_array().expect("args harus array");

        assert_eq!(args.len(), 2);
        assert_eq!(
            args[0],
            format!("--env-file={}", root.join(".env").display())
        );
        assert_eq!(
            args[1],
            root.join("midscene-mcp/src/index.ts").display().to_string()
        );
        std::fs::remove_dir_all(root).expect("akar test harus dapat dibersihkan");
    }

    #[test]
    fn env_membawa_akar_repo() {
        let root = akar("environment");
        let json = serde_json::to_value(midscene_server(&root)).expect("harus terserialisasi");
        let env = json["env"].as_array().expect("env harus array");

        assert_eq!(env.len(), 2);
        assert_eq!(env[0]["name"], "MIDSCENE_MCP_ROOT");
        assert_eq!(env[0]["value"], root.display().to_string());
        assert_eq!(env[1]["name"], "MIDSCENE_MCP_DATA_DIR");
        assert_eq!(env[1]["value"], root.display().to_string());
        std::fs::remove_dir_all(root).expect("akar test harus dapat dibersihkan");
    }

    #[test]
    fn root_data_terpisah_dikirim_untuk_bundle() {
        let root = akar("kode");
        let data_root = akar("data");
        let json = serde_json::to_value(midscene_server_with_runtime(
            &root,
            &data_root,
            &RuntimeOverrides::default(),
        ))
        .expect("harus terserialisasi");
        let env = json["env"].as_array().expect("env harus array");

        assert!(env.iter().any(|item| {
            item["name"] == "MIDSCENE_MCP_DATA_DIR"
                && item["value"] == data_root.display().to_string()
        }));
        std::fs::remove_dir_all(root).expect("akar kode harus dapat dibersihkan");
        std::fs::remove_dir_all(data_root).expect("akar data harus dapat dibersihkan");
    }

    #[test]
    fn override_settings_dikirim_tanpa_menghilangkan_env_compatibility() {
        let configured_root = akar("override");
        let configured = midscene_server_with_overrides(
            &configured_root,
            &RuntimeOverrides {
                model_base_url: Some("https://openrouter.ai/api/v1".to_owned()),
                model_api_key: Some("secret-test-value".to_owned()),
                model_name: Some("vendor/model".to_owned()),
                model_family: Some("qwen2.5-vl".to_owned()),
                browser_executable_path: Some("/Applications/Chrome".to_owned()),
            },
        );
        let json = serde_json::to_value(configured).unwrap();
        let env = json["env"].as_array().unwrap();
        assert_eq!(env.len(), 7);
        assert!(env
            .iter()
            .any(|item| item["name"] == "MIDSCENE_MODEL_API_KEY"));
        std::fs::remove_dir_all(configured_root).expect("akar test harus dapat dibersihkan");

        let default_root = akar("override-default");
        let defaults = serde_json::to_value(midscene_server(&default_root)).unwrap();
        assert_eq!(defaults["env"].as_array().map(Vec::len), Some(2));
        std::fs::remove_dir_all(default_root).expect("akar test harus dapat dibersihkan");
    }

    /// `codex-acp` menuntut `args` dan `env` hadir sebagai array, jadi keduanya
    /// tidak boleh hilang dari JSON — termasuk bila suatu saat isinya kosong.
    #[test]
    fn args_dan_env_selalu_hadir_walau_kosong() {
        let json = serde_json::to_value(McpServer::Stdio(McpServerStdio::new("kosong", "node")))
            .expect("harus terserialisasi");

        assert_eq!(json["args"].as_array().map(Vec::len), Some(0));
        assert_eq!(json["env"].as_array().map(Vec::len), Some(0));
    }
}
