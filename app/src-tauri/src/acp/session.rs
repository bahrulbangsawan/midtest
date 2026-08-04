//! Pembuatan sesi ACP: `session/new` berikut daftar server MCP-nya.
//!
//! Bentuk API crate yang menentukan modul ini — dan menyimpang dari deskripsi
//! rencana, jadi dicatat di sini:
//!
//! * `SessionBuilder::with_mcp_server` (`agent-client-protocol-2.0.0/src/session.rs:157`)
//!   **bukan** cara memasang entri `mcpServers` biasa. Ia menerima
//!   `mcp_server::McpServer` — server MCP *in-process* yang bicara lewat kanal
//!   ACP (MCP-over-ACP), ada di balik fitur `unstable_mcp_over_acp`, dan
//!   mendaftarkan handler dinamis pada koneksi kita. Sidecar Midscene bukan itu:
//!   ia proses terpisah yang di-spawn oleh *agen*, jadi ia adalah
//!   `schema::v1::McpServer::Stdio`. Satu-satunya jalan memasangnya adalah field
//!   `NewSessionRequest::mcp_servers` (`schema-1.5.0/src/v1/agent.rs:1026`).
//!   Dua tipe berbeda dengan nama yang sama persis.
//! * Karena itu `SessionBuilder` tidak dipakai. Jalur builder
//!   (`build_session_from(..).block_task().start_session()`) akan mengembalikan
//!   `ActiveSession`, yang kontrak fungsi ini tidak simpan; men-drop-nya langsung
//!   mencabut kembali handler yang baru saja didaftarkannya
//!   (`session.rs:520–525`). Mendaftar lalu mencabut dalam satu tarikan napas
//!   hanyalah `send_request` dengan langkah tambahan, jadi request-nya dikirim
//!   langsung — pola yang sama dengan `initialize` di [`super::connect_with_timeout`].

use std::path::Path;

use agent_client_protocol::schema::v1::{McpServer, NewSessionRequest, SessionId};

use super::{AcpError, AcpHandle, resolve_cwd};

/// Susun permintaan `session/new`.
///
/// Dipisah dari pengirimannya supaya bentuk permintaannya bisa diuji tanpa agen
/// hidup — dan tanpa biaya.
fn request(cwd: &Path, servers: Vec<McpServer>) -> Result<NewSessionRequest, AcpError> {
    Ok(NewSessionRequest::new(resolve_cwd(cwd)?).mcp_servers(servers))
}

/// Buat sesi baru pada koneksi yang sudah selesai handshake, dengan `servers`
/// terdaftar sebagai server MCP sesi itu.
///
/// `cwd` diminta eksplisit, bukan diambil dari [`AcpHandle::cwd`], supaya satu
/// koneksi bisa melayani lebih dari satu akar bila nanti dibutuhkan. Nilainya
/// tetap dijadikan absolut lebih dulu: ACP mewajibkan cwd sesi berupa path
/// absolut, dan agen tidak punya cara menebak relatif terhadap apa.
///
/// # Errors
///
/// Mengembalikan [`AcpError::InvalidCwd`] bila `cwd` tidak ada atau tidak bisa
/// di-canonicalize, dan [`AcpError::Protocol`] bila agen menolak `session/new`
/// (misalnya karena butuh autentikasi) atau koneksinya sudah putus.
pub async fn new_session(
    handle: &AcpHandle,
    cwd: &Path,
    servers: Vec<McpServer>,
) -> Result<SessionId, AcpError> {
    let response = handle
        .connection()
        .send_request(request(cwd, servers)?)
        .block_task()
        .await?;

    Ok(response.session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::midscene_server;

    fn akar() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR"))
    }

    #[test]
    fn permintaan_memakai_cwd_absolut() {
        let permintaan = request(Path::new("."), Vec::new()).expect("cwd saat ini harus ada");

        assert!(
            permintaan.cwd.is_absolute(),
            "cwd sesi wajib absolut, dapat {}",
            permintaan.cwd.display()
        );
    }

    #[test]
    fn permintaan_menolak_cwd_yang_tidak_ada() {
        let hilang = Path::new("/jalur/yang/pasti/tidak/ada/midscene-desktop");

        match request(hilang, Vec::new()) {
            Err(AcpError::InvalidCwd { path, .. }) => assert_eq!(path, hilang),
            other => panic!("harusnya InvalidCwd, dapat {other:?}"),
        }
    }

    #[test]
    fn permintaan_membawa_server_mcp_yang_dioper() {
        let permintaan =
            request(akar(), vec![midscene_server(akar())]).expect("akar crate harus ada");

        assert_eq!(permintaan.mcp_servers.len(), 1);
    }

    /// Kelalaian yang paling mahal di sini adalah entri MCP yang diam-diam
    /// hilang dari kawat, jadi yang diperiksa adalah JSON permintaannya.
    #[test]
    fn json_permintaan_menyertakan_entri_stdio_tanpa_field_type() {
        let permintaan =
            request(akar(), vec![midscene_server(akar())]).expect("akar crate harus ada");
        let json = serde_json::to_value(&permintaan).expect("harus terserialisasi");

        let servers = json["mcpServers"]
            .as_array()
            .expect("mcpServers harus array");
        assert_eq!(servers.len(), 1);
        assert!(
            servers[0].get("type").is_none(),
            "entri stdio harus tanpa field type, dapat: {}",
            servers[0]
        );
        assert_eq!(servers[0]["name"], "midscene");
    }
}
