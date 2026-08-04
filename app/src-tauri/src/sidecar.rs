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

/// Build the stdio MCP entry for the Midscene sidecar.
///
/// The `type` field is deliberately omitted: in both adapters' schemas the
/// stdio variant is the one *without* a type discriminator. Sending
/// `type: "stdio"` was tested and also works on claude-agent-acp 0.64.2, but
/// the omitted form is the canonical shape and is what codex-acp's union
/// expects by construction.
///
/// `root` harus akar repo yang sudah absolut — sumber untuk `.env`, entry point
/// TypeScript, dan `MIDSCENE_MCP_ROOT`.
#[must_use]
pub fn midscene_server(root: &Path) -> McpServer {
    let env_file = root.join(".env");
    let entry = root.join("midscene-mcp/src/index.ts");

    McpServer::Stdio(
        McpServerStdio::new(SERVER_NAME, "node")
            .args(vec![
                format!("--env-file={}", env_file.display()),
                entry.display().to_string(),
            ])
            .env(vec![EnvVariable::new(
                "MIDSCENE_MCP_ROOT",
                root.display().to_string(),
            )]),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn akar() -> PathBuf {
        PathBuf::from("/tmp/midscene-desktop")
    }

    #[test]
    fn entri_memakai_varian_stdio() {
        assert!(matches!(midscene_server(&akar()), McpServer::Stdio(_)));
    }

    #[test]
    fn argumen_memakai_path_absolut() {
        let json = serde_json::to_value(midscene_server(&akar())).expect("harus terserialisasi");
        let args = json["args"].as_array().expect("args harus array");

        assert_eq!(args[0], "--env-file=/tmp/midscene-desktop/.env");
        assert_eq!(args[1], "/tmp/midscene-desktop/midscene-mcp/src/index.ts");
        assert_eq!(json["command"], "node");
    }

    #[test]
    fn env_membawa_akar_repo() {
        let json = serde_json::to_value(midscene_server(&akar())).expect("harus terserialisasi");
        let env = json["env"].as_array().expect("env harus array");

        assert_eq!(env.len(), 1);
        assert_eq!(env[0]["name"], "MIDSCENE_MCP_ROOT");
        assert_eq!(env[0]["value"], "/tmp/midscene-desktop");
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
