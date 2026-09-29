# Rencana 2a: Shell Tauri, Klien ACP, dan Chat Minimal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplikasi desktop Tauri berisi antarmuka chat yang mengemudikan agen ACP (Codex atau Claude) dengan sidecar Midscene sudah tersambung, sehingga pengguna dapat meminta otomasi UI dalam bahasa sehari-hari dan melihat balasan agen mengalir.

**Architecture:** Rust men-spawn adapter ACP sebagai proses anak dan bicara JSON-RPC over stdio memakai crate `agent-client-protocol`. Notifikasi `session/update` diterjemahkan menjadi event AG-UI dan diemisikan sebagai event Tauri. Webview React memakai `SubscribeConnectionAdapter` TanStack AI: `send` memanggil `invoke()`, `subscribe` mendengarkan event Tauri. Sidecar Midscene didaftarkan ke sesi lewat parameter `mcpServers` pada `session/new`.

**Tech Stack:** Tauri 2.11, Rust 1.97, crate `agent-client-protocol` 2.0 (protokol V1), Vite + React + TypeScript, `@tanstack/ai` 0.42 + `@tanstack/ai-react` 0.18, shadcn.

## Global Constraints

- Aplikasi hidup di `app/`. **Jangan menyentuh `package.json` atau `package-lock.json` di root repo** — itu milik human partner dan berisi perubahan tak ter-commit.
- `midscene-mcp/` **tidak boleh diubah** oleh rencana ini. Ia dipakai sebagai proses, bukan pustaka.
- `~/.cargo/bin` tidak ada di PATH shell non-interaktif. Awali perintah cargo dengan `export PATH="$HOME/.cargo/bin:$PATH"`.
- Aplikasi adalah ACP **client**. Ia tidak pernah menyimpan, menyentuh, atau mem-proxy kredensial. Login terjadi di CLI milik pengguna.
- Server MCP stdio dikirim **tanpa** field `type` — itu bentuk kanonik di skema kedua adapter.
- Teks yang dilihat pengguna berbahasa **Indonesia**. Identifier kode dan pesan log berbahasa Inggris.
- Rust: `cargo test` dan `cargo clippy -- -D warnings` harus lulus. TypeScript: `tsc --noEmit` harus lulus.
- Setiap task diakhiri commit. Stage hanya berkas di bawah `app/`.

## Fakta terverifikasi yang mengikat rencana ini

Diverifikasi 2026-08-04 dengan menjalankan, bukan membaca dokumentasi. Sumber lengkap:
`docs/superpowers/notes/2026-08-04-hasil-e2e.md`.

- **Tidak ada agen yang punya mode ACP native.** Keduanya adapter terpisah:
  `codex-acp` 1.1.9 (men-spawn `${CODEX_PATH ?? "codex"} app-server`) dan
  `claude-agent-acp` 0.64.2. Keduanya sudah terpasang global di mesin ini.
- **`authMethods` berbeda.** Codex: `api-key` dan `chat-gpt`. Claude: `[]` (sudah
  terautentikasi). Rencana ini memakai **Claude** karena tidak butuh alur auth —
  auth UI adalah lingkup Rencana 2b.
- **`mcpServers` pada `session/new` bekerja.** Dibuktikan end-to-end: 10 dari 10 tool
  Midscene terlihat oleh agen.
- **Sesi mewarisi server MCP milik pengguna** dari konfigurasi CLI-nya, digabung dengan
  yang dikirim klien. Jangan berasumsi hanya tool kita yang ada.
- **`StreamChunk` TanStack AI = `AGUIEvent`** dari `@ag-ui/core`. Nama event yang
  dipakai rencana ini: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`,
  `TEXT_MESSAGE_CHUNK`, `THINKING_TEXT_MESSAGE_START/CONTENT/END`,
  `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`.
- **Sidecar dijalankan sebagai:** `node --env-file=<akar>/.env <akar>/midscene-mcp/src/index.ts`
  dengan env `MIDSCENE_MCP_ROOT=<akar>`.

---

### Task 1: Scaffold aplikasi Tauri

**Files:**
- Create: `app/` (seluruh isi hasil scaffold)
- Modify: `.gitignore` (root)

**Interfaces:**
- Produces: proyek Tauri yang bisa dibangun di `app/`, dengan `app/src-tauri/` berisi crate Rust dan `app/src/` berisi React.

- [ ] **Step 1: Scaffold**

```bash
cd /Users/rulisme/midtest
export PATH="$HOME/.cargo/bin:$PATH"
npm create tauri-app@latest app -- --template react-ts --manager npm --yes
```

Bila flag `--yes` tidak dikenali oleh versi CLI yang terpasang, jalankan tanpa `--yes`
dan jawab promptnya: nama `app`, identifier `com.midtest.desktop`, frontend
React + TypeScript, package manager npm. **Catat di laporan versi CLI dan flag yang
benar-benar dipakai.**

- [ ] **Step 2: Verifikasi build Rust**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo build 2>&1 | tail -5
```

Expected: `Finished` tanpa error. Build pertama mengunduh banyak crate dan bisa
memakan beberapa menit.

- [ ] **Step 3: Verifikasi typecheck frontend**

```bash
cd /Users/rulisme/midtest/app
npm install
npx tsc --noEmit
```

Expected: keluar tanpa error.

- [ ] **Step 4: Tambahkan artefak build ke .gitignore root**

Sisipkan di `/Users/rulisme/midtest/.gitignore` setelah baris `dist/`:

```
# Build aplikasi Tauri
app/node_modules/
app/dist/
app/src-tauri/target/
```

Hapus baris `src-tauri/target/` yang lama bila ada, karena lokasinya kini di bawah `app/`.

- [ ] **Step 5: Commit**

```bash
cd /Users/rulisme/midtest
git add app .gitignore
git commit -m "feat(app): scaffold aplikasi Tauri"
```

---

### Task 2: Registry agen dan deteksi prasyarat

**Files:**
- Create: `app/src-tauri/src/agents.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `pub struct AgentSpec { pub id: &'static str, pub label: &'static str, pub bin: &'static str }`, `pub const AGENTS: [AgentSpec; 2]`, `pub fn find_agent(id: &str) -> Option<&'static AgentSpec>`, `pub fn probe(bin: &str, path_lookup: &dyn Fn(&str) -> Option<PathBuf>) -> bool`.

- [ ] **Step 1: Tulis test yang gagal**

Buat `app/src-tauri/src/agents.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn registry_memuat_kedua_agen() {
        let id: Vec<&str> = AGENTS.iter().map(|a| a.id).collect();
        assert!(id.contains(&"claude"));
        assert!(id.contains(&"codex"));
    }

    #[test]
    fn find_agent_mengembalikan_spec_yang_cocok() {
        let a = find_agent("claude").expect("claude harus ada");
        assert_eq!(a.bin, "claude-agent-acp");
        assert!(find_agent("tidak-ada").is_none());
    }

    #[test]
    fn probe_benar_bila_biner_ditemukan() {
        let ada = |_: &str| Some(PathBuf::from("/usr/local/bin/x"));
        assert!(probe("claude-agent-acp", &ada));
    }

    #[test]
    fn probe_salah_bila_biner_tidak_ditemukan() {
        let kosong = |_: &str| None;
        assert!(!probe("claude-agent-acp", &kosong));
    }
}
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test agents 2>&1 | tail -20
```

Expected: gagal kompilasi — `AGENTS`, `find_agent`, `probe` belum ada.

- [ ] **Step 3: Tulis implementasi**

Sisipkan di atas blok `mod tests` pada `app/src-tauri/src/agents.rs`:

```rust
use std::path::PathBuf;

/// One ACP agent adapter this app can drive.
/// Neither Codex nor Claude ships a native ACP mode; both are separate
/// adapter binaries that translate ACP to the vendor's own CLI protocol.
pub struct AgentSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub bin: &'static str,
}

pub const AGENTS: [AgentSpec; 2] = [
    AgentSpec { id: "claude", label: "Claude", bin: "claude-agent-acp" },
    AgentSpec { id: "codex", label: "Codex", bin: "codex-acp" },
];

pub fn find_agent(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|a| a.id == id)
}

/// Whether the adapter binary is resolvable. The lookup is injected so this
/// stays testable without depending on the machine's PATH.
pub fn probe(bin: &str, path_lookup: &dyn Fn(&str) -> Option<PathBuf>) -> bool {
    path_lookup(bin).is_some()
}
```

- [ ] **Step 4: Daftarkan modul**

Di `app/src-tauri/src/lib.rs`, tambahkan di baris paling atas:

```rust
pub mod agents;
```

- [ ] **Step 5: Jalankan test untuk memastikan lulus**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test agents 2>&1 | tail -10
cargo clippy -- -D warnings 2>&1 | tail -5
```

Expected: 4 test lulus, clippy bersih.

- [ ] **Step 6: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src-tauri/src
git commit -m "feat(app): registry agen ACP dan deteksi biner"
```

---

### Task 3: Klien ACP — handshake initialize

**Task ini punya risiko API tertinggi di rencana ini. Baca peringatannya.**

Crate `agent-client-protocol` 2.0.0 menyediakan sisi client lengkap termasuk transport
`Stdio`, tetapi **tanda tangan persisnya belum diverifikasi**. Rencana ini sengaja
tidak menuliskan signature palsu. Langkah pertama task ini adalah menurunkan API
sebenarnya dari crate, lalu menulis kode terhadap API itu.

Ini pelajaran langsung dari Rencana 1, di mana kode yang ditulis dari ingatan ternyata
salah di enam tempat — termasuk satu yang akan menghasilkan gambar kosong selamanya
tanpa error.

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Create: `app/src-tauri/src/acp/mod.rs`
- Create: `app/src-tauri/src/acp/client.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `agents::{find_agent, AgentSpec}` (Task 2)
- Produces: `pub struct AcpHandle` yang membungkus koneksi hidup ke satu proses adapter, dan `pub async fn connect(spec: &AgentSpec, cwd: &Path) -> Result<(AcpHandle, InitializeResponse), AcpError>`. Nama tipe balasan mengikuti nama sebenarnya di crate — turunkan, jangan karang.

- [ ] **Step 1: Turunkan API crate yang sebenarnya**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo add agent-client-protocol@2
cargo add tokio --features rt-multi-thread,macros,process,io-util,sync
cargo doc -p agent-client-protocol --no-deps 2>&1 | tail -3
```

Lalu baca API-nya langsung dari sumber crate yang terunduh:

```bash
find ~/.cargo/registry/src -maxdepth 3 -type d -name "agent-client-protocol-2*" | head -1
```

Catat di laporan, dengan kutipan dari sumber:
1. Bagaimana transport `Stdio` dibuat dari `tokio::process::Child` (stdin/stdout).
2. Trait apa yang **kita** harus implementasikan sebagai client — yang menangani
   permintaan agen ke kita (`session/request_permission`, operasi fs). Sebutkan tiap
   method wajibnya.
3. Tanda tangan `initialize`, dan tipe request/response-nya.
4. Bagaimana `Builder`/`ConnectionTo` dipakai untuk peran client.
5. Apakah `ProtocolVersion::V1` yang dipakai secara default.

**Jangan menulis kode sebelum kelima hal itu terjawab dari sumber.**

- [ ] **Step 2: Tulis test integrasi yang gagal**

Buat `app/src-tauri/tests/acp_initialize.rs`. Test ini menjalankan
`claude-agent-acp` sungguhan, yang **sudah terpasang** dan **tidak butuh auth**
untuk handshake. Tidak ada panggilan model dan tidak ada biaya.

```rust
use std::path::Path;

#[tokio::test]
async fn initialize_mengembalikan_info_agen_dan_kapabilitas() {
    let spec = midtest_lib::agents::find_agent("claude").expect("agen claude harus ada");
    let (handle, init) = midtest_lib::acp::connect(spec, Path::new("."))
        .await
        .expect("connect harus berhasil");

    assert!(
        init.agent_info_name().contains("claude-agent-acp"),
        "agentInfo.name tak terduga: {}",
        init.agent_info_name()
    );
    assert!(init.supports_image_prompt(), "agen harus mendukung prompt gambar");

    handle.shutdown().await;
}
```

Catatan: `agent_info_name()` dan `supports_image_prompt()` adalah **helper yang kamu
tulis sendiri** pada tipe balasan crate (lewat extension trait atau struct pembungkus),
supaya test tidak bergantung pada bentuk internal crate. Definisikan keduanya di
`acp/mod.rs`. Bila nama crate untuk lib berbeda dari `midtest_lib`, sesuaikan dan catat.

- [ ] **Step 3: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --test acp_initialize 2>&1 | tail -20
```

Expected: gagal kompilasi — modul `acp` belum ada.

- [ ] **Step 4: Tulis implementasi terhadap API yang sudah diturunkan**

Buat `app/src-tauri/src/acp/client.rs` berisi implementasi trait client. Untuk task
ini, handler permintaan izin boleh menolak semuanya dengan jawaban terstruktur — Task 6
menggantinya dengan gerbang izin sungguhan. **Jangan** membuatnya `unimplemented!()`
atau panik: agen akan menggantung.

Buat `app/src-tauri/src/acp/mod.rs` berisi `AcpHandle`, `connect`, `shutdown`, dan
kedua helper yang dipakai test. Bentuk yang diharapkan:

```rust
pub struct AcpHandle {
    // Simpan child process dan handle koneksi sesuai bentuk yang crate sediakan.
}

impl AcpHandle {
    pub async fn shutdown(self) { /* matikan proses anak, tunggu keluar */ }
}
```

Isi `connect` menurut API yang kamu turunkan di Step 1: spawn `spec.bin` dengan
stdin/stdout ter-pipe, bangun transport `Stdio`, bangun koneksi peran client, kirim
`initialize` dengan `ProtocolVersion::V1`, kembalikan handle dan balasannya.

- [ ] **Step 5: Daftarkan modul**

Di `app/src-tauri/src/lib.rs` tambahkan:

```rust
pub mod acp;
```

- [ ] **Step 6: Jalankan test untuk memastikan lulus**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --test acp_initialize 2>&1 | tail -15
cargo clippy -- -D warnings 2>&1 | tail -5
```

Expected: test lulus terhadap `claude-agent-acp` sungguhan; clippy bersih.

- [ ] **Step 7: Buktikan proses anak tidak bocor**

```bash
pgrep -fl claude-agent-acp | head
```

Expected: tidak ada baris. Bila ada, `shutdown` tidak benar-benar mematikan proses —
perbaiki sebelum lanjut.

- [ ] **Step 8: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src-tauri
git commit -m "feat(app): klien ACP dengan handshake initialize"
```

---

### Task 4: Sesi dengan sidecar Midscene terdaftar

**Files:**
- Create: `app/src-tauri/src/sidecar.rs`
- Create: `app/src-tauri/src/acp/session.rs`
- Modify: `app/src-tauri/src/acp/mod.rs`, `app/src-tauri/src/lib.rs`
- Test: `app/src-tauri/tests/acp_session.rs`

**Interfaces:**
- Consumes: `acp::connect` (Task 3)
- Produces: `pub fn midscene_server(root: &Path) -> McpServerConfig` di `sidecar.rs`, dan `pub async fn new_session(handle: &AcpHandle, cwd: &Path, servers: Vec<McpServerConfig>) -> Result<SessionId, AcpError>`. Tipe `McpServerConfig` adalah tipe crate untuk entri stdio — turunkan namanya dari sumber.

- [ ] **Step 1: Tulis test yang gagal**

Buat `app/src-tauri/tests/acp_session.rs`:

```rust
use std::path::{Path, PathBuf};

fn akar_repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

#[test]
fn konfigurasi_sidecar_tidak_menyertakan_field_type() {
    let cfg = midtest_lib::sidecar::midscene_server(&akar_repo());
    let json = serde_json::to_value(&cfg).unwrap();
    assert!(
        json.get("type").is_none(),
        "entri stdio harus tanpa field type, dapat: {json}"
    );
    assert_eq!(json["name"], "midscene");
    let args = json["args"].as_array().expect("args harus array");
    assert!(args.iter().any(|a| a.as_str().unwrap_or("").contains("--env-file")));
    assert!(args.iter().any(|a| a.as_str().unwrap_or("").ends_with("midscene-mcp/src/index.ts")));
}

#[tokio::test]
async fn sesi_baru_membuat_id_sesi() {
    let spec = midtest_lib::agents::find_agent("claude").unwrap();
    let akar = akar_repo();
    let (handle, _init) = midtest_lib::acp::connect(spec, &akar).await.unwrap();
    let servers = vec![midtest_lib::sidecar::midscene_server(&akar)];
    let sid = midtest_lib::acp::new_session(&handle, &akar, servers).await.unwrap();
    assert!(!sid.to_string().is_empty(), "sessionId tidak boleh kosong");
    handle.shutdown().await;
}
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --test acp_session 2>&1 | tail -20
```

Expected: gagal kompilasi — `sidecar` dan `new_session` belum ada.

- [ ] **Step 3: Tulis `sidecar.rs`**

Tipe entri MCP stdio milik crate diturunkan dari sumber, sama seperti Task 3 Step 1.
Yang mengikat adalah **nilai** yang harus dihasilkan, bukan nama tipenya:

| Field | Nilai |
|---|---|
| `name` | `"midscene"` |
| `command` | `"node"` |
| `args[0]` | `--env-file=<root>/.env` |
| `args[1]` | `<root>/midscene-mcp/src/index.ts` |
| `env` | satu entri: nama `MIDSCENE_MCP_ROOT`, nilai `<root>` |
| `type` | **tidak ada** |

Skema `codex-acp` menuntut `args` dan `env` sebagai array **wajib** — kirim array
kosong bila suatu saat kosong, jangan hilangkan field-nya.

Doc comment yang wajib ada di fungsi, karena alasannya tidak terlihat dari kode:

```rust
/// Build the stdio MCP entry for the Midscene sidecar.
///
/// The `type` field is deliberately omitted: in both adapters' schemas the
/// stdio variant is the one *without* a type discriminator. Sending
/// `type: "stdio"` was tested and also works on claude-agent-acp 0.64.2, but
/// the omitted form is the canonical shape and is what codex-acp's union
/// expects by construction.
```

Test di Step 1 menegaskan bentuk JSON hasil serialisasinya, jadi ia akan gagal bila
tipe crate ternyata menyisipkan `type` sendiri — itu memang yang ingin kita ketahui.

- [ ] **Step 4: Tulis `acp/session.rs`**

Implementasikan `new_session` memakai `SessionBuilder` crate: `cwd` diisi akar repo,
`mcpServers` diisi daftar yang dioper. Kembalikan `SessionId` milik crate.

- [ ] **Step 5: Jalankan test untuk memastikan lulus**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --test acp_session 2>&1 | tail -15
cargo clippy -- -D warnings 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src-tauri
git commit -m "feat(app): sesi ACP dengan sidecar Midscene terdaftar"
```

---

### Task 5: Terjemahkan `session/update` menjadi event AG-UI

**Files:**
- Create: `app/src-tauri/src/acp/events.rs`
- Modify: `app/src-tauri/src/acp/mod.rs`
- Test: unit test di dalam `events.rs`

**Interfaces:**
- Produces: `pub fn to_agui(update: &SessionUpdate, run_id: &str, thread_id: &str) -> Vec<serde_json::Value>` — satu notifikasi ACP dapat menghasilkan nol atau lebih event AG-UI.

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan di akhir `app/src-tauri/src/acp/events.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn potongan_pesan_agen_jadi_text_message_chunk() {
        let ev = agui_text_chunk("r1", "t1", "halo");
        assert_eq!(ev["type"], "TEXT_MESSAGE_CHUNK");
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
}
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test events 2>&1 | tail -20
```

Expected: gagal kompilasi — fungsi-fungsi itu belum ada.

- [ ] **Step 3: Tulis pembangun event**

Di `app/src-tauri/src/acp/events.rs`, di atas blok test:

```rust
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

pub fn agui_text_chunk(run_id: &str, thread_id: &str, delta: &str) -> Value {
    json!({ "type": "TEXT_MESSAGE_CHUNK", "runId": run_id, "threadId": thread_id, "delta": delta })
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
```

- [ ] **Step 4: Tulis `to_agui`**

Petakan varian `SessionUpdate` crate ke pembangun di atas. Nama varian turunkan dari
sumber crate — jangan karang. Pemetaan yang dituju:

| Varian ACP | Event AG-UI |
|---|---|
| potongan pesan agen | `agui_text_chunk` |
| potongan pemikiran agen | `THINKING_TEXT_MESSAGE_CONTENT` |
| tool call baru | `agui_tool_call_start` (dua event) |
| pembaruan tool call selesai | `agui_tool_call_end` |
| varian lain | kembalikan `vec![]` |

Varian yang belum dipetakan **harus** menghasilkan `vec![]`, bukan panik.

- [ ] **Step 5: Jalankan test untuk memastikan lulus**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test events 2>&1 | tail -10
cargo clippy -- -D warnings 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src-tauri
git commit -m "feat(app): terjemahkan session/update ACP ke event AG-UI"
```

---

### Task 6: Perintah Tauri — prompt, streaming, dan gerbang izin

**Files:**
- Create: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/acp/client.rs`, `app/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: perintah Tauri `connect_agent(agent_id: String) -> Result<AgentInfo, String>`, `send_prompt(text: String) -> Result<(), String>`, `answer_permission(request_id: String, option_id: String) -> Result<(), String>`; event Tauri bernama `agui` (payload `serde_json::Value`) dan `permission-request`.

- [ ] **Step 1: Alirkan event AG-UI ke webview**

Di handler notifikasi `session/update`, panggil `to_agui(...)` dan emisikan tiap event:

```rust
for ev in to_agui(&update, &run_id, &thread_id) {
    let _ = app_handle.emit("agui", ev);
}
```

`RUN_STARTED` diemisikan tepat sebelum prompt dikirim; `RUN_FINISHED` saat prompt
selesai; `RUN_ERROR` bila prompt gagal. Tanpa ketiganya, `useChat` tidak akan pernah
menganggap satu giliran selesai.

- [ ] **Step 2: Ganti handler izin penolak-semua dari Task 3**

Ketika agen mengirim `session/request_permission`, emisikan event `permission-request`
berisi id permintaan dan daftar opsi, lalu **tunggu** jawaban dari frontend lewat
`answer_permission`. Pakai `tokio::sync::oneshot` per permintaan, disimpan dalam map
yang dikunci id permintaan.

Batas waktu wajib: bila tidak dijawab dalam 120 detik, jawab dengan opsi penolakan dan
buang entri map-nya. Tanpa batas waktu, sesi menggantung selamanya bila webview
tertutup saat izin diminta.

- [ ] **Step 3: Tulis test unit untuk peta izin**

Peta permintaan izin dapat diuji tanpa agen. Buat test di `commands.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(peta.jawab("hantu", "allow").is_err());
    }

    #[tokio::test]
    async fn penunggu_dibuang_setelah_dijawab() {
        let peta = PermissionMap::default();
        let _rx = peta.daftar("req-2".into());
        peta.jawab("req-2", "allow").unwrap();
        assert!(peta.jawab("req-2", "allow").is_err(), "entri harus sudah dibuang");
    }
}
```

- [ ] **Step 4: Jalankan test**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test commands 2>&1 | tail -10
cargo clippy -- -D warnings 2>&1 | tail -5
```

Expected: 3 test lulus, clippy bersih.

- [ ] **Step 5: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src-tauri
git commit -m "feat(app): perintah prompt, streaming AG-UI, dan gerbang izin"
```

---

### Task 7: Connection adapter TanStack di frontend

**Files:**
- Create: `app/src/connection/tauri-acp-connection.ts`
- Test: `app/src/connection/tauri-acp-connection.test.ts`
- Modify: `app/package.json`

**Interfaces:**
- Produces: `export function createTauriAcpConnection(deps: Deps): SubscribeConnectionAdapter`, di mana `Deps = { invoke: (cmd: string, args?: unknown) => Promise<unknown>; listen: (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> }`. Dependensi disuntikkan supaya bisa diuji tanpa runtime Tauri.

- [ ] **Step 1: Pasang dependensi**

```bash
cd /Users/rulisme/midtest/app
npm install @tanstack/ai@0.42.0 @tanstack/ai-react@0.18.1
npm install -D vitest
```

Tambahkan ke `app/package.json` bagian `scripts`:

```json
"test": "vitest run",
"typecheck": "tsc --noEmit"
```

- [ ] **Step 2: Tulis test yang gagal**

Buat `app/src/connection/tauri-acp-connection.test.ts`:

```ts
import { test, expect, vi } from 'vitest';
import { createTauriAcpConnection } from './tauri-acp-connection';

function deps() {
  const pendengar: Array<(e: { payload: unknown }) => void> = [];
  return {
    invoke: vi.fn(async () => undefined),
    listen: vi.fn(async (_e: string, cb: (e: { payload: unknown }) => void) => {
      pendengar.push(cb);
      return () => {};
    }),
    emit: (payload: unknown) => pendengar.forEach((cb) => cb({ payload })),
  };
}

test('send meneruskan teks pesan terakhir ke perintah Tauri', async () => {
  const d = deps();
  const conn = createTauriAcpConnection(d);
  await conn.send([{ role: 'user', parts: [{ type: 'text', text: 'halo' }] } as never]);
  expect(d.invoke).toHaveBeenCalledWith('send_prompt', { text: 'halo' });
});

test('subscribe menghasilkan event agui yang diterima', async () => {
  const d = deps();
  const conn = createTauriAcpConnection(d);
  const iter = conn.subscribe()[Symbol.asyncIterator]();
  const berikut = iter.next();
  d.emit({ type: 'TEXT_MESSAGE_CHUNK', delta: 'halo' });
  const hasil = await berikut;
  expect(hasil.done).toBe(false);
  expect((hasil.value as { type: string }).type).toBe('TEXT_MESSAGE_CHUNK');
});

test('abortSignal menghentikan iterasi', async () => {
  const d = deps();
  const conn = createTauriAcpConnection(d);
  const ac = new AbortController();
  const iter = conn.subscribe(ac.signal)[Symbol.asyncIterator]();
  const berikut = iter.next();
  ac.abort();
  const hasil = await berikut;
  expect(hasil.done).toBe(true);
});
```

- [ ] **Step 3: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app
npx vitest run 2>&1 | tail -15
```

Expected: gagal — modul belum ada.

- [ ] **Step 4: Tulis implementasi**

Buat `app/src/connection/tauri-acp-connection.ts`. Bentuknya: antrean asinkron yang
diisi oleh listener event Tauri dan dikuras oleh generator `subscribe`. `send`
mengambil teks dari pesan terakhir dan memanggil `invoke('send_prompt', { text })`.

Detail yang wajib benar:
- `subscribe` harus mendaftarkan listener sekali, bukan tiap iterasi.
- Event yang tiba saat tidak ada konsumen menunggu harus **di-buffer**, bukan hilang.
- `abortSignal` yang menyala harus mengakhiri iterasi (`done: true`) dan melepas listener.

- [ ] **Step 5: Jalankan test untuk memastikan lulus**

```bash
cd /Users/rulisme/midtest/app
npx vitest run 2>&1 | tail -10
npx tsc --noEmit
```

Expected: 3 test lulus, typecheck bersih.

- [ ] **Step 6: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src app/package.json app/package-lock.json
git commit -m "feat(app): connection adapter TanStack di atas event Tauri"
```

---

### Task 8: Antarmuka chat

**Files:**
- Modify: `app/src/App.tsx`
- Create: `app/src/components/Chat.tsx`
- Create: `app/src/components/PermissionDialog.tsx`

**Interfaces:**
- Consumes: `createTauriAcpConnection` (Task 7); perintah dan event dari Task 6.

- [ ] **Step 1: Pasang shadcn**

```bash
cd /Users/rulisme/midtest/app
npx shadcn@latest init --yes --base-color neutral
npx shadcn@latest add message message-scroller marker typeset button textarea dialog
```

Bila salah satu komponen tidak tersedia di registry pada versi ini, catat mana yang
gagal di laporan dan lanjut dengan komponen yang ada — jangan menulis tiruannya.

- [ ] **Step 2: Tulis `Chat.tsx`**

Inti perkabelannya — bagian ini pasti, tulis persis:

```tsx
import { useChat } from '@tanstack/ai-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useMemo, useState } from 'react';
import { createTauriAcpConnection } from '../connection/tauri-acp-connection';

export function Chat() {
  const connection = useMemo(
    () => createTauriAcpConnection({ invoke, listen }),
    [],
  );
  const { messages, sendMessage } = useChat({ connection });
  const [teks, setTeks] = useState('');

  async function kirim() {
    const isi = teks.trim();
    if (!isi) return;
    setTeks('');
    await sendMessage(isi);
  }
  // …render di bawah
}
```

Nama yang dikembalikan `useChat` (`sendMessage` vs `append` vs lainnya) **turunkan dari
tipe paket terpasang**, jangan dari ingatan — periksa
`app/node_modules/@tanstack/ai-react/dist/esm/*.d.ts`. Kalau berbeda, sesuaikan dan
catat di laporan.

Render: daftar pesan di dalam `MessageScroller`, tiap pesan dalam `MessageScrollerItem`
dengan `scrollAnchor` untuk pesan pengguna. Input `Textarea` dengan tombol kirim; Enter
mengirim, Shift+Enter baris baru.

Teks yang dilihat pengguna berbahasa Indonesia: placeholder
`"Minta sesuatu — misalnya: buat dokumentasi alur checkout"`, tombol `"Kirim"`.

- [ ] **Step 3: Tulis `PermissionDialog.tsx`**

Mendengarkan event `permission-request`, menampilkan `Dialog` berisi penjelasan
permintaan dan tombol per opsi, lalu memanggil
`invoke('answer_permission', { requestId, optionId })`.

Judul: `"Agen meminta izin"`. Sertakan nama tool yang diminta, karena pengguna harus
tahu apa yang akan dijalankan.

- [ ] **Step 4: Rangkai di `App.tsx`**

Saat mount, panggil `invoke('connect_agent', { agentId: 'claude' })`. Tampilkan
status koneksi. Render `<Chat />` dan `<PermissionDialog />`.

Bila `connect_agent` gagal, tampilkan pesan galat berbahasa Indonesia yang menyebutkan
biner mana yang tidak ditemukan — jangan layar kosong.

- [ ] **Step 5: Verifikasi typecheck dan build**

```bash
cd /Users/rulisme/midtest/app
npx tsc --noEmit
npm run build
```

Expected: keduanya bersih.

- [ ] **Step 6: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src app/components.json app/package.json app/package-lock.json
git commit -m "feat(app): antarmuka chat dan dialog izin"
```

---

### Task 9: Verifikasi end-to-end manual

Task ini dijalankan **oleh human partner**, bukan implementer — ia membuka jendela
aplikasi dan memakai langganan.

**Files:**
- Create: `docs/superpowers/notes/2026-08-04-e2e-tauri.md`

- [ ] **Step 1: Jalankan aplikasi**

```
! cd /Users/rulisme/midtest/app && export PATH="$HOME/.cargo/bin:$PATH" && npm run tauri dev
```

- [ ] **Step 2: Periksa daftar berikut dan catat hasilnya**

1. Jendela terbuka dan status koneksi menunjukkan agen tersambung.
2. Kirim: *"Sebutkan nama tool MCP dari server midscene yang tersedia untukmu."*
   Balasan mengalir masuk potongan demi potongan, dan menyebut sepuluh tool.
3. Kirim: *"Pakai tool midscene: buka sesi web ke https://example.com, pastikan
   judulnya memuat kata Example, lalu tutup sesi."*
   Dialog izin muncul, dan menyebut nama tool yang diminta.
4. Setelah izin diberikan, Chrome terbuka, assertion lulus, sesi tertutup.
5. Tutup jendela aplikasi, lalu jalankan `pgrep -fl "claude-agent-acp|midscene-mcp"` —
   harus kosong. Proses anak tidak boleh bocor.

- [ ] **Step 3: Tulis catatan hasil**

Rekam tiap butir di atas beserta hasilnya apa adanya, termasuk yang gagal.

- [ ] **Step 4: Commit**

```bash
cd /Users/rulisme/midtest
git add docs/superpowers/notes/2026-08-04-e2e-tauri.md
git commit -m "docs: hasil verifikasi end-to-end aplikasi Tauri"
```

---

## Yang tidak termasuk rencana ini

Ditangani Rencana 2b:

- Panel progres langkah dengan screenshot live (baca event `TOOL_CALL_*` dari aliran yang sama)
- Preview walkthrough di dalam aplikasi
- Deteksi keenam prasyarat dengan panel instruksi install
- Alur auth untuk Codex (`authMethods`: `api-key` dan `chat-gpt`) — rencana ini memakai
  Claude, yang tidak menuntut pilihan auth
- Pemilih agen di UI
- Riwayat percakapan persisten (agen sudah menyediakan `loadSession`, `resume`, `list`)
