# Rencana 2b-1: Kontrol Harian

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menambahkan tiga kontrol yang membuat aplikasi layak dipakai sehari-hari: menghentikan giliran yang sedang berjalan, mode izin penuh yang tersimpan, dan berpindah antara agen Codex dan Claude.

**Architecture:** Ketiganya bertumpu pada mesin yang sudah ada di `app/src-tauri/`. Pembatalan memakai notifikasi ACP `session/cancel`. Mode izin penuh menyisipkan keputusan otomatis di gerbang izin yang sudah ada, memilih opsi berdasarkan `PermissionOptionKind`. Berpindah agen memakai ulang jalur tutup-lalu-sambung yang sudah terbukti bekerja. UI menaruh kontrolnya seadanya asal berfungsi — penataan visual adalah pekerjaan rencana 2b-3.

**Tech Stack:** Rust 1.97, Tauri 2.11, crate `agent-client-protocol` 2.0 (protokol V1), React + TypeScript, TanStack AI, shadcn.

## Global Constraints

- Aplikasi hidup di `app/`. **Jangan menyentuh `package.json` atau `package-lock.json` di root repo** — berisi perubahan tak ter-commit milik human partner, bersama `build-demo.js` dan `demo-registrasi.mjs` yang untracked.
- `midscene-mcp/` tidak boleh diubah.
- `~/.cargo/bin` tidak ada di PATH shell non-interaktif. Awali perintah cargo dengan `export PATH="$HOME/.cargo/bin:$PATH"`.
- Aplikasi adalah ACP **client**. Ia tidak pernah menyimpan, menyentuh, atau mem-proxy kredensial agen.
- Teks yang dilihat pengguna berbahasa **Indonesia**. Identifier kode dan pesan log berbahasa **Inggris**. Nama test boleh Indonesia.
- Gate wajib lulus: `cargo test`, `cargo clippy --all-targets -- -D warnings`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`.
- Setelah suite, `pgrep -fl "claude-agent-acp"` dan `pgrep -fl "midscene-mcp"` harus kosong.
- Jangan menjalankan `npm run tauri dev`, membuka jendela, atau mengirim prompt ke agen sungguhan. Verifikasi manual adalah tugas human partner.
- Stage hanya berkas di bawah `app/`. Jangan pernah `git add -A` atau `git add .`.
- Tiap task diakhiri commit.

## Fakta terverifikasi yang mengikat rencana ini

Diturunkan dari sumber crate pada 2026-08-05, bukan dari ingatan.

**`PermissionOptionKind`** (`agent-client-protocol-schema-1.5.0/src/v1/client.rs`) adalah
`#[non_exhaustive]` dengan varian `AllowOnce`, `AllowAlways`, `RejectOnce`, `RejectAlways`.
`PermissionOption` membawa `option_id`, `name` (label untuk manusia), dan `kind`.

**`session/cancel` adalah NOTIFIKASI, bukan request.** Tipenya `CancelNotification { session_id }`.
Tidak ada respons yang bisa ditunggu.

**`StopReason`** (`.../v1/agent.rs`) `#[non_exhaustive]` dengan `EndTurn`, `MaxTokens`,
`MaxTurnRequests`, `Refusal`, `Cancelled`. Dokumentasi skema menyatakan tegas bahwa
`Cancelled` **HARUS** dikembalikan `session/prompt` yang sedang berjalan ketika klien
mengirim `session/cancel`, bahkan bila pembatalan menimbulkan exception di operasi yang
mendasarinya.

**Konsekuensi yang menentukan desain:** giliran yang dibatalkan berakhir sebagai respons
normal, bukan galat. Jalur `Ok` di `send_prompt` yang memancarkan `RUN_FINISHED` sudah
benar apa adanya — jangan diubah jadi `RUN_ERROR`.

## Keadaan kode yang sudah ada

Perintah Tauri: `connect_agent(agentId)`, `send_prompt(text)`, `answer_permission(requestId, optionId)`.
Event Tauri: `agui`, `permission-request`, `agent-disconnected`.

Modul Rust: `agents.rs`, `sidecar.rs`, `commands.rs`, `acp/{mod,client,session,events,testing}.rs`.
Frontend: `src/App.tsx`, `src/components/{Chat,PermissionDialog}.tsx`,
`src/connection/tauri-acp-connection.ts`.

**Nama helper internal harus dibaca dari berkasnya, bukan ditebak.** Beberapa sempat
berganti nama selama 2a. Sebelum memodifikasi sebuah fungsi, baca berkasnya dan pakai
nama yang benar-benar ada. Rencana ini hanya menyebut nama yang sudah diverifikasi:
tipe crate di atas, perintah dan event Tauri di atas.

`FakeAgent` di `acp/testing.rs` bicara JSON-RPC mentah lewat transport `Lines` milik
crate. Semua test perilaku di rencana ini memakainya — bukan memanggil helper secara
langsung, karena itu tidak membuktikan handler benar-benar terdaftar.

### Kenapa sebagian langkah test tidak memuat kode literal

Task 1 dan 2 membuat berkas baru yang murni, jadi kode test-nya ditulis lengkap dan
harus disalin apa adanya.

Task 3 sampai 8 menyentuh berkas yang sudah ada, dan langkah test-nya menyebut
**perilaku yang harus dibuktikan** — bernomor, dengan hal yang diamati disebut jelas —
bukan kode literal. Itu keputusan sadar, bukan kelalaian.

Alasannya: menulis kode test literal untuk berkas-berkas itu berarti mengarang nama
helper internal yang tidak dibaca saat rencana ini disusun. Proyek ini sudah punya
**enam** kasus terdokumentasi di mana API yang ditulis dari ingatan ternyata salah —
lima soal crate `agent-client-protocol`, satu soal `StreamProcessor` TanStack yang
membuat setiap kata asisten dibuang diam-diam sementara 85 test tetap hijau.

Jadi: baca berkasnya, pakai nama dan helper yang benar-benar ada, tiru bentuk test
tetangganya, dan buktikan perilaku yang disebut. Bila sebuah perilaku ternyata tidak
bisa diuji dengan mesin yang ada, katakan di laporan — jangan melemahkan assertion-nya
supaya lulus.

---

### Task 1: Penyimpanan pengaturan

**Files:**
- Create: `app/src-tauri/src/settings.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `pub struct Settings { pub full_permissions: bool }` dengan `Default`,
  `pub fn load(dir: &Path) -> Settings`, `pub fn save(dir: &Path, s: &Settings) -> std::io::Result<()>`.

- [ ] **Step 1: Tulis test yang gagal**

Buat `app/src-tauri/src/settings.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn dir_sementara() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "midscene-settings-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn default_mematikan_full_permissions() {
        assert!(!Settings::default().full_permissions);
    }

    #[test]
    fn direktori_kosong_menghasilkan_default() {
        let d = dir_sementara();
        assert!(!load(&d).full_permissions);
    }

    #[test]
    fn simpan_lalu_muat_mengembalikan_nilai_yang_sama() {
        let d = dir_sementara();
        save(&d, &Settings { full_permissions: true }).unwrap();
        assert!(load(&d).full_permissions);
    }

    #[test]
    fn berkas_rusak_jatuh_ke_default_bukan_panik() {
        let d = dir_sementara();
        std::fs::write(d.join("settings.json"), "{ bukan json").unwrap();
        assert!(!load(&d).full_permissions);
    }

    #[test]
    fn save_membuat_direktori_yang_belum_ada() {
        let d = dir_sementara().join("belum").join("ada");
        save(&d, &Settings { full_permissions: true }).unwrap();
        assert!(load(&d).full_permissions);
    }
}
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test settings 2>&1 | tail -20
```

Expected: gagal kompilasi — `Settings`, `load`, `save` belum ada. Bila melaporkan
"0 tests" alih-alih gagal kompilasi, modulnya belum terdaftar — kerjakan Step 4 lebih
dulu, lalu ulangi.

- [ ] **Step 3: Tulis implementasi**

Sisipkan di atas blok `mod tests`:

```rust
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Persisted user preferences.
///
/// Deliberately tiny and forgiving: a corrupt or missing file falls back to
/// defaults rather than failing startup. A settings file is never worth
/// blocking the app over.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Auto-approve permission requests without asking. Persists across launches,
    /// which is why the UI must show it at all times.
    pub full_permissions: bool,
}

const FILE_NAME: &str = "settings.json";

pub fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(dir.join(FILE_NAME))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, settings: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(dir.join(FILE_NAME), raw)
}
```

- [ ] **Step 4: Daftarkan modul**

Tambahkan `pub mod settings;` di `app/src-tauri/src/lib.rs`, di antara deklarasi modul
yang sudah ada. Jangan mengganti isi berkas.

- [ ] **Step 5: Jalankan gate**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test settings 2>&1 | tail -10
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5
```

Expected: 5 test lulus, clippy bersih.

- [ ] **Step 6: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src-tauri/src/settings.rs app/src-tauri/src/lib.rs
git commit -m "feat(app): penyimpanan pengaturan yang toleran terhadap berkas rusak"
```

---

### Task 2: Keputusan otomatis di gerbang izin

**Files:**
- Create: `app/src-tauri/src/acp/auto_permission.rs`
- Modify: `app/src-tauri/src/acp/mod.rs`

**Interfaces:**
- Produces: `pub fn pick_allow(options: &[PermissionOption]) -> Option<PermissionOptionId>`

Fungsi murni, dipisahkan dari gerbang supaya bisa diuji tanpa agen. Task 3 yang
menyambungkannya.

- [ ] **Step 1: Tulis test yang gagal**

Buat `app/src-tauri/src/acp/auto_permission.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        PermissionOption, PermissionOptionId, PermissionOptionKind,
    };

    fn opsi(id: &str, kind: PermissionOptionKind) -> PermissionOption {
        PermissionOption::new(PermissionOptionId(id.into()), id.to_string(), kind)
    }

    #[test]
    fn memilih_allow_once_bila_tersedia() {
        let daftar = vec![
            opsi("tolak", PermissionOptionKind::RejectOnce),
            opsi("izinkan", PermissionOptionKind::AllowOnce),
        ];
        assert_eq!(pick_allow(&daftar).unwrap().0.as_ref(), "izinkan");
    }

    #[test]
    fn memilih_allow_always_bila_itu_satu_satunya_izin() {
        let daftar = vec![
            opsi("tolak", PermissionOptionKind::RejectAlways),
            opsi("selalu", PermissionOptionKind::AllowAlways),
        ];
        assert_eq!(pick_allow(&daftar).unwrap().0.as_ref(), "selalu");
    }

    #[test]
    fn allow_once_didahulukan_atas_allow_always() {
        let daftar = vec![
            opsi("selalu", PermissionOptionKind::AllowAlways),
            opsi("sekali", PermissionOptionKind::AllowOnce),
        ];
        assert_eq!(pick_allow(&daftar).unwrap().0.as_ref(), "sekali");
    }

    #[test]
    fn tanpa_opsi_izin_mengembalikan_none() {
        let daftar = vec![
            opsi("tolak", PermissionOptionKind::RejectOnce),
            opsi("tolak-selalu", PermissionOptionKind::RejectAlways),
        ];
        assert!(pick_allow(&daftar).is_none());
    }

    #[test]
    fn daftar_kosong_mengembalikan_none() {
        assert!(pick_allow(&[]).is_none());
    }
}
```

Bila `PermissionOption::new` menuntut argumen dengan urutan atau tipe berbeda, baca
sumber crate dan sesuaikan pembangun `opsi()` — jangan mengubah maksud test-nya.

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test auto_permission 2>&1 | tail -20
```

Expected: gagal kompilasi — `pick_allow` belum ada.

- [ ] **Step 3: Tulis implementasi**

```rust
use agent_client_protocol::schema::v1::{
    PermissionOption, PermissionOptionId, PermissionOptionKind,
};

/// Choose an option that genuinely means "allow", for full-permissions mode.
///
/// Returns `None` when the agent offered nothing that clearly allows. The caller
/// MUST fall back to asking the user in that case. Approving something that is not
/// an approval is worse than asking — and `PermissionOptionKind` is
/// `#[non_exhaustive]`, so unknown kinds must never be treated as consent.
///
/// `AllowOnce` wins over `AllowAlways`: this mode is already a standing decision
/// by the user, so it should not additionally teach the agent to remember consent
/// on its own side.
pub fn pick_allow(options: &[PermissionOption]) -> Option<PermissionOptionId> {
    let by_kind = |wanted: PermissionOptionKind| {
        options
            .iter()
            .find(|o| o.kind == wanted)
            .map(|o| o.option_id.clone())
    };
    by_kind(PermissionOptionKind::AllowOnce).or_else(|| by_kind(PermissionOptionKind::AllowAlways))
}
```

Bila `PermissionOptionKind` tidak mengimplementasikan `PartialEq`, pakai `matches!`
alih-alih `==`, dan catat itu di laporan.

- [ ] **Step 4: Daftarkan modul**

Tambahkan `pub mod auto_permission;` di `app/src-tauri/src/acp/mod.rs`, sejajar dengan
deklarasi modul yang sudah ada di sana.

- [ ] **Step 5: Jalankan gate**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test auto_permission 2>&1 | tail -10
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5
```

Expected: 5 test lulus, clippy bersih.

- [ ] **Step 6: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src-tauri/src/acp/auto_permission.rs app/src-tauri/src/acp/mod.rs
git commit -m "feat(app): pemilih opsi izin untuk mode izin penuh"
```

---

### Task 3: Sambungkan mode izin penuh ke gerbang

**Files:**
- Modify: `app/src-tauri/src/acp/client.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `settings::{Settings, load, save}` (Task 1), `acp::auto_permission::pick_allow` (Task 2)
- Produces: perintah Tauri `get_full_permissions() -> bool` dan
  `set_full_permissions(enabled: bool) -> Result<(), String>`

- [ ] **Step 1: Baca gerbang izin yang sudah ada**

Buka `app/src-tauri/src/acp/client.rs` dan temukan fungsi yang menangani
`session/request_permission`. Catat di laporan: nama fungsinya, bagaimana ia mengakses
opsi yang ditawarkan agen, dan di titik mana ia memancarkan event `permission-request`.
Kamu akan menyisipkan keputusan otomatis **sebelum** titik itu.

- [ ] **Step 2: Tulis test yang gagal**

Tambahkan ke blok test di `client.rs`, memakai `FakeAgent` seperti test gerbang yang
sudah ada di sana. Tiru bentuk test dispatch izin yang sudah ada — baca dulu, lalu tulis
yang setara untuk tiga perilaku ini:

1. Dengan mode izin penuh menyala dan agen menawarkan opsi `AllowOnce`, permintaan
   dijawab dengan `option_id` opsi itu, dan **tidak ada** event `permission-request`
   yang dipancarkan.
2. Dengan mode menyala tetapi agen hanya menawarkan opsi penolakan, event
   `permission-request` **tetap** dipancarkan — jatuh ke bertanya.
3. Dengan mode mati, perilakunya persis seperti sekarang: event dipancarkan.

Assert atas hasil yang teramati — balasan yang benar-benar dikirim ke agen dan event
yang benar-benar sampai ke sink — bukan atas keadaan internal.

- [ ] **Step 3: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test client 2>&1 | tail -20
```

Expected: gagal — mode izin penuh belum ada.

- [ ] **Step 4: Tambahkan flag ke konteks klien**

Simpan flag sebagai `AtomicBool` di struktur konteks klien yang sudah ada, dengan
pembaca dan penulis. `AtomicBool` dipilih karena konteks itu dipakai lintas thread dan
flag-nya bisa berubah saat sesi berjalan.

- [ ] **Step 5: Sisipkan keputusan otomatis di gerbang**

Sebelum memancarkan `permission-request`: bila flag menyala, panggil `pick_allow` atas
opsi yang ditawarkan agen. Bila mengembalikan `Some`, balas langsung dan kembali. Bila
`None`, teruskan ke jalur bertanya yang sudah ada.

Jangan menyentuh jalur timeout, pembersihan peta, maupun validasi `option_id` yang sudah
ada — semuanya sudah diuji dan tidak berubah.

- [ ] **Step 6: Tambahkan perintah Tauri**

Di `commands.rs`:

```rust
#[tauri::command]
pub fn get_full_permissions(state: tauri::State<'_, AppState>) -> bool {
    // Read from the client context flag.
}

#[tauri::command]
pub fn set_full_permissions(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    // Set the flag, then persist via settings::save into the app config dir.
    // A failed write must surface as an Err, not be swallowed — the user chose
    // persistence, so silently forgetting it is a lie.
}
```

Isi badannya sesuai bentuk `AppState` yang sebenarnya. Untuk direktori config, pakai
`app.path().app_config_dir()`; bila API-nya berbeda di Tauri 2.11, baca dan sesuaikan.

Daftarkan keduanya di `invoke_handler` pada `lib.rs`, di samping perintah yang sudah ada.

- [ ] **Step 7: Muat pengaturan saat start**

Saat aplikasi dibangun, panggil `settings::load` dan pakai hasilnya sebagai nilai awal
flag. Pengaturan yang tersimpan harus berlaku sebelum sesi pertama dibuat.

- [ ] **Step 8: Jalankan gate**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test 2>&1 | tail -10
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5
pgrep -fl "claude-agent-acp|midscene-mcp" | head; echo "(kosong = bersih)"
```

- [ ] **Step 9: Buktikan lewat mutasi**

Hapus panggilan `pick_allow` dari gerbang sehingga mode izin penuh tidak berpengaruh.
Jalankan `cargo test` dan pastikan test perilaku 1 gagal. Pulihkan berkasnya
byte-identik dan verifikasi dengan checksum. Catat hasilnya di laporan.

- [ ] **Step 10: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src-tauri/src
git commit -m "feat(app): mode izin penuh yang tersimpan, dengan jatuh ke bertanya"
```

---

### Task 4: Perintah pembatalan giliran

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: perintah Tauri `cancel_turn() -> Result<(), String>`

- [ ] **Step 1: Turunkan cara mengirim notifikasi dari sumber**

`session/cancel` adalah **notifikasi**, bukan request — tipenya `CancelNotification { session_id }`.
Baca crate untuk menemukan cara mengirim notifikasi lewat `ConnectionTo<Agent>`; ia
berbeda dari `send_request` yang dipakai `new_session`. Catat tanda tangan sebenarnya di
laporan sebelum menulis kode.

- [ ] **Step 2: Tulis test yang gagal**

Tambahkan test di `commands.rs` memakai `FakeAgent`, mengikuti bentuk test giliran yang
sudah ada di sana:

1. Agen palsu menerima `session/prompt` dan **tidak pernah menjawabnya**.
2. Panggil jalur pembatalan.
3. Assert bahwa agen benar-benar menerima notifikasi `session/cancel` dengan
   `session_id` yang benar.
4. Lalu agen palsu menjawab prompt dengan `StopReason::Cancelled`, dan assert bahwa
   `RUN_FINISHED` sampai ke sink — **bukan** `RUN_ERROR`.

Butir 4 penting: skema menyatakan giliran yang dibatalkan berakhir sebagai respons
normal. Bila kode memperlakukannya sebagai galat, UI akan menampilkan galat untuk
sesuatu yang diminta pengguna sendiri.

Seperti `send_prompt`, badan giliran harus bisa diuji tanpa `State` — pakai ulang
pemisahan yang sudah ada di sana. Bila perlu memisahkan badan pembatalan dengan cara
yang sama, lakukan dan catat.

- [ ] **Step 3: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test commands 2>&1 | tail -20
```

- [ ] **Step 4: Tulis implementasi**

`cancel_turn` mengambil `session_id` dan koneksi lewat mekanisme yang sama seperti
`send_prompt` — yang mengembalikan nilai ter-owned dan **tidak** memegang lock sesi
selama menunggu. Jangan memegang lock: itu justru perbaikan yang memungkinkan
pembatalan bekerja saat giliran berjalan.

Karena ini notifikasi, tidak ada respons yang ditunggu. Kirim lalu kembali. Giliran
berakhir ketika agen menjawab prompt yang tertunda dengan `Cancelled`.

Bila tidak ada sesi aktif, kembalikan pesan Indonesia yang jelas, bukan panik.

Daftarkan di `invoke_handler`.

- [ ] **Step 5: Jalankan gate**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test 2>&1 | tail -10
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5
pgrep -fl "claude-agent-acp|midscene-mcp" | head; echo "(kosong = bersih)"
```

- [ ] **Step 6: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src-tauri/src
git commit -m "feat(app): perintah pembatalan giliran lewat session/cancel"
```

---

### Task 5: Tombol stop di UI

**Files:**
- Modify: `app/src/components/Chat.tsx`

**Interfaces:**
- Consumes: perintah Tauri `cancel_turn` (Task 4)

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan ke berkas test komponen. Bila belum ada `jsdom` dan `@testing-library/react`
di `app/`, pasang keduanya sebagai devDependency `app/` dan konfigurasikan vitest untuk
memakai environment jsdom — catat itu sebagai deviasi.

Test yang dibutuhkan:

1. Saat tidak ada giliran berjalan, tombol stop tidak ditampilkan.
2. Saat giliran berjalan, tombol stop muncul dan tombol kirim tidak bisa ditekan.
3. Menekan stop memanggil `invoke('cancel_turn')` tepat satu kali.
4. Bila `cancel_turn` menolak, pesan galat Indonesia ditampilkan dan tombol stop
   kembali bisa ditekan — bukan mati permanen.

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app
npx vitest run 2>&1 | tail -15
```

- [ ] **Step 3: Tulis implementasi**

Tombol stop menggantikan tombol kirim selama giliran berjalan, memakai keadaan "sedang
mengirim" yang sudah ada di komponen. Labelnya `"Hentikan"`.

Karena UI sendiri yang meminta pembatalan, ia boleh menandai giliran itu sebagai
dihentikan secara lokal. **Jangan menyisipkan teks palsu seolah-olah agen yang
mengatakannya** — pakai penanda milik UI sendiri.

Penempatan visualnya seadanya asal berfungsi dan terjangkau keyboard; penataan adalah
pekerjaan rencana 2b-3.

- [ ] **Step 4: Jalankan gate**

```bash
cd /Users/rulisme/midtest/app
npx vitest run 2>&1 | tail -10
npx tsc --noEmit && echo "tsc bersih"
npm run build 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src app/package.json app/package-lock.json
git commit -m "feat(app): tombol hentikan giliran"
```

---

### Task 6: Deteksi biner dan pesan galat yang tepat

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src/App.tsx`

**Interfaces:**
- Consumes: `agents::probe` (sudah ada, belum pernah dipanggil)

Menutup residu yang tercatat: `probe()` ada tapi tidak dipakai, sehingga biner yang
hilang muncul sebagai galat protokol yang menyesatkan, dan `App.tsx` menambal itu dengan
menduplikasi nama biner dari `agents.rs`.

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan test di `commands.rs`:

1. Menyambung ke id agen yang tidak dikenal mengembalikan pesan yang menyebut id itu.
2. Menyambung ketika biner tidak dapat ditemukan mengembalikan pesan yang menyebut
   **nama biner**, dan pesan itu **berbeda** dari pesan galat protokol.

Untuk butir 2, suntikkan pencari path lewat parameter — `agents::probe` sudah menerima
closure pencari justru untuk ini.

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test commands 2>&1 | tail -20
```

- [ ] **Step 3: Panggil probe sebelum menyambung**

Di jalur `connect_agent`, sebelum men-spawn adapter: jalankan `probe` dengan pencari
PATH sungguhan. Bila biner tidak ada, kembalikan galat Indonesia yang menyebut nama
biner dan cara memasangnya, tanpa pernah men-spawn apa pun.

- [ ] **Step 4: Hapus duplikasi nama biner di frontend**

`App.tsx` saat ini menyimpan salinan hardcoded nama biner dan menempelkannya ke pesan
galat. Karena Rust kini menghasilkan pesan yang lengkap, hapus salinan itu dan tampilkan
pesan dari Rust apa adanya. Satu sumber kebenaran, di `agents.rs`.

- [ ] **Step 5: Jalankan gate**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test 2>&1 | tail -10
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5
cd /Users/rulisme/midtest/app && npx tsc --noEmit && npx vitest run 2>&1 | tail -6
```

- [ ] **Step 6: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src-tauri/src app/src
git commit -m "feat(app): deteksi biner agen sebelum menyambung"
```

---

### Task 7: Berpindah agen

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src/App.tsx`

**Interfaces:**
- Consumes: `connect_agent` dan jalur penutupan sesi yang sudah ada

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan test di `commands.rs`:

1. Menyambung ke agen kedua ketika satu sesi sudah berjalan akan **menutup yang lama**
   sebelum membuka yang baru — assert bahwa penutupan benar-benar terjadi.
2. Setelah berpindah, tidak ada proses yang tertinggal.

Jalur penutupan sudah terbukti bekerja pada giliran yang tersangkut; test ini memastikan
perpindahan agen memakai jalur yang sama, bukan jalur baru yang belum teruji.

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test commands 2>&1 | tail -20
```

- [ ] **Step 3: Pastikan connect_agent menutup sesi lama**

Baca `connect_agent`. Bila ia sudah menutup sesi yang ada sebelum menyambung, test akan
lulus tanpa perubahan — catat itu dan lanjut. Bila belum, tambahkan.

- [ ] **Step 4: Petakan kegagalan Codex ke pesan yang berguna**

Ketika agen yang dipilih adalah `codex` dan pembuatan sesi gagal, tampilkan pesan
Indonesia yang menyebut `codex login` sebagai langkah yang harus dilakukan pengguna.

**Berbasis perilaku, bukan tebakan atas `authMethods`:** saat handshake Tahap 0, Codex
mengembalikan dua metode auth padahal belum login, dan tidak diketahui apakah isinya
kosong setelah login. Jadi jangan menyimpulkan dari `authMethods`. Coba buat sesi;
petakan kegagalannya. Membuat sesi tidak memanggil model, jadi percobaan ini tidak
berbiaya.

Aplikasi tidak pernah menyentuh kredensial — itu prinsip yang menopang argumen
kepatuhan ToS di spec.

- [ ] **Step 5: Tambahkan pemilih agen di UI**

Di `App.tsx`, tampilkan dua pilihan agen dari registry. Memilih salah satu memanggil
`invoke('connect_agent', { agentId })`. Selama berpindah, tampilkan keadaan
menyambung, dan tampilkan galat bila gagal.

Jangan menampilkan pemilih sebagai sesuatu yang berubah diam-diam: pengguna harus
melihat agen mana yang aktif sekarang.

Penempatan visual seadanya; penataan adalah pekerjaan 2b-3.

- [ ] **Step 6: Jalankan gate lengkap**

```bash
cd /Users/rulisme/midtest/app/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
cargo test 2>&1 | tail -10
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5
cd /Users/rulisme/midtest/app
npx tsc --noEmit && echo "tsc bersih"
npx vitest run 2>&1 | tail -6
npm run build 2>&1 | tail -3
pgrep -fl "claude-agent-acp|codex-acp|midscene-mcp" | head; echo "(kosong = bersih)"
```

- [ ] **Step 7: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src-tauri/src app/src
git commit -m "feat(app): pemilih agen Codex dan Claude"
```

---

### Task 8: Toggle izin penuh di UI

**Files:**
- Modify: `app/src/App.tsx`

**Interfaces:**
- Consumes: perintah `get_full_permissions` dan `set_full_permissions` (Task 3)

- [ ] **Step 1: Tulis test yang gagal**

1. Saat mount, `get_full_permissions` dipanggil dan keadaannya tercermin di UI.
2. Menekan toggle memanggil `set_full_permissions` dengan nilai kebalikannya.
3. Bila `set_full_permissions` menolak, keadaan UI **kembali** ke nilai sebelumnya dan
   galat ditampilkan — jangan menampilkan mati padahal masih menyala di disk.
4. Saat menyala, indikatornya terlihat tanpa membuka menu apa pun.

Butir 4 mengikat sejak sekarang, bukan menunggu 2b-3: pengaturan ini bertahan lintas
peluncuran, jadi pengguna tidak boleh membuka aplikasi besok dalam keadaan menyetujui
segalanya tanpa sadar.

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd /Users/rulisme/midtest/app
npx vitest run 2>&1 | tail -15
```

- [ ] **Step 3: Tulis implementasi**

Toggle dengan label Indonesia `"Izin penuh"`, dan keterangan singkat bahwa permintaan
izin akan disetujui otomatis. Saat menyala, tampilkan penanda yang selalu terlihat.

- [ ] **Step 4: Jalankan gate**

```bash
cd /Users/rulisme/midtest/app
npx vitest run 2>&1 | tail -10
npx tsc --noEmit && echo "tsc bersih"
npm run build 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
cd /Users/rulisme/midtest
git add app/src
git commit -m "feat(app): toggle izin penuh yang selalu terlihat"
```

---

### Task 9: Verifikasi manual

Dijalankan **oleh human partner**. Memakai langganan dan membuka jendela.

**Files:**
- Create: `docs/superpowers/notes/2026-08-05-e2e-2b1.md`

- [ ] **Step 1: Jalankan aplikasi**

```
! cd /Users/rulisme/midtest/app && export PATH="$HOME/.cargo/bin:$PATH" && npm run tauri dev
```

- [ ] **Step 2: Periksa daftar berikut dan catat hasilnya apa adanya**

1. Pemilih agen menampilkan Claude dan Codex, dan agen yang aktif terlihat jelas.
2. Beralih ke Codex: bila belum `codex login`, pesan galatnya menyebut perintah itu.
3. Kembali ke Claude dan pastikan tersambung lagi.
4. Dengan izin penuh **mati**: kirim prompt yang memanggil tool Midscene — dialog izin
   muncul dan menyebut nama tool. Ini menutup butir Task 9 rencana 2a yang belum teruji.
5. Nyalakan izin penuh. Kirim prompt serupa — tidak ada dialog, tool langsung jalan,
   dan penanda izin penuh terlihat sepanjang waktu.
6. Tutup aplikasi, buka lagi: izin penuh **masih menyala**.
7. Kirim prompt panjang lalu tekan **Hentikan** — giliran berhenti, spinner berhenti,
   dan tidak ada galat yang ditampilkan seolah ada yang rusak.
8. Tutup jendela, lalu `pgrep -fl "claude-agent-acp|codex-acp|midscene-mcp|chrome"` —
   harus kosong.

- [ ] **Step 3: Tulis catatan hasil dan commit**

Rekam tiap butir beserta hasilnya, termasuk yang gagal atau tidak sempat diuji.

```bash
cd /Users/rulisme/midtest
git add docs/superpowers/notes/2026-08-05-e2e-2b1.md
git commit -m "docs: hasil verifikasi manual rencana 2b-1"
```

---

## Yang tidak termasuk rencana ini

- Panel artefak, daftar skenario, daftar dan kelanjutan sesi — rencana 2b-2
- Render markdown, tipografi, tata letak, mode gelap-terang — rencana 2b-3
- Emisi `TOOL_CALL_RESULT` — rencana 2b-3, bersama tampilan tool call
- Handler defensif `fs/*` dan `terminal/*`, hook keluar `AppState::close` —
  tercatat di `2026-08-04-residu-tauri-acp.md`
