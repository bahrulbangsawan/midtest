//! Perintah Tauri: menyambung ke agen, mengirim prompt, dan menjawab izin.
//!
//! Modul ini satu-satunya tempat di crate yang tahu tentang Tauri. Seluruh
//! plumbing ACP di bawahnya berbicara lewat [`EventSink`] dan [`ClientContext`],
//! yang tidak menyinggung `AppHandle` sama sekali — itulah yang membuat jalur
//! notifikasi, gerbang izin, dan siklus hidup giliran bisa diuji tanpa
//! menjalankan aplikasi.
//!
//! # Tiga event AG-UI yang menutup satu giliran
//!
//! `useChat` di frontend hanya menganggap satu giliran selesai bila ia melihat
//! `RUN_FINISHED` atau `RUN_ERROR` untuk `runId` yang sama dengan `RUN_STARTED`
//! yang membukanya. Karena itu [`run_turn`] mengemisikan `RUN_STARTED`
//! **sebelum** permintaan dikirim (agar `runId`-nya sudah berlaku saat
//! notifikasi pertama datang) dan menutupnya di kedua cabang hasil. Kehilangan
//! salah satunya bukan cacat kosmetik: teks tetap muncul, tetapi spinner tidak
//! pernah berhenti.
//!
//! [`run_turn`] sengaja dipisahkan dari [`send_prompt`] dan bebas dari `State`
//! milik Tauri supaya klaim di atas bisa **dibuktikan** terhadap agen palsu,
//! bukan sekadar dijanjikan di komentar.
//!
//! # Kunci sesi tidak boleh ditahan selama giliran
//!
//! [`send_prompt`] mengambil [`TurnTarget`] di bawah kunci lalu **melepas
//! kuncinya** sebelum menunggu giliran selesai. Menahannya berarti
//! [`connect_agent`] — satu-satunya jalan menyambung ulang — ikut terkunci
//! selama giliran berjalan. Untuk agen yang mati itu tidak berbahaya
//! (`block_task` gagal saat EOF), tetapi untuk agen yang **hidup dan membisu**
//! — tersangkut prompt kredensial, misalnya — tidak ada EOF, tidak ada
//! `RUN_ERROR`, tidak ada `agent-disconnected`, dan tidak ada perintah cancel.
//! Bila kuncinya ditahan, satu-satunya pemulihan adalah menutup aplikasi. Itu
//! kegagalan yang sama persis dengan yang dijaga
//! [`crate::acp::DEFAULT_HANDSHAKE_TIMEOUT`] satu fase lebih awal.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use agent_client_protocol::schema::v1::{ContentBlock, PromptRequest, SessionId};
use agent_client_protocol::{Agent, ConnectionTo};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::acp::events::{agui_run_error, agui_run_finished, agui_run_started};
use crate::acp::{
    AcpError, AcpHandle, ClientContext, EVENT_AGUI, EventSink, InitializeResponseExt, connect,
    new_session,
};
use crate::agents::{AgentSpec, find_agent};
use crate::settings;
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
    let raw = std::env::var_os(ENV_ROOT).map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."),
        PathBuf::from,
    );

    raw.canonicalize().unwrap_or(raw)
}

/// Terjemahkan kegagalan ACP menjadi kalimat yang berguna bagi pengguna.
///
/// `match`-nya sengaja ekshaustif dan [`AcpError`] sengaja bukan
/// `#[non_exhaustive]`: varian baru harus menagih keputusan di sini, bukan
/// diam-diam jatuh ke lengan `_` yang berbunyi "terjadi kesalahan".
fn user_message(error: &AcpError) -> String {
    match error {
        AcpError::Protocol(source) => {
            format!("Agen menolak permintaan protokol: {source}")
        }
        AcpError::ConnectionClosed(detail) => {
            format!("Koneksi ke agen terputus sebelum siap: {detail}")
        }
        AcpError::HandshakeTimeout(budget) => format!(
            "Adapter agen tidak menjawab dalam {} detik. Periksa pemasangan adapternya.",
            budget.as_secs()
        ),
        AcpError::SessionTimeout(budget) => format!(
            "Agen tidak berhasil membuka sesi dalam {} detik. \
             Periksa sidecar Midscene, `node`, dan berkas `.env`.",
            budget.as_secs()
        ),
        AcpError::InvalidCwd { path, source } => format!(
            "Direktori kerja {} tidak bisa dipakai: {source}",
            path.display()
        ),
    }
}

/// Semua yang dibutuhkan satu giliran.
///
/// Sengaja `Clone` dan bebas dari [`AcpHandle`] supaya bisa diambil keluar dari
/// kunci sesi sebelum giliran dijalankan — lihat catatan modul. `ConnectionTo`
/// murah untuk di-clone: seluruh clone menunjuk koneksi yang sama.
#[derive(Clone, Debug)]
struct TurnTarget {
    connection: ConnectionTo<Agent>,
    session_id: SessionId,
}

/// Sesi yang sedang hidup.
struct Session {
    handle: AcpHandle,
    target: TurnTarget,
}

/// State aplikasi yang dikelola Tauri.
pub struct AppState {
    ctx: ClientContext,
    session: Mutex<Option<Session>>,
    root: PathBuf,
}

impl AppState {
    /// Bangun state untuk satu aplikasi Tauri.
    #[must_use]
    pub fn new(app: AppHandle) -> Self {
        Self::with_sink(Arc::new(TauriSink { app }))
    }

    /// Seperti [`Self::new`], tetapi dengan tujuan emisi apa pun. Test memakai
    /// sink berbasis channel; produksi memakai `AppHandle`.
    fn with_sink(sink: Arc<dyn EventSink>) -> Self {
        Self {
            ctx: ClientContext::new(sink),
            session: Mutex::new(None),
            root: repo_root(),
        }
    }

    /// Konteks klien yang dibagi ke handler-handler ACP.
    #[must_use]
    pub fn ctx(&self) -> &ClientContext {
        &self.ctx
    }

    /// Ambil target giliran dan **lepaskan kunci sesi sebelum kembali**.
    ///
    /// Pelepasan kunci itu bukan detail: ia yang membuat [`connect_agent`] tetap
    /// bisa mendahului giliran yang tersangkut. Lihat catatan modul.
    async fn turn_target(&self) -> Result<TurnTarget, String> {
        self.session
            .lock()
            .await
            .as_ref()
            .map(|session| session.target.clone())
            .ok_or_else(|| "Belum terhubung ke agen. Pilih agen lebih dulu.".to_owned())
    }

    /// Tutup satu koneksi tanpa memperingatkan webview: penutupan ini kita
    /// minta sendiri, jadi `agent-disconnected` justru akan menyesatkan.
    async fn close(&self, handle: AcpHandle) {
        self.ctx.disarm_disconnect_notice();
        handle.shutdown().await;
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
/// Kalimat berbahasa Indonesia yang siap ditampilkan; lihat [`user_message`].
#[tauri::command]
pub async fn connect_agent(
    state: State<'_, AppState>,
    agent_id: String,
) -> Result<AgentInfo, String> {
    let spec: &'static AgentSpec =
        find_agent(&agent_id).ok_or_else(|| format!("Agen \"{agent_id}\" tidak dikenal."))?;

    let mut guard = state.session.lock().await;
    if let Some(previous) = guard.take() {
        state.close(previous.handle).await;
    }

    let root = state.root.clone();
    let (handle, initialize) = connect(spec, &root, state.ctx.clone())
        .await
        .map_err(|error| user_message(&error))?;

    let session_id = match new_session(&handle, &root, vec![midscene_server(&root)]).await {
        Ok(session_id) => session_id,
        Err(error) => {
            // Handshake sudah berhasil, jadi proses anaknya hidup. Jangan
            // biarkan ia bocor hanya karena sesinya gagal dibuat.
            state.close(handle).await;
            return Err(user_message(&error));
        }
    };

    let thread_id = session_id.0.to_string();
    state.ctx.begin_thread(thread_id.clone());

    let info = AgentInfo {
        id: spec.id.to_owned(),
        label: spec.label.to_owned(),
        name: initialize.agent_info_name().to_owned(),
        session_id: thread_id.clone(),
        thread_id,
        cwd: handle.cwd().display().to_string(),
        supports_image_prompt: initialize.supports_image_prompt(),
    };

    let target = TurnTarget {
        connection: handle.connection().clone(),
        session_id,
    };
    *guard = Some(Session { handle, target });

    // Paling akhir: sejak titik ini putusnya koneksi memang kabar buruk yang
    // hanya bisa disampaikan lewat event.
    state.ctx.arm_disconnect_notice();

    Ok(info)
}

/// Jalankan satu giliran dan bingkai alirannya dengan `RUN_STARTED` /
/// `RUN_FINISHED` / `RUN_ERROR`.
///
/// Dipisahkan dari [`send_prompt`] — dan bebas dari `State` milik Tauri — supaya
/// siklus hidup giliran bisa diuji terhadap agen palsu. Itu bukan kenyamanan:
/// menghapus ketiga emisi ini adalah cacat yang paling mudah lolos, karena
/// aplikasinya tetap "bekerja" (teks tetap mengalir lewat notifikasi) sementara
/// spinner-nya tidak pernah berhenti.
///
/// Tidak ada batas waktu di sini dengan sengaja: satu giliran boleh berjalan
/// berlama-lama secara sah (agen berpikir, tool Midscene menunggu halaman).
/// Yang menjaga giliran tidak menggantung selamanya ada dua, dan keduanya di
/// luar fungsi ini: transport-nya sendiri (`block_task` gagal begitu stdout
/// adapter mencapai EOF) untuk agen yang mati, dan kunci sesi yang sudah
/// dilepas [`send_prompt`] untuk agen yang hidup tapi membisu.
///
/// # Errors
///
/// Bila permintaan `session/prompt` gagal.
async fn run_turn(ctx: &ClientContext, target: &TurnTarget, text: String) -> Result<(), String> {
    let (run_id, thread_id) = ctx.begin_run();
    ctx.emit(EVENT_AGUI, agui_run_started(&run_id, &thread_id));

    let request = PromptRequest::new(
        target.session_id.clone(),
        vec![ContentBlock::from(text.as_str())],
    );

    match target.connection.send_request(request).block_task().await {
        Ok(_response) => {
            ctx.emit(EVENT_AGUI, agui_run_finished(&run_id, &thread_id));
            Ok(())
        }
        Err(error) => {
            let message = format!("Giliran gagal diselesaikan: {error}");
            ctx.emit(EVENT_AGUI, agui_run_error(&run_id, &thread_id, &message));
            Err(message)
        }
    }
}

/// Kirim satu giliran ke agen.
///
/// # Errors
///
/// Bila belum ada sesi, atau bila permintaan `session/prompt` gagal.
#[tauri::command]
pub async fn send_prompt(state: State<'_, AppState>, text: String) -> Result<(), String> {
    // Kunci diambil dan dilepas di sini, bukan ditahan selama giliran.
    let target = state.turn_target().await?;
    run_turn(&state.ctx, &target, text).await
}

/// Teruskan pilihan pengguna ke permintaan izin yang sedang menunggu.
///
/// Sengaja **tidak** menyentuh kunci sesi: permintaan izin muncul di tengah
/// giliran, jadi menunggu kunci di sini akan menggantung persis pada saat
/// gerbang ini paling dibutuhkan.
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

/// Apakah mode izin penuh sedang menyala.
///
/// Frontend memanggilnya saat start untuk menampilkan toggle pada posisi yang
/// benar: mode ini bertahan lintas peluncuran, jadi UI yang selalu mulai dari
/// "mati" akan berbohong tentang apa yang sedang berlaku.
#[tauri::command]
pub fn get_full_permissions(state: State<'_, AppState>) -> bool {
    state.ctx.full_permissions()
}

/// Kalimat untuk kegagalan menyimpan, **disesuaikan dengan arah perubahannya**.
///
/// Satu kalimat tetap untuk kedua arah pernah dipakai di sini, dan itu keliru
/// justru ke arah yang berbahaya: saat pengguna **mematikan** mode dan
/// penyimpanan gagal, kalimat itu berbunyi "mode izin penuh berlaku sekarang" —
/// kebalikan dari yang terjadi — sambil menyebut akibatnya sekadar "tidak akan
/// bertahan". Akibat sebenarnya jauh lebih mendesak: berkas di diska masih
/// berisi `true`, jadi [`crate::run`] membacanya lagi saat peluncuran
/// berikutnya dan persetujuan otomatis menyala sendiri tanpa diminta.
///
/// `tersimpan` adalah nilai yang **benar-benar** akan terbaca nanti — `None`
/// bila kita bahkan tidak bisa mengetahuinya. Dengan begitu kalimatnya
/// menjanjikan apa yang akan terjadi, bukan menebaknya.
fn persist_failure_message(enabled: bool, tersimpan: Option<bool>, detail: &str) -> String {
    let pembuka = if enabled {
        "Mode izin penuh menyala sekarang"
    } else {
        "Mode izin penuh sudah mati sekarang"
    };

    let akibat = match tersimpan {
        // Berkasnya kebetulan sudah berisi pilihan yang sama. Penyimpanan tetap
        // gagal (dan itu tetap layak dilaporkan), tetapi peluncuran berikutnya
        // tidak akan menyimpang.
        Some(t) if t == enabled => {
            "Untungnya berkas pengaturan yang ada sudah berisi pilihan yang sama, \
             jadi peluncuran berikutnya tetap sesuai. Tetap periksa penyimpanannya."
                .to_owned()
        }
        // Arah berbahaya: pengguna mematikan, diska masih menyala.
        Some(true) => "PERINGATAN: pengaturan lama yang tersimpan masih menyala, jadi begitu aplikasi \
             ditutup dan dibuka lagi mode ini akan menyala sendiri dan permintaan izin kembali \
             disetujui otomatis tanpa bertanya. Matikan lagi setelah masalah penyimpanan diperbaiki."
            .to_owned(),
        // Arah aman: pengguna menyalakan, diska masih mati.
        Some(false) => "Saat aplikasi dibuka lagi mode ini akan kembali mati dan setiap permintaan izin \
             akan ditanyakan seperti biasa."
            .to_owned(),
        None if enabled => "Pengaturan tersimpan tidak bisa dibaca maupun ditulis, jadi mode ini mungkin \
             tidak berlaku lagi saat aplikasi dibuka kembali."
            .to_owned(),
        None => "PERINGATAN: pengaturan tersimpan tidak bisa dibaca maupun ditulis, jadi mode ini bisa \
             menyala sendiri saat aplikasi dibuka kembali. Periksa lagi setelah masalah \
             penyimpanan diperbaiki."
            .to_owned(),
    };

    format!("{pembuka}, tetapi pilihannya gagal disimpan: {detail}. {akibat}")
}

/// Pasang flag lalu simpan pilihannya — dalam urutan itu.
///
/// Dipisahkan dari [`set_full_permissions`] dan bebas dari `AppHandle` semata
/// supaya **urutannya bisa diuji**. Tanpa fungsi ini, refactor yang menukar
/// urutannya menjadi `settings::save(…)?; set_flag(enabled);` akan
/// mengembalikan persis cacat yang urutan ini hindari, dan seluruh suite tetap
/// hijau.
///
/// # Errors
///
/// Bila berkas gagal ditulis. Flag di memori **tetap berubah** dalam kasus itu;
/// lihat catatan di [`set_full_permissions`].
fn apply_and_persist_full_permissions(
    dir: &Path,
    enabled: bool,
    set_flag: impl FnOnce(bool),
) -> Result<(), String> {
    // Flag lebih dulu, dan itu bukan kelalaian. Arah **mematikan** adalah arah
    // yang menambah keamanan, dan ia harus berlaku seketika meskipun diska
    // menolak ditulisi. Menyimpan lebih dulu lalu `?` berarti permintaan
    // "matikan persetujuan otomatis" ditolak gara-gara berkas pengaturan, dan
    // agen terus menyetujui sendiri sepanjang sesi.
    set_flag(enabled);

    settings::save(
        dir,
        &settings::Settings {
            full_permissions: enabled,
        },
    )
    .map_err(|error| {
        // `load` infalibel, jadi aman dipanggil di jalur galat: ia memberi tahu
        // kita apa yang **sungguh** akan terbaca pada peluncuran berikutnya.
        let tersimpan = settings::load(dir).full_permissions;
        persist_failure_message(enabled, Some(tersimpan), &format!("{error} ({})", dir.display()))
    })
}

/// Nyalakan atau matikan mode izin penuh, dan simpan pilihannya.
///
/// # Perubahan di memori selalu berlaku, termasuk saat hasilnya `Err`
///
/// Ini menyimpang dari konvensi biasa dan pemanggil **wajib** tahu. `Err` di
/// sini berarti "pilihannya berlaku sekarang tetapi gagal disimpan", bukan
/// "tidak terjadi apa-apa". Frontend yang memperlakukannya seperti kegagalan
/// biasa lalu mengembalikan posisi toggle akan menampilkan "mati" sementara
/// persetujuan otomatis sungguhan **menyala** untuk sisa sesi — kebohongan UI
/// tepat pada kendali yang paling tidak boleh berbohong.
///
/// Karena itu: setelah menerima `Err`, panggil [`get_full_permissions`] dan
/// tampilkan apa pun yang ia kembalikan. Jangan mengasumsikan rollback — tidak
/// ada rollback. Tampilkan juga pesan galatnya apa adanya; ia sudah dirangkai
/// sesuai arah perubahan dan menyebut akibatnya pada peluncuran berikutnya.
///
/// Alasan urutan itu ada di [`apply_and_persist_full_permissions`].
///
/// # Errors
///
/// Bila direktori config tidak bisa ditentukan atau berkas gagal ditulis.
/// Kegagalan menyimpan **tidak boleh** ditelan: pengguna memilih mode ini untuk
/// bertahan, jadi diam-diam melupakannya berarti berbohong pada peluncuran
/// berikutnya. UI-lah yang menampilkan kalimat ini.
#[tauri::command]
pub fn set_full_permissions(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let dir = match app.path().app_config_dir() {
        Ok(dir) => dir,
        Err(error) => {
            // Tetap berlakukan pilihannya — alasannya sama persis dengan di
            // `apply_and_persist_full_permissions`, dan di sini kita bahkan
            // tidak bisa membaca apa yang tersimpan.
            state.ctx.set_full_permissions(enabled);
            return Err(persist_failure_message(
                enabled,
                None,
                &format!("direktori pengaturan tidak bisa ditentukan: {error}"),
            ));
        }
    };

    apply_and_persist_full_permissions(&dir, enabled, |nilai| {
        state.ctx.set_full_permissions(nilai);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::EVENT_AGENT_DISCONNECTED;
    use crate::acp::testing::{FakeAgent, RecordingSink, TEST_TIMEOUT, recording_context};
    use serde_json::json;
    use std::time::Duration;
    use tokio::sync::mpsc;

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
        let handshake = user_message(&AcpError::HandshakeTimeout(Duration::from_secs(30)));
        let sesi = user_message(&AcpError::SessionTimeout(Duration::from_secs(120)));
        let cwd = user_message(&AcpError::InvalidCwd {
            path: PathBuf::from("/jalur/hilang"),
            source: std::io::Error::from(std::io::ErrorKind::NotFound),
        });
        let tertutup = user_message(&AcpError::ConnectionClosed("EOF".to_owned()));

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

    // ------------------------------------------------ siklus hidup giliran

    fn turn_target_of(agen: &FakeAgent) -> TurnTarget {
        TurnTarget {
            connection: agen.connection().clone(),
            session_id: SessionId::from("sesi-uji"),
        }
    }

    /// Ambil `id` dari baris `session/prompt` yang dikirim klien, sekaligus
    /// memastikan yang dikirim memang prompt dengan teks yang benar.
    async fn tunggu_prompt(agen: &mut FakeAgent, teks: &str) -> Value {
        let baris = agen.next_line().await;
        assert_eq!(baris["method"], "session/prompt", "dapat: {baris}");
        assert_eq!(baris["params"]["prompt"][0]["text"], teks, "dapat: {baris}");
        baris["id"].clone()
    }

    /// **Siklus hidup giliran yang sukses.** Tanpa test ini, menghapus ketiga
    /// emisi `RUN_*` dari [`run_turn`] tidak menggagalkan apa pun: teks tetap
    /// mengalir lewat notifikasi, dan hanya spinner frontend yang berputar
    /// selamanya — cacat yang tidak terlihat dari Rust sama sekali.
    #[tokio::test]
    async fn giliran_sukses_mengemisikan_run_started_lalu_run_finished() {
        let (ctx, events) = recording_context(Duration::from_secs(30));
        let mut agen = FakeAgent::start(&ctx, events).await;
        let target = turn_target_of(&agen);

        let giliran = tokio::spawn({
            let ctx = ctx.clone();
            async move { run_turn(&ctx, &target, "halo".into()).await }
        });

        let id = tunggu_prompt(&mut agen, "halo").await;

        // RUN_STARTED harus sudah diemisikan sebelum balasan datang: notifikasi
        // pertama dari agen bisa tiba kapan saja setelah prompt terkirim, dan
        // event AG-UI sebelum RUN_STARTED tidak punya giliran untuk ditempeli.
        let (nama, mulai) = agen.next_event().await;
        assert_eq!(nama, EVENT_AGUI);
        assert_eq!(mulai["type"], "RUN_STARTED", "dapat: {mulai}");

        agen.reply(&id, json!({ "stopReason": "end_turn" }));

        let (nama, selesai) = agen.next_event().await;
        assert_eq!(nama, EVENT_AGUI);
        assert_eq!(selesai["type"], "RUN_FINISHED", "dapat: {selesai}");
        assert_eq!(
            selesai["runId"], mulai["runId"],
            "RUN_FINISHED harus menutup runId yang dibuka RUN_STARTED"
        );
        assert_eq!(selesai["threadId"], mulai["threadId"]);

        tokio::time::timeout(TEST_TIMEOUT, giliran)
            .await
            .expect("giliran harus selesai")
            .expect("task tidak boleh panik")
            .expect("giliran harus sukses");

        agen.shutdown().await;
    }

    /// Giliran yang gagal wajib ditutup `RUN_ERROR` — bukan `RUN_FINISHED`, dan
    /// bukan tidak ditutup sama sekali.
    #[tokio::test]
    async fn giliran_gagal_mengemisikan_run_error_bukan_run_finished() {
        let (ctx, events) = recording_context(Duration::from_secs(30));
        let mut agen = FakeAgent::start(&ctx, events).await;
        let target = turn_target_of(&agen);

        let giliran = tokio::spawn({
            let ctx = ctx.clone();
            async move { run_turn(&ctx, &target, "halo".into()).await }
        });

        let id = tunggu_prompt(&mut agen, "halo").await;

        let (_, mulai) = agen.next_event().await;
        assert_eq!(mulai["type"], "RUN_STARTED");

        agen.reply_error(&id, -32603, "agen kehabisan kuota");

        let (nama, galat) = agen.next_event().await;
        assert_eq!(nama, EVENT_AGUI);
        assert_eq!(galat["type"], "RUN_ERROR", "dapat: {galat}");
        assert_eq!(galat["runId"], mulai["runId"]);
        assert!(
            galat["message"].as_str().unwrap_or("").contains("kuota"),
            "pesan galat agen harus ikut sampai: {galat}"
        );

        let hasil = tokio::time::timeout(TEST_TIMEOUT, giliran)
            .await
            .expect("giliran harus selesai")
            .expect("task tidak boleh panik");
        assert!(hasil.is_err(), "giliran gagal harus mengembalikan Err");

        agen.shutdown().await;
    }

    /// Persis dua event AG-UI untuk satu giliran tanpa notifikasi: pembuka dan
    /// penutup. Ini yang menangkap emisi ganda atau emisi yang tertukar.
    #[tokio::test]
    async fn giliran_mengemisikan_tepat_satu_pembuka_dan_satu_penutup() {
        let (ctx, events) = recording_context(Duration::from_secs(30));
        let mut agen = FakeAgent::start(&ctx, events).await;
        let target = turn_target_of(&agen);

        let giliran = tokio::spawn({
            let ctx = ctx.clone();
            async move { run_turn(&ctx, &target, "halo".into()).await }
        });

        let id = tunggu_prompt(&mut agen, "halo").await;
        let (_, mulai) = agen.next_event().await;
        agen.reply(&id, json!({ "stopReason": "end_turn" }));
        let (_, selesai) = agen.next_event().await;

        tokio::time::timeout(TEST_TIMEOUT, giliran)
            .await
            .expect("giliran harus selesai")
            .expect("task tidak boleh panik")
            .expect("giliran harus sukses");

        assert_eq!(mulai["type"], "RUN_STARTED");
        assert_eq!(selesai["type"], "RUN_FINISHED");
        assert!(
            agen.try_next_event().is_none(),
            "giliran tanpa notifikasi hanya boleh menghasilkan dua event"
        );

        agen.shutdown().await;
    }

    // ------------------------------------------------------- disiplin kunci

    fn state_uji() -> (AppState, mpsc::UnboundedReceiver<(String, Value)>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (AppState::with_sink(Arc::new(RecordingSink::new(tx))), rx)
    }

    /// **Agen yang hidup tapi membisu tidak boleh mengunci aplikasi.**
    ///
    /// Bila [`send_prompt`] menahan kunci sesi selama giliran, [`connect_agent`]
    /// — satu-satunya jalan menyambung ulang — ikut terkunci selamanya, dan
    /// tidak ada perintah cancel untuk memutusnya. Test ini membiarkan agen
    /// palsu menerima prompt lalu diam, persis seperti adapter yang tersangkut
    /// prompt kredensial, dan menuntut kunci sesi tetap bisa diambil.
    #[tokio::test]
    async fn giliran_yang_tersangkut_tidak_menahan_kunci_sesi() {
        let (ctx, events) = recording_context(Duration::from_secs(30));
        let mut agen = FakeAgent::start(&ctx, events).await;
        let (state, _events_state) = state_uji();

        let target = turn_target_of(&agen);
        *state.session.lock().await = Some(Session {
            handle: agen.handle(PathBuf::from(env!("CARGO_MANIFEST_DIR"))),
            target,
        });

        // Ambil target seperti `send_prompt`, lalu jalankan giliran yang tidak
        // akan pernah dijawab.
        let diambil = state.turn_target().await.expect("sesi harus ada");
        let giliran = tokio::spawn({
            let ctx = ctx.clone();
            async move { run_turn(&ctx, &diambil, "halo".into()).await }
        });

        tunggu_prompt(&mut agen, "halo").await;

        // Agen diam selamanya di sini. Kunci sesi tetap harus bebas, kalau
        // tidak `connect_agent` tidak akan pernah bisa mendahuluinya.
        let bebas = tokio::time::timeout(Duration::from_millis(500), state.session.lock())
            .await
            .expect("kunci sesi harus bebas selama giliran berjalan");
        assert!(bebas.is_some(), "sesi harus masih terpasang");
        drop(bebas);

        giliran.abort();
        drop(giliran.await);
        agen.shutdown().await;
    }

    /// Jalur yang dipakai `get_full_permissions` / `set_full_permissions`:
    /// keduanya lewat `state.ctx`, yaitu konteks yang sama yang dibawa gerbang
    /// izin. Bila `AppState` suatu saat menyimpan konteks kedua, perintahnya
    /// akan menyetel flag yang tidak dibaca siapa pun — dan itu tidak terlihat
    /// dari test gerbang mana pun.
    #[tokio::test]
    async fn state_meneruskan_flag_izin_penuh_ke_konteks_gerbang() {
        let (state, _events) = state_uji();
        assert!(
            !state.ctx().full_permissions(),
            "bawaan wajib mati: bertanya adalah sisi yang aman"
        );

        state.ctx.set_full_permissions(true);
        assert!(state.ctx().full_permissions());

        state.ctx.set_full_permissions(false);
        assert!(!state.ctx().full_permissions());
    }

    // ------------------------------------- urutan pasang-flag lalu simpan

    static PEMBEDA: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// Direktori unik per pemanggil. Penghitung atomik, bukan jam: lihat
    /// catatan pada helper serupa di `settings::tests`.
    fn dir_sementara() -> PathBuf {
        let urutan = PEMBEDA.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!(
            "midscene-commands-{}-{}",
            std::process::id(),
            urutan
        ));
        std::fs::create_dir_all(&d).expect("direktori uji harus bisa dibuat");
        d
    }

    /// Direktori yang tidak mungkin bisa ditulisi: `/dev/null` bukan direktori,
    /// jadi `create_dir_all` di dalamnya gagal dengan `ENOTDIR`.
    fn dir_mustahil() -> PathBuf {
        PathBuf::from("/dev/null/mustahil/pengaturan")
    }

    fn perekam() -> (Arc<std::sync::atomic::AtomicBool>, impl Fn(bool)) {
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let tulis = {
            let flag = Arc::clone(&flag);
            move |nilai: bool| flag.store(nilai, std::sync::atomic::Ordering::SeqCst)
        };
        (flag, tulis)
    }

    /// **Urutan yang menjadi inti keputusan ini.** Menyimpan lebih dulu lalu
    /// `?` akan membuat permintaan "matikan persetujuan otomatis" ditolak gara-
    /// gara berkas pengaturan, dan agen terus menyetujui sendiri sepanjang
    /// sesi. Tanpa test ini, refactor ke urutan itu tidak menggagalkan apa pun.
    #[test]
    fn simpan_gagal_tetap_memberlakukan_perubahan_di_memori() {
        let (flag, tulis) = perekam();
        flag.store(true, std::sync::atomic::Ordering::SeqCst);

        let hasil = apply_and_persist_full_permissions(&dir_mustahil(), false, tulis);

        assert!(
            hasil.is_err(),
            "kegagalan menyimpan wajib muncul sebagai Err, bukan ditelan"
        );
        assert!(
            !flag.load(std::sync::atomic::Ordering::SeqCst),
            "mematikan mode harus tetap berlaku di memori meski simpan gagal"
        );
    }

    /// Arah sebaliknya, supaya urutannya terkunci di kedua arah.
    #[test]
    fn simpan_gagal_saat_menyalakan_juga_tetap_berlaku_dan_tetap_err() {
        let (flag, tulis) = perekam();

        let hasil = apply_and_persist_full_permissions(&dir_mustahil(), true, tulis);

        assert!(hasil.is_err());
        assert!(flag.load(std::sync::atomic::Ordering::SeqCst));
    }

    /// Jalur suksesnya: flag berubah **dan** berkasnya benar-benar ditulis,
    /// sehingga `settings::load` berikutnya membacanya kembali.
    #[test]
    fn simpan_sukses_mengubah_flag_dan_menulis_berkas() {
        let dir = dir_sementara();
        let (flag, tulis) = perekam();

        apply_and_persist_full_permissions(&dir, true, tulis).expect("simpan harus berhasil");

        assert!(flag.load(std::sync::atomic::Ordering::SeqCst));
        assert!(
            settings::load(&dir).full_permissions,
            "pilihan harus benar-benar sampai ke diska"
        );
    }

    // ------------------------------------------ pesan gagal simpan per arah

    /// Kalimat yang sama untuk kedua arah pernah dipakai di sini dan keliru ke
    /// arah berbahaya. Yang menentukan bukan arah perubahannya sendiri
    /// melainkan **apa yang akan terbaca nanti**, jadi itulah yang diuji.
    #[test]
    fn pesan_gagal_simpan_memperingatkan_hanya_saat_diska_masih_menyala() {
        // Pengguna mematikan; diska masih `true` → mode menyala sendiri nanti.
        let berbahaya = persist_failure_message(false, Some(true), "diska penuh");
        // Pengguna menyalakan; diska masih `false` → nanti kembali mati.
        let aman = persist_failure_message(true, Some(false), "diska penuh");

        assert_ne!(
            berbahaya, aman,
            "kedua arah tidak boleh menghasilkan kalimat yang sama"
        );
        assert!(
            berbahaya.contains("menyala sendiri"),
            "arah mematikan wajib memperingatkan mode akan menyala sendiri: {berbahaya}"
        );
        assert!(
            !aman.contains("menyala sendiri"),
            "arah menyalakan tidak boleh memakai peringatan itu: {aman}"
        );
        assert!(
            berbahaya.contains("sudah mati sekarang"),
            "kalimat tidak boleh menyatakan kebalikan dari yang terjadi: {berbahaya}"
        );
        assert!(aman.contains("menyala sekarang"), "dapat: {aman}");

        for pesan in [&berbahaya, &aman] {
            assert!(
                pesan.contains("diska penuh"),
                "sebab teknisnya harus ikut terbawa: {pesan}"
            );
        }
    }

    /// Bila berkasnya kebetulan sudah berisi pilihan yang sama, tidak ada yang
    /// akan menyimpang nanti — jadi kalimatnya tidak boleh menakut-nakuti.
    #[test]
    fn pesan_gagal_simpan_tidak_memperingatkan_bila_diska_sudah_sama() {
        let pesan = persist_failure_message(false, Some(false), "diska penuh");
        assert!(!pesan.contains("PERINGATAN"), "dapat: {pesan}");
        assert!(pesan.contains("tetap sesuai"), "dapat: {pesan}");
    }

    /// Saat kita bahkan tidak bisa membaca apa yang tersimpan, arah mematikan
    /// tetap harus berbunyi hati-hati — menebak ke sisi aman.
    #[test]
    fn pesan_gagal_simpan_berhati_hati_saat_diska_tak_terbaca() {
        let mati = persist_failure_message(false, None, "direktori tak dikenal");
        let nyala = persist_failure_message(true, None, "direktori tak dikenal");

        assert!(mati.contains("PERINGATAN"), "dapat: {mati}");
        assert!(!nyala.contains("PERINGATAN"), "dapat: {nyala}");
    }

    /// Kegagalan menyimpan yang sungguhan harus membawa kalimat arah yang
    /// benar sampai ke pemanggil — bukan hanya `persist_failure_message` yang
    /// benar bila dipanggil langsung.
    #[test]
    fn galat_dari_helper_memakai_kalimat_sesuai_arah() {
        let (_flag, tulis) = perekam();
        let galat = apply_and_persist_full_permissions(&dir_mustahil(), false, tulis)
            .expect_err("harus gagal");

        assert!(galat.contains("sudah mati sekarang"), "dapat: {galat}");
    }

    /// Tanpa sesi, `turn_target` menolak dengan kalimat yang bisa dibaca
    /// pengguna — bukan panik dan bukan menggantung.
    #[tokio::test]
    async fn tanpa_sesi_turn_target_menolak() {
        let (state, _events) = state_uji();
        let galat = state.turn_target().await.expect_err("harus menolak");
        assert!(galat.contains("Belum terhubung"), "dapat: {galat}");
    }

    /// Penutupan yang kita minta sendiri melucuti pemberitahuan putus lebih
    /// dulu, jadi UI tidak menerima peringatan untuk sesuatu yang normal.
    #[tokio::test]
    async fn menutup_sesi_tidak_mengemisikan_agent_disconnected() {
        let (ctx, events) = recording_context(Duration::from_secs(30));
        let mut agen = FakeAgent::start(&ctx, events).await;
        ctx.arm_disconnect_notice();

        let handle = agen.handle(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

        // Urutan yang sama dengan `AppState::close`.
        ctx.disarm_disconnect_notice();
        handle.shutdown().await;

        agen.wait_closed().await;
        while let Some((nama, payload)) = agen.try_next_event() {
            assert_ne!(
                nama, EVENT_AGENT_DISCONNECTED,
                "penutupan yang disengaja tidak boleh melaporkan putus: {payload}"
            );
        }
    }
}
