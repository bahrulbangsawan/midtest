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
/// Setiap potongan didahului `TEXT_MESSAGE_START` yang membawa `messageId`
/// tetap, dan itu bukan formalitas protokol melainkan perbaikan bug yang
/// terlihat pengguna.
///
/// `TEXT_MESSAGE_CONTENT` sendiri memang tidak mensyaratkan `START`
/// (`handleTextMessageContentEvent` memanggil `ensureAssistantMessage(undefined)`
/// dan membuat pesan asistennya sendiri). Tanpa `START`, teks setelah sebuah
/// tool call **mengulang seluruh narasi sebelumnya**, dan pengulangannya
/// bertumpuk pada setiap tool call berikutnya:
///
/// ```text
/// text "Satu. " / tool / text "Satu. Dua. " / tool / text "Satu. Dua. Tiga."
/// ```
///
/// Untuk agen Midscene yang lazim memanggil beberapa tool dalam satu giliran,
/// blok terakhir jadi mengulang percakapan sepanjang giliran itu.
///
/// Sebabnya: `handleTextMessageContentEvent` hanya memulai segmen teks baru
/// bila `isNewTextSegment()` benar, dan fungsi itu (`processor.js:1212-1222`)
/// mengembalikan `false` tanpa syarat untuk chunk yang hanya membawa `delta`
/// tanpa `content` — bentuk yang kita kirim. Karena bagian terakhir pesannya
/// saat itu bertipe `tool-call`, `updateTextPart` **menambah** bagian teks
/// baru alih-alih mengganti, dan isinya adalah seluruh segmen terakumulasi.
///
/// Dua jalan buntu yang sudah dicoba dan gagal, dicatat supaya tidak dicoba
/// lagi:
///
/// - `messageId` pada `TEXT_MESSAGE_CONTENT` saja **tidak** memperbaiki apa
///   pun. Logika segmennya tidak pernah membacanya.
/// - `TEXT_MESSAGE_START` **tanpa** `messageId` justru merusak lebih parah:
///   `ensureAssistantMessage` membuat pesan baru setiap kali, hasilnya empat
///   pesan terpisah dan agregat `thinking` yang hilang sama sekali.
///
/// Yang bekerja: `START` dengan `messageId` tetap. `handleTextMessageStartEvent`
/// (`processor.js:511-518`) me-reset `currentSegmentText`/`lastEmittedText`
/// **hanya** ketika `hasToolCallsSinceTextStart` bernilai benar, dan tidak
/// melakukan apa-apa selain itu. Sifat "no-op di luar posisi pasca-tool-call"
/// itulah yang membuat fungsi ini boleh tetap tanpa state: `START` aman
/// dikirim mendahului **setiap** potongan, termasuk berkali-kali di tengah
/// satu rentang teks, tanpa memecah akumulasinya. Diverifikasi terhadap
/// `StreamProcessor` terpasang dengan rentang teks multi-delta, bukan hanya
/// satu delta per rentang.
///
/// `messageId`-nya diturunkan dari `run_id` sehingga tetap selama satu giliran
/// dan berganti pada giliran berikutnya — satu giliran, satu pesan asisten.
/// `TEXT_MESSAGE_END` tidak diperlukan dan tidak dikirim.
pub fn agui_text_chunk(run_id: &str, thread_id: &str, delta: &str) -> Vec<Value> {
    vec![
        json!({ "type": "TEXT_MESSAGE_START", "runId": run_id, "threadId": thread_id,
                "messageId": text_message_id(run_id) }),
        json!({ "type": "TEXT_MESSAGE_CONTENT", "runId": run_id, "threadId": thread_id,
                "delta": delta }),
    ]
}

/// Identitas pesan asisten untuk satu giliran.
///
/// Wajib ada dan wajib tetap sepanjang giliran — lihat [`agui_text_chunk`]
/// untuk apa yang terjadi bila tidak.
fn text_message_id(run_id: &str) -> String {
    format!("msg-{run_id}")
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

/// Deliver the execution outcome through the standard AG-UI result event.
///
/// `TOOL_CALL_END` only means that arguments are complete to TanStack AI. It
/// does not mean execution succeeded. Sending a result with an explicit output
/// state is what transitions the existing tool-call part, by id, to `complete`
/// or `error` without creating a duplicate visual event.
pub fn agui_tool_call_result(
    run_id: &str,
    thread_id: &str,
    call_id: &str,
    content: &str,
    failed: bool,
) -> Value {
    json!({
        "type": "TOOL_CALL_RESULT",
        "runId": run_id,
        "threadId": thread_id,
        "messageId": format!("tool-result-{call_id}"),
        "toolCallId": call_id,
        "role": "tool",
        "content": content,
        "state": if failed { "output-error" } else { "output-available" },
    })
}

fn tool_result_content(
    raw_output: Option<&Value>,
    content: Option<&impl serde::Serialize>,
) -> String {
    if let Some(output) = raw_output {
        return output.to_string();
    }
    content
        .and_then(|value| serde_json::to_string(value).ok())
        .filter(|value| value != "[]")
        .unwrap_or_else(|| json!({ "status": "completed" }).to_string())
}

fn terminal_tool_events(
    run_id: &str,
    thread_id: &str,
    call_id: &str,
    status: &ToolCallStatus,
    raw_output: Option<&Value>,
    content: Option<&impl serde::Serialize>,
) -> Vec<Value> {
    match status {
        ToolCallStatus::Pending => vec![],
        ToolCallStatus::InProgress => vec![agui_tool_call_end(run_id, thread_id, call_id)],
        ToolCallStatus::Completed => {
            let result = tool_result_content(raw_output, content);
            vec![
                agui_tool_call_end(run_id, thread_id, call_id),
                agui_tool_call_result(run_id, thread_id, call_id, &result, false),
            ]
        }
        ToolCallStatus::Failed => {
            let detail = tool_result_content(raw_output, content);
            let result = if serde_json::from_str::<Value>(&detail)
                .ok()
                .is_some_and(|value| value.get("error").is_some())
            {
                detail
            } else {
                json!({ "error": detail }).to_string()
            };
            vec![
                agui_tool_call_end(run_id, thread_id, call_id),
                agui_tool_call_result(run_id, thread_id, call_id, &result, true),
            ]
        }
        _ => vec![],
    }
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
            ContentBlock::Text(text) => agui_text_chunk(run_id, thread_id, &text.text),
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
            let mut events = agui_tool_call_start(
                run_id,
                thread_id,
                &tool_call.tool_call_id.0,
                &tool_call.title,
                &args_json,
            );
            events.extend(terminal_tool_events(
                run_id,
                thread_id,
                &tool_call.tool_call_id.0,
                &tool_call.status,
                tool_call.raw_output.as_ref(),
                Some(&tool_call.content),
            ));
            events
        }
        SessionUpdate::ToolCallUpdate(update) => {
            update
                .fields
                .status
                .as_ref()
                .map_or_else(Vec::new, |status| {
                    terminal_tool_events(
                        run_id,
                        thread_id,
                        &update.tool_call_id.0,
                        status,
                        update.fields.raw_output.as_ref(),
                        update.fields.content.as_ref(),
                    )
                })
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn potongan_pesan_agen_jadi_text_message_content() {
        let ev = agui_text_chunk("r1", "t1", "halo");
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0]["type"], "TEXT_MESSAGE_START");
        assert_eq!(ev[0]["messageId"], "msg-r1");
        assert_eq!(ev[1]["type"], "TEXT_MESSAGE_CONTENT");
        assert_eq!(ev[1]["delta"], "halo");
        assert_eq!(ev[1]["runId"], "r1");
        assert_eq!(ev[1]["threadId"], "t1");
    }

    /// `messageId` harus tetap selama satu giliran dan berganti pada giliran
    /// berikutnya. Yang pertama menjaga seluruh giliran jadi satu pesan
    /// asisten; yang kedua menjaga giliran baru tidak menempel ke pesan lama.
    #[test]
    fn message_id_tetap_dalam_satu_run_dan_berganti_antar_run() {
        let pertama = agui_text_chunk("r1", "t1", "satu");
        let kedua = agui_text_chunk("r1", "t1", "dua");
        assert_eq!(pertama[0]["messageId"], kedua[0]["messageId"]);

        let giliran_lain = agui_text_chunk("r2", "t1", "tiga");
        assert_ne!(pertama[0]["messageId"], giliran_lain[0]["messageId"]);
    }

    #[test]
    fn tool_call_jadi_start_dan_args() {
        let ev = agui_tool_call_start(
            "r1",
            "t1",
            "call-9",
            "mcp__midscene__act",
            "{\"instruction\":\"klik\"}",
        );
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
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "TEXT_MESSAGE_START");
        assert_eq!(events[0]["messageId"], "msg-r1");
        assert_eq!(events[1]["type"], "TEXT_MESSAGE_CONTENT");
        assert_eq!(events[1]["delta"], "halo dari agen");
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
    fn tool_call_selesai_jadi_end_dan_result_sukses() {
        use agent_client_protocol::schema::v1::{ToolCallUpdate, ToolCallUpdateFields};

        let update = SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "call-1",
            ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
        ));

        let events = to_agui(&update, "r1", "t1");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "TOOL_CALL_END");
        assert_eq!(events[0]["toolCallId"], "call-1");
        assert_eq!(events[1]["type"], "TOOL_CALL_RESULT");
        assert_eq!(events[1]["state"], "output-available");
        assert_eq!(events[1]["toolCallId"], "call-1");
    }

    /// "Selesai" mencakup gagal, bukan cuma sukses: klien butuh tahu tool call
    /// itu berhenti dikirim update lagi supaya UI-nya berhenti berputar,
    /// terlepas dari hasilnya.
    #[test]
    fn tool_call_gagal_jadi_result_error_bukan_sukses() {
        use agent_client_protocol::schema::v1::{ToolCallUpdate, ToolCallUpdateFields};

        let update = SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "call-1",
            ToolCallUpdateFields::new().status(ToolCallStatus::Failed),
        ));

        let events = to_agui(&update, "r1", "t1");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "TOOL_CALL_END");
        assert_eq!(events[0]["toolCallId"], "call-1");
        assert_eq!(events[1]["type"], "TOOL_CALL_RESULT");
        assert_eq!(events[1]["state"], "output-error");
        assert!(events[1]["content"].as_str().unwrap().contains("error"));
    }

    #[test]
    fn tool_call_in_progress_mengakhiri_input_dan_masuk_status_running() {
        use agent_client_protocol::schema::v1::{ToolCallUpdate, ToolCallUpdateFields};

        let update = SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "call-1",
            ToolCallUpdateFields::new().status(ToolCallStatus::InProgress),
        ));

        let events = to_agui(&update, "r1", "t1");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "TOOL_CALL_END");
        assert_eq!(events[0]["toolCallId"], "call-1");
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
            // Tool call kedua, dan teks sesudahnya. Bukan hiasan: cacat
            // pengulangan teks yang diperbaiki `agui_text_chunk` **bertumpuk**
            // — satu tool call hanya menggandakan kalimat pertama, dua tool
            // call membuat blok terakhir mengulang seluruh narasi giliran.
            // Agen Midscene lazim memanggil beberapa tool per giliran, jadi
            // bentuk inilah yang akan dilihat pengguna lebih dulu.
            SessionUpdate::ToolCall(
                ToolCall::new("call-2", "mcp__midscene__query")
                    .raw_input(json!({ "query": "judul halaman" })),
            ),
            SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                "call-2",
                ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
            )),
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from(
                " Judulnya \"Masuk\".",
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
