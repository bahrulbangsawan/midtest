//! Terjemahkan notifikasi `session/update` ACP menjadi event AG-UI.
//!
//! AG-UI adalah kosakata JSON yang dipahami pustaka chat di frontend. Yang
//! menentukan nama event di modul ini **bukan** `@ag-ui/core` — paket itu
//! tidak terpasang di `app/` sama sekali — melainkan `switch` di
//! `StreamProcessor::processChunk`
//! (`@tanstack/ai/dist/esm/activities/chat/stream/processor.js`), yang hanya
//! mengimplementasikan sebagian kosakata AG-UI dan mengabaikan sisanya tanpa
//! error. Daftar `case` yang ada di versi terpasang (`@tanstack/ai` 0.42):
//! `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`,
//! `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`,
//! `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_STARTED`,
//! `STEP_FINISHED`, `MESSAGES_SNAPSHOT`, `CUSTOM`, `REASONING_START`,
//! `REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT`,
//! `REASONING_MESSAGE_END`, `REASONING_END`.
//!
//! Karena kegagalannya diam, daftar itu tidak boleh dipercaya dari ingatan.
//! Yang menjaganya ada di `app/src/connection/agui-processor.test.ts`: test
//! itu menyuapkan fikstur yang **dihasilkan modul ini** ke `StreamProcessor`
//! sungguhan dan menuntut pesan asisten yang utuh keluar dari sana.
//! Fiksturnya sendiri dikunci oleh [`tests::fikstur_agui_untuk_typescript_mutakhir`]
//! di bawah, jadi mengganti nama event di sini tanpa memperbarui fikstur akan
//! menggagalkan `cargo test`, dan mengganti nama ke nama yang tidak dikenal
//! `StreamProcessor` akan menggagalkan `vitest`.
//!
//! Modul ini murni penerjemah: tidak menyentuh jaringan, tidak
//! `async`, tidak menyimpan state. Itu sengaja — [`to_agui`] akan dipanggil dari
//! closure `on_receive_notification` (Task berikutnya), yang tidak memiliki
//! runtime async sendiri dan boleh saja dijalankan di konteks yang mensyaratkan
//! `Send`. Fungsi sinkron yang hanya membaca referensi dan mengembalikan
//! `Vec<serde_json::Value>` yang dimiliki sendiri otomatis memenuhi keduanya.
//!
//! Bentuk varian [`SessionUpdate`] di bawah ini dibaca langsung dari sumber
//! crate `agent-client-protocol-schema` 1.5.0
//! (`agent-client-protocol-schema-1.5.0/src/v1/client.rs:99`), bukan dari
//! ingatan atau dari nama yang "terdengar masuk akal" — riwayat proyek ini
//! sudah empat kali salah menebak bentuk API crate ini.

use agent_client_protocol::schema::v1::{ContentBlock, SessionUpdate, ToolCallStatus};
use serde_json::{json, Value};

pub fn agui_run_started(run_id: &str, thread_id: &str) -> Value {
    json!({ "type": "RUN_STARTED", "runId": run_id, "threadId": thread_id })
}

pub fn agui_run_finished(run_id: &str, thread_id: &str) -> Value {
    json!({ "type": "RUN_FINISHED", "runId": run_id, "threadId": thread_id })
}

pub fn agui_run_error(run_id: &str, thread_id: &str, message: &str) -> Value {
    json!({ "type": "RUN_ERROR", "runId": run_id, "threadId": thread_id, "message": message })
}

/// Potongan teks pesan asisten.
///
/// Namanya `TEXT_MESSAGE_CONTENT`, bukan `TEXT_MESSAGE_CHUNK`. Keduanya ada di
/// kosakata `@ag-ui/core`, tetapi yang menentukan di sini bukan `@ag-ui/core`
/// (crate/paket itu tidak terpasang sama sekali) melainkan `switch` di
/// `@tanstack/ai/dist/esm/activities/chat/stream/processor.js` —
/// `StreamProcessor::processChunk`. `switch` itu hanya mengenali sebagian
/// nama AG-UI dan **diam** untuk sisanya: event dengan `type` yang tidak
/// punya `case` jatuh ke ujung `switch` tanpa error, tanpa log, tanpa pesan.
/// `TEXT_MESSAGE_CHUNK` adalah salah satunya, jadi setiap kata asisten hilang
/// tanpa jejak sementara tool call tetap muncul.
///
/// `TEXT_MESSAGE_CONTENT` tidak memerlukan `TEXT_MESSAGE_START` lebih dulu:
/// `handleTextMessageContentEvent` memanggil `ensureAssistantMessage(undefined)`
/// dan membuat pesan asistennya sendiri bila belum ada.
pub fn agui_text_chunk(run_id: &str, thread_id: &str, delta: &str) -> Value {
    json!({ "type": "TEXT_MESSAGE_CONTENT", "runId": run_id, "threadId": thread_id, "delta": delta })
}

pub fn agui_tool_call_start(
    run_id: &str,
    thread_id: &str,
    call_id: &str,
    name: &str,
    args_json: &str,
) -> Vec<Value> {
    vec![
        json!({ "type": "TOOL_CALL_START", "runId": run_id, "threadId": thread_id,
                "toolCallId": call_id, "toolCallName": name }),
        json!({ "type": "TOOL_CALL_ARGS", "runId": run_id, "threadId": thread_id,
                "toolCallId": call_id, "delta": args_json }),
    ]
}

pub fn agui_tool_call_end(run_id: &str, thread_id: &str, call_id: &str) -> Value {
    json!({ "type": "TOOL_CALL_END", "runId": run_id, "threadId": thread_id, "toolCallId": call_id })
}

/// Potongan pemikiran agen (bukan pesan): tipe event berbeda dari
/// [`agui_text_chunk`], bentuk payload sama persis.
///
/// Namanya `REASONING_MESSAGE_CONTENT`, bukan `THINKING_TEXT_MESSAGE_CONTENT`.
/// Alasannya sama dengan [`agui_text_chunk`]: nama yang kedua tidak punya
/// `case` di `StreamProcessor::processChunk` dan hilang tanpa suara.
/// `handleReasoningMessageContentEvent` menghasilkan tepat bagian
/// `{ type: "thinking" }` yang sudah dirender `Chat.tsx`.
pub fn agui_thinking_chunk(run_id: &str, thread_id: &str, delta: &str) -> Value {
    json!({ "type": "REASONING_MESSAGE_CONTENT", "runId": run_id, "threadId": thread_id, "delta": delta })
}

/// Terjemahkan satu [`SessionUpdate`] menjadi nol atau lebih event AG-UI.
///
/// Varian yang belum dipetakan **harus** mengembalikan `vec![]`, bukan panik:
/// `SessionUpdate` bertanda `#[non_exhaustive]` di crate skema (lihat
/// `agent-client-protocol-schema-1.5.0/src/v1/client.rs:98`) sehingga daftarnya
/// bisa bertambah kapan saja crate diperbarui, dan satu notifikasi yang tak
/// dikenal tidak boleh menjatuhkan aplikasi.
pub fn to_agui(update: &SessionUpdate, run_id: &str, thread_id: &str) -> Vec<Value> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => match &chunk.content {
            ContentBlock::Text(text) => vec![agui_text_chunk(run_id, thread_id, &text.text)],
            _ => vec![],
        },
        SessionUpdate::AgentThoughtChunk(chunk) => match &chunk.content {
            ContentBlock::Text(text) => vec![agui_thinking_chunk(run_id, thread_id, &text.text)],
            _ => vec![],
        },
        SessionUpdate::ToolCall(tool_call) => {
            let args_json = tool_call
                .raw_input
                .as_ref()
                .map_or_else(|| "{}".to_owned(), Value::to_string);
            agui_tool_call_start(
                run_id,
                thread_id,
                &tool_call.tool_call_id.0,
                &tool_call.title,
                &args_json,
            )
        }
        SessionUpdate::ToolCallUpdate(update) => match update.fields.status {
            Some(ToolCallStatus::Completed | ToolCallStatus::Failed) => {
                vec![agui_tool_call_end(run_id, thread_id, &update.tool_call_id.0)]
            }
            _ => vec![],
        },
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn potongan_pesan_agen_jadi_text_message_content() {
        let ev = agui_text_chunk("r1", "t1", "halo");
        assert_eq!(ev["type"], "TEXT_MESSAGE_CONTENT");
        assert_eq!(ev["delta"], "halo");
        assert_eq!(ev["runId"], "r1");
        assert_eq!(ev["threadId"], "t1");
    }

    #[test]
    fn tool_call_jadi_start_dan_args() {
        let ev = agui_tool_call_start("r1", "t1", "call-9", "mcp__midscene__act", "{\"instruction\":\"klik\"}");
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0]["type"], "TOOL_CALL_START");
        assert_eq!(ev[0]["toolCallId"], "call-9");
        assert_eq!(ev[0]["toolCallName"], "mcp__midscene__act");
        assert_eq!(ev[1]["type"], "TOOL_CALL_ARGS");
        assert_eq!(ev[1]["delta"], "{\"instruction\":\"klik\"}");
    }

    #[test]
    fn run_started_dan_finished_membawa_id() {
        let s = agui_run_started("r1", "t1");
        assert_eq!(s["type"], "RUN_STARTED");
        assert_eq!(s["runId"], "r1");
        let f = agui_run_finished("r1", "t1");
        assert_eq!(f["type"], "RUN_FINISHED");
    }

    #[test]
    fn run_error_membawa_pesan() {
        let e = agui_run_error("r1", "t1", "gagal konek");
        assert_eq!(e["type"], "RUN_ERROR");
        assert_eq!(e["message"], "gagal konek");
    }

    /// Jalur kode paling sering dipakai — pesan asisten biasa yang di-stream ke
    /// pengguna — sengaja diuji lewat `to_agui` sendiri, bukan hanya lewat
    /// pembangun `agui_text_chunk` mentah. Test ini yang membuat penukaran
    /// lengan `AgentMessageChunk` <-> `AgentThoughtChunk` (atau salah cocok
    /// varian `ContentBlock` di lengan ini) gagal dikompilasi lolos test,
    /// bukan hanya lolos lalu diam-diam merender bubble "thinking" untuk
    /// teks asisten biasa.
    #[test]
    fn potongan_pesan_agen_jadi_text_message_content_lewat_to_agui() {
        use agent_client_protocol::schema::v1::ContentChunk;

        let update = SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from(
            "halo dari agen",
        )));
        let events = to_agui(&update, "r1", "t1");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "TEXT_MESSAGE_CONTENT");
        assert_eq!(events[0]["delta"], "halo dari agen");
    }

    #[test]
    fn potongan_pemikiran_agen_jadi_reasoning_content() {
        use agent_client_protocol::schema::v1::ContentChunk;

        let update = SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::from(
            "menimbang opsi",
        )));
        let events = to_agui(&update, "r1", "t1");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "REASONING_MESSAGE_CONTENT");
        assert_eq!(events[0]["delta"], "menimbang opsi");
    }

    /// Konten non-teks (mis. gambar) pada potongan pesan/pemikiran tidak
    /// punya delta string yang jujur untuk dikirim, jadi harus jatuh ke
    /// `vec![]`, bukan mengarang teks.
    #[test]
    fn potongan_konten_non_teks_kembalikan_vec_kosong() {
        use agent_client_protocol::schema::v1::{ContentChunk, ImageContent};

        let gambar = ContentBlock::Image(ImageContent::new("base64data==", "image/png"));
        let update = SessionUpdate::AgentMessageChunk(ContentChunk::new(gambar));

        assert_eq!(to_agui(&update, "r1", "t1"), Vec::<Value>::new());
    }

    #[test]
    fn tool_call_baru_jadi_start_dan_args_lewat_to_agui() {
        use agent_client_protocol::schema::v1::ToolCall;

        let tool_call = ToolCall::new("call-1", "mcp__midscene__act")
            .raw_input(json!({ "instruction": "klik" }));
        let update = SessionUpdate::ToolCall(tool_call);

        let events = to_agui(&update, "r1", "t1");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "TOOL_CALL_START");
        assert_eq!(events[0]["toolCallId"], "call-1");
        assert_eq!(events[0]["toolCallName"], "mcp__midscene__act");
        assert_eq!(events[1]["type"], "TOOL_CALL_ARGS");
    }

    #[test]
    fn tool_call_selesai_jadi_tool_call_end() {
        use agent_client_protocol::schema::v1::{ToolCallUpdate, ToolCallUpdateFields};

        let update = SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "call-1",
            ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
        ));

        let events = to_agui(&update, "r1", "t1");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "TOOL_CALL_END");
        assert_eq!(events[0]["toolCallId"], "call-1");
    }

    /// "Selesai" mencakup gagal, bukan cuma sukses: klien butuh tahu tool call
    /// itu berhenti dikirim update lagi supaya UI-nya berhenti berputar,
    /// terlepas dari hasilnya.
    #[test]
    fn tool_call_gagal_juga_jadi_tool_call_end() {
        use agent_client_protocol::schema::v1::{ToolCallUpdate, ToolCallUpdateFields};

        let update = SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "call-1",
            ToolCallUpdateFields::new().status(ToolCallStatus::Failed),
        ));

        let events = to_agui(&update, "r1", "t1");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "TOOL_CALL_END");
        assert_eq!(events[0]["toolCallId"], "call-1");
    }

    #[test]
    fn tool_call_belum_selesai_tidak_menghasilkan_event() {
        use agent_client_protocol::schema::v1::{ToolCallUpdate, ToolCallUpdateFields};

        let update = SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "call-1",
            ToolCallUpdateFields::new().status(ToolCallStatus::InProgress),
        ));

        assert_eq!(to_agui(&update, "r1", "t1"), Vec::<Value>::new());
    }

    #[test]
    fn varian_lain_kembalikan_vec_kosong() {
        use agent_client_protocol::schema::v1::Plan;

        let update = SessionUpdate::Plan(Plan::new(vec![]));
        assert_eq!(to_agui(&update, "r1", "t1"), Vec::<Value>::new());
    }

    // ------------------------------------------------- fikstur lintas-batas

    /// Di mana fikstur untuk sisi TypeScript ditulis, relatif terhadap
    /// `app/src-tauri/`.
    const JALUR_FIKSTUR: &str = "../src/connection/__fixtures__/agui-events.json";

    /// Satu giliran lengkap seperti yang benar-benar dikirim ke webview.
    ///
    /// Urutannya meniru `run_turn` di `commands.rs` (`RUN_STARTED` … lalu
    /// setiap `session/update` lewat `ClientContext::forward_update` …
    /// lalu `RUN_FINISHED`), sehingga fikstur yang dihasilkan bukan daftar
    /// event karangan melainkan persis apa yang mengalir di produksi.
    fn giliran_lengkap() -> Vec<Value> {
        use agent_client_protocol::schema::v1::{
            ContentChunk, ToolCall, ToolCallUpdate, ToolCallUpdateFields,
        };

        const RUN: &str = "run-fikstur";
        const THREAD: &str = "thread-fikstur";

        let pembaruan = vec![
            SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::from(
                "Perlu membuka halamannya dulu.",
            ))),
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from("Baik, "))),
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from(
                "saya buka halamannya.",
            ))),
            SessionUpdate::ToolCall(
                ToolCall::new("call-1", "mcp__midscene__act")
                    .raw_input(json!({ "instruction": "klik tombol Masuk" })),
            ),
            SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                "call-1",
                ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
            )),
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from(
                " Halamannya sudah terbuka.",
            ))),
        ];

        let mut events = vec![agui_run_started(RUN, THREAD)];
        for update in &pembaruan {
            events.extend(to_agui(update, RUN, THREAD));
        }
        events.push(agui_run_finished(RUN, THREAD));
        events
    }

    /// Jahitan Rust → TypeScript, dijaga dari sisi Rust.
    ///
    /// Fikstur di `JALUR_FIKSTUR` **dihasilkan** oleh test ini, bukan disalin
    /// tangan; `agui-processor.test.ts` menyuapkannya ke `StreamProcessor`
    /// sungguhan milik `@tanstack/ai`. Jadi test ini menjawab "apakah yang
    /// dibaca TypeScript masih sama dengan yang dikirim Rust", dan test
    /// vitest itu menjawab "apakah yang dikirim Rust masih dimengerti
    /// pustakanya". Sebelum keduanya ada, tidak ada satu pun test yang
    /// menyeberangi batas ini: sisi Rust hanya mencocokkan string buatannya
    /// sendiri dengan dirinya sendiri, dan sisi vitest hanya membuktikan
    /// adapter mengangkut apa pun yang diberikan padanya. Nama event yang
    /// salah lolos dari keduanya, dan itu persis yang terjadi.
    ///
    /// Menyegarkan fikstur setelah perubahan yang disengaja:
    /// `UPDATE_AGUI_FIXTURE=1 cargo test fikstur_agui`.
    #[test]
    fn fikstur_agui_untuk_typescript_mutakhir() {
        use std::path::Path;

        let jalur = Path::new(env!("CARGO_MANIFEST_DIR")).join(JALUR_FIKSTUR);
        let mut isi = serde_json::to_string_pretty(&giliran_lengkap())
            .expect("event AG-UI selalu bisa diserialisasi");
        isi.push('\n');

        if std::env::var_os("UPDATE_AGUI_FIXTURE").is_some() {
            let induk = jalur.parent().expect("jalur fikstur punya direktori induk");
            std::fs::create_dir_all(induk).expect("direktori fikstur bisa dibuat");
            std::fs::write(&jalur, &isi).expect("fikstur bisa ditulis");
            return;
        }

        let tersimpan = std::fs::read_to_string(&jalur).unwrap_or_else(|galat| {
            panic!(
                "fikstur {} tidak terbaca ({galat}). \
                 Hasilkan ulang dengan: UPDATE_AGUI_FIXTURE=1 cargo test fikstur_agui",
                jalur.display()
            )
        });

        assert_eq!(
            tersimpan,
            isi,
            "fikstur {} sudah basi terhadap events.rs. \
             Sisi TypeScript membaca berkas itu untuk menguji StreamProcessor sungguhan, \
             jadi selisih ini berarti test lintas-batas menguji event yang tidak lagi kita kirim. \
             Hasilkan ulang dengan: UPDATE_AGUI_FIXTURE=1 cargo test fikstur_agui",
            jalur.display()
        );
    }
}
