//! Sisi klien ACP: apa yang agen boleh minta dari *kita*, dan apa yang kita
//! teruskan ke webview.
//!
//! Catatan API penting: crate `agent-client-protocol` 2.0.0 **tidak** punya trait
//! `Client` yang kita implementasikan (tidak ada `impl Client for X`). Peran klien
//! diwujudkan lewat `Builder` berbasis closure:
//! `Client.builder().on_receive_request(..).on_receive_notification(..)`.
//! `agent_client_protocol::Client` adalah *marker role* (`pub struct Client;`
//! dengan `impl Role for Client { type Counterpart = Agent; .. }`), bukan trait
//! yang menuntut method wajib. Jadi file ini berisi "implementasi peran klien"
//! dalam bentuk builder + handler, bukan blok `impl Trait`.
//!
//! # Notifikasi yang tidak ditangani menghilang tanpa jejak
//!
//! Sampai Task 5 modul ini hanya mendaftarkan `on_receive_request`. Akibatnya
//! setiap `session/update` — yaitu **seluruh teks asisten dan seluruh perubahan
//! status tool call** — jatuh ke jalur bawaan crate
//! (`agent-client-protocol-2.0.0/src/jsonrpc/incoming_actor.rs:627`), yang cuma
//! menulis `tracing::debug!(?method, "Ignoring unhandled notification")`.
//! Aplikasi ini tidak memakai `tracing` dan tidak memasang subscriber, jadi baris
//! itu menguap sepenuhnya: prompt terkirim, puluhan notifikasi datang, dan UI
//! membeku sampai balasan `session/prompt` terakhir tiba. Task 6 menutupnya
//! dengan [`Builder::on_receive_notification`].
//!
//! Tanda tangan sebenarnya (dibaca dari `agent-client-protocol-2.0.0/src/jsonrpc.rs:1369`,
//! bukan dari ingatan — tebakan atas bentuk API crate ini sudah salah lima kali
//! di proyek ini):
//!
//! ```text
//! pub fn on_receive_notification<Notif, F, T, ToFut>(
//!     self,
//!     op: F,
//!     to_future_hack: ToFut,
//! ) -> Builder<Host, impl HandleDispatchFrom<Host::Counterpart>, Runner, Close>
//! where
//!     Host::Counterpart: HasPeer<Host::Counterpart>,
//!     Notif: JsonRpcNotification,
//!     F: AsyncFnMut(Notif, ConnectionTo<Host::Counterpart>) -> Result<T, crate::Error> + Send,
//!     T: IntoHandled<(Notif, ConnectionTo<Host::Counterpart>)>,
//!     ToFut: Fn(&mut F, Notif, ConnectionTo<Host::Counterpart>)
//!         -> crate::BoxFuture<'_, Result<T, crate::Error>> + Send + Sync,
//! ```
//!
//! `Notif` untuk `session/update` adalah `schema::v1::SessionNotification`
//! (`agent-client-protocol-2.0.0/src/schema/agent_to_client/notifications.rs:5`:
//! `impl_jsonrpc_notification!(SessionNotification, "session/update")`), dan
//! `to_future_hack` diisi makro `on_receive_notification!()`
//! (`src/lib.rs:197`), bukan `on_receive_request!()`.
//!
//! # Koreksi atas catatan Task 3: request ber-`sessionId` tanpa handler **menggantung**
//!
//! Catatan lama modul ini menyatakan permintaan tanpa handler dibalas otomatis
//! dengan `method not found`, jadi "agen tidak menggantung". Itu salah, dan
//! pembeda sebenarnya bukan soal method dikenal atau tidak.
//!
//! Pembedanya adalah **ada tidaknya field `sessionId` di dalam `params`**.
//! `Agent::default_handle_dispatch_from` (`src/role/acp.rs:294-313`) melakukan
//! `let retry = message.has_session_id();`, dan `has_session_id` hanyalah
//! `has_field("sessionId")` (`src/jsonrpc.rs:4393-4396`) — pemeriksaan field
//! JSON mentah, bukan pengenalan method. Konsekuensinya:
//!
//! | Pesan | Akibat bila tak ada handler |
//! |---|---|
//! | method apa pun **dengan** `sessionId` | masuk antrean retry (`incoming_actor.rs:617`) menunggu handler dinamis yang tidak akan pernah ada — **tidak ada balasan** |
//! | method apa pun **tanpa** `sessionId` | dibalas `-32601 Method not found` (`incoming_actor.rs:631`) |
//!
//! Jadi **setiap** request agen→klien yang berlingkup sesi — `session/*`,
//! `fs/*`, `terminal/*`, termasuk method kustom — menggantung diam-diam bila
//! handler-nya tidak terdaftar. `session/request_permission` selalu membawa
//! `sessionId`, jadi ia jatuh tepat di baris pertama tabel itu.
//!
//! Itulah sebabnya pendaftaran gerbang izin diuji lewat kawat JSON-RPC
//! sungguhan, bukan dengan memanggil [`refuse`] langsung: salah pasang tipe
//! request tidak menghasilkan galat yang berisik, melainkan sesi yang membeku
//! tanpa satu pun pesan. Ketiga baris tabel dikunci oleh test
//! `permintaan_ber_session_id_tanpa_handler_menggantung`,
//! `permintaan_tanpa_session_id_dibalas_method_not_found`, dan
//! `method_dikenal_tanpa_session_id_tetap_dibalas_method_not_found`.
//!
//! Kaitannya dengan kapabilitas yang kita iklankan dicatat di
//! [`super::client_capabilities`]: kita aman menangani `session/request_permission`
//! saja **hanya karena** `fs` dan `terminal` diiklankan mati.
//!
//! # Gerbang izin menunggu di luar dispatch loop
//!
//! Callback `on_receive_*` berjalan **di dalam** dispatch loop dan menahannya
//! sampai selesai (`src/concepts/ordering.rs:17`). Menunggu jawaban pengguna
//! sampai dua menit di sana berarti tidak ada pesan masuk yang diproses selama
//! itu — termasuk `$/cancel_request` untuk permintaan izin itu sendiri, yang
//! justru satu-satunya jalan agen membatalkannya. Jadi handler izin memindahkan
//! penantian ke [`ConnectionTo::spawn`] dan mengembalikan [`Handled::Yes`]:
//! `Responder` boleh dibawa keluar loop dan dijawab belakangan.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    PermissionOptionKind, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionNotification, SessionUpdate,
};
use agent_client_protocol::{
    Agent, Builder, Client, ConnectionTo, HandleConnectionClose, HandleDispatchFrom, Handled,
    NullRun, Responder, on_receive_notification, on_receive_request,
};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::events::to_agui;

/// Nama klien yang dikirim ke agen pada `initialize`.
pub const CLIENT_NAME: &str = "midscene-desktop";

/// Event Tauri yang membawa satu event AG-UI (payload `serde_json::Value`).
pub const EVENT_AGUI: &str = "agui";

/// Event Tauri yang meminta webview menampilkan dialog izin.
pub const EVENT_PERMISSION_REQUEST: &str = "permission-request";

/// Event Tauri yang memberi tahu webview bahwa transport agen tertutup di luar
/// penutupan yang kita minta sendiri.
pub const EVENT_AGENT_DISCONNECTED: &str = "agent-disconnected";

/// Berapa lama gerbang izin menunggu jawaban dari webview sebelum menolak
/// sendiri.
///
/// Batas ini **wajib**. Tanpa dia, satu permintaan izin yang muncul saat webview
/// tertutup (atau saat frontend-nya sedang error) menggantungkan sesi selamanya:
/// agen menunggu balasan kita, kita menunggu klik yang tidak akan pernah datang,
/// dan tidak ada pihak ketiga yang bisa memutus. Dua menit dipilih supaya jauh
/// di atas waktu baca manusia yang wajar untuk satu dialog, sekaligus terbatas.
pub const DEFAULT_PERMISSION_TIMEOUT: Duration = Duration::from_secs(120);

/// Tujuan emisi event ke webview.
///
/// Diabstraksikan supaya seluruh jalur notifikasi bisa diuji tanpa Tauri sama
/// sekali: test memasang sink berbasis channel, produksi memasang `AppHandle`.
/// Tanpa ini, satu-satunya cara membuktikan `session/update` benar-benar sampai
/// ke webview adalah menjalankan aplikasi sungguhan.
pub trait EventSink: Send + Sync + 'static {
    /// Kirim satu event bernama `event` dengan payload `payload`.
    ///
    /// Kegagalan emisi bukan urusan pemanggil — implementasi yang menanganinya.
    fn emit(&self, event: &str, payload: Value);
}

/// Sink yang membuang setiap event.
///
/// Disediakan untuk pemakaian **tanpa webview**: test integrasi yang memeriksa
/// handshake atau pembuatan sesi, bukan streaming. Memakainya di jalur aplikasi
/// berarti menghidupkan kembali persis cacat yang ditutup Task 6 — setiap
/// `session/update` diterjemahkan dengan benar lalu dibuang tanpa jejak.
#[derive(Clone, Copy, Debug, Default)]
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _event: &str, _payload: Value) {}
}

/// Kegagalan saat menjawab satu permintaan izin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionError {
    /// Tidak ada permintaan dengan id itu: sudah dijawab, sudah kedaluwarsa,
    /// atau memang tidak pernah ada.
    Unknown(String),
    /// Entrinya ada tetapi penunggunya sudah pergi.
    WaiterGone(String),
}

impl fmt::Display for PermissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unknown(id) => write!(
                f,
                "permintaan izin {id} tidak dikenal; mungkin sudah dijawab atau kedaluwarsa"
            ),
            Self::WaiterGone(id) => {
                write!(f, "permintaan izin {id} sudah tidak ditunggu siapa pun")
            }
        }
    }
}

impl std::error::Error for PermissionError {}

/// Peta permintaan izin yang sedang menunggu jawaban webview.
///
/// Satu entri hidup dari saat agen meminta izin sampai salah satu dari empat hal
/// terjadi: pengguna menjawab ([`Self::jawab`]), batas waktu lewat, agen
/// membatalkan, atau `ConnectionTo::spawn` menolak menjalankan task-nya.
/// Keempat jalur itu **wajib** membuang entrinya — peta yang bocor berarti
/// dialog izin lama menumpuk sepanjang umur aplikasi, dan id yang sudah mati
/// tetap tampak hidup bagi `answer_permission`.
///
/// # Jalur kelima yang memang membocorkan entri (diketahui, sengaja dibiarkan)
///
/// Bila koneksi mati **saat gerbang izin masih menunggu**, task yang dijalankan
/// `ConnectionTo::spawn` ikut mati bersama koneksinya. `tokio::time::timeout`
/// di dalamnya tidak pernah selesai, jadi [`Self::discard`] tidak pernah
/// dipanggil dan entrinya tertinggal. Entri itu juga bertahan melewati sambung
/// ulang, karena `ClientContext` hidup di `AppState` dan bukan milik satu
/// koneksi.
///
/// Dinilai bisa diterima, bukan diperbaiki, karena kerusakannya berhenti di
/// memori:
///
/// * id izin berasal dari penghitung monoton, jadi entri basi tidak akan pernah
///   bertabrakan dengan permintaan baru dan tidak bisa "menjawab" permintaan
///   lain;
/// * `answer_permission` atas entri basi mengembalikan
///   [`PermissionError::WaiterGone`] — berisik, bukan diam-diam menyetujui;
/// * sisi protokolnya tetap tuntas: `ResponderDropGuard` milik crate menjawab
///   agen saat `Responder`-nya ikut ter-drop.
///
/// Yang tersisa hanyalah satu entri `HashMap` per permintaan izin yang
/// tertinggal. Menutupnya butuh pengait siklus hidup koneksi ke dalam peta, dan
/// itu bukan pertukaran yang sepadan di task ini.
#[derive(Clone, Default)]
pub struct PermissionMap {
    waiters: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
}

impl fmt::Debug for PermissionMap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PermissionMap")
            .field("menunggu", &self.pending_count())
            .finish()
    }
}

impl PermissionMap {
    fn waiters(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<String>>> {
        // Peta ini hanya disentuh oleh operasi infalibel (insert/remove), jadi
        // satu-satunya cara racun masuk adalah panik di kode lain sambil
        // memegang kunci. Memulihkan isinya lebih baik daripada menjatuhkan
        // seluruh sesi hanya karena itu.
        self.waiters.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Daftarkan satu permintaan dan kembalikan penerima jawabannya.
    #[must_use]
    pub fn daftar(&self, request_id: String) -> oneshot::Receiver<String> {
        let (tx, rx) = oneshot::channel();
        self.waiters().insert(request_id, tx);
        rx
    }

    /// Jawab satu permintaan dan buang entrinya.
    ///
    /// # Errors
    ///
    /// [`PermissionError::Unknown`] bila tidak ada entri dengan id itu —
    /// sengaja galat, bukan diam-diam tidak melakukan apa-apa, supaya frontend
    /// yang menjawab dialog basi tahu jawabannya tidak sampai ke mana pun.
    /// [`PermissionError::WaiterGone`] bila entrinya ada tetapi
    /// penunggunya sudah dibuang.
    pub fn jawab(&self, request_id: &str, option_id: &str) -> Result<(), PermissionError> {
        let tx = self
            .waiters()
            .remove(request_id)
            .ok_or_else(|| PermissionError::Unknown(request_id.to_owned()))?;

        tx.send(option_id.to_owned())
            .map_err(|_| PermissionError::WaiterGone(request_id.to_owned()))
    }

    /// Buang satu entri tanpa menjawabnya. Dipakai jalur batas waktu dan
    /// pembatalan, yang menjawab agen sendiri.
    pub fn discard(&self, request_id: &str) {
        self.waiters().remove(request_id);
    }

    /// Berapa permintaan yang masih menunggu jawaban.
    #[must_use]
    pub fn pending_count(&self) -> usize {
        self.waiters().len()
    }
}

/// Pasangan id yang menempel pada setiap event AG-UI.
#[derive(Clone, Debug, Default)]
struct RunIds {
    run_id: String,
    thread_id: String,
}

struct Inner {
    sink: Arc<dyn EventSink>,
    permissions: PermissionMap,
    ids: Mutex<RunIds>,
    permission_timeout: Duration,
    next_permission: AtomicU64,
    next_run: AtomicU64,
    notify_on_close: AtomicBool,
}

/// State yang dibagi antara perintah Tauri dan handler-handler peran klien.
///
/// Handler notifikasi butuh tiga hal yang tidak ada di notifikasinya sendiri:
/// ke mana event dikirim, `runId` giliran yang sedang berjalan, dan `threadId`
/// sesi. Ketiganya berubah dari luar (perintah `send_prompt` memulai run baru),
/// jadi disimpan di balik `Arc` dan dibagikan, bukan disalin ke dalam closure.
#[derive(Clone)]
pub struct ClientContext {
    inner: Arc<Inner>,
}

impl fmt::Debug for ClientContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ids = self.ids();
        f.debug_struct("ClientContext")
            .field("run_id", &ids.run_id)
            .field("thread_id", &ids.thread_id)
            .field("permission_timeout", &self.inner.permission_timeout)
            .finish_non_exhaustive()
    }
}

impl ClientContext {
    /// Konteks baru dengan batas waktu izin bawaan.
    #[must_use]
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Self::with_permission_timeout(sink, DEFAULT_PERMISSION_TIMEOUT)
    }

    /// Seperti [`Self::new`], tetapi dengan batas waktu izin yang ditentukan
    /// pemanggil. Test tidak boleh menunggu dua menit hanya untuk membuktikan
    /// batas waktunya bekerja.
    #[must_use]
    pub fn with_permission_timeout(sink: Arc<dyn EventSink>, permission_timeout: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                sink,
                permissions: PermissionMap::default(),
                ids: Mutex::new(RunIds::default()),
                permission_timeout,
                next_permission: AtomicU64::new(1),
                next_run: AtomicU64::new(1),
                // Mulai dari "jangan beri tahu": sebelum satu sesi benar-benar
                // berdiri, tidak ada koneksi yang layak dilaporkan putus.
                notify_on_close: AtomicBool::new(false),
            }),
        }
    }

    /// Konteks yang membuang setiap event, untuk pemakaian tanpa webview.
    ///
    /// Lihat peringatan di [`NullSink`].
    #[must_use]
    pub fn silent() -> Self {
        Self::new(Arc::new(NullSink))
    }

    /// Peta permintaan izin yang sedang menunggu.
    #[must_use]
    pub fn permissions(&self) -> &PermissionMap {
        &self.inner.permissions
    }

    /// Batas waktu jawaban izin yang berlaku.
    #[must_use]
    pub fn permission_timeout(&self) -> Duration {
        self.inner.permission_timeout
    }

    fn ids(&self) -> RunIds {
        self.inner
            .ids
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// `runId` dan `threadId` yang berlaku saat ini.
    #[must_use]
    pub fn run_ids(&self) -> (String, String) {
        let ids = self.ids();
        (ids.run_id, ids.thread_id)
    }

    /// Pasang `threadId` sesi baru dan mulai run pertamanya.
    ///
    /// Run id sengaja **selalu** terisi, termasuk di luar giliran: agen boleh
    /// mengirim `session/update` sebelum prompt pertama atau setelah satu
    /// giliran selesai, dan event AG-UI tanpa `runId` tidak berarti apa-apa bagi
    /// frontend. Menempelkannya ke run terakhir lebih jujur daripada membuangnya.
    pub fn begin_thread(&self, thread_id: String) {
        let run_id = self.new_run_id();
        let mut ids = self.inner.ids.lock().unwrap_or_else(PoisonError::into_inner);
        ids.thread_id = thread_id;
        ids.run_id = run_id;
    }

    /// Mulai satu giliran baru dan kembalikan `(runId, threadId)`-nya.
    pub fn begin_run(&self) -> (String, String) {
        let run_id = self.new_run_id();
        let mut ids = self.inner.ids.lock().unwrap_or_else(PoisonError::into_inner);
        ids.run_id.clone_from(&run_id);
        (run_id, ids.thread_id.clone())
    }

    fn new_run_id(&self) -> String {
        format!(
            "run-{}",
            self.inner.next_run.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn new_permission_id(&self) -> String {
        format!(
            "izin-{}",
            self.inner.next_permission.fetch_add(1, Ordering::Relaxed)
        )
    }

    /// Kirim satu event ke webview.
    pub fn emit(&self, event: &str, payload: Value) {
        self.inner.sink.emit(event, payload);
    }

    /// Mulai laporkan putusnya koneksi ke webview.
    ///
    /// Sengaja **opt-in dan dipasang paling akhir**, setelah sesi benar-benar
    /// berdiri. Sebelum titik itu setiap penutupan sudah punya pelapornya
    /// sendiri — `connect_agent` mengembalikan galat — jadi mengemisikan
    /// `agent-disconnected` juga berarti webview menerima dua kabar untuk satu
    /// kejadian. Bawaan yang mati juga membuat jalur-jalur gagal-handshake
    /// konsisten satu sama lain: yang EOF di tengah handshake dan yang kena
    /// batas waktu (di mana `runner.abort()` tidak menjalankan `on_close` sama
    /// sekali) sekarang sama-sama diam.
    pub fn arm_disconnect_notice(&self) {
        self.inner.notify_on_close.store(true, Ordering::SeqCst);
    }

    /// Berhenti melaporkan putusnya koneksi — dipasang sebelum penutupan yang
    /// kita minta sendiri, yang bukan kabar buruk.
    pub fn disarm_disconnect_notice(&self) {
        self.inner.notify_on_close.store(false, Ordering::SeqCst);
    }

    /// Apakah penutupan berikutnya akan dilaporkan ke webview.
    #[must_use]
    pub fn notifies_on_close(&self) -> bool {
        self.inner.notify_on_close.load(Ordering::SeqCst)
    }

    /// Terjemahkan satu `session/update` dan emisikan hasilnya ke webview.
    ///
    /// Ini satu-satunya jalur yang membuat teks asisten dan progres tool call
    /// sampai ke layar. Sengaja sinkron dan tanpa I/O supaya aman dipanggil dari
    /// dalam dispatch loop.
    pub fn forward_update(&self, update: &SessionUpdate) {
        let (run_id, thread_id) = self.run_ids();
        for event in to_agui(update, &run_id, &thread_id) {
            self.emit(EVENT_AGUI, event);
        }
    }
}

/// Apa yang mengakhiri penantian satu permintaan izin.
enum Decision {
    Selected(String),
    Refused,
    Cancelled,
}

/// Bangun builder koneksi untuk peran klien, lengkap dengan handler-handlernya.
///
/// Tiga handler terdaftar, dan ketiganya wajib:
///
/// * `session/update` → event `agui` (lihat catatan modul soal notifikasi yang
///   hilang tanpa jejak bila handler ini tidak ada).
/// * `session/request_permission` → event `permission-request`, lalu menunggu
///   `answer_permission` di luar dispatch loop.
/// * penutupan transport → event `agent-disconnected`, tetapi hanya bila
///   [`ClientContext::arm_disconnect_notice`] sudah dipasang.
pub fn builder(
    ctx: ClientContext,
) -> Builder<
    Client,
    impl HandleDispatchFrom<Agent>,
    NullRun,
    impl HandleConnectionClose<Agent>,
> {
    let notification_ctx = ctx.clone();
    let permission_ctx = ctx.clone();
    let close_ctx = ctx;

    Client
        .builder()
        .name(CLIENT_NAME)
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                notification_ctx.forward_update(&notification.update);
                Ok(())
            },
            on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, cx: ConnectionTo<Agent>| {
                permission_gate(&permission_ctx, request, responder, &cx)
            },
            on_receive_request!(),
        )
        .on_close(async move |_cx| {
            if close_ctx.notifies_on_close() {
                close_ctx.emit(
                    EVENT_AGENT_DISCONNECTED,
                    json!({ "reason": "transport agen tertutup" }),
                );
            }
            Ok(())
        })
}

/// Tangani satu `session/request_permission`.
///
/// Mengembalikan [`Handled::Yes`] segera: jawabannya dikirim belakangan dari
/// task yang dijalankan [`ConnectionTo::spawn`], sehingga dispatch loop bebas
/// menerima `$/cancel_request` untuk permintaan ini.
fn permission_gate(
    ctx: &ClientContext,
    request: RequestPermissionRequest,
    responder: Responder<RequestPermissionResponse>,
    cx: &ConnectionTo<Agent>,
) -> Result<
    Handled<(RequestPermissionRequest, Responder<RequestPermissionResponse>)>,
    agent_client_protocol::Error,
> {
    let request_id = ctx.new_permission_id();
    let rx = ctx.permissions().daftar(request_id.clone());

    ctx.emit(
        EVENT_PERMISSION_REQUEST,
        json!({
            "requestId": request_id,
            "sessionId": request.session_id.0.as_ref(),
            "toolCall": serde_json::to_value(&request.tool_call).unwrap_or(Value::Null),
            "options": serde_json::to_value(&request.options).unwrap_or(Value::Null),
        }),
    );

    let budget = ctx.permission_timeout();
    let permissions = ctx.permissions().clone();
    let cancellation = responder.cancellation();
    let task_request_id = request_id.clone();

    let spawned = cx.spawn(async move {
        let decision = tokio::select! {
            biased;
            () = cancellation.cancelled() => Decision::Cancelled,
            answered = tokio::time::timeout(budget, rx) => match answered {
                Ok(Ok(option_id)) => Decision::Selected(option_id),
                // Penunggunya dibuang, atau batas waktu lewat tanpa jawaban.
                // Keduanya berarti tidak ada persetujuan manusia, dan tidak ada
                // persetujuan berarti tolak.
                Ok(Err(_)) | Err(_) => Decision::Refused,
            },
        };

        // Wajib, di semua jalur: entri yang tertinggal membuat id mati tampak
        // hidup bagi `answer_permission`.
        permissions.discard(&task_request_id);

        match decision {
            Decision::Selected(option_id) => responder.respond(select_option(&request, &option_id)),
            Decision::Refused => responder.respond(refuse(&request)),
            Decision::Cancelled => {
                responder.respond_with_error(agent_client_protocol::Error::request_cancelled())
            }
        }
    });

    if let Err(error) = spawned {
        // Task-nya tidak jadi jalan, jadi `responder` dan `rx` sudah ikut
        // ter-drop bersama closure-nya. Yang masih bisa (dan wajib) dibersihkan
        // adalah entri petanya.
        ctx.permissions().discard(&request_id);
        return Err(error);
    }

    Ok(Handled::Yes)
}

/// Susun jawaban untuk opsi yang dipilih pengguna.
///
/// `option_id` diverifikasi terhadap daftar yang benar-benar ditawarkan agen.
/// Frontend yang salah kirim tidak boleh berubah menjadi persetujuan atas opsi
/// yang tidak pernah ada; kegagalan yang aman di sini adalah menolak.
fn select_option(request: &RequestPermissionRequest, option_id: &str) -> RequestPermissionResponse {
    match request
        .options
        .iter()
        .find(|option| option.option_id.0.as_ref() == option_id)
    {
        Some(option) => RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new(option.option_id.clone()),
        )),
        None => refuse(request),
    }
}

/// Susun penolakan terstruktur untuk satu permintaan izin.
///
/// Utamakan opsi bertipe `RejectOnce` (menolak sekali, tidak diingat), lalu
/// `RejectAlways`. Bila agen sama sekali tidak menawarkan opsi penolakan,
/// jawab `Cancelled` — tetap balasan yang sah, bukan panik dan bukan diam.
fn refuse(request: &RequestPermissionRequest) -> RequestPermissionResponse {
    let reject = request
        .options
        .iter()
        .find(|option| matches!(option.kind, PermissionOptionKind::RejectOnce))
        .or_else(|| {
            request
                .options
                .iter()
                .find(|option| matches!(option.kind, PermissionOptionKind::RejectAlways))
        });

    match reject {
        Some(option) => RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new(option.option_id.clone()),
        )),
        None => RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::testing::{FakeAgent, recording_context};
    use agent_client_protocol::schema::v1::{
        ContentBlock, ContentChunk, PermissionOption, ToolCallUpdate, ToolCallUpdateFields,
    };

    fn permintaan(options: Vec<PermissionOption>) -> RequestPermissionRequest {
        RequestPermissionRequest::new(
            "sesi-uji",
            ToolCallUpdate::new("tool-1", ToolCallUpdateFields::new()),
            options,
        )
    }

    fn opsi_lengkap() -> Vec<PermissionOption> {
        vec![
            PermissionOption::new("ya", "Izinkan", PermissionOptionKind::AllowOnce),
            PermissionOption::new("tidak", "Tolak", PermissionOptionKind::RejectOnce),
        ]
    }

    fn params_izin() -> Value {
        serde_json::to_value(permintaan(opsi_lengkap())).expect("harus terserialisasi")
    }

    fn potongan_teks(teks: &str) -> Value {
        let notifikasi = SessionNotification::new(
            "sesi-uji",
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from(teks))),
        );
        serde_json::to_value(&notifikasi).expect("harus terserialisasi")
    }

    // ---------------------------------------------------------------- refuse

    #[test]
    fn menolak_dengan_opsi_reject_once_bila_ada() {
        let request = permintaan(vec![
            PermissionOption::new("ya", "Izinkan", PermissionOptionKind::AllowOnce),
            PermissionOption::new("tidak", "Tolak", PermissionOptionKind::RejectOnce),
            PermissionOption::new(
                "tidak-selalu",
                "Tolak selalu",
                PermissionOptionKind::RejectAlways,
            ),
        ]);

        match refuse(&request).outcome {
            RequestPermissionOutcome::Selected(selected) => {
                assert_eq!(selected.option_id.0.as_ref(), "tidak");
            }
            other => panic!("harusnya memilih opsi penolakan, dapat {other:?}"),
        }
    }

    #[test]
    fn mundur_ke_reject_always_bila_reject_once_tidak_ada() {
        let request = permintaan(vec![
            PermissionOption::new("ya", "Izinkan", PermissionOptionKind::AllowOnce),
            PermissionOption::new(
                "tidak-selalu",
                "Tolak selalu",
                PermissionOptionKind::RejectAlways,
            ),
        ]);

        match refuse(&request).outcome {
            RequestPermissionOutcome::Selected(selected) => {
                assert_eq!(selected.option_id.0.as_ref(), "tidak-selalu");
            }
            other => panic!("harusnya memilih opsi penolakan, dapat {other:?}"),
        }
    }

    #[test]
    fn menjawab_cancelled_bila_tak_ada_opsi_penolakan() {
        let request = permintaan(vec![PermissionOption::new(
            "ya",
            "Izinkan",
            PermissionOptionKind::AllowOnce,
        )]);

        assert!(matches!(
            refuse(&request).outcome,
            RequestPermissionOutcome::Cancelled
        ));
    }

    #[test]
    fn menjawab_cancelled_bila_daftar_opsi_kosong() {
        assert!(matches!(
            refuse(&permintaan(vec![])).outcome,
            RequestPermissionOutcome::Cancelled
        ));
    }

    // ---------------------------------------------------------- select_option

    #[test]
    fn memilih_opsi_yang_ditawarkan() {
        match select_option(&permintaan(opsi_lengkap()), "ya").outcome {
            RequestPermissionOutcome::Selected(selected) => {
                assert_eq!(selected.option_id.0.as_ref(), "ya");
            }
            other => panic!("harusnya memilih opsi 'ya', dapat {other:?}"),
        }
    }

    /// Opsi yang tidak pernah ditawarkan agen tidak boleh berubah menjadi
    /// persetujuan; kegagalan yang aman adalah menolak.
    #[test]
    fn menolak_opsi_yang_tidak_ditawarkan() {
        match select_option(&permintaan(opsi_lengkap()), "opsi-karangan").outcome {
            RequestPermissionOutcome::Selected(selected) => {
                assert_eq!(selected.option_id.0.as_ref(), "tidak");
            }
            other => panic!("harusnya jatuh ke penolakan, dapat {other:?}"),
        }
    }

    // -------------------------------------------------------- PermissionMap

    #[tokio::test]
    async fn jawaban_izin_sampai_ke_penunggu() {
        let peta = PermissionMap::default();
        let rx = peta.daftar("req-1".into());
        peta.jawab("req-1", "allow").expect("harus ada penunggu");
        assert_eq!(rx.await.unwrap(), "allow");
    }

    #[tokio::test]
    async fn menjawab_id_tak_dikenal_mengembalikan_galat() {
        let peta = PermissionMap::default();
        assert_eq!(
            peta.jawab("hantu", "allow"),
            Err(PermissionError::Unknown("hantu".into()))
        );
    }

    #[tokio::test]
    async fn penunggu_dibuang_setelah_dijawab() {
        let peta = PermissionMap::default();
        let _rx = peta.daftar("req-2".into());
        peta.jawab("req-2", "allow").unwrap();
        assert!(
            peta.jawab("req-2", "allow").is_err(),
            "entri harus sudah dibuang"
        );
        assert_eq!(peta.pending_count(), 0);
    }

    #[tokio::test]
    async fn menjawab_penunggu_yang_hilang_mengembalikan_galat() {
        let peta = PermissionMap::default();
        drop(peta.daftar("req-3".into()));
        assert_eq!(
            peta.jawab("req-3", "allow"),
            Err(PermissionError::WaiterGone("req-3".into()))
        );
        assert_eq!(peta.pending_count(), 0, "entri harus tetap dibuang");
    }

    // -------------------------------------------------------- ClientContext

    #[tokio::test]
    async fn pembaruan_sesi_diterjemahkan_dan_diemisikan() {
        let (ctx, mut events) = recording_context(DEFAULT_PERMISSION_TIMEOUT);
        let (run_id, thread_id) = ctx.run_ids();

        ctx.forward_update(&SessionUpdate::AgentMessageChunk(ContentChunk::new(
            ContentBlock::from("halo"),
        )));

        let (nama, payload) = events.recv().await.expect("harus ada satu event");
        assert_eq!(nama, EVENT_AGUI);
        assert_eq!(payload["type"], "TEXT_MESSAGE_CHUNK");
        assert_eq!(payload["delta"], "halo");
        assert_eq!(payload["runId"], run_id);
        assert_eq!(payload["threadId"], thread_id);
    }

    #[tokio::test]
    async fn begin_run_mengganti_run_id_tetapi_menahan_thread_id() {
        let (ctx, _events) = recording_context(DEFAULT_PERMISSION_TIMEOUT);
        let (run_pertama, thread_pertama) = ctx.run_ids();
        let (run_kedua, thread_kedua) = ctx.begin_run();

        assert_ne!(run_pertama, run_kedua);
        assert_eq!(thread_pertama, thread_kedua);
        assert_eq!(ctx.run_ids(), (run_kedua, thread_kedua));
    }

    // ------------------------------------------------- dispatch sungguhan

    /// **Gerbang utama Task 6.** Membuktikan `session/update` yang datang
    /// sebagai notifikasi JSON-RPC sungguhan berakhir sebagai event `agui` di
    /// webview. Sebelum task ini, notifikasi itu jatuh ke
    /// `incoming_actor.rs:627` dan hilang tanpa jejak.
    #[tokio::test]
    async fn notifikasi_session_update_sampai_ke_webview() {
        let (ctx, events) = recording_context(DEFAULT_PERMISSION_TIMEOUT);
        let (run_id, thread_id) = ctx.run_ids();
        let mut agen = FakeAgent::start(&ctx, events).await;

        agen.send_notification("session/update", potongan_teks("teks dari agen"));

        let (nama, payload) = agen.next_event().await;
        assert_eq!(nama, EVENT_AGUI);
        assert_eq!(payload["type"], "TEXT_MESSAGE_CHUNK");
        assert_eq!(payload["delta"], "teks dari agen");
        assert_eq!(payload["runId"], run_id);
        assert_eq!(payload["threadId"], thread_id);

        agen.shutdown().await;
    }

    /// Satu `session/update` berisi tool call menghasilkan dua event AG-UI,
    /// dan keduanya harus sampai — bukan cuma yang pertama.
    #[tokio::test]
    async fn notifikasi_tool_call_menghasilkan_dua_event() {
        use agent_client_protocol::schema::v1::ToolCall;

        let (ctx, events) = recording_context(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = FakeAgent::start(&ctx, events).await;

        let notifikasi = SessionNotification::new(
            "sesi-uji",
            SessionUpdate::ToolCall(
                ToolCall::new("call-1", "midscene__act").raw_input(json!({ "instruction": "klik" })),
            ),
        );
        agen.send_notification(
            "session/update",
            serde_json::to_value(&notifikasi).expect("harus terserialisasi"),
        );

        let (_, mulai) = agen.next_event().await;
        assert_eq!(mulai["type"], "TOOL_CALL_START");
        assert_eq!(mulai["toolCallId"], "call-1");

        let (_, argumen) = agen.next_event().await;
        assert_eq!(argumen["type"], "TOOL_CALL_ARGS");

        agen.shutdown().await;
    }

    /// **Kelalaian kedua yang ditutup Task 6.** Sampai sekarang tidak ada test
    /// yang menyentuh *pendaftaran* handler izin: semuanya memanggil `refuse`
    /// langsung. Bila handler terpasang pada tipe request yang salah, agen
    /// tidak menerima balasan sama sekali dan seluruh test lama tetap hijau.
    /// Test ini mengirim `session/request_permission` mentah lewat kawat dan
    /// menuntut balasan `result`.
    #[tokio::test]
    async fn dispatch_izin_sungguhan_meneruskan_jawaban_pengguna() {
        let (ctx, events) = recording_context(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = FakeAgent::start(&ctx, events).await;

        agen.send_request(7, "session/request_permission", params_izin());

        let (nama, payload) = agen.next_event().await;
        assert_eq!(nama, EVENT_PERMISSION_REQUEST);
        assert_eq!(payload["options"][0]["optionId"], "ya");
        let request_id = payload["requestId"]
            .as_str()
            .expect("requestId harus string")
            .to_owned();

        assert_eq!(ctx.permissions().pending_count(), 1);
        ctx.permissions()
            .jawab(&request_id, "ya")
            .expect("penunggu harus ada");

        let balasan = agen.next_line().await;
        assert!(
            balasan.get("error").is_none(),
            "handler izin tidak terpasang pada method yang benar: {balasan}"
        );
        assert_eq!(balasan["id"], 7);
        // `RequestPermissionOutcome` bertanda internal `#[serde(tag = "outcome")]`,
        // jadi bentuk kawatnya adalah `result.outcome.{outcome,optionId}`.
        assert_eq!(balasan["result"]["outcome"]["outcome"], "selected");
        assert_eq!(balasan["result"]["outcome"]["optionId"], "ya");
        assert_eq!(
            ctx.permissions().pending_count(),
            0,
            "entri peta harus dibuang setelah dijawab"
        );

        agen.shutdown().await;
    }

    /// **Mekanisme sebenarnya**, dikoreksi dari catatan Task 3 dan dari
    /// kesimpulan pertama saya sendiri di task ini.
    ///
    /// Pembeda antara "dibalas `method not found`" dan "menggantung" bukan
    /// apakah crate mengenali method-nya, melainkan apakah `params` punya field
    /// `sessionId`: `Agent::default_handle_dispatch_from` melakukan
    /// `let retry = message.has_session_id()` (`src/role/acp.rs:294-313`), dan
    /// `has_session_id` hanyalah `has_field("sessionId")` (`jsonrpc.rs:4393`).
    ///
    /// Method yang **sepenuhnya asing** pun menggantung asal membawa
    /// `sessionId` — jadi kelas bahayanya jauh lebih luas daripada "method
    /// yang kebetulan dikenal crate".
    #[tokio::test]
    async fn permintaan_ber_session_id_tanpa_handler_menggantung() {
        let (ctx, events) = recording_context(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = FakeAgent::start(&ctx, events).await;

        agen.send_request(
            12,
            "metode/sepenuhnya-asing",
            json!({ "sessionId": "sesi-uji" }),
        );

        assert!(
            agen.line_within(Duration::from_millis(300)).await.is_none(),
            "request ber-sessionId tanpa handler ternyata dibalas; \
             catatan modul soal has_session_id perlu diperbarui"
        );

        agen.shutdown().await;
    }

    /// Sisi lain pembeda yang sama: tanpa `sessionId`, method asing yang persis
    /// sama justru dibalas `-32601`.
    #[tokio::test]
    async fn permintaan_tanpa_session_id_dibalas_method_not_found() {
        let (ctx, events) = recording_context(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = FakeAgent::start(&ctx, events).await;

        agen.send_request(13, "metode/sepenuhnya-asing", json!({}));

        let balasan = agen.next_line().await;
        assert_eq!(balasan["id"], 13);
        assert_eq!(
            balasan["error"]["code"], -32601,
            "dapat: {balasan}"
        );
        assert!(balasan.get("result").is_none());

        agen.shutdown().await;
    }

    /// Dan pengenalan method memang tidak berperan: `fs/read_text_file` adalah
    /// method peran klien yang dikenal crate, tetapi tanpa `sessionId` ia tetap
    /// dibalas `-32601`. Inilah yang mematahkan hipotesis "dikenal vs tidak
    /// dikenal" yang sempat saya tulis.
    #[tokio::test]
    async fn method_dikenal_tanpa_session_id_tetap_dibalas_method_not_found() {
        let (ctx, events) = recording_context(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = FakeAgent::start(&ctx, events).await;

        agen.send_request(14, "fs/read_text_file", json!({ "path": "/tmp/x" }));

        let balasan = agen.next_line().await;
        assert_eq!(balasan["id"], 14);
        assert_eq!(balasan["error"]["code"], -32601, "dapat: {balasan}");

        agen.shutdown().await;
    }

    /// Batas waktu wajib: permintaan yang tidak dijawab harus tetap berakhir
    /// dengan balasan penolakan yang sah, dan entri petanya harus hilang.
    #[tokio::test]
    async fn dispatch_izin_menolak_dan_membersihkan_setelah_batas_waktu() {
        let (ctx, events) = recording_context(Duration::from_millis(50));
        let mut agen = FakeAgent::start(&ctx, events).await;

        agen.send_request(8, "session/request_permission", params_izin());

        let (nama, _) = agen.next_event().await;
        assert_eq!(nama, EVENT_PERMISSION_REQUEST);

        let balasan = agen.next_line().await;
        assert_eq!(balasan["id"], 8);
        assert_eq!(balasan["result"]["outcome"]["outcome"], "selected");
        assert_eq!(
            balasan["result"]["outcome"]["optionId"], "tidak",
            "batas waktu harus memilih opsi penolakan"
        );
        assert_eq!(
            ctx.permissions().pending_count(),
            0,
            "entri peta harus dibuang setelah kedaluwarsa"
        );

        agen.shutdown().await;
    }

    /// Menunggu izin tidak boleh menahan dispatch loop: notifikasi yang datang
    /// selama dialog terbuka harus tetap sampai ke webview.
    #[tokio::test]
    async fn notifikasi_tetap_mengalir_saat_izin_menunggu() {
        let (ctx, events) = recording_context(Duration::from_secs(30));
        let mut agen = FakeAgent::start(&ctx, events).await;

        agen.send_request(9, "session/request_permission", params_izin());
        let (nama, payload) = agen.next_event().await;
        assert_eq!(nama, EVENT_PERMISSION_REQUEST);
        let request_id = payload["requestId"].as_str().unwrap().to_owned();

        agen.send_notification("session/update", potongan_teks("sambil jalan"));

        let (nama, payload) = agen.next_event().await;
        assert_eq!(nama, EVENT_AGUI);
        assert_eq!(payload["delta"], "sambil jalan");

        ctx.permissions().jawab(&request_id, "tidak").unwrap();
        let balasan = agen.next_line().await;
        assert_eq!(balasan["result"]["outcome"]["optionId"], "tidak");

        agen.shutdown().await;
    }

    /// Transport yang tertutup setelah sesi berdiri harus terlihat di webview,
    /// bukan hanya menjadi `JoinHandle` yang hasilnya dibuang.
    #[tokio::test]
    async fn transport_tertutup_mengemisikan_agent_disconnected() {
        let (ctx, events) = recording_context(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = FakeAgent::start(&ctx, events).await;
        ctx.arm_disconnect_notice();

        agen.disconnect();

        let (nama, _) = agen.next_event().await;
        assert_eq!(nama, EVENT_AGENT_DISCONNECTED);

        agen.shutdown().await;
    }

    /// Penutupan yang kita minta sendiri bukan kabar buruk dan tidak boleh
    /// memicu peringatan di UI.
    #[tokio::test]
    async fn penutupan_yang_disengaja_tidak_mengemisikan_apa_pun() {
        let (ctx, events) = recording_context(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = FakeAgent::start(&ctx, events).await;
        ctx.arm_disconnect_notice();
        ctx.disarm_disconnect_notice();

        agen.disconnect();
        agen.wait_closed().await;

        assert!(
            agen.try_next_event().is_none(),
            "penutupan yang disengaja tidak boleh mengemisikan event"
        );
    }

    /// Koneksi yang gugur **sebelum** sesi berdiri sudah punya pelapornya
    /// sendiri: `connect_agent` mengembalikan galat. Mengemisikan
    /// `agent-disconnected` juga akan membuat webview merender dua kabar untuk
    /// satu kejadian, dan tidak konsisten dengan jalur batas waktu handshake
    /// yang `abort()`-nya tidak pernah menjalankan `on_close`.
    #[tokio::test]
    async fn putus_sebelum_sesi_berdiri_tidak_mengemisikan_apa_pun() {
        let (ctx, events) = recording_context(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = FakeAgent::start(&ctx, events).await;

        assert!(
            !ctx.notifies_on_close(),
            "pemberitahuan putus harus mati sampai sesi benar-benar berdiri"
        );

        agen.disconnect();
        agen.wait_closed().await;

        assert!(
            agen.try_next_event().is_none(),
            "putus sebelum sesi berdiri tidak boleh mengemisikan event"
        );
    }
}
