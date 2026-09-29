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
use std::time::Duration;

use agent_client_protocol::schema::v1::{McpServer, NewSessionRequest, NewSessionResponse};

use super::{resolve_cwd, AcpError, AcpHandle};

/// Batas waktu bawaan untuk menunggu balasan `session/new`.
///
/// `session/new` bukan sekadar pencatatan: di situlah agen benar-benar
/// **men-spawn setiap server MCP** yang kita daftarkan lalu menunggunya siap.
/// Karena itu ia mewarisi penyakit yang sama dengan `initialize` —
/// `block_task` hanya selesai bila ada balasan, pembatalan, atau EOF — tetapi
/// dengan permukaan kegagalan yang lebih luas: `node` yang hidup tapi
/// menggantung (`.env` di mount yang macet, `import` yang tak pernah selesai)
/// tidak menghasilkan balasan **dan** tidak menghasilkan EOF. Tanpa batas ini
/// perintah Tauri yang menunggunya membekukan chat tanpa jalur error, dan
/// `cargo test` menggantung tanpa akhir.
///
/// Dua menit, dan angkanya diukur bukan ditebak. Pada mesin ini `session/new`
/// dengan satu sidecar Midscene yang cache-nya panas memakan **2,26 detik**
/// (diukur langsung, di luar `connect` yang 0,44 detik). Anggaran harus menutup
/// kasus terburuk yang masih sah, dan regimenya berbeda dari dua anggaran lain
/// di sistem ini: `node` start dingin yang memuat graf dependensi
/// `puppeteer` + `@midscene/web` (lihat `midscene-mcp/package.json`) sambil
/// menanggalkan tipe TypeScript, dikali jumlah server yang didaftarkan, karena
/// agen menyalakan semuanya dalam satu permintaan ini. Itu jauh lebih berat
/// daripada [`super::DEFAULT_HANDSHAKE_TIMEOUT`] (30 detik, yang hanya menunggu
/// satu biner adapter menjawab) dan sama sekali bukan ukuran yang sama dengan
/// `SHUTDOWN_TIMEOUT` (5 detik, pembersihan, bukan start dingin).
/// 120 detik memberi sekitar 50× ruang di atas biaya terukur. Timeout palsu di
/// sini merusak lebih parah daripada spinner panjang: ia membuat sesi tidak
/// pernah bisa dibuat sama sekali, yaitu seluruh fungsi aplikasi ini.
pub const DEFAULT_SESSION_TIMEOUT: Duration = Duration::from_secs(120);

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
/// Lihat [`new_session_with_timeout`].
pub async fn new_session(
    handle: &AcpHandle,
    cwd: &Path,
    servers: Vec<McpServer>,
) -> Result<NewSessionResponse, AcpError> {
    new_session_with_timeout(handle, cwd, servers, DEFAULT_SESSION_TIMEOUT).await
}

/// Seperti [`new_session`], tetapi dengan batas waktu yang ditentukan pemanggil.
///
/// Anggarannya disuntikkan dengan bentuk yang sama seperti
/// [`super::connect_with_timeout`], dan alasannya sama: test tidak boleh
/// menunggu dua menit hanya untuk membuktikan batas waktunya bekerja.
///
/// # Errors
///
/// Mengembalikan [`AcpError::InvalidCwd`] bila `cwd` tidak ada atau tidak bisa
/// di-canonicalize, [`AcpError::Protocol`] bila agen menolak `session/new`
/// (misalnya karena butuh autentikasi) atau koneksinya sudah putus, dan
/// [`AcpError::SessionTimeout`] bila agen tidak menjawab dalam `budget`.
pub async fn new_session_with_timeout(
    handle: &AcpHandle,
    cwd: &Path,
    servers: Vec<McpServer>,
    budget: Duration,
) -> Result<NewSessionResponse, AcpError> {
    let sent = handle
        .connection()
        .send_request(request(cwd, servers)?)
        .block_task();

    // Men-drop future yang belum selesai inilah yang membatalkan permintaannya:
    // `SentRequest` memasang `SentRequestCancellation` yang mengirim pembatalan
    // ke agen saat di-drop (`agent-client-protocol-2.0.0/src/jsonrpc.rs:3375`).
    // Jadi koneksinya tetap sehat setelah timeout — yang gugur hanya satu
    // permintaan, bukan seluruh handle.
    match tokio::time::timeout(budget, sent).await {
        Ok(response) => Ok(response?),
        Err(_) => Err(AcpError::SessionTimeout(budget)),
    }
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
        let hilang = Path::new("/jalur/yang/pasti/tidak/ada/midtest");

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
