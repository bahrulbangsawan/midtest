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

use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, PromptRequest, SessionConfigKind, SessionConfigOption,
    SessionConfigOptionCategory, SessionConfigSelectOptions, SessionId,
    SetSessionConfigOptionRequest,
};
use agent_client_protocol::{Agent, ConnectionTo};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::acp::events::{agui_run_error, agui_run_finished, agui_run_started};
use crate::acp::{
    connect, new_session, AcpError, AcpHandle, ClientContext, EventSink, InitializeResponseExt,
    EVENT_AGUI,
};
use crate::agents::{find_agent, missing_binary_message, probe, AgentSpec};
use crate::settings;
use crate::sidecar::{midscene_server_with_runtime, RuntimeOverrides};

/// Env var untuk menimpa akar repo yang dipakai sesi dan sidecar MCP.
const ENV_ROOT: &str = "MIDTEST_ROOT";

/// Nama direktori resource yang membawa runtime MCP dalam bundle Tauri.
const RUNTIME_RESOURCE_DIR: &str = "midscene-runtime";

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

fn canonicalize_or_raw(raw: PathBuf) -> PathBuf {
    raw.canonicalize().unwrap_or(raw)
}

/// Akar yang dipilih eksplisit oleh operator. Ini selalu mendahului bundle
/// agar pengembangan dan diagnosis dapat menunjuk runtime MCP lain dengan
/// deterministis.
fn configured_root() -> Option<PathBuf> {
    std::env::var_os(ENV_ROOT)
        .map(PathBuf::from)
        .map(canonicalize_or_raw)
}

/// Akar source saat pengembangan. Biner Tauri dibangun dari `app/src-tauri`,
/// sehingga repo ada dua tingkat di atas manifest Cargo.
fn source_repo_root() -> PathBuf {
    canonicalize_or_raw(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

/// Akar repo yang dipakai test dan mode source.
#[cfg(test)]
fn repo_root() -> PathBuf {
    configured_root().unwrap_or_else(source_repo_root)
}

/// Cari runtime MCP yang benar-benar ikut disalin ke resource bundle.
///
/// Tidak cukup memeriksa direktori saja: entry point TypeScript adalah kontrak
/// yang dipakai sidecar, jadi bundle parsial harus jatuh ke fallback yang jelas
/// alih-alih baru gagal jauh di `session/new`.
fn bundled_runtime_root(resource_dir: &Path) -> Option<PathBuf> {
    let root = resource_dir.join(RUNTIME_RESOURCE_DIR);
    root.join("midscene-mcp/src/index.ts")
        .is_file()
        .then_some(root)
}

/// Akar runtime MCP yang berlaku untuk aplikasi berjalan.
///
/// Urutannya sengaja eksplisit: override operator, resource bundle yang valid,
/// lalu source tree (untuk `tauri dev` dan test). Dengan begitu paket release
/// tidak lagi bergantung pada path build machine.
fn runtime_root(app: &AppHandle) -> PathBuf {
    configured_root()
        .or_else(|| {
            app.path()
                .resource_dir()
                .ok()
                .and_then(|dir| bundled_runtime_root(&dir))
        })
        .unwrap_or_else(source_repo_root)
}

/// Pilih direktori yang boleh ditulisi aplikasi untuk skenario dan sebagai
/// workspace awal saat bundle pertama kali dibuka.
fn application_data_root(app: &AppHandle, fallback: &Path) -> PathBuf {
    match app.path().app_data_dir() {
        Ok(path) => match std::fs::create_dir_all(&path) {
            Ok(()) => path,
            Err(error) => {
                eprintln!(
                    "failed to create app data directory {}, using runtime root: {error}",
                    path.display()
                );
                fallback.to_path_buf()
            }
        },
        Err(error) => {
            eprintln!("failed to resolve app data directory, using runtime root: {error}");
            fallback.to_path_buf()
        }
    }
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

/// Petakan kegagalan `session/new` pada agen Codex ke pesan yang menyebut
/// `codex login`.
///
/// **Berbasis perilaku, bukan tebakan atas `authMethods`.** Saat handshake
/// `initialize`, Codex melaporkan dua metode auth padahal belum login, dan
/// tidak diketahui apakah daftar itu berubah setelah login — jadi
/// menyimpulkan status auth darinya berarti menebak. Aplikasi ini juga
/// sengaja **tidak pernah menyentuh kredensial**; itulah yang menopang
/// argumen kepatuhan ToS di spec, dan kenapa tidak ada alur login di sini
/// sama sekali.
///
/// Satu-satunya sinyal yang jujur adalah mencoba: `session/new` tidak
/// memanggil model, jadi percobaannya tidak berbiaya. Karena itu **setiap**
/// kegagalan `session/new` pada agen Codex — bukan hanya yang kelihatan
/// seperti galat auth — dipetakan ke pesan ini. Detail teknisnya tetap ikut
/// terbawa lewat `{error}`, supaya kegagalan yang sungguhan bukan soal auth
/// (mis. sidecar Midscene macet) masih bisa didiagnosis dari pesan yang sama.
#[must_use]
fn codex_session_failure_message(error: &AcpError) -> String {
    format!(
        "Codex menolak membuka sesi: {error}. Kemungkinan besar Codex belum \
         diautentikasi di mesin ini. Jalankan `codex login` lewat terminal, \
         lalu coba sambungkan lagi."
    )
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
    model: Option<ModelSelection>,
}

/// State aplikasi yang dikelola Tauri.
pub struct AppState {
    ctx: ClientContext,
    session: Mutex<Option<Session>>,
    root: PathBuf,
    data_root: PathBuf,
    settings_lock: std::sync::Mutex<()>,
}

impl AppState {
    /// Bangun state untuk satu aplikasi Tauri.
    #[must_use]
    pub fn new(app: AppHandle) -> Self {
        let root = runtime_root(&app);
        let data_root = application_data_root(&app, &root);
        Self::with_paths(Arc::new(TauriSink { app }), root, data_root)
    }

    /// Seperti [`Self::new`], tetapi dengan tujuan emisi apa pun. Test memakai
    /// sink berbasis channel; produksi memakai `AppHandle`.
    #[cfg(test)]
    fn with_sink(sink: Arc<dyn EventSink>) -> Self {
        let root = repo_root();
        Self::with_paths(sink, root.clone(), root)
    }

    fn with_paths(sink: Arc<dyn EventSink>, root: PathBuf, data_root: PathBuf) -> Self {
        Self {
            ctx: ClientContext::new(sink),
            session: Mutex::new(None),
            root,
            data_root,
            settings_lock: std::sync::Mutex::new(()),
        }
    }

    /// Konteks klien yang dibagi ke handler-handler ACP.
    #[must_use]
    pub fn ctx(&self) -> &ClientContext {
        &self.ctx
    }

    #[must_use]
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Direktori data yang writable; berbeda dari resource bundle pada
    /// aplikasi release.
    #[must_use]
    pub(crate) fn data_root(&self) -> &Path {
        &self.data_root
    }

    /// Serialize read-modify-write operations over one `settings.json`.
    ///
    /// Atomic rename prevents torn files, while this lock preserves fields
    /// changed by different commands (workspace, browser, and Midscene model)
    /// from overwriting one another with stale snapshots.
    pub(crate) fn settings_lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.settings_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
        self.ctx.permissions().clear();
        handle.shutdown().await;
    }

    /// Tutup sesi aktif bila ada. Idempoten supaya dapat dipanggil baik ketika
    /// workspace terakhir ditutup maupun saat event loop aplikasi berakhir.
    pub(crate) async fn shutdown(&self) {
        let session = self.session.lock().await.take();
        if let Some(session) = session {
            self.close(session.handle).await;
        } else {
            self.ctx.disarm_disconnect_notice();
            self.ctx.permissions().clear();
        }
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
    /// Models are supplied by the live ACP adapter. An empty list means the
    /// adapter did not expose a model selector, never that the frontend forgot
    /// to hardcode one.
    pub models: Vec<ModelOption>,
    pub selected_model: Option<String>,
    pub supports_model_selection: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone)]
struct ModelSelection {
    config_id: String,
    options: Vec<ModelOption>,
    selected: String,
}

/// Find the semantically-declared model selector, with a conservative id/name
/// fallback for adapters that implemented session config before categories
/// were added to ACP.
fn model_selection(options: &[SessionConfigOption]) -> Option<ModelSelection> {
    let option = options.iter().find(|option| {
        matches!(option.category, Some(SessionConfigOptionCategory::Model))
            || option.id.to_string().eq_ignore_ascii_case("model")
            || option.name.eq_ignore_ascii_case("model")
    })?;
    let SessionConfigKind::Select(select) = &option.kind else {
        return None;
    };
    let values = match &select.options {
        SessionConfigSelectOptions::Ungrouped(values) => values
            .iter()
            .map(|value| ModelOption {
                id: value.value.to_string(),
                label: value.name.clone(),
                description: value.description.clone(),
            })
            .collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter())
            .map(|value| ModelOption {
                id: value.value.to_string(),
                label: value.name.clone(),
                description: value.description.clone(),
            })
            .collect(),
        _ => Vec::new(),
    };
    Some(ModelSelection {
        config_id: option.id.to_string(),
        options: values,
        selected: select.current_value.to_string(),
    })
}

/// Pencari PATH sungguhan dipakai [`connect_agent`] di produksi.
///
/// Fungsi biasa, bukan closure inline, supaya bisa diteruskan sebagai `&dyn
/// Fn` — persis bentuk yang [`connect_agent_body`] terima di test lewat
/// pencari palsu. [`agents::probe`] sendiri sudah menerima closure ini demi
/// alasan yang sama; lihat dokumentasi di sana.
fn real_path_lookup(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(bin);
        candidate.is_file().then_some(candidate)
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelState {
    pub models: Vec<ModelOption>,
    pub selected_model: Option<String>,
    pub supports_model_selection: bool,
}

impl ModelState {
    fn from_selection(selection: Option<&ModelSelection>) -> Self {
        Self {
            models: selection.map_or_else(Vec::new, |value| value.options.clone()),
            selected_model: selection.map(|value| value.selected.clone()),
            supports_model_selection: selection.is_some(),
        }
    }
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
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    workspace_path: Option<String>,
    preferred_model: Option<String>,
) -> Result<AgentInfo, String> {
    let workspace = workspace_path.map(PathBuf::from);
    let stored = settings::load(&config_dir(&app)?);
    let overrides = crate::system::runtime_overrides(state.root(), &stored)?;
    connect_agent_body_with_runtime(
        &state,
        agent_id,
        workspace.as_deref(),
        preferred_model.as_deref(),
        &real_path_lookup,
        &overrides,
    )
    .await
}

/// Badan [`connect_agent`], bebas dari `State` milik Tauri dan dari pencari
/// PATH sungguhan.
///
/// Dipisahkan dengan alasan yang sama seperti [`run_turn`] dan
/// [`cancel_turn_body`]: satu-satunya cara membuktikan bahwa biner yang
/// hilang **tidak pernah** sampai ke [`connect`] adalah menjalankan jalur ini
/// dengan pencari palsu yang selalu mengembalikan `None`, tanpa bergantung
/// pada — atau mengubah — PATH mesin yang menjalankan test.
///
/// `probe` dipanggil **sebelum** sesi lama ditutup dan sebelum [`connect`]
/// dipanggil: agen tujuan yang binernya hilang tidak boleh merobohkan sesi
/// yang sedang berjalan, dan tidak boleh sampai men-spawn apa pun.
///
/// # Errors
///
/// Kalimat berbahasa Indonesia yang siap ditampilkan:
/// - id agen tak dikenal → menyebut id itu;
/// - biner adapter tak ditemukan → [`missing_binary_message`], berbeda dari
///   galat protokol mana pun yang dihasilkan [`user_message`];
/// - `session/new` gagal pada agen Codex → [`codex_session_failure_message`],
///   yang menyebut `codex login` — lihat dokumentasi fungsi itu untuk kenapa
///   ini berbasis perilaku, bukan tebakan atas `authMethods`;
/// - kegagalan lain → lihat [`user_message`].
#[cfg(test)]
async fn connect_agent_body(
    state: &AppState,
    agent_id: String,
    path_lookup: &(dyn Fn(&str) -> Option<PathBuf> + Send + Sync),
) -> Result<AgentInfo, String> {
    connect_agent_body_with_options(state, agent_id, None, None, path_lookup).await
}

#[cfg(test)]
async fn connect_agent_body_with_options(
    state: &AppState,
    agent_id: String,
    workspace: Option<&Path>,
    preferred_model: Option<&str>,
    path_lookup: &(dyn Fn(&str) -> Option<PathBuf> + Send + Sync),
) -> Result<AgentInfo, String> {
    connect_agent_body_with_runtime(
        state,
        agent_id,
        workspace,
        preferred_model,
        path_lookup,
        &RuntimeOverrides::default(),
    )
    .await
}

async fn connect_agent_body_with_runtime(
    state: &AppState,
    agent_id: String,
    workspace: Option<&Path>,
    preferred_model: Option<&str>,
    path_lookup: &(dyn Fn(&str) -> Option<PathBuf> + Send + Sync),
    runtime_overrides: &RuntimeOverrides,
) -> Result<AgentInfo, String> {
    let spec: &'static AgentSpec =
        find_agent(&agent_id).ok_or_else(|| format!("Agen \"{agent_id}\" tidak dikenal."))?;

    if !probe(spec.bin, path_lookup) {
        return Err(missing_binary_message(spec));
    }

    let mut guard = state.session.lock().await;
    if let Some(previous) = guard.take() {
        state.close(previous.handle).await;
    }

    let runtime_root = state.root.clone();
    let data_root = state.data_root.clone();
    let cwd = workspace.unwrap_or(&runtime_root);
    let (handle, initialize) = connect(spec, cwd, state.ctx.clone())
        .await
        .map_err(|error| user_message(&error))?;

    let response = match new_session(
        &handle,
        cwd,
        vec![midscene_server_with_runtime(
            &runtime_root,
            &data_root,
            runtime_overrides,
        )],
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            // Handshake sudah berhasil, jadi proses anaknya hidup. Jangan
            // biarkan ia bocor hanya karena sesinya gagal dibuat.
            state.close(handle).await;
            let message = if spec.id == "codex" {
                codex_session_failure_message(&error)
            } else {
                user_message(&error)
            };
            return Err(message);
        }
    };

    let session_id = response.session_id;
    let mut model = response.config_options.as_deref().and_then(model_selection);

    if let (Some(preferred), Some(selection)) = (preferred_model, model.as_ref()) {
        let is_available = selection
            .options
            .iter()
            .any(|option| option.id == preferred);
        if is_available && selection.selected != preferred {
            let request = SetSessionConfigOptionRequest::new(
                session_id.clone(),
                selection.config_id.clone(),
                preferred,
            );
            match handle.connection().send_request(request).block_task().await {
                Ok(updated) => {
                    model = model_selection(&updated.config_options);
                }
                Err(error) => {
                    state.close(handle).await;
                    return Err(format!(
                        "Model {preferred} tidak dapat dipilih oleh agen {label}: {error}",
                        label = spec.label
                    ));
                }
            }
        }
    }

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
        models: model
            .as_ref()
            .map_or_else(Vec::new, |selection| selection.options.clone()),
        selected_model: model.as_ref().map(|selection| selection.selected.clone()),
        supports_model_selection: model.is_some(),
    };

    let target = TurnTarget {
        connection: handle.connection().clone(),
        session_id,
    };
    *guard = Some(Session {
        handle,
        target,
        model,
    });

    // Paling akhir: sejak titik ini putusnya koneksi memang kabar buruk yang
    // hanya bisa disampaikan lewat event.
    state.ctx.arm_disconnect_notice();

    Ok(info)
}

/// Change the live session model using the selector exposed by the ACP agent.
/// No model ids are invented in the desktop client.
#[tauri::command]
pub async fn set_agent_model(
    state: State<'_, AppState>,
    model_id: String,
) -> Result<ModelState, String> {
    let mut guard = state.session.lock().await;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Belum terhubung ke agen. Sambungkan agen lebih dulu.".to_owned())?;
    let selection = session.model.as_ref().ok_or_else(|| {
        "Agen ini tidak mengekspos pemilih model melalui ACP. Model bawaan agen tetap digunakan."
            .to_owned()
    })?;
    if !selection.options.iter().any(|option| option.id == model_id) {
        return Err(format!(
            "Model \"{model_id}\" tidak tersedia pada sesi ini. Muat ulang daftar model dari agen."
        ));
    }
    if selection.selected == model_id {
        return Ok(ModelState::from_selection(session.model.as_ref()));
    }

    let request = SetSessionConfigOptionRequest::new(
        session.target.session_id.clone(),
        selection.config_id.clone(),
        model_id.as_str(),
    );
    let updated = session
        .target
        .connection
        .send_request(request)
        .block_task()
        .await
        .map_err(|error| format!("Model gagal diubah: {error}"))?;
    session.model = model_selection(&updated.config_options);
    Ok(ModelState::from_selection(session.model.as_ref()))
}

fn workspace_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Workspace")
        .to_owned()
}

fn validate_workspace_path(path: &Path) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(|error| {
        format!(
            "Folder {} tidak dapat dibuka. Folder mungkin sudah dipindah atau dihapus: {error}",
            path.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!("{} bukan sebuah folder.", canonical.display()));
    }
    std::fs::read_dir(&canonical).map_err(|error| {
        format!(
            "Akses ke folder {} ditolak atau tidak tersedia: {error}",
            canonical.display()
        )
    })?;
    Ok(canonical)
}

fn default_workspace(path: &Path) -> settings::Workspace {
    let thread = settings::Thread {
        id: "thread-main".to_owned(),
        title: "New thread".to_owned(),
    };
    settings::Workspace {
        path: path.display().to_string(),
        name: workspace_name(path),
        threads: vec![thread.clone()],
        selected_thread_id: Some(thread.id),
    }
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| format!("Direktori pengaturan aplikasi tidak tersedia: {error}"))
}

fn normalized_settings(state: &AppState, mut stored: settings::Settings) -> settings::Settings {
    if stored.workspaces.is_empty() {
        stored.workspaces.push(default_workspace(state.data_root()));
    }
    if stored.selected_workspace.as_ref().is_none_or(|selected| {
        !stored
            .workspaces
            .iter()
            .any(|workspace| workspace.path == *selected)
    }) {
        stored.selected_workspace = stored
            .workspaces
            .first()
            .map(|workspace| workspace.path.clone());
    }
    if find_agent(&stored.default_provider).is_none() {
        stored.default_provider = "claude".to_owned();
    }
    for workspace in &mut stored.workspaces {
        if workspace.name.trim().is_empty() {
            workspace.name = workspace_name(Path::new(&workspace.path));
        }
        if workspace.threads.is_empty() {
            workspace.threads.push(settings::Thread {
                id: "thread-main".to_owned(),
                title: "New thread".to_owned(),
            });
        }
        if workspace
            .selected_thread_id
            .as_ref()
            .is_none_or(|selected| {
                !workspace
                    .threads
                    .iter()
                    .any(|thread| thread.id == *selected)
            })
        {
            workspace.selected_thread_id =
                workspace.threads.first().map(|thread| thread.id.clone());
        }
    }
    stored
}

/// Load every durable UI preference. Missing workspaces are deliberately not
/// removed here; attempting to connect will produce the actionable path error.
#[tauri::command]
pub fn get_app_settings(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<settings::Settings, String> {
    let dir = config_dir(&app)?;
    let mut stored = normalized_settings(&state, settings::load(&dir));
    stored.full_permissions = state.ctx.full_permissions();
    Ok(stored)
}

/// Persist frontend-owned preferences while keeping the runtime permission
/// flag authoritative. This prevents a stale React snapshot from changing the
/// safety mode as a side effect of renaming a thread.
#[tauri::command]
pub fn save_app_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut value: settings::Settings,
) -> Result<settings::Settings, String> {
    let _settings_lock = state.settings_lock();
    value.full_permissions = state.ctx.full_permissions();
    let value = normalized_settings(&state, value);
    let dir = config_dir(&app)?;
    settings::save(&dir, &value)
        .map_err(|error| format!("Pengaturan aplikasi gagal disimpan: {error}"))?;
    Ok(value)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddWorkspaceResult {
    pub settings: settings::Settings,
    pub added: bool,
}

/// Validate, canonicalize, deduplicate, and persist a folder selected by the
/// native dialog.
#[tauri::command]
pub fn add_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<AddWorkspaceResult, String> {
    let canonical = validate_workspace_path(Path::new(&path))?;
    let canonical_string = canonical.display().to_string();
    let dir = config_dir(&app)?;
    let _settings_lock = state.settings_lock();
    let mut stored = normalized_settings(&state, settings::load(&dir));
    let added = !stored
        .workspaces
        .iter()
        .any(|workspace| workspace.path == canonical_string);
    if added {
        stored.workspaces.push(default_workspace(&canonical));
    }
    stored.selected_workspace = Some(canonical_string);
    stored.full_permissions = state.ctx.full_permissions();
    settings::save(&dir, &stored)
        .map_err(|error| format!("Workspace valid, tetapi gagal disimpan: {error}"))?;
    Ok(AddWorkspaceResult {
        settings: stored,
        added,
    })
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

/// Kirim `session/cancel` untuk sesi `target`.
///
/// **Ini notifikasi, bukan request.** Tanda tangannya
/// `ConnectionTo::send_notification<N: JsonRpcNotification>(&self, notification: N)
/// -> Result<(), Error>` (`agent-client-protocol-2.0.0/src/jsonrpc.rs:3480`):
/// sinkron, tanpa `id`, dan tanpa `SentRequest`/`block_task` untuk ditunggu.
/// Karena itu fungsi ini kembali seketika. `Ok` di sini hanya berarti
/// "terkirim", bukan "giliran sudah berhenti".
///
/// Yang mengakhiri gilirannya adalah agen: skema mewajibkan `session/prompt`
/// yang tertunda dijawab dengan [`StopReason::Cancelled`], **sebagai respons
/// normal** — jadi [`run_turn`] menutupnya lewat cabang `Ok` dengan
/// `RUN_FINISHED`. Mengubahnya menjadi `RUN_ERROR` akan menampilkan galat untuk
/// sesuatu yang pengguna sendiri minta.
///
/// [`StopReason::Cancelled`]: agent_client_protocol::schema::v1::StopReason::Cancelled
fn send_cancel(target: &TurnTarget) -> Result<(), String> {
    target
        .connection
        .send_notification(CancelNotification::new(target.session_id.clone()))
        .map_err(|error| format!("Permintaan berhenti gagal dikirim ke agen: {error}"))
}

/// Badan [`cancel_turn`], bebas dari `State` milik Tauri.
///
/// Dipisahkan dengan alasan yang sama seperti [`run_turn`]: satu-satunya cara
/// membuktikan bahwa pembatalan **tidak** antre di kunci sesi adalah
/// menjalankannya terhadap [`AppState`] sungguhan saat sebuah giliran sedang
/// menggantung, dan `State<'_, AppState>` tidak bisa dibangun di test.
///
/// # Errors
///
/// Bila belum ada sesi, atau bila notifikasi gagal masuk ke transport.
async fn cancel_turn_body(state: &AppState) -> Result<(), String> {
    // Kunci diambil dan dilepas di sini. Pembatalan dipanggil justru saat
    // giliran berjalan, jadi menahan kunci akan membekukan tombol berhenti
    // tepat pada saat ia dibutuhkan.
    let target = state.turn_target().await?;
    send_cancel(&target)
}

/// Minta agen menghentikan giliran yang sedang berjalan.
///
/// Kembali begitu notifikasi terkirim; giliran berakhir belakangan, saat agen
/// menjawab prompt yang tertunda dengan `Cancelled` dan [`run_turn`] menutupnya
/// dengan `RUN_FINISHED`. Frontend tidak boleh menganggap giliran sudah selesai
/// hanya karena perintah ini `Ok`.
///
/// # Errors
///
/// Bila belum ada sesi, atau bila notifikasi gagal masuk ke transport.
#[tauri::command]
pub async fn cancel_turn(state: State<'_, AppState>) -> Result<(), String> {
    cancel_turn_body(&state).await
}

/// Tutup sesi ACP aktif secara eksplisit.
///
/// Dipanggil ketika workspace terakhir dilupakan; hook event loop juga memakai
/// metode state yang sama saat aplikasi keluar. Tidak ada sesi adalah hasil
/// normal, sehingga command ini idempoten dan selalu berhasil.
#[tauri::command]
pub async fn disconnect_agent(state: State<'_, AppState>) -> Result<(), String> {
    state.shutdown().await;
    Ok(())
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
            ..settings::load(dir)
        },
    )
    .map_err(|error| {
        // `load` infalibel, jadi aman dipanggil di jalur galat: ia memberi tahu
        // kita apa yang **sungguh** akan terbaca pada peluncuran berikutnya.
        let tersimpan = settings::load(dir).full_permissions;
        persist_failure_message(
            enabled,
            Some(tersimpan),
            &format!("{error} ({})", dir.display()),
        )
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
    let _settings_lock = state.settings_lock();
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
    use crate::acp::testing::{recording_context, FakeAgent, RecordingSink, TEST_TIMEOUT};
    use crate::acp::EVENT_AGENT_DISCONNECTED;
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

    #[test]
    fn runtime_bundle_hanya_dipilih_bila_entry_point_lengkap() {
        let resource_dir = dir_sementara();
        assert!(bundled_runtime_root(&resource_dir).is_none());

        let runtime = resource_dir.join(RUNTIME_RESOURCE_DIR);
        std::fs::create_dir_all(runtime.join("midscene-mcp/src"))
            .expect("struktur resource test harus dapat dibuat");
        std::fs::write(runtime.join("midscene-mcp/src/index.ts"), "// entry")
            .expect("entry point test harus dapat ditulis");

        assert_eq!(bundled_runtime_root(&resource_dir), Some(runtime));
        std::fs::remove_dir_all(resource_dir).expect("resource test harus dapat dibersihkan");
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
            models: Vec::new(),
            selected_model: None,
            supports_model_selection: false,
        })
        .expect("harus terserialisasi");

        assert_eq!(json["sessionId"], "sesi-1");
        assert_eq!(json["threadId"], "sesi-1");
        assert_eq!(json["supportsImagePrompt"], true);
        assert!(json.get("session_id").is_none());
    }

    // -------------------------------------------- deteksi biner adapter

    /// Menyambung dengan id agen yang tidak dikenal wajib menyebut id itu di
    /// pesannya — pengguna butuh tahu persis apa yang salah ketik.
    #[tokio::test]
    async fn connect_agent_dengan_id_tak_dikenal_menyebut_id_itu() {
        let (state, _events) = state_uji();
        // Pencari tidak relevan di jalur ini: `find_agent` gagal duluan.
        let tak_dipanggil =
            |_: &str| panic!("path_lookup tidak boleh dipanggil untuk id tak dikenal");

        let galat = connect_agent_body(&state, "agen-siluman".into(), &tak_dipanggil)
            .await
            .expect_err("id tak dikenal harus ditolak");

        assert!(galat.contains("agen-siluman"), "dapat: {galat}");
    }

    /// **Inti perbaikan Task 6.** Sebelum `probe` dipanggil di jalur ini,
    /// biner yang hilang tidak pernah tertangkap di sini sama sekali — ia
    /// jatuh ke `connect` dan muncul sebagai galat protokol yang menyesatkan.
    /// Test ini menuntut dua hal sekaligus: pesannya menyebut nama biner
    /// sungguhan dari registry (bukan salinan hardcoded), dan pesannya
    /// **berbeda** dari galat protokol mana pun — kalau keduanya sama,
    /// pengguna tidak belajar apa-apa dan perbaikan ini tidak berguna.
    ///
    /// Pencari palsu (`kosong`) dipakai justru supaya test ini tidak
    /// bergantung pada apakah `claude-agent-acp` sungguhan terpasang di
    /// mesin yang menjalankannya.
    #[tokio::test]
    async fn connect_agent_dengan_biner_hilang_menyebut_biner_dan_beda_dari_galat_protokol() {
        let (state, _events) = state_uji();
        let kosong = |_: &str| None;

        let galat = connect_agent_body(&state, "claude".into(), &kosong)
            .await
            .expect_err("biner hilang harus ditolak sebelum menyambung");

        assert!(galat.contains("claude-agent-acp"), "dapat: {galat}");
        assert!(galat.contains("npm install"), "dapat: {galat}");
        assert!(
            galat.contains("@agentclientprotocol/claude-agent-acp"),
            "dapat: {galat}"
        );

        let galat_protokol = user_message(&AcpError::HandshakeTimeout(Duration::from_secs(30)));
        assert_ne!(
            galat, galat_protokol,
            "pesan biner hilang wajib berbeda dari galat protokol, kalau tidak pengguna \
             tidak belajar apa-apa dari perbaikan ini"
        );
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
            model: None,
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

    // ------------------------------------------------------ pembatalan giliran

    /// **Notifikasi `session/cancel` benar-benar sampai ke agen, dan giliran
    /// yang dibatalkan berakhir sebagai respons normal.**
    ///
    /// Dua klaim dalam satu test karena keduanya satu peristiwa: skema
    /// menyatakan `Cancelled` **WAJIB** dikembalikan `session/prompt` yang
    /// tertunda begitu klien mengirim `session/cancel`. Jadi bila kita
    /// memperlakukan giliran yang dibatalkan sebagai galat, UI akan menampilkan
    /// galat merah untuk sesuatu yang pengguna sendiri minta.
    #[tokio::test]
    async fn membatalkan_mengirim_session_cancel_lalu_giliran_ditutup_run_finished() {
        let (ctx, events) = recording_context(Duration::from_secs(30));
        let mut agen = FakeAgent::start(&ctx, events).await;
        let target = turn_target_of(&agen);

        let giliran = tokio::spawn({
            let ctx = ctx.clone();
            let target = target.clone();
            async move { run_turn(&ctx, &target, "halo".into()).await }
        });

        // Agen menerima prompt dan sengaja **tidak** menjawabnya dulu.
        let id = tunggu_prompt(&mut agen, "halo").await;
        let (_, mulai) = agen.next_event().await;
        assert_eq!(mulai["type"], "RUN_STARTED", "dapat: {mulai}");

        send_cancel(&target).expect("notifikasi batal harus terkirim");

        let baris = agen.next_line().await;
        assert_eq!(baris["method"], "session/cancel", "dapat: {baris}");
        assert_eq!(baris["params"]["sessionId"], "sesi-uji", "dapat: {baris}");
        assert!(
            baris.get("id").is_none(),
            "session/cancel adalah notifikasi: tidak boleh ada id yang menunggu balasan: {baris}"
        );

        // Baru sekarang agen menutup prompt yang tertunda, sesuai skema.
        agen.reply(&id, json!({ "stopReason": "cancelled" }));

        let (nama, selesai) = agen.next_event().await;
        assert_eq!(nama, EVENT_AGUI);
        assert_eq!(
            selesai["type"], "RUN_FINISHED",
            "giliran yang dibatalkan berakhir normal, bukan galat: {selesai}"
        );
        assert_eq!(selesai["runId"], mulai["runId"]);
        assert_eq!(selesai["threadId"], mulai["threadId"]);

        tokio::time::timeout(TEST_TIMEOUT, giliran)
            .await
            .expect("giliran harus selesai")
            .expect("task tidak boleh panik")
            .expect("pembatalan bukan kegagalan giliran");

        agen.shutdown().await;
    }

    /// **Pembatalan tidak boleh menunggu kunci sesi.** Ia dipanggil justru saat
    /// giliran sedang berjalan; bila ia antre di kunci yang sama dengan yang
    /// ditahan giliran, tombol berhenti tidak akan pernah berfungsi tepat pada
    /// satu-satunya saat ia dibutuhkan.
    #[tokio::test]
    async fn membatalkan_bekerja_saat_giliran_berjalan_dan_tidak_menahan_kunci() {
        let (ctx, events) = recording_context(Duration::from_secs(30));
        let mut agen = FakeAgent::start(&ctx, events).await;
        let (state, _events_state) = state_uji();

        let target = turn_target_of(&agen);
        *state.session.lock().await = Some(Session {
            handle: agen.handle(PathBuf::from(env!("CARGO_MANIFEST_DIR"))),
            target,
            model: None,
        });

        let diambil = state.turn_target().await.expect("sesi harus ada");
        let giliran = tokio::spawn({
            let ctx = ctx.clone();
            async move { run_turn(&ctx, &diambil, "halo".into()).await }
        });

        tunggu_prompt(&mut agen, "halo").await;

        // Giliran menggantung di sini. Pembatalan tetap harus selesai cepat.
        tokio::time::timeout(Duration::from_millis(500), cancel_turn_body(&state))
            .await
            .expect("pembatalan tidak boleh menunggu giliran atau kunci sesi")
            .expect("pembatalan harus berhasil");

        let baris = agen.next_line().await;
        assert_eq!(baris["method"], "session/cancel", "dapat: {baris}");
        assert_eq!(baris["params"]["sessionId"], "sesi-uji", "dapat: {baris}");

        // Dan kuncinya memang tidak ditahan setelahnya.
        let bebas = tokio::time::timeout(Duration::from_millis(500), state.session.lock())
            .await
            .expect("kunci sesi harus tetap bebas setelah pembatalan");
        assert!(bebas.is_some());
        drop(bebas);

        giliran.abort();
        drop(giliran.await);
        agen.shutdown().await;
    }

    /// Menekan berhenti sebelum ada agen tersambung harus menghasilkan kalimat
    /// yang bisa dibaca pengguna — bukan panik dan bukan `unwrap` pada `None`.
    #[tokio::test]
    async fn membatalkan_tanpa_sesi_menolak_dengan_kalimat_indonesia() {
        let (state, _events) = state_uji();

        let galat = cancel_turn_body(&state)
            .await
            .expect_err("tanpa sesi harus menolak");

        assert!(galat.contains("Belum terhubung"), "dapat: {galat}");
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

    /// `disconnect_agent` dan hook keluar aplikasi harus benar-benar menutup
    /// transport, mengosongkan sesi, dan membatalkan dialog izin yang mungkin
    /// masih tampil. Tanpa tiga efek itu, proses adapter atau pilihan izin basi
    /// dapat hidup melampaui workspace yang baru saja ditutup.
    #[tokio::test]
    async fn shutdown_state_menutup_sesi_dan_membersihkan_izin() {
        let (state, events) = state_uji();
        let mut agen = FakeAgent::start(state.ctx(), events).await;
        let target = turn_target_of(&agen);
        *state.session.lock().await = Some(Session {
            handle: agen.handle(PathBuf::from(env!("CARGO_MANIFEST_DIR"))),
            target,
            model: None,
        });
        let penunggu = state.ctx().permissions().daftar("izin-lama".to_owned());
        state.ctx().arm_disconnect_notice();

        state.shutdown().await;

        assert!(state.session.lock().await.is_none());
        assert_eq!(state.ctx().permissions().pending_count(), 0);
        assert!(penunggu.await.is_err(), "izin lama harus dibatalkan");
        agen.wait_closed().await;
        while let Some((nama, payload)) = agen.try_next_event() {
            assert_ne!(
                nama, EVENT_AGENT_DISCONNECTED,
                "penutupan disengaja tidak boleh dilaporkan: {payload}"
            );
        }
    }

    // -------------------------------------- berpindah agen (adapter sungguhan palsu)
    //
    // Semua test di bawah ini sengaja **tidak** memakai `FakeAgent`
    // (`acp::testing`): `FakeAgent` bicara lewat kanal in-process, jadi ia
    // tidak pernah menyentuh `connect()` sungguhan — jalur yang justru men-
    // spawn proses OS lewat `spec.bin`, dicari lewat PATH proses ini, **bukan**
    // lewat closure `path_lookup` yang hanya dipakai `probe`. Membuktikan
    // "sesi lama benar-benar ditutup" dan "tidak ada proses tertinggal" perlu
    // proses OS sungguhan untuk diperiksa hidup-matinya — kode yang "kelihatan
    // benar" tidak cukup, itulah inti tuntutan Task 7.
    //
    // Mesin ini punya `claude-agent-acp` dan `codex-acp` **sungguhan**
    // terpasang di PATH aslinya (lihat brief Task 7). Membiarkan `path_lookup`
    // palsu meloloskan `probe` tanpa membatasi PATH proses ini berarti test
    // diam-diam men-spawn adapter sungguhan. [`RestrictedPath`] mengganti PATH
    // proses ini ke direktori berisi biner palsu ([`StubAdapter`]) sepanjang
    // hidupnya, dan memulihkannya saat di-drop.

    /// Kunci proses: hanya satu test boleh mengubah PATH proses ini di satu
    /// waktu. Tidak ada test lain di crate ini yang membaca PATH sungguhan
    /// (satu-satunya jalur yang melakukannya adalah `real_path_lookup`, yang
    /// tidak dipanggil `connect_agent_body` di test — lihat `connect_agent`),
    /// jadi kunci ini hanya perlu menyerialkan test-test di bagian ini
    /// terhadap satu sama lain, bukan terhadap seluruh suite.
    static PATH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Membatasi `PATH` proses test ini ke sekumpulan direktori, dan
    /// memulihkan nilai aslinya saat di-drop — bahkan bila test panik di
    /// tengah jalan (unwind menjalankan `Drop`).
    struct RestrictedPath {
        lama: Option<std::ffi::OsString>,
        _kunci: std::sync::MutexGuard<'static, ()>,
    }

    impl RestrictedPath {
        fn new(dirs: &[&Path]) -> Self {
            let kunci = PATH_LOCK
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let lama = std::env::var_os("PATH");
            let baru =
                std::env::join_paths(dirs.iter().copied()).expect("path direktori uji harus sah");
            std::env::set_var("PATH", baru);
            Self {
                lama,
                _kunci: kunci,
            }
        }
    }

    impl Drop for RestrictedPath {
        fn drop(&mut self) {
            match self.lama.take() {
                Some(nilai) => std::env::set_var("PATH", nilai),
                None => std::env::remove_var("PATH"),
            }
        }
    }

    /// Templat biner adapter palsu: skrip Python yang bicara JSON-RPC baris-
    /// demi-baris lewat stdio, persis format `Lines` yang dipakai `AcpAgent`
    /// sungguhan (`agent-client-protocol-2.0.0/src/acp_agent.rs:727`). Cukup
    /// untuk menyelesaikan `initialize` dan `session/new` — dua-duanya yang
    /// dibutuhkan `connect_agent_body` — tanpa jadi adapter sungguhan.
    ///
    /// `__PID_LOG__` diganti path berkas tempat skrip mencatat PID-nya sendiri
    /// setiap kali dijalankan, supaya test bisa memeriksa hidup-matinya
    /// prosesnya dari sisi Rust.
    ///
    /// `__GAGAL_SESI__` diganti `True`/`False`: dipakai test pemetaan galat
    /// Codex untuk mensimulasikan agen yang menolak `session/new` (mis. karena
    /// belum `codex login`) tanpa perlu autentikasi sungguhan — aplikasi ini
    /// tidak pernah menyentuh kredensial sama sekali, termasuk di test.
    ///
    /// `__KELUAR_LAMBAT__` diganti `True`/`False`: saat `True`, skrip menunda
    /// diri 300ms setelah stdin-nya EOF sebelum benar-benar keluar. Ini bukan
    /// hiasan — lihat dokumentasi
    /// [`menyambung_agen_kedua_menutup_agen_lama_sebelum_membuka_yang_baru`]
    /// untuk kenapa jeda ini satu-satunya cara membuktikan urutan penutupan
    /// tanpa bergantung pada seberapa cepat *executor* kebetulan menjadwalkan
    /// task yang di-drop.
    const STUB_TEMPLATE: &str = r#"#!/usr/bin/python3
import sys, os, json, time

PID_LOG = "__PID_LOG__"
with open(PID_LOG, "a") as f:
    f.write(str(os.getpid()) + "\n")

def kirim(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for baris in sys.stdin:
    baris = baris.strip()
    if not baris:
        continue
    try:
        pesan = json.loads(baris)
    except Exception:
        continue
    mid = pesan.get("id")
    metode = pesan.get("method")
    if mid is None:
        continue
    if metode == "initialize":
        kirim({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1}})
    elif metode == "session/new":
        if __GAGAL_SESI__:
            kirim({"jsonrpc": "2.0", "id": mid, "error": {"code": -32001, "message": "authentication required"}})
        else:
            kirim({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "sesi-stub"}})
    else:
        kirim({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "stub: unknown method"}})

# stdin EOF: klien sudah menutup ujung tulisnya. Tunda sebelum benar-benar
# keluar bila diminta — lihat dokumentasi __KELUAR_LAMBAT__ di atas.
if __KELUAR_LAMBAT__:
    time.sleep(0.3)
"#;

    static STUB_PEMBEDA: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// Satu adapter palsu di diska: direktori sementara berisi tepat satu
    /// biner bernama `bin`, siap ditemukan lewat PATH yang dibatasi
    /// [`RestrictedPath`].
    struct StubAdapter {
        dir: PathBuf,
        pid_log: PathBuf,
    }

    impl StubAdapter {
        /// `gagal_sesi = true` membuat skrip menolak `session/new` — dipakai
        /// untuk menguji pemetaan galat Codex tanpa proses sungguhan.
        /// `keluar_lambat = true` membuat skrip menunda 300ms sebelum keluar
        /// setelah EOF — lihat dokumentasi [`STUB_TEMPLATE`].
        fn new(bin: &str, gagal_sesi: bool, keluar_lambat: bool) -> Self {
            let urutan = STUB_PEMBEDA.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "midscene-stub-adapter-{}-{}",
                std::process::id(),
                urutan
            ));
            std::fs::create_dir_all(&dir).expect("direktori stub harus bisa dibuat");

            let pid_log = dir.join("pid.log");
            let isi = STUB_TEMPLATE
                .replace("__PID_LOG__", &pid_log.display().to_string())
                .replace("__GAGAL_SESI__", if gagal_sesi { "True" } else { "False" })
                .replace(
                    "__KELUAR_LAMBAT__",
                    if keluar_lambat { "True" } else { "False" },
                );

            let biner = dir.join(bin);
            std::fs::write(&biner, isi).expect("skrip stub harus bisa ditulis");

            let mut izin = std::fs::metadata(&biner)
                .expect("metadata skrip stub harus terbaca")
                .permissions();
            std::os::unix::fs::PermissionsExt::set_mode(&mut izin, 0o755);
            std::fs::set_permissions(&biner, izin).expect("izin eksekusi harus bisa dipasang");

            Self { dir, pid_log }
        }

        fn dir(&self) -> &Path {
            &self.dir
        }

        /// PID terakhir yang dicatat skrip ini. Panik bila skrip belum pernah
        /// dijalankan — itu berarti test yang memanggilnya salah rakit.
        fn pid(&self) -> i32 {
            let isi = std::fs::read_to_string(&self.pid_log).expect(
                "log PID harus terbaca: skrip stub menulisnya sebelum membalas initialize apa pun",
            );
            isi.lines()
                .next_back()
                .expect("log PID tidak boleh kosong")
                .trim()
                .parse()
                .expect("isi log PID harus berupa angka")
        }
    }

    impl Drop for StubAdapter {
        fn drop(&mut self) {
            drop(std::fs::remove_dir_all(&self.dir));
        }
    }

    /// Apakah proses `pid` masih hidup. Sinyal `0`: hanya memeriksa
    /// keberadaan proses (dan izin kita mengirim sinyal ke sana), tidak
    /// benar-benar mengirim apa pun ke proses itu.
    fn masih_hidup(pid: i32) -> bool {
        // SAFETY: `kill(pid, 0)` tidak membaca maupun menulis memori proses
        // manapun; ia hanya query kernel. Aman dipanggil dengan `pid` mana pun.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Tunggu sampai `pid` benar-benar berhenti, atau `batas` terlampaui.
    ///
    /// Dipakai di tempat yang **tidak** menguji urutan penutupan (tidak ada
    /// mutasi licik untuk dijaga di sana) — sekadar kebersihan "tidak ada
    /// proses tertinggal" setelah sesi yang sudah di-`.await` sampai selesai
    /// ditutup. Ada jeda kecil yang legitimate antara `state.close()` kembali
    /// dan kernel benar-benar melepas slot proses; polling pendek menyerap itu
    /// tanpa melonggarkan apa pun yang sedang dibuktikan.
    async fn tunggu_mati(pid: i32, batas: Duration) -> bool {
        let mulai = tokio::time::Instant::now();
        loop {
            if !masih_hidup(pid) {
                return true;
            }
            if mulai.elapsed() >= batas {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Pencari PATH yang selalu bilang "ada" tanpa peduli apa yang dicari:
    /// cocok dipakai di test-test ini karena keberadaan biner yang sungguhan
    /// diperiksa lewat [`RestrictedPath`] + [`StubAdapter`], bukan lewat
    /// closure ini. Closure ini hanya perlu meloloskan `probe`.
    fn path_lookup_selalu_ada(_: &str) -> Option<PathBuf> {
        Some(PathBuf::from("/diselesaikan-oleh-restricted-path"))
    }

    /// **Inti Task 7, dan inti klaim "penutupan benar-benar terjadi".**
    ///
    /// Menyambung ke agen kedua dengan sesi pertama masih berjalan harus
    /// menutup sesi pertama **sebelum** membuka yang baru — dibuktikan lewat
    /// urutan waktu yang sungguhan, bukan dengan membaca kode dan
    /// memercayainya.
    ///
    /// **Kenapa adapter `claude` (yang lama) sengaja lambat keluar.** Sinyal
    /// paling jujur untuk "ditunggu penuh" vs "sekadar di-drop" bukan
    /// keberadaan proses OS-nya — keduanya berakhir membunuh proses yang sama
    /// cepatnya, karena men-drop `AcpHandle` juga men-drop `shutdown_tx`, yang
    /// membangunkan closure koneksinya di background lewat *executor* yang
    /// sama, seringkali dalam hitungan milidetik. Test awal yang hanya
    /// memeriksa "prosesnya sudah mati" — dengan atau tanpa jeda — gagal
    /// membedakan keduanya persis karena itu.
    ///
    /// Yang benar-benar berbeda adalah **apakah `connect()` kedua menunggu**.
    /// `StubAdapter` di sini ditulis menunda diri 300ms setelah stdin-nya EOF
    /// sebelum benar-benar keluar (lihat `STUB_TEMPLATE`/`keluar_lambat`).
    /// `connect_agent_body` yang benar meng-`.await` `state.close()` —
    /// yang menunggu proses anaknya benar-benar direap
    /// (`agent-client-protocol-2.0.0/src/acp_agent.rs:489-503`,
    /// `wait_for_child`) — **sebelum** memanggil `connect()` yang kedua sama
    /// sekali. Jadi begitu panggilan kedua ini kembali, sedikitnya 300ms sudah
    /// lewat sejak stdin lama ditutup, dan proses lama itu **pasti** sudah
    /// mati — diperiksa tanpa jeda tambahan pun tetap benar, karena 300ms itu
    /// jauh melebihi baik latensi reap sungguhan (order milidetik, terukur
    /// terpisah) maupun waktu yang dibutuhkan `connect()` + `session/new`
    /// kedua (juga order milidetik untuk stub lokal ini).
    ///
    /// Mutasi yang menghapus `state.close()` tapi membiarkan sesi lama
    /// ditimpa di akhir fungsi **tidak pernah menunggu** proses lama sama
    /// sekali: `connect()` kedua langsung jalan begitu dipanggil, jauh lebih
    /// cepat dari 300ms. Jadi begitu panggilan kedua ini kembali, adapter lama
    /// masih tertidur di tengah `time.sleep(0.3)`-nya — pasti masih hidup.
    /// Itulah yang membedakan kedua kasus secara andal, bukan lomba kecepatan
    /// dengan *scheduler*.
    ///
    /// Dua adapter palsu sungguhan (proses OS betulan lewat [`StubAdapter`]):
    /// satu untuk `claude`, satu untuk `codex`, supaya "berpindah agen" diuji
    /// persis seperti namanya — bukan menyambung ulang ke agen yang sama.
    ///
    /// Ujung test menutup sesi yang tersisa lalu memeriksa proses barunya juga
    /// mati, membuktikan klaim kedua Task 7: tidak ada proses tertinggal
    /// setelah berpindah agen.
    #[tokio::test]
    async fn menyambung_agen_kedua_menutup_agen_lama_sebelum_membuka_yang_baru() {
        let claude = StubAdapter::new("claude-agent-acp", false, true);
        let codex = StubAdapter::new("codex-acp", false, false);
        let _path = RestrictedPath::new(&[claude.dir(), codex.dir()]);

        let (state, _events) = state_uji();

        connect_agent_body(&state, "claude".into(), &path_lookup_selalu_ada)
            .await
            .expect("connect pertama ke claude harus berhasil");
        let pid_lama = claude.pid();
        assert!(
            masih_hidup(pid_lama),
            "adapter claude yang baru disambung harus benar-benar berjalan"
        );

        let info_baru = connect_agent_body(&state, "codex".into(), &path_lookup_selalu_ada)
            .await
            .expect("connect kedua ke codex harus berhasil");
        assert_eq!(info_baru.id, "codex");
        let pid_baru = codex.pid();
        assert_ne!(
            pid_lama, pid_baru,
            "adapter baru harus proses OS yang berbeda dari yang lama"
        );

        // Tanpa jeda tambahan di sini dengan sengaja — lihat penjelasan di
        // atas kenapa 300ms yang sudah lewat di dalam `state.close()` (jalur
        // benar) atau belum lewat sama sekali (jalur mutasi) sudah cukup.
        assert!(
            !masih_hidup(pid_lama),
            "proses adapter claude (pid {pid_lama}) harus sudah berhenti begitu connect \
             kedua kembali — connect_agent_body wajib menunggu penutupannya penuh, bukan \
             sekadar menimpa sesi lama di memori dan membiarkannya mati belakangan"
        );
        assert!(
            masih_hidup(pid_baru),
            "sesi codex yang baru dibuka harus tetap hidup"
        );

        // Bersihkan sesi yang masih tersambung, lalu buktikan klaim kedua:
        // tidak ada proses adapter yang tertinggal setelah berpindah agen.
        let mut guard = state.session.lock().await;
        if let Some(sesi) = guard.take() {
            state.close(sesi.handle).await;
        }
        drop(guard);

        assert!(
            tunggu_mati(pid_baru, Duration::from_secs(2)).await,
            "tidak boleh ada proses adapter yang tertinggal setelah berpindah agen"
        );
    }

    /// Kegagalan `session/new` pada Codex wajib menyebut `codex login`, dan
    /// pesannya wajib berbeda dari pesan biner hilang maupun pesan protokol
    /// generik — kalau tidak, pengguna Codex yang belum login tidak belajar
    /// apa-apa dari pemetaan ini.
    ///
    /// Adapternya betulan menjawab `initialize` (agar galatnya sungguh datang
    /// dari `session/new`, bukan dari fase sebelumnya) lalu menolak
    /// `session/new` — mensimulasikan Codex yang belum diautentikasi tanpa
    /// menyentuh kredensial apa pun.
    #[tokio::test]
    async fn kegagalan_sesi_codex_menyebut_codex_login_dan_beda_dari_pesan_lain() {
        let codex = StubAdapter::new("codex-acp", true, false);
        let _path = RestrictedPath::new(&[codex.dir()]);

        let (state, _events) = state_uji();

        let galat = connect_agent_body(&state, "codex".into(), &path_lookup_selalu_ada)
            .await
            .expect_err("sesi yang ditolak agen harus dilaporkan sebagai galat");

        assert!(galat.contains("codex login"), "dapat: {galat}");

        let biner_hilang = missing_binary_message(find_agent("codex").expect("codex harus ada"));
        assert_ne!(
            galat, biner_hilang,
            "pesan gagal sesi tidak boleh sama dengan pesan biner hilang"
        );

        let protokol_generik = user_message(&AcpError::HandshakeTimeout(Duration::from_secs(30)));
        assert_ne!(
            galat, protokol_generik,
            "pesan gagal sesi tidak boleh sama dengan galat protokol generik"
        );

        // Tidak ada proses tertinggal: sesi yang gagal dibuat tetap wajib
        // ditutup (lihat cabang `Err` di `connect_agent_body`). Tidak ada
        // mutasi adversarial untuk dijaga di sini — lihat dokumentasi
        // `tunggu_mati` untuk kenapa polling pendek tepat di tempat ini.
        assert!(
            tunggu_mati(codex.pid(), Duration::from_secs(2)).await,
            "proses codex yang gagal membuat sesi tidak boleh tertinggal"
        );
    }

    /// Pemetaan ke `codex login` khusus untuk agen Codex — bukan untuk semua
    /// agen. Tanpa test ini, menghapus syarat `spec.id == "codex"` di
    /// `connect_agent_body` (menerapkan pemetaan itu ke semua agen) tidak
    /// menggagalkan test manapun.
    #[tokio::test]
    async fn kegagalan_sesi_agen_selain_codex_tidak_menyebut_codex_login() {
        let claude = StubAdapter::new("claude-agent-acp", true, false);
        let _path = RestrictedPath::new(&[claude.dir()]);

        let (state, _events) = state_uji();

        let galat = connect_agent_body(&state, "claude".into(), &path_lookup_selalu_ada)
            .await
            .expect_err("sesi yang ditolak agen harus dilaporkan sebagai galat");

        assert!(!galat.contains("codex login"), "dapat: {galat}");

        assert!(
            tunggu_mati(claude.pid(), Duration::from_secs(2)).await,
            "proses claude yang gagal membuat sesi tidak boleh tertinggal"
        );
    }

    #[test]
    fn pemilih_model_dibaca_dari_config_acp_bukan_daftar_hardcode() {
        use agent_client_protocol::schema::v1::SessionConfigSelectOption;

        let options = vec![SessionConfigOption::select(
            "runtime-model",
            "Runtime model",
            "claude-sonnet",
            vec![
                SessionConfigSelectOption::new("claude-sonnet", "Claude Sonnet")
                    .description("Balanced"),
                SessionConfigSelectOption::new("claude-opus", "Claude Opus"),
            ],
        )
        .category(SessionConfigOptionCategory::Model)];

        let selection = model_selection(&options).expect("kategori model harus dikenali");
        assert_eq!(selection.config_id, "runtime-model");
        assert_eq!(selection.selected, "claude-sonnet");
        assert_eq!(selection.options.len(), 2);
        assert_eq!(selection.options[1].id, "claude-opus");
        assert_eq!(
            selection.options[0].description.as_deref(),
            Some("Balanced")
        );
    }

    #[test]
    fn validasi_workspace_membedakan_folder_dari_file_dan_path_hilang() {
        let root = std::env::temp_dir().join(format!(
            "midscene-workspace-validation-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("bukan-folder.txt");
        std::fs::write(&file, "x").unwrap();

        assert_eq!(
            validate_workspace_path(&root).unwrap(),
            root.canonicalize().unwrap()
        );
        assert!(validate_workspace_path(&file)
            .unwrap_err()
            .contains("bukan sebuah folder"));
        assert!(validate_workspace_path(&root.join("hilang")).is_err());
    }
}
