//! Agen palsu di ujung kawat, untuk test.
//!
//! Hanya dikompilasi di `cfg(test)`. Ia bicara **JSON-RPC mentah** lewat
//! transport `Lines` milik crate ACP (`agent-client-protocol-2.0.0/src/jsonrpc.rs:5411`),
//! disuplai channel `futures`. Itu penting: satu-satunya cara membuktikan handler
//! kita terpasang pada method yang benar adalah mengirim baris JSON-RPC
//! sungguhan dan melihat apa yang keluar. Memanggil fungsi pembantunya langsung
//! tidak membuktikan apa pun tentang pendaftaran.
//!
//! Koneksi dijalankan lewat `connect_with`, bukan `connect_to`, dengan pola yang
//! sama persis seperti [`super::connect_with_timeout`]: closure utamanya parkir
//! di sebuah `oneshot` sampai diminta berhenti. Itu memberi kita
//! [`ConnectionTo<Agent>`] yang hidup — yang dibutuhkan untuk menguji jalur
//! giliran — dan sekaligus [`AcpHandle`] sungguhan tanpa satu pun proses anak.

use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::{Agent, ConnectionTo, Lines};
use futures::channel::mpsc as futures_mpsc;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::client::{ClientContext, EventSink, builder};
use super::AcpHandle;

/// Batas kesabaran test. Cukup longgar untuk mesin yang sedang sibuk, cukup
/// ketat untuk gagal alih-alih menggantung selamanya.
pub(crate) const TEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Sink berbasis channel: menggantikan `AppHandle` di test.
pub(crate) struct RecordingSink {
    tx: mpsc::UnboundedSender<(String, Value)>,
}

impl RecordingSink {
    pub(crate) fn new(tx: mpsc::UnboundedSender<(String, Value)>) -> Self {
        Self { tx }
    }
}

impl EventSink for RecordingSink {
    fn emit(&self, event: &str, payload: Value) {
        drop(self.tx.send((event.to_owned(), payload)));
    }
}

/// Konteks klien yang merekam setiap emisi, beserta ujung penerimanya.
pub(crate) fn recording_context(
    permission_timeout: Duration,
) -> (ClientContext, mpsc::UnboundedReceiver<(String, Value)>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let ctx = ClientContext::with_permission_timeout(Arc::new(RecordingSink { tx }), permission_timeout);
    ctx.begin_thread("thread-uji".into());
    (ctx, rx)
}

/// Satu agen palsu di ujung kawat.
pub(crate) struct FakeAgent {
    to_client: Option<futures_mpsc::UnboundedSender<std::io::Result<String>>>,
    from_client: futures_mpsc::UnboundedReceiver<String>,
    events: mpsc::UnboundedReceiver<(String, Value)>,
    connection: ConnectionTo<Agent>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    runner: Option<JoinHandle<Result<(), agent_client_protocol::Error>>>,
}

impl FakeAgent {
    /// Nyalakan koneksi klien di atas transport palsu dan tunggu sampai siap.
    pub(crate) async fn start(
        ctx: &ClientContext,
        events: mpsc::UnboundedReceiver<(String, Value)>,
    ) -> Self {
        let (to_client, incoming) = futures_mpsc::unbounded::<std::io::Result<String>>();
        let (outgoing, from_client) = futures_mpsc::unbounded::<String>();
        let transport = Lines::new(outgoing.sink_map_err(std::io::Error::other), incoming);

        let (ready_tx, ready_rx) = oneshot::channel::<ConnectionTo<Agent>>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let runner = tokio::spawn(
            builder(ctx.clone()).connect_with(transport, async move |cx: ConnectionTo<Agent>| {
                if ready_tx.send(cx).is_err() {
                    return Ok(());
                }
                drop(shutdown_rx.await);
                Ok(())
            }),
        );

        let connection = tokio::time::timeout(TEST_TIMEOUT, ready_rx)
            .await
            .expect("koneksi palsu harus siap")
            .expect("closure koneksi harus mengirim ConnectionTo");

        Self {
            to_client: Some(to_client),
            from_client,
            events,
            connection,
            shutdown_tx: Some(shutdown_tx),
            runner: Some(runner),
        }
    }

    /// Koneksi hidup ke "agen" ini, untuk kode yang mengirim request.
    pub(crate) fn connection(&self) -> &ConnectionTo<Agent> {
        &self.connection
    }

    /// [`AcpHandle`] sungguhan di atas transport palsu — tanpa proses anak.
    pub(crate) fn handle(&mut self, cwd: std::path::PathBuf) -> AcpHandle {
        AcpHandle::from_parts(
            self.connection.clone(),
            self.shutdown_tx.take(),
            self.runner.take().expect("runner hanya boleh diambil sekali"),
            cwd,
        )
    }

    fn send(&self, message: Value) {
        self.to_client
            .as_ref()
            .expect("kanal ke klien harus masih ada")
            .unbounded_send(Ok(message.to_string()))
            .expect("kanal ke klien harus terbuka");
    }

    pub(crate) fn send_notification(&self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    pub(crate) fn send_request(&self, id: u64, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
    }

    /// Balas satu request yang dikirim klien.
    pub(crate) fn reply(&self, id: &Value, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    /// Balas satu request yang dikirim klien dengan galat.
    pub(crate) fn reply_error(&self, id: &Value, code: i64, message: &str) {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }));
    }

    /// Baris berikutnya yang dikirim klien.
    pub(crate) async fn next_line(&mut self) -> Value {
        self.line_within(TEST_TIMEOUT)
            .await
            .expect("klien harus mengirim sesuatu sebelum batas waktu test")
    }

    /// Baris berikutnya, atau `None` bila tidak ada dalam `budget`.
    pub(crate) async fn line_within(&mut self, budget: Duration) -> Option<Value> {
        let line = tokio::time::timeout(budget, self.from_client.next())
            .await
            .ok()?
            .expect("kanal dari klien tidak boleh tertutup");
        Some(serde_json::from_str(&line).expect("baris harus JSON"))
    }

    /// Event berikutnya yang diemisikan ke webview.
    pub(crate) async fn next_event(&mut self) -> (String, Value) {
        tokio::time::timeout(TEST_TIMEOUT, self.events.recv())
            .await
            .expect("event harus datang sebelum batas waktu test")
            .expect("kanal event tidak boleh tertutup")
    }

    /// Apakah ada event yang menunggu diambil.
    pub(crate) fn try_next_event(&mut self) -> Option<(String, Value)> {
        self.events.try_recv().ok()
    }

    /// Tutup arah agen → klien: EOF bersih di transport masuk.
    pub(crate) fn disconnect(&mut self) {
        drop(self.to_client.take());
    }

    /// Tunggu future koneksi selesai. Aman dipanggil berkali-kali.
    ///
    /// Sinyal shutdown ikut dilepas lebih dulu: EOF bersih pada transport masuk
    /// **tidak** membatalkan closure utama `connect_with`
    /// (`jsonrpc.rs:1616-1623` — "It does not cancel unrelated work in
    /// `main_fn`"), jadi menunggu tanpa melepas sinyal itu berarti menunggu
    /// selamanya. `on_close` sendiri sudah jalan saat EOF, terlepas dari ini.
    pub(crate) async fn wait_closed(&mut self) {
        drop(self.shutdown_tx.take());
        let Some(runner) = self.runner.take() else {
            return;
        };
        drop(tokio::time::timeout(TEST_TIMEOUT, runner).await);
    }

    pub(crate) async fn shutdown(mut self) {
        self.disconnect();
        self.wait_closed().await;
    }
}
