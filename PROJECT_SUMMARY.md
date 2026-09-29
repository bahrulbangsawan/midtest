# Ringkasan Proyek MidTest

> Snapshot implementasi: 15 Agustus 2026. Dokumen ini merangkum source code
> pada working tree saat ini. Dokumen di `docs/superpowers/` tetap berguna untuk
> sejarah desain, tetapi tidak semuanya sudah diimplementasikan.

## Gambaran singkat

MidTest adalah aplikasi desktop berbasis Tauri yang menyediakan
antarmuka chat untuk mengarahkan agen Codex atau Claude. Agen tersebut bekerja
di workspace yang dipilih pengguna dan dapat memakai server MCP Midscene untuk
mengoperasikan antarmuka web atau desktop dengan instruksi bahasa natural.

Tujuan utama proyek ini adalah menghasilkan dua artefak:

1. skenario QA berbentuk YAML yang dapat diputar ulang; dan
2. walkthrough HTML berbahasa Indonesia yang dapat dipakai sebagai panduan atau
   demo produk.

Proyek memisahkan dua jenis kecerdasan buatan:

- **Agen ACP (Codex/Claude)** merencanakan pekerjaan, berkomunikasi dengan
  pengguna, dan memanggil tool.
- **Model vision-language Midscene (VLM)** membaca screenshot dan menentukan
  elemen/koordinat UI. Model ini memakai API key tersendiri di `.env` dan tidak
  tercakup oleh langganan agen.

## Arsitektur

```text
Pengguna
   │
   ▼
React + TanStack AI (`app/src`)
   │  invoke command / menerima event Tauri
   ▼
Backend Tauri Rust (`app/src-tauri/src`)
   │  menjalankan adapter ACP melalui stdio
   ▼
Codex ACP atau Claude ACP
   │  menerima server MCP saat `session/new`
   ▼
Midscene MCP (`midscene-mcp/src`)
   ├── target web: Puppeteer + Chrome
   ├── target computer: kontrol desktop macOS
   ├── skenario YAML + cache
   └── report Midscene → `build-demo.js` → walkthrough HTML
```

Alur balasan chat bergerak ke arah sebaliknya: notifikasi ACP diterjemahkan
oleh backend Rust menjadi event AG-UI, dikirim melalui event Tauri `agui`, lalu
diproses oleh TanStack AI untuk menampilkan teks, reasoning, dan tool call.

## Komponen utama

| Komponen | Teknologi | Tanggung jawab |
|---|---|---|
| Aplikasi frontend | React 19, TypeScript, Vite, Tailwind CSS, TanStack AI | Chat, workspace/thread, pemilih provider/model, pengaturan, status koneksi, dan dialog izin |
| Backend desktop | Tauri 2, Rust, Tokio | Lifecycle proses ACP, sesi, command Tauri, event AG-UI, izin, pembatalan giliran, dan penyimpanan settings |
| Bridge ACP | `agent-client-protocol` | Menjalankan adapter Codex/Claude dan menjembatani prompt, notifikasi, tool call, model, serta permission request |
| Sidecar MCP | Node.js/TypeScript, MCP SDK | Mengekspos tool eksplorasi, skenario, replay, screenshot, dan walkthrough |
| Adapter otomasi | Midscene, Puppeteer | Mengoperasikan browser atau desktop, membuat report, dan menggunakan cache |
| Generator walkthrough | Node.js (`build-demo.js`) | Mengekstrak langkah/screenshot dari report Midscene dan membuat HTML mandiri berbahasa Indonesia |

## Fitur yang sudah tersedia

### Aplikasi desktop

- Chat streaming dengan Codex atau Claude melalui adapter ACP eksternal.
- Pemilihan folder workspace; folder tersebut menjadi `cwd` sesi ACP.
- Daftar workspace dan metadata thread lokal: buat, pilih, ubah nama, dan
  hapus thread.
- Pemilihan model secara dinamis bila adapter ACP mengekspos konfigurasi model.
- Render Markdown, blok reasoning, dan indikator tool call.
- Tombol **Stop** yang mengirim `session/cancel` tanpa mematikan seluruh sesi.
- Dialog permission request dengan antrean dan timeout dua menit.
- Mode **Full access** yang menyetujui permission request secara otomatis dan
  disimpan lintas peluncuran.
- Pengaturan provider default, model terakhir per provider, kepadatan UI, dan
  keadaan sidebar.
- Deteksi adapter ACP yang hilang serta pesan instalasi yang dapat ditindaklanjuti.

### Server MCP Midscene

Server menyediakan sepuluh tool:

| Tool | Fungsi |
|---|---|
| `start_session` | Membuka satu sesi target `web` atau `computer` |
| `act` | Melakukan aksi UI dari instruksi natural |
| `query` | Mengambil data terstruktur dari layar |
| `assert` | Memverifikasi kondisi layar |
| `screenshot` | Mengambil screenshot tanpa memakai budget operasi AI |
| `end_session` | Menutup sesi dan melepas browser/desktop |
| `save_scenario` | Menyimpan skenario YAML yang dapat dipakai ulang |
| `list_scenarios` | Menampilkan skenario yang tersimpan |
| `run_scenario` | Memutar ulang skenario dengan cache dan penjaga budget |
| `build_walkthrough` | Mengubah report menjadi walkthrough HTML Indonesia |

Aturan penting server:

- Hanya satu sesi otomasi dapat aktif pada satu waktu.
- Budget default adalah 40 operasi berbasis AI per sesi. `act`, `query`, dan
  `assert` memakai budget; `screenshot` tidak.
- Replay memesan budget berdasarkan jumlah langkah sebelum browser dibuka.
- URL web harus absolut dan memakai skema `http`, `https`, atau `file`.
- `runGherkinScenario` ditolak karena jumlah operasi dan biayanya tidak dapat
  dibatasi sebelum eksekusi.
- Cache modern diaktifkan oleh adapter dengan ID stabil; `MIDSCENE_CACHE=1`
  masih diterima untuk kompatibilitas, tetapi bukan syarat agar cache aktif.

## Alur penggunaan utama

1. Pengguna membuka workspace dan memilih Codex atau Claude.
2. Backend memeriksa adapter ACP, menjalankannya, lalu melakukan handshake
   `initialize`.
3. Backend membuat sesi ACP dan mendaftarkan `midscene-mcp` sebagai MCP server
   stdio untuk sesi tersebut.
4. Pengguna meminta agen mengeksplorasi sebuah alur UI.
5. Agen memakai `start_session`, `act`, `query`, `assert`, dan `screenshot`.
6. Setelah alur terbukti, agen menyimpannya dengan `save_scenario`.
7. Skenario dapat diputar ulang dengan `run_scenario`; cache mengurangi
   panggilan VLM yang sebenarnya.
8. Report hasil run dapat diubah menjadi walkthrough mandiri melalui
   `build_walkthrough` atau langsung dengan `build-demo.js`.

## Prasyarat

- macOS untuk target otomasi desktop saat ini.
- Node.js **>= 24**; server MCP menjalankan file `.ts` langsung dengan type
  stripping bawaan Node.
- Rust toolchain dan prasyarat sistem Tauri 2.
- Google Chrome untuk target web.
- API key VLM yang didukung Midscene.
- Minimal satu adapter ACP:
  - `@agentclientprotocol/claude-agent-acp`, atau
  - `@agentclientprotocol/codex-acp`.
- CLI/vendor account terkait sudah login. Khusus Codex, aplikasi mengarahkan
  pengguna untuk menjalankan `codex login` bila pembuatan sesi gagal.

## Setup pengembangan

### 1. Konfigurasi model Midscene

```bash
cp .env.example .env
```

Isi minimal variabel `MIDSCENE_MODEL_*` di `.env`. Jangan commit `.env` karena
berisi kredensial.

| Variabel | Kegunaan |
|---|---|
| `MIDSCENE_MODEL_BASE_URL` | Endpoint provider VLM |
| `MIDSCENE_MODEL_API_KEY` | API key VLM |
| `MIDSCENE_MODEL_NAME` | Nama model provider |
| `MIDSCENE_MODEL_FAMILY` | Family model yang dikenali Midscene |
| `PUPPETEER_EXECUTABLE_PATH` | Lokasi binary Chrome |
| `MIDSCENE_MCP_BUDGET` | Batas operasi AI per sesi; default `40` |
| `MIDSCENE_CACHE` | Flag cache lama/kompatibilitas |
| `MIDSCENE_MCP_ROOT` | Root kode MCP untuk entry point dan `build-demo.js`; biasanya diinjeksi oleh client MCP |
| `MIDSCENE_MCP_DATA_DIR` | Root writable untuk `scenarios/`; aplikasi desktop menginjeksi Application Support saat dibundel |
| `MIDTEST_ROOT` | Override root source yang dipakai backend Tauri |

Daftar family model dan penjelasan konfigurasi lengkap ada di
[`midscene-mcp/README.md`](midscene-mcp/README.md).

### 2. Instal dependensi

Root dan aplikasi Tauri memakai instalasi npm yang terpisah:

```bash
# Root + workspace midscene-mcp
npm install

# Frontend Tauri
npm install --prefix app
```

`midscene-mcp` adalah anggota npm workspace root dan memakai
`package-lock.json` di root. Folder `app` bukan anggota workspace tersebut dan
memiliki `app/package-lock.json` sendiri.

### 3. Instal adapter agen

Pilih minimal satu:

```bash
npm install -g @agentclientprotocol/claude-agent-acp
npm install -g @agentclientprotocol/codex-acp
```

### 4. Jalankan aplikasi

```bash
npm --prefix app run tauri -- dev
```

Dalam mode pengembangan, backend menurunkan root repo dari
`app/src-tauri`. Variabel `MIDTEST_ROOT` dapat dipakai untuk menimpa
lokasi tersebut. Build terpaket membawa entry point `midscene-mcp`,
dependency Node yang dikunci, dan `build-demo.js` di dalam resource aplikasi;
data skenario disimpan di Application Support, bukan di bundle. Node.js >=24
dan adapter ACP tetap merupakan prasyarat mesin host. Konfigurasi model dapat
berasal dari Settings atau `.env` opsional pada root source yang dipilih.

## Perintah pengembangan dan verifikasi

```bash
# MCP
npm test --prefix midscene-mcp
npm run typecheck --prefix midscene-mcp

# Frontend
npm test --prefix app
npm run typecheck --prefix app
npm run build --prefix app

# Backend Tauri
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings
```

`npm test` dan `npm run typecheck` di root adalah agregator untuk suite MCP dan
frontend. Verifikasi Rust tetap dijalankan dengan perintah Cargo di atas.

Untuk menjalankan server MCP secara mandiri dari client MCP lain, gunakan
konfigurasi stdio dan `--env-file` yang dicontohkan di
[`midscene-mcp/README.md`](midscene-mcp/README.md).

## Data lokal dan artefak

| Lokasi | Isi | Status Git |
|---|---|---|
| `.env` | Kredensial dan konfigurasi model | Diabaikan |
| Tauri `app_config_dir/settings.json` | Workspace, thread, provider/model, sidebar, skala UI, dan full permissions | Di luar repo |
| `scenarios/` | Skenario YAML hasil `save_scenario` | Diabaikan |
| `midscene_run/cache/` | Cache Midscene | Diabaikan |
| `midscene_run/report/` | Report HTML dan walkthrough `.demo.html` | Diabaikan |
| `midscene_run/output/` dan `midscene_run/log/` | Output/log runtime Midscene | Diabaikan |

Output `midscene_run/` bersifat relatif terhadap working directory proses
Midscene. Ketika sesi memakai workspace lain, periksa path report yang
dikembalikan tool karena artefaknya dapat berada di workspace tersebut.
Skenario tersimpan memakai root source saat development dan Application
Support MidTest saat aplikasi dibundel.

## Batasan implementasi saat ini

- Entri thread yang disimpan hanya berisi ID dan judul. Isi chat masih hidup
  di state frontend dan belum dipersistenkan atau di-resume dari sesi ACP lama.
  Memilih thread/workspace membuat sesi ACP baru.
- Aplikasi belum menyediakan panel khusus untuk mendaftar atau membuka report,
  walkthrough, dan skenario. Gunakan path hasil tool atau buka folder output
  secara manual.
- Runtime MCP dibundel, tetapi executable Node.js >=24 dan adapter ACP masih
  harus tersedia pada mesin host.
- Target `computer` diimplementasikan untuk desktop macOS; target web membuka
  Chrome non-headless.
- File di `docs/superpowers/` adalah catatan desain/rencana historis; statusnya
  perlu selalu dicocokkan dengan source code.

## Peta direktori

```text
midtest/
├── app/                    # aplikasi desktop React + Tauri
│   ├── src/                # UI, state aplikasi, dan bridge event AG-UI
│   └── src-tauri/          # backend Rust, ACP, settings, dan sidecar config
├── midscene-mcp/           # server MCP standalone
│   ├── src/                # server, session, tool, scenario, dan adapter device
│   └── test/               # unit/integration test dengan device palsu
├── scripts/                # skrip utilitas/rekaman melalui MCP
├── docs/superpowers/       # desain, rencana implementasi, dan catatan E2E
├── build-demo.js           # generator walkthrough HTML
├── demo-registrasi.mjs     # demo browser Midscene langsung
├── example.ts              # demo kontrol desktop Midscene langsung
├── .env.example            # template konfigurasi VLM/Chrome/budget
└── package.json            # root package + npm workspace midscene-mcp
```

## Indeks file terkait

### Orientasi dan konfigurasi

| File | Peran |
|---|---|
| [`package.json`](package.json) | Dependensi root, script playground/example, dan deklarasi workspace |
| [`app/package.json`](app/package.json) | Script frontend/Tauri dan dependensi UI |
| [`midscene-mcp/package.json`](midscene-mcp/package.json) | Runtime Node >=24, binary MCP, test, dan typecheck |
| [`.env.example`](.env.example) | Template konfigurasi model, Chrome, cache, dan budget |
| [`app/src-tauri/tauri.conf.json`](app/src-tauri/tauri.conf.json) | Identitas produk, window, build, dan bundling Tauri |
| [`app/src-tauri/Cargo.toml`](app/src-tauri/Cargo.toml) | Dependensi backend Rust |
| [`app/vite.config.ts`](app/vite.config.ts) | Konfigurasi Vite, Tailwind, alias, dan port dev |

### Frontend desktop

| File | Peran |
|---|---|
| [`app/src/App.tsx`](app/src/App.tsx) | State utama, lifecycle koneksi, workspace/thread, model, permission, dan settings |
| [`app/src/components/WorkspaceShell.tsx`](app/src/components/WorkspaceShell.tsx) | Kerangka layout, header, notice, chat, dan settings |
| [`app/src/components/Chat.tsx`](app/src/components/Chat.tsx) | Chat TanStack AI, composer, provider/model, permission, dan stop |
| [`app/src/components/Sidebar.tsx`](app/src/components/Sidebar.tsx) | Navigasi workspace/thread dan aksi rename/delete |
| [`app/src/components/SettingsPage.tsx`](app/src/components/SettingsPage.tsx) | Halaman konfigurasi provider, model, workspace, dan tampilan |
| [`app/src/components/PermissionDialog.tsx`](app/src/components/PermissionDialog.tsx) | Antrean dan jawaban permission request |
| [`app/src/components/MarkdownContent.tsx`](app/src/components/MarkdownContent.tsx) | Render Markdown/GFM untuk balasan agen |
| [`app/src/connection/tauri-acp-connection.ts`](app/src/connection/tauri-acp-connection.ts) | Adapter TanStack AI ke command/event Tauri |
| [`app/src/lib/app-types.ts`](app/src/lib/app-types.ts) | Kontrak tipe frontend dan default settings |
| [`app/src/index.css`](app/src/index.css) | Design token dan styling aplikasi |

### Backend Tauri dan ACP

| File | Peran |
|---|---|
| [`app/src-tauri/src/lib.rs`](app/src-tauri/src/lib.rs) | Bootstrap Tauri, plugin, managed state, dan command registry |
| [`app/src-tauri/src/commands.rs`](app/src-tauri/src/commands.rs) | Command koneksi, prompt, cancel, model, workspace, settings, dan permission |
| [`app/src-tauri/src/agents.rs`](app/src-tauri/src/agents.rs) | Registry adapter Claude/Codex dan deteksi binary |
| [`app/src-tauri/src/settings.rs`](app/src-tauri/src/settings.rs) | Skema serta penyimpanan atomik `settings.json` |
| [`app/src-tauri/src/sidecar.rs`](app/src-tauri/src/sidecar.rs) | Konfigurasi MCP stdio yang dikirim saat membuat sesi ACP |
| [`app/src-tauri/src/acp/mod.rs`](app/src-tauri/src/acp/mod.rs) | Lifecycle proses/transport ACP dan timeout handshake |
| [`app/src-tauri/src/acp/session.rs`](app/src-tauri/src/acp/session.rs) | Pembuatan sesi ACP dengan daftar server MCP |
| [`app/src-tauri/src/acp/client.rs`](app/src-tauri/src/acp/client.rs) | Implementasi client ACP, event sink, permission map, dan disconnect handling |
| [`app/src-tauri/src/acp/events.rs`](app/src-tauri/src/acp/events.rs) | Translasi update ACP menjadi event AG-UI |
| [`app/src-tauri/src/acp/auto_permission.rs`](app/src-tauri/src/acp/auto_permission.rs) | Pemilihan opsi izin yang aman untuk full access |

### Server MCP dan otomasi

| File | Peran |
|---|---|
| [`midscene-mcp/src/index.ts`](midscene-mcp/src/index.ts) | Entry point stdio, root, budget, session manager, dan scenario store |
| [`midscene-mcp/src/server.ts`](midscene-mcp/src/server.ts) | Registrasi seluruh kelompok tool MCP |
| [`midscene-mcp/src/session.ts`](midscene-mcp/src/session.ts) | Lifecycle satu sesi dan budget operasi AI |
| [`midscene-mcp/src/scenarios.ts`](midscene-mcp/src/scenarios.ts) | Parsing, validasi, hitung langkah, URL skenario, dan penyimpanan YAML |
| [`midscene-mcp/src/url.ts`](midscene-mcp/src/url.ts) | Validasi URL sebelum browser dibuka |
| [`midscene-mcp/src/errors.ts`](midscene-mcp/src/errors.ts) | Kode error dan hasil tool yang konsisten |
| [`midscene-mcp/src/tools/exploration.ts`](midscene-mcp/src/tools/exploration.ts) | Tool sesi, act, query, assert, screenshot, dan end |
| [`midscene-mcp/src/tools/scenarios.ts`](midscene-mcp/src/tools/scenarios.ts) | Tool save/list/run scenario |
| [`midscene-mcp/src/tools/walkthrough.ts`](midscene-mcp/src/tools/walkthrough.ts) | Tool pembuat walkthrough |
| [`midscene-mcp/src/devices/factory.ts`](midscene-mcp/src/devices/factory.ts) | Pemilihan adapter web/computer secara dinamis |
| [`midscene-mcp/src/devices/web.ts`](midscene-mcp/src/devices/web.ts) | Adapter Puppeteer/Chrome |
| [`midscene-mcp/src/devices/computer.ts`](midscene-mcp/src/devices/computer.ts) | Adapter desktop Midscene |
| [`midscene-mcp/src/devices/cache.ts`](midscene-mcp/src/devices/cache.ts) | Konfigurasi cache modern dan kompatibilitas cache ID |
| [`build-demo.js`](build-demo.js) | Parser report dan generator walkthrough HTML mandiri |
| [`scripts/record-rekamedika-registration.mjs`](scripts/record-rekamedika-registration.mjs) | Contoh client yang merekam alur web melalui tool MCP |
| [`demo-registrasi.mjs`](demo-registrasi.mjs) | Contoh otomasi web dengan Midscene secara langsung |
| [`example.ts`](example.ts) | Contoh otomasi desktop dengan Midscene secara langsung |

### Test dan referensi

- [`midscene-mcp/test/`](midscene-mcp/test/) menguji tool, budget, URL,
  skenario, cache, screenshot, serta adapter palsu tanpa memanggil VLM nyata.
- [`app/src/components/Chat.test.tsx`](app/src/components/Chat.test.tsx),
  [`app/src/App.test.tsx`](app/src/App.test.tsx), dan file test di
  [`app/src/connection/`](app/src/connection/) menguji UI dan bridge AG-UI.
- [`app/src-tauri/tests/`](app/src-tauri/tests/) serta test inline modul Rust
  menguji handshake, sesi, lifecycle proses, event, permission, dan settings.
- [`docs/superpowers/specs/2026-08-04-midtest-design.md`](docs/superpowers/specs/2026-08-04-midtest-design.md)
  menjelaskan tujuan dan keputusan arsitektur awal.
- [`docs/superpowers/specs/2026-08-05-aplikasi-tauri-2b-design.md`](docs/superpowers/specs/2026-08-05-aplikasi-tauri-2b-design.md)
  mendokumentasikan rancangan kontrol harian, artefak, kelanjutan sesi, dan
  visual; sebagian masih berupa arah pengembangan.
