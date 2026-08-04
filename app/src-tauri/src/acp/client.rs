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
//! # Koreksi atas catatan Task 3: handler yang salah pasang **menggantung**
//!
//! Catatan lama modul ini menyatakan permintaan tanpa handler dibalas otomatis
//! dengan `method not found`, jadi "agen tidak menggantung". Itu hanya benar
//! untuk method yang crate sendiri tidak kenal. Method peran klien yang dikenal
//! tetapi tanpa handler justru masuk antrean retry
//! (`incoming_actor.rs:617`) menunggu handler dinamis yang tidak akan pernah
//! didaftarkan — tidak ada balasan sama sekali. Keduanya dikunci oleh test
//! `permintaan_tanpa_handler_dibalas_method_not_found` dan
//! `permintaan_klien_yang_tak_didaftarkan_menggantung_bukan_ditolak`.
//!
//! Itulah sebabnya pendaftaran gerbang izin diuji lewat kawat JSON-RPC
//! sungguhan, bukan dengan memanggil [`refuse`] langsung: salah pasang tipe
//! request tidak menghasilkan galat yang berisik, melainkan sesi yang membeku
//! diam-diam.
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
pub struct SinkDiam;

impl EventSink for SinkDiam {
    fn emit(&self, _event: &str, _payload: Value) {}
}

/// Kegagalan saat menjawab satu permintaan izin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionError {
    /// Tidak ada permintaan dengan id itu: sudah dijawab, sudah kedaluwarsa,
    /// atau memang tidak pernah ada.
    TidakDikenal(String),
    /// Entrinya ada tetapi penunggunya sudah pergi.
    PenungguHilang(String),
}

impl fmt::Display for PermissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TidakDikenal(id) => write!(
                f,
                "permintaan izin {id} tidak dikenal; mungkin sudah dijawab atau kedaluwarsa"
            ),
            Self::PenungguHilang(id) => {
                write!(f, "permintaan izin {id} sudah tidak ditunggu siapa pun")
            }
        }
    }
}

impl std::error::Error for PermissionError {}

/// Peta permintaan izin yang sedang menunggu jawaban webview.
///
/// Satu entri hidup dari saat agen meminta izin sampai salah satu dari tiga hal
/// terjadi: pengguna menjawab, batas waktu lewat, atau agen membatalkan. Ketiga
/// jalur itu **wajib** membuang entrinya — peta yang bocor berarti setiap
/// dialog izin sepanjang umur aplikasi tetap tersimpan, dan id yang sudah mati
/// tetap tampak hidup bagi `answer_permission`.
#[derive(Clone, Default)]
pub struct PermissionMap {
    waiters: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
}

impl fmt::Debug for PermissionMap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PermissionMap")
            .field("menunggu", &self.jumlah_penunggu())
            .finish()
    }
}

impl PermissionMap {
    fn kunci(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<String>>> {
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
        self.kunci().insert(request_id, tx);
        rx
    }

    /// Jawab satu permintaan dan buang entrinya.
    ///
    /// # Errors
    ///
    /// [`PermissionError::TidakDikenal`] bila tidak ada entri dengan id itu —
    /// sengaja galat, bukan diam-diam tidak melakukan apa-apa, supaya frontend
    /// yang menjawab dialog basi tahu jawabannya tidak sampai ke mana pun.
    /// [`PermissionError::PenungguHilang`] bila entrinya ada tetapi
    /// penunggunya sudah dibuang.
    pub fn jawab(&self, request_id: &str, option_id: &str) -> Result<(), PermissionError> {
        let tx = self
            .kunci()
            .remove(request_id)
            .ok_or_else(|| PermissionError::TidakDikenal(request_id.to_owned()))?;

        tx.send(option_id.to_owned())
            .map_err(|_| PermissionError::PenungguHilang(request_id.to_owned()))
    }

    /// Buang satu entri tanpa menjawabnya. Dipakai jalur batas waktu dan
    /// pembatalan, yang menjawab agen sendiri.
    pub fn buang(&self, request_id: &str) {
        self.kunci().remove(request_id);
    }

    /// Berapa permintaan yang masih menunggu jawaban.
    #[must_use]
    pub fn jumlah_penunggu(&self) -> usize {
        self.kunci().len()
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
    izin_berikutnya: AtomicU64,
    run_berikutnya: AtomicU64,
    sedang_menutup: AtomicBool,
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
                izin_berikutnya: AtomicU64::new(1),
                run_berikutnya: AtomicU64::new(1),
                sedang_menutup: AtomicBool::new(false),
            }),
        }
    }

    /// Konteks yang membuang setiap event, untuk pemakaian tanpa webview.
    ///
    /// Lihat peringatan di [`SinkDiam`].
    #[must_use]
    pub fn diam() -> Self {
        Self::new(Arc::new(SinkDiam))
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
    pub fn pasang_thread(&self, thread_id: String) {
        let run_id = self.run_id_baru();
        let mut ids = self.inner.ids.lock().unwrap_or_else(PoisonError::into_inner);
        ids.thread_id = thread_id;
        ids.run_id = run_id;
    }

    /// Mulai satu giliran baru dan kembalikan `(runId, threadId)`-nya.
    pub fn mulai_run(&self) -> (String, String) {
        let run_id = self.run_id_baru();
        let mut ids = self.inner.ids.lock().unwrap_or_else(PoisonError::into_inner);
        ids.run_id.clone_from(&run_id);
        (run_id, ids.thread_id.clone())
    }

    fn run_id_baru(&self) -> String {
        format!(
            "run-{}",
            self.inner.run_berikutnya.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn izin_id_baru(&self) -> String {
        format!(
            "izin-{}",
            self.inner.izin_berikutnya.fetch_add(1, Ordering::Relaxed)
        )
    }

    /// Kirim satu event ke webview.
    pub fn emit(&self, event: &str, payload: Value) {
        self.inner.sink.emit(event, payload);
    }

    /// Tandai bahwa penutupan koneksi berikutnya kita minta sendiri, supaya
    /// [`EVENT_AGENT_DISCONNECTED`] tidak dikirim untuk itu.
    pub fn tandai_menutup(&self) {
        self.inner.sedang_menutup.store(true, Ordering::SeqCst);
    }

    /// Kebalikan [`Self::tandai_menutup`], dipanggil setelah koneksi baru siap.
    pub fn batalkan_penutupan(&self) {
        self.inner.sedang_menutup.store(false, Ordering::SeqCst);
    }

    /// Apakah penutupan yang sedang terjadi kita minta sendiri.
    #[must_use]
    pub fn sedang_menutup(&self) -> bool {
        self.inner.sedang_menutup.load(Ordering::SeqCst)
    }

    /// Terjemahkan satu `session/update` dan emisikan hasilnya ke webview.
    ///
    /// Ini satu-satunya jalur yang membuat teks asisten dan progres tool call
    /// sampai ke layar. Sengaja sinkron dan tanpa I/O supaya aman dipanggil dari
    /// dalam dispatch loop.
    pub fn teruskan_pembaruan(&self, update: &SessionUpdate) {
        let (run_id, thread_id) = self.run_ids();
        for event in to_agui(update, &run_id, &thread_id) {
            self.emit(EVENT_AGUI, event);
        }
    }
}

/// Apa yang mengakhiri penantian satu permintaan izin.
enum Keputusan {
    Dipilih(String),
    Ditolak,
    Dibatalkan,
}

/// Bangun builder koneksi untuk peran klien, lengkap dengan handler-handlernya.
///
/// Tiga handler terdaftar, dan ketiganya wajib:
///
/// * `session/update` → event `agui` (lihat catatan modul soal notifikasi yang
///   hilang tanpa jejak bila handler ini tidak ada).
/// * `session/request_permission` → event `permission-request`, lalu menunggu
///   `answer_permission` di luar dispatch loop.
/// * penutupan transport → event `agent-disconnected`, kecuali penutupannya
///   memang kita minta sendiri.
pub fn builder(
    ctx: ClientContext,
) -> Builder<
    Client,
    impl HandleDispatchFrom<Agent>,
    NullRun,
    impl HandleConnectionClose<Agent>,
> {
    let ctx_notifikasi = ctx.clone();
    let ctx_izin = ctx.clone();
    let ctx_tutup = ctx;

    Client
        .builder()
        .name(CLIENT_NAME)
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                ctx_notifikasi.teruskan_pembaruan(&notification.update);
                Ok(())
            },
            on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, cx: ConnectionTo<Agent>| {
                gerbang_izin(&ctx_izin, request, responder, &cx)
            },
            on_receive_request!(),
        )
        .on_close(async move |_cx| {
            if !ctx_tutup.sedang_menutup() {
                ctx_tutup.emit(
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
fn gerbang_izin(
    ctx: &ClientContext,
    request: RequestPermissionRequest,
    responder: Responder<RequestPermissionResponse>,
    cx: &ConnectionTo<Agent>,
) -> Result<
    Handled<(RequestPermissionRequest, Responder<RequestPermissionResponse>)>,
    agent_client_protocol::Error,
> {
    let request_id = ctx.izin_id_baru();
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

    let batas = ctx.permission_timeout();
    let permissions = ctx.permissions().clone();
    let cancellation = responder.cancellation();
    let id_task = request_id.clone();

    let hasil_spawn = cx.spawn(async move {
        let keputusan = tokio::select! {
            biased;
            () = cancellation.cancelled() => Keputusan::Dibatalkan,
            hasil = tokio::time::timeout(batas, rx) => match hasil {
                Ok(Ok(option_id)) => Keputusan::Dipilih(option_id),
                // Penunggunya dibuang, atau batas waktu lewat tanpa jawaban.
                // Keduanya berarti tidak ada persetujuan manusia, dan tidak ada
                // persetujuan berarti tolak.
                Ok(Err(_)) | Err(_) => Keputusan::Ditolak,
            },
        };

        // Wajib, di semua jalur: entri yang tertinggal membuat id mati tampak
        // hidup bagi `answer_permission`.
        permissions.buang(&id_task);

        match keputusan {
            Keputusan::Dipilih(option_id) => responder.respond(pilih(&request, &option_id)),
            Keputusan::Ditolak => responder.respond(refuse(&request)),
            Keputusan::Dibatalkan => {
                responder.respond_with_error(agent_client_protocol::Error::request_cancelled())
            }
        }
    });

    if let Err(error) = hasil_spawn {
        // Task-nya tidak jadi jalan, jadi `responder` dan `rx` sudah ikut
        // ter-drop bersama closure-nya. Yang masih bisa (dan wajib) dibersihkan
        // adalah entri petanya.
        ctx.permissions().buang(&request_id);
        return Err(error);
    }

    Ok(Handled::Yes)
}

/// Susun jawaban untuk opsi yang dipilih pengguna.
///
/// `option_id` diverifikasi terhadap daftar yang benar-benar ditawarkan agen.
/// Frontend yang salah kirim tidak boleh berubah menjadi persetujuan atas opsi
/// yang tidak pernah ada; kegagalan yang aman di sini adalah menolak.
fn pilih(request: &RequestPermissionRequest, option_id: &str) -> RequestPermissionResponse {
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
    use agent_client_protocol::Lines;
    use agent_client_protocol::schema::v1::{
        ContentBlock, ContentChunk, PermissionOption, ToolCallUpdate, ToolCallUpdateFields,
    };
    use futures::channel::mpsc as futures_mpsc;
    use futures::{SinkExt, StreamExt};
    use tokio::sync::mpsc;
    use tokio::task::JoinHandle;

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

    // ----------------------------------------------------------------- pilih

    #[test]
    fn pilih_meneruskan_opsi_yang_ditawarkan() {
        match pilih(&permintaan(opsi_lengkap()), "ya").outcome {
            RequestPermissionOutcome::Selected(selected) => {
                assert_eq!(selected.option_id.0.as_ref(), "ya");
            }
            other => panic!("harusnya memilih opsi 'ya', dapat {other:?}"),
        }
    }

    /// Opsi yang tidak pernah ditawarkan agen tidak boleh berubah menjadi
    /// persetujuan; kegagalan yang aman adalah menolak.
    #[test]
    fn pilih_menolak_opsi_yang_tidak_ditawarkan() {
        match pilih(&permintaan(opsi_lengkap()), "opsi-karangan").outcome {
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
            Err(PermissionError::TidakDikenal("hantu".into()))
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
        assert_eq!(peta.jumlah_penunggu(), 0);
    }

    #[tokio::test]
    async fn menjawab_penunggu_yang_hilang_mengembalikan_galat() {
        let peta = PermissionMap::default();
        drop(peta.daftar("req-3".into()));
        assert_eq!(
            peta.jawab("req-3", "allow"),
            Err(PermissionError::PenungguHilang("req-3".into()))
        );
        assert_eq!(peta.jumlah_penunggu(), 0, "entri harus tetap dibuang");
    }

    // -------------------------------------------------------- ClientContext

    /// Sink berbasis channel: menggantikan `AppHandle` di test.
    struct SinkUji {
        tx: mpsc::UnboundedSender<(String, Value)>,
    }

    impl EventSink for SinkUji {
        fn emit(&self, event: &str, payload: Value) {
            drop(self.tx.send((event.to_owned(), payload)));
        }
    }

    fn konteks(batas: Duration) -> (ClientContext, mpsc::UnboundedReceiver<(String, Value)>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let ctx = ClientContext::with_permission_timeout(Arc::new(SinkUji { tx }), batas);
        ctx.pasang_thread("thread-uji".into());
        (ctx, rx)
    }

    #[tokio::test]
    async fn pembaruan_sesi_diterjemahkan_dan_diemisikan() {
        let (ctx, mut events) = konteks(DEFAULT_PERMISSION_TIMEOUT);
        let (run_id, thread_id) = ctx.run_ids();

        ctx.teruskan_pembaruan(&SessionUpdate::AgentMessageChunk(ContentChunk::new(
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
    async fn mulai_run_mengganti_run_id_tetapi_menahan_thread_id() {
        let (ctx, _events) = konteks(DEFAULT_PERMISSION_TIMEOUT);
        let (run_pertama, thread_pertama) = ctx.run_ids();
        let (run_kedua, thread_kedua) = ctx.mulai_run();

        assert_ne!(run_pertama, run_kedua);
        assert_eq!(thread_pertama, thread_kedua);
        assert_eq!(ctx.run_ids(), (run_kedua, thread_kedua));
    }

    // ------------------------------------------------- dispatch sungguhan

    /// Satu agen palsu di ujung kawat.
    ///
    /// Sengaja bicara **JSON-RPC mentah**, bukan lewat helper crate: itulah satu-
    /// satunya cara membuktikan handler kita benar-benar terpasang pada nama
    /// method yang benar. Bila `on_receive_request` dipasang pada tipe request
    /// yang salah, crate akan menjawab `method_not_found` dan test yang hanya
    /// memanggil `refuse`/`pilih` langsung tetap lulus — persis lubang yang
    /// ditutup di sini.
    struct AgenPalsu {
        ke_klien: Option<futures_mpsc::UnboundedSender<std::io::Result<String>>>,
        dari_klien: futures_mpsc::UnboundedReceiver<String>,
        events: mpsc::UnboundedReceiver<(String, Value)>,
        koneksi: Option<JoinHandle<Result<(), agent_client_protocol::Error>>>,
    }

    impl AgenPalsu {
        fn baru(ctx: &ClientContext, events: mpsc::UnboundedReceiver<(String, Value)>) -> Self {
            let (ke_klien, masuk) = futures_mpsc::unbounded::<std::io::Result<String>>();
            let (keluar, dari_klien) = futures_mpsc::unbounded::<String>();
            let transport = Lines::new(keluar.sink_map_err(std::io::Error::other), masuk);
            let koneksi = tokio::spawn(builder(ctx.clone()).connect_to(transport));

            Self {
                ke_klien: Some(ke_klien),
                dari_klien,
                events,
                koneksi: Some(koneksi),
            }
        }

        fn kirim(&self, pesan: Value) {
            self.ke_klien
                .as_ref()
                .expect("kanal ke klien harus masih ada")
                .unbounded_send(Ok(pesan.to_string()))
                .expect("kanal ke klien harus terbuka");
        }

        fn kirim_notifikasi(&self, method: &str, params: Value) {
            self.kirim(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
        }

        fn kirim_permintaan(&self, id: u64, method: &str, params: Value) {
            self.kirim(
                json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
            );
        }

        async fn balasan(&mut self) -> Value {
            let baris = tokio::time::timeout(Duration::from_secs(5), self.dari_klien.next())
                .await
                .expect("klien harus membalas sebelum batas waktu test")
                .expect("kanal dari klien tidak boleh tertutup");
            serde_json::from_str(&baris).expect("balasan harus JSON")
        }

        /// Balasan yang datang dalam `batas`, atau `None` bila tidak ada.
        async fn balasan_dalam(&mut self, batas: Duration) -> Option<Value> {
            let baris = tokio::time::timeout(batas, self.dari_klien.next())
                .await
                .ok()?
                .expect("kanal dari klien tidak boleh tertutup");
            Some(serde_json::from_str(&baris).expect("balasan harus JSON"))
        }

        async fn event(&mut self) -> (String, Value) {
            tokio::time::timeout(Duration::from_secs(5), self.events.recv())
                .await
                .expect("event harus datang sebelum batas waktu test")
                .expect("kanal event tidak boleh tertutup")
        }

        /// Tutup arah agen → klien, yaitu EOF bersih di sisi transport masuk.
        fn putuskan(&mut self) {
            drop(self.ke_klien.take());
        }

        /// Tunggu future koneksi selesai. Aman dipanggil berkali-kali.
        async fn tunggu_selesai(&mut self) {
            let Some(koneksi) = self.koneksi.take() else {
                return;
            };
            let _ = tokio::time::timeout(Duration::from_secs(5), koneksi).await;
        }

        async fn tutup(mut self) {
            self.putuskan();
            self.tunggu_selesai().await;
        }
    }

    fn params_izin() -> Value {
        serde_json::to_value(permintaan(opsi_lengkap())).expect("harus terserialisasi")
    }

    /// **Gerbang utama Task 6.** Membuktikan `session/update` yang datang
    /// sebagai notifikasi JSON-RPC sungguhan berakhir sebagai event `agui` di
    /// webview. Sebelum task ini, notifikasi itu jatuh ke
    /// `incoming_actor.rs:627` dan hilang tanpa jejak.
    #[tokio::test]
    async fn notifikasi_session_update_sampai_ke_webview() {
        let (ctx, events) = konteks(DEFAULT_PERMISSION_TIMEOUT);
        let (run_id, thread_id) = ctx.run_ids();
        let mut agen = AgenPalsu::baru(&ctx, events);

        let notifikasi = SessionNotification::new(
            "sesi-uji",
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from(
                "teks dari agen",
            ))),
        );
        agen.kirim_notifikasi(
            "session/update",
            serde_json::to_value(&notifikasi).expect("harus terserialisasi"),
        );

        let (nama, payload) = agen.event().await;
        assert_eq!(nama, EVENT_AGUI);
        assert_eq!(payload["type"], "TEXT_MESSAGE_CHUNK");
        assert_eq!(payload["delta"], "teks dari agen");
        assert_eq!(payload["runId"], run_id);
        assert_eq!(payload["threadId"], thread_id);

        agen.tutup().await;
    }

    /// Satu `session/update` berisi tool call menghasilkan dua event AG-UI,
    /// dan keduanya harus sampai — bukan cuma yang pertama.
    #[tokio::test]
    async fn notifikasi_tool_call_menghasilkan_dua_event() {
        use agent_client_protocol::schema::v1::ToolCall;

        let (ctx, events) = konteks(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = AgenPalsu::baru(&ctx, events);

        let notifikasi = SessionNotification::new(
            "sesi-uji",
            SessionUpdate::ToolCall(
                ToolCall::new("call-1", "midscene__act").raw_input(json!({ "instruction": "klik" })),
            ),
        );
        agen.kirim_notifikasi(
            "session/update",
            serde_json::to_value(&notifikasi).expect("harus terserialisasi"),
        );

        let (_, mulai) = agen.event().await;
        assert_eq!(mulai["type"], "TOOL_CALL_START");
        assert_eq!(mulai["toolCallId"], "call-1");

        let (_, argumen) = agen.event().await;
        assert_eq!(argumen["type"], "TOOL_CALL_ARGS");

        agen.tutup().await;
    }

    /// **Kelalaian kedua yang ditutup Task 6.** Sampai sekarang tidak ada test
    /// yang menyentuh *pendaftaran* handler izin: semuanya memanggil `refuse`
    /// langsung. Bila handler terpasang pada tipe request yang salah, crate
    /// membalas `method_not_found` dan seluruh test lama tetap hijau. Test ini
    /// mengirim `session/request_permission` mentah lewat kawat dan menuntut
    /// balasan `result`, bukan `error`.
    #[tokio::test]
    async fn dispatch_izin_sungguhan_meneruskan_jawaban_pengguna() {
        let (ctx, events) = konteks(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = AgenPalsu::baru(&ctx, events);

        agen.kirim_permintaan(7, "session/request_permission", params_izin());

        let (nama, payload) = agen.event().await;
        assert_eq!(nama, EVENT_PERMISSION_REQUEST);
        assert_eq!(payload["options"][0]["optionId"], "ya");
        let request_id = payload["requestId"]
            .as_str()
            .expect("requestId harus string")
            .to_owned();

        assert_eq!(ctx.permissions().jumlah_penunggu(), 1);
        ctx.permissions()
            .jawab(&request_id, "ya")
            .expect("penunggu harus ada");

        let balasan = agen.balasan().await;
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
            ctx.permissions().jumlah_penunggu(),
            0,
            "entri peta harus dibuang setelah dijawab"
        );

        agen.tutup().await;
    }

    /// Kontrol pembanding untuk test di atas: method yang crate sendiri tidak
    /// kenal memang dibalas `method not found`
    /// (`jsonrpc/incoming_actor.rs:631`: *"Rejecting request with error, no
    /// handler"*). Kedua test memakai kawat yang sama, jadi hanya method yang
    /// benar-benar terdaftar yang bisa menghasilkan `result`.
    #[tokio::test]
    async fn permintaan_tanpa_handler_dibalas_method_not_found() {
        let (ctx, events) = konteks(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = AgenPalsu::baru(&ctx, events);

        agen.kirim_permintaan(11, "metode/tidak-dikenal", json!({}));

        let balasan = agen.balasan().await;
        assert_eq!(balasan["id"], 11);
        assert_eq!(
            balasan["error"]["code"], -32601,
            "permintaan tanpa handler harus jadi method not found, dapat: {balasan}"
        );
        assert!(balasan.get("result").is_none());

        agen.tutup().await;
    }

    /// **Temuan yang mengoreksi catatan Task 3.** Method peran klien yang
    /// *dikenal crate* tetapi tidak kita daftarkan handler-nya **tidak**
    /// dibalas `method not found`: ia masuk antrean retry
    /// (`jsonrpc/incoming_actor.rs:617`, `"Retrying message as new dynamic
    /// handlers are added"`) menunggu handler dinamis yang tidak akan pernah
    /// muncul. Artinya agen menggantung, bukan menerima galat.
    ///
    /// Konsekuensinya langsung untuk task ini: seandainya gerbang izin
    /// terpasang pada tipe request yang salah, akibatnya bukan "balasan galat
    /// yang jelas" melainkan sesi beku tanpa pesan apa pun — justru alasan
    /// pendaftaran handler harus diuji lewat kawat, bukan lewat pemanggilan
    /// fungsi pembantunya.
    #[tokio::test]
    async fn permintaan_klien_yang_tak_didaftarkan_menggantung_bukan_ditolak() {
        let (ctx, events) = konteks(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = AgenPalsu::baru(&ctx, events);

        agen.kirim_permintaan(
            12,
            "fs/read_text_file",
            json!({ "sessionId": "sesi-uji", "path": "/tmp/tidak-ada" }),
        );

        assert!(
            agen.balasan_dalam(Duration::from_millis(300)).await.is_none(),
            "fs/read_text_file tanpa handler ternyata dibalas; catatan modul perlu diperbarui"
        );

        agen.tutup().await;
    }

    /// Batas waktu wajib: permintaan yang tidak dijawab harus tetap berakhir
    /// dengan balasan penolakan yang sah, dan entri petanya harus hilang.
    #[tokio::test]
    async fn dispatch_izin_menolak_dan_membersihkan_setelah_batas_waktu() {
        let (ctx, events) = konteks(Duration::from_millis(50));
        let mut agen = AgenPalsu::baru(&ctx, events);

        agen.kirim_permintaan(8, "session/request_permission", params_izin());

        let (nama, _) = agen.event().await;
        assert_eq!(nama, EVENT_PERMISSION_REQUEST);

        let balasan = agen.balasan().await;
        assert_eq!(balasan["id"], 8);
        assert_eq!(balasan["result"]["outcome"]["outcome"], "selected");
        assert_eq!(
            balasan["result"]["outcome"]["optionId"], "tidak",
            "batas waktu harus memilih opsi penolakan"
        );
        assert_eq!(
            ctx.permissions().jumlah_penunggu(),
            0,
            "entri peta harus dibuang setelah kedaluwarsa"
        );

        agen.tutup().await;
    }

    /// Menunggu izin tidak boleh menahan dispatch loop: notifikasi yang datang
    /// selama dialog terbuka harus tetap sampai ke webview.
    #[tokio::test]
    async fn notifikasi_tetap_mengalir_saat_izin_menunggu() {
        let (ctx, events) = konteks(Duration::from_secs(30));
        let mut agen = AgenPalsu::baru(&ctx, events);

        agen.kirim_permintaan(9, "session/request_permission", params_izin());
        let (nama, payload) = agen.event().await;
        assert_eq!(nama, EVENT_PERMISSION_REQUEST);
        let request_id = payload["requestId"].as_str().unwrap().to_owned();

        let notifikasi = SessionNotification::new(
            "sesi-uji",
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from("sambil jalan"))),
        );
        agen.kirim_notifikasi(
            "session/update",
            serde_json::to_value(&notifikasi).expect("harus terserialisasi"),
        );

        let (nama, payload) = agen.event().await;
        assert_eq!(nama, EVENT_AGUI);
        assert_eq!(payload["delta"], "sambil jalan");

        ctx.permissions().jawab(&request_id, "tidak").unwrap();
        let balasan = agen.balasan().await;
        assert_eq!(balasan["result"]["outcome"]["optionId"], "tidak");

        agen.tutup().await;
    }

    /// Transport yang tertutup di luar kehendak kita harus terlihat di webview,
    /// bukan hanya menjadi `JoinHandle` yang hasilnya dibuang.
    #[tokio::test]
    async fn transport_tertutup_mengemisikan_agent_disconnected() {
        let (ctx, events) = konteks(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = AgenPalsu::baru(&ctx, events);

        agen.putuskan();

        let (nama, _) = agen.event().await;
        assert_eq!(nama, EVENT_AGENT_DISCONNECTED);

        agen.tutup().await;
    }

    /// Penutupan yang kita minta sendiri bukan kabar buruk dan tidak boleh
    /// memicu peringatan di UI.
    #[tokio::test]
    async fn penutupan_yang_disengaja_tidak_mengemisikan_apa_pun() {
        let (ctx, events) = konteks(DEFAULT_PERMISSION_TIMEOUT);
        let mut agen = AgenPalsu::baru(&ctx, events);
        ctx.tandai_menutup();

        agen.putuskan();
        agen.tunggu_selesai().await;

        assert!(
            agen.events.try_recv().is_err(),
            "penutupan yang disengaja tidak boleh mengemisikan event"
        );
    }
}
