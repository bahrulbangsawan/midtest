//! Perintah Tauri: menyambung ke agen, mengirim prompt, dan menjawab izin.
//!
//! Modul ini satu-satunya tempat di crate yang tahu tentang Tauri. Seluruh
//! plumbing ACP di bawahnya berbicara lewat [`EventSink`] dan [`ClientContext`],
//! yang tidak menyinggung `AppHandle` sama sekali — itulah yang membuat jalur
//! notifikasi dan gerbang izin bisa diuji tanpa menjalankan aplikasi.
//!
//! # Tiga event AG-UI yang menutup satu giliran
//!
//! `useChat` di frontend hanya menganggap satu giliran selesai bila ia melihat
//! `RUN_FINISHED` atau `RUN_ERROR` untuk `runId` yang sama dengan `RUN_STARTED`
//! yang membukanya. Karena itu [`send_prompt`] mengemisikan `RUN_STARTED`
//! **sebelum** permintaan dikirim (agar `runId`-nya sudah berlaku saat
//! notifikasi pertama datang) dan menutupnya di kedua cabang hasil. Kehilangan
//! salah satunya bukan cacat kosmetik: teks tetap muncul, tetapi spinner tidak
//! pernah berhenti.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use agent_client_protocol::schema::v1::{ContentBlock, PromptRequest, SessionId};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::acp::events::{agui_run_error, agui_run_finished, agui_run_started};
use crate::acp::{
    AcpError, AcpHandle, ClientContext, EVENT_AGUI, EventSink, InitializeResponseExt, connect,
    new_session,
};
use crate::agents::{AgentSpec, find_agent};
use crate::sidecar::midscene_server;

/// Env var untuk menimpa akar repo yang dipakai sesi dan sidecar MCP.
const ENV_ROOT: &str = "MIDSCENE_DESKTOP_ROOT";

/// Emisi event lewat Tauri.
struct TauriSink {
    app: AppHandle,
}

impl EventSink for TauriSink {
    fn emit(&self, event: &str, payload: Value) {
        if let Err(error) = Emitter::emit(&self.app, event, payload) {
            eprintln!("failed to emit Tauri event {event}: {error}");
        }
    }
}

/// Akar repo: sumber `.env`, entry point sidecar MCP, dan cwd sesi.
///
/// Dalam pengembangan, biner ini dibangun dari `app/src-tauri`, jadi akar repo
/// ada dua tingkat di atas `CARGO_MANIFEST_DIR`. Aplikasi yang sudah dibundel
/// tidak punya hubungan itu lagi, karena itu [`ENV_ROOT`] selalu menang bila
/// diset. Task 8/9 boleh menggantinya dengan pemilih direktori sungguhan.
fn repo_root() -> PathBuf {
    let mentah = std::env::var_os(ENV_ROOT).map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."),
        PathBuf::from,
    );

    mentah.canonicalize().unwrap_or(mentah)
}

/// Terjemahkan kegagalan ACP menjadi kalimat yang berguna bagi pengguna.
///
/// `match`-nya sengaja ekshaustif dan [`AcpError`] sengaja bukan
/// `#[non_exhaustive]`: varian baru harus menagih keputusan di sini, bukan
/// diam-diam jatuh ke lengan `_` yang berbunyi "terjadi kesalahan".
fn pesan_galat(error: &AcpError) -> String {
    match error {
        AcpError::Protocol(sumber) => {
            format!("Agen menolak permintaan protokol: {sumber}")
        }
        AcpError::ConnectionClosed(detail) => {
            format!("Koneksi ke agen terputus sebelum siap: {detail}")
        }
        AcpError::HandshakeTimeout(anggaran) => format!(
            "Adapter agen tidak menjawab dalam {} detik. Periksa pemasangan adapternya.",
            anggaran.as_secs()
        ),
        AcpError::SessionTimeout(anggaran) => format!(
            "Agen tidak berhasil membuka sesi dalam {} detik. \
             Periksa sidecar Midscene, `node`, dan berkas `.env`.",
            anggaran.as_secs()
        ),
        AcpError::InvalidCwd { path, source } => format!(
            "Direktori kerja {} tidak bisa dipakai: {source}",
            path.display()
        ),
    }
}

/// Sesi yang sedang hidup.
struct Sesi {
    handle: AcpHandle,
    session_id: SessionId,
}

/// State aplikasi yang dikelola Tauri.
pub struct AppState {
    ctx: ClientContext,
    sesi: Mutex<Option<Sesi>>,
    root: PathBuf,
}

impl AppState {
    /// Bangun state untuk satu aplikasi Tauri.
    #[must_use]
    pub fn new(app: AppHandle) -> Self {
        Self {
            ctx: ClientContext::new(Arc::new(TauriSink { app })),
            sesi: Mutex::new(None),
            root: repo_root(),
        }
    }

    /// Konteks klien yang dibagi ke handler-handler ACP.
    #[must_use]
    pub fn ctx(&self) -> &ClientContext {
        &self.ctx
    }

    /// Tutup satu koneksi tanpa memperingatkan webview: penutupan ini kita
    /// minta sendiri, jadi `agent-disconnected` justru akan menyesatkan.
    async fn tutup(&self, handle: AcpHandle) {
        self.ctx.tandai_menutup();
        handle.shutdown().await;
        self.ctx.batalkan_penutupan();
    }
}

/// Ringkasan agen yang berhasil disambungkan, untuk ditampilkan di UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    /// Id di registry lokal (`claude`, `codex`).
    pub id: String,
    /// Label yang layak ditampilkan.
    pub label: String,
    /// Nama yang dilaporkan agen sendiri pada `initialize`, bila ada.
    pub name: String,
    /// Id sesi ACP.
    pub session_id: String,
    /// `threadId` yang dipakai seluruh event AG-UI sesi ini.
    pub thread_id: String,
    /// Direktori kerja sesi (absolut).
    pub cwd: String,
    /// Apakah agen menerima gambar di dalam prompt.
    pub supports_image_prompt: bool,
}

/// Jalankan adapter `agent_id`, selesaikan handshake, dan buka sesi dengan
/// sidecar Midscene terdaftar sebagai server MCP.
///
/// Sesi lama — bila ada — ditutup lebih dulu, termasuk proses anaknya.
///
/// # Errors
///
/// Kalimat berbahasa Indonesia yang siap ditampilkan; lihat [`pesan_galat`].
#[tauri::command]
pub async fn connect_agent(
    state: State<'_, AppState>,
    agent_id: String,
) -> Result<AgentInfo, String> {
    let spec: &'static AgentSpec = find_agent(&agent_id)
        .ok_or_else(|| format!("Agen \"{agent_id}\" tidak dikenal."))?;

    let mut terkunci = state.sesi.lock().await;
    if let Some(lama) = terkunci.take() {
        state.tutup(lama.handle).await;
    }

    let root = state.root.clone();
    let (handle, initialize) = connect(spec, &root, state.ctx.clone())
        .await
        .map_err(|error| pesan_galat(&error))?;

    let session_id = match new_session(&handle, &root, vec![midscene_server(&root)]).await {
        Ok(session_id) => session_id,
        Err(error) => {
            // Handshake sudah berhasil, jadi proses anaknya hidup. Jangan
            // biarkan ia bocor hanya karena sesinya gagal dibuat.
            state.tutup(handle).await;
            return Err(pesan_galat(&error));
        }
    };

    let thread_id = session_id.0.to_string();
    state.ctx.pasang_thread(thread_id.clone());

    let info = AgentInfo {
        id: spec.id.to_owned(),
        label: spec.label.to_owned(),
        name: initialize.agent_info_name().to_owned(),
        session_id: thread_id.clone(),
        thread_id,
        cwd: handle.cwd().display().to_string(),
        supports_image_prompt: initialize.supports_image_prompt(),
    };

    *terkunci = Some(Sesi { handle, session_id });
    Ok(info)
}

/// Kirim satu giliran ke agen dan bingkai alirannya dengan `RUN_STARTED` /
/// `RUN_FINISHED` / `RUN_ERROR`.
///
/// Tidak ada batas waktu di sini dengan sengaja: satu giliran boleh berjalan
/// berlama-lama secara sah (agen berpikir, tool Midscene menunggu halaman).
/// Yang menjaga perintah ini tidak menggantung selamanya adalah transport-nya
/// sendiri — `block_task` gagal begitu stdout adapter mencapai EOF, jadi adapter
/// yang mati di tengah giliran muncul sebagai `RUN_ERROR`, bukan sebagai
/// spinner abadi.
///
/// # Errors
///
/// Bila belum ada sesi, atau bila permintaan `session/prompt` gagal.
#[tauri::command]
pub async fn send_prompt(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let terkunci = state.sesi.lock().await;
    let sesi = terkunci
        .as_ref()
        .ok_or_else(|| "Belum terhubung ke agen. Pilih agen lebih dulu.".to_owned())?;

    let (run_id, thread_id) = state.ctx.mulai_run();
    state
        .ctx
        .emit(EVENT_AGUI, agui_run_started(&run_id, &thread_id));

    let request = PromptRequest::new(
        sesi.session_id.clone(),
        vec![ContentBlock::from(text.as_str())],
    );

    match sesi
        .handle
        .connection()
        .send_request(request)
        .block_task()
        .await
    {
        Ok(_response) => {
            state
                .ctx
                .emit(EVENT_AGUI, agui_run_finished(&run_id, &thread_id));
            Ok(())
        }
        Err(error) => {
            let pesan = format!("Giliran gagal diselesaikan: {error}");
            state
                .ctx
                .emit(EVENT_AGUI, agui_run_error(&run_id, &thread_id, &pesan));
            Err(pesan)
        }
    }
}

/// Teruskan pilihan pengguna ke permintaan izin yang sedang menunggu.
///
/// Sengaja **tidak** menyentuh kunci sesi: permintaan izin muncul justru saat
/// `send_prompt` sedang memegang kunci itu, jadi menunggunya di sini akan
/// menggantung persis pada saat gerbang ini paling dibutuhkan.
///
/// # Errors
///
/// Bila `request_id` tidak dikenal — sudah dijawab, kedaluwarsa, atau
/// dibatalkan agen. Frontend memakainya untuk menutup dialog yang basi.
#[tauri::command]
pub fn answer_permission(
    state: State<'_, AppState>,
    request_id: String,
    option_id: String,
) -> Result<(), String> {
    state
        .ctx
        .permissions()
        .jawab(&request_id, &option_id)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn akar_repo_menunjuk_pohon_yang_berisi_sidecar() {
        if std::env::var_os(ENV_ROOT).is_some() {
            return; // env sengaja ditimpa; jalur bawaan tidak diuji di sini.
        }

        let root = repo_root();
        assert!(root.is_absolute(), "akar repo wajib absolut: {root:?}");
        assert!(
            root.join("midscene-mcp").is_dir(),
            "akar repo harus berisi midscene-mcp, dapat {}",
            root.display()
        );
    }

    /// Pesan galat dipisahkan per fase supaya pengguna tahu apa yang harus
    /// diperiksa. Menggabungkannya menjadi satu kalimat generik akan
    /// menghapus seluruh gunanya varian-varian [`AcpError`] yang terpisah.
    #[test]
    fn pesan_galat_membedakan_setiap_fase_kegagalan() {
        let handshake = pesan_galat(&AcpError::HandshakeTimeout(Duration::from_secs(30)));
        let sesi = pesan_galat(&AcpError::SessionTimeout(Duration::from_secs(120)));
        let cwd = pesan_galat(&AcpError::InvalidCwd {
            path: PathBuf::from("/jalur/hilang"),
            source: std::io::Error::from(std::io::ErrorKind::NotFound),
        });
        let tertutup = pesan_galat(&AcpError::ConnectionClosed("EOF".to_owned()));

        assert!(handshake.contains("30"), "dapat: {handshake}");
        assert!(handshake.contains("adapter"), "dapat: {handshake}");
        assert!(sesi.contains("120"), "dapat: {sesi}");
        assert!(sesi.contains("Midscene"), "dapat: {sesi}");
        assert!(cwd.contains("/jalur/hilang"), "dapat: {cwd}");
        assert!(tertutup.contains("EOF"), "dapat: {tertutup}");

        for pesan in [&handshake, &sesi, &cwd, &tertutup] {
            assert!(!pesan.is_empty());
        }
        assert_ne!(handshake, sesi);
    }

    #[test]
    fn agent_info_terserialisasi_camel_case() {
        let json = serde_json::to_value(AgentInfo {
            id: "claude".into(),
            label: "Claude".into(),
            name: "claude-agent-acp".into(),
            session_id: "sesi-1".into(),
            thread_id: "sesi-1".into(),
            cwd: "/tmp".into(),
            supports_image_prompt: true,
        })
        .expect("harus terserialisasi");

        assert_eq!(json["sessionId"], "sesi-1");
        assert_eq!(json["threadId"], "sesi-1");
        assert_eq!(json["supportsImagePrompt"], true);
        assert!(json.get("session_id").is_none());
    }
}
