# Desain: Midscene Desktop — Agen Chat untuk Dokumentasi QA & Demo Produk

Tanggal: 2026-08-04

## Tujuan

Aplikasi desktop Tauri berisi antarmuka chat. Pengguna meminta sesuatu dalam
bahasa sehari-hari ("buat dokumentasi alur checkout"), lalu agen ACP — Codex atau
Claude Code — merencanakan langkahnya, menjalankan Midscene untuk mengoperasikan
target, dan menghasilkan dua keluaran:

1. Skenario QA yang bisa dijalankan ulang sebagai uji regresi
2. Panduan walkthrough berbahasa Indonesia untuk demo produk

Target otomasi mencakup web app (lewat Puppeteer) dan aplikasi desktop macOS.

v1 dipakai sendiri oleh penulisnya, tetapi strukturnya disiapkan untuk dirilis
sebagai proyek open source.

## Batasan yang menentukan desain

### Midscene butuh AI di dua lapisan berbeda

**Grounding.** Screenshot → koordinat elemen. Butuh VLM dengan kemampuan
grounding. Family yang didukung terbatas dan formatnya di-parse langsung oleh
Midscene — `MODEL_FAMILY_VALUES` di `@midscene/shared@1.10.8` (versi yang
dipakai `midscene-mcp`; daftar ini bisa berubah di versi lain, cek
`node_modules/@midscene/shared/dist/lib/env/types.js`): `doubao-vision`,
`doubao-seed`, `gemini`, `qwen2.5-vl`, `qwen3-vl`, `qwen3`, `qwen3.5`,
`qwen3.6`, `vlm-ui-tars`, `vlm-ui-tars-doubao`, `vlm-ui-tars-doubao-1.5`,
`glm-v`, `auto-glm`, `auto-glm-multilingual`, `gpt-5`, `kimi`, `kimi3`,
`xiaomi-mimo`. Agen coding tidak bisa menggantikan peran ini.

**Perencanaan.** Memecah permintaan jadi urutan langkah, menulis skenario,
menyusun narasi dokumentasi. Ini yang dikerjakan agen ACP.

Konsekuensinya: memakai agen ACP **tidak menghapus** kebutuhan API key VLM.
Yang berubah adalah volume panggilannya.

### Kepatuhan terhadap ketentuan langganan

Pola yang dipakai — dan alasannya aman — adalah pola yang sama dengan Zed:

- Aplikasi ini adalah ACP **client**
- Codex CLI dan Claude Code diinstall dan di-login oleh pengguna sendiri
- Aplikasi tidak pernah menyimpan, menyentuh, atau mem-proxy kredensial
- Kedua vendor menyediakan mode ACP justru supaya klien pihak ketiga bisa
  mengemudikan agennya

Pola yang **dilarang** dan secara sengaja tidak ada di desain ini:

- Shim `/v1/chat/completions` yang membungkus langganan menjadi endpoint API generik
- Memakai langganan Codex atau Claude untuk menyalakan grounding VLM Midscene
- Multi-tenant, penjualan ulang akses, atau membundel kredensial ke distribusi

Karena itu pemisahannya tegas: **agen ACP = asisten coding dan penulisan yang
diajak bicara pengguna** (penggunaan yang memang dimaksudkan vendor);
**grounding VLM = API key terpisah milik pengguna sendiri.**

Catatan: ini bukan nasihat hukum dan ketentuan dapat berubah. Ketentuan Codex dan
Claude Code yang berlaku wajib dibaca ulang sebelum rilis publik.

### Cache adalah mekanisme penghematan yang sebenarnya

Midscene punya cache elemen dan plan (`MIDSCENE_CACHE`). Cache hit melewati
panggilan VLM sepenuhnya. Struktur biayanya jadi:

| Lapisan | Pelaksana | Biaya |
|---|---|---|
| Rencanakan skenario, tulis script | Agen ACP | langganan |
| Run pertama: eksplorasi & grounding | VLM Midscene | API, sekali |
| Run ulang / regresi | Cache Midscene | ~nol |
| Tulis narasi dokumentasi Indonesia | Agen ACP | langganan |

Pembagian permukaan tool MCP di bawah mengikuti struktur ini secara langsung.

## Arsitektur

```
┌──────────── Tauri ────────────┐
│  Webview (React)              │
│   shadcn + TanStack useChat   │
│        ▲ event AG-UI          │
│  ──────┼──────────────────    │
│  Rust core                    │
│   • ACP client (stdio)  ──────┼──▶ codex-acp │ claude-agent-acp
│   • lifecycle sidecar   ──────┼──▶ Midscene MCP server (Node)
│   • gerbang izin              │         │
└───────────────────────────────┘         ▼
                                    Chrome / desktop macOS
                                    → midscene_run/ (report, cache)
```

Midscene dibungkus sebagai **MCP server**, bukan dijalankan agen lewat terminal.
Alasannya: aplikasi ini harus mendukung dua agen ACP yang berbeda, dan MCP adalah
denominator bersama keduanya. ACP `session/new` menerima parameter `mcpServers`,
sehingga satu sidecar bekerja di agen mana pun. Sebagai efek samping, sidecar itu
berguna berdiri sendiri — bisa dipakai dari Zed atau Claude Code tanpa aplikasi ini.

### Posisi Rust pada jalur data

Di ACP, agen terhubung **langsung** ke MCP server; trafik tool call tidak melewati
Tauri. Tauri mengamati lewat dua sumber:

1. Notifikasi `session/update` dari ACP, berisi `tool_call` dan `tool_call_update`
   lengkap dengan nama, argumen, status, dan content block termasuk gambar
2. Sidecar adalah proses milik Tauri, sehingga bisa melaporkan progres detail
   balik lewat stdout/IPC-nya sendiri

Tauri **mengamati**, tidak **mencegat**. Gerbang izin karena itu bekerja di lapisan
ACP (`session/request_permission`), bukan di lapisan MCP.

## Komponen

Empat modul dengan batas yang tegas. Tiap modul dapat dipahami dan diuji tanpa
membaca isi modul lain.

### `midscene-mcp/` — sidecar Node

Membungkus Midscene sebagai MCP server. Menangani lifecycle sesi dan pemilihan
device adapter (web lewat Puppeteer, desktop lewat `@midscene/computer`).

Tidak tahu apa pun soal Tauri, ACP, atau React.

### `src-tauri/` — Rust

- `acp/` — klien JSON-RPC over stdio, manajemen sesi
- `agents/` — registry Codex dan Claude Code, deteksi prasyarat
- `sidecar/` — spawn dan pengawasan proses Node
- `permissions/` — gerbang izin
- `events/` — emisi ke webview

Tidak tahu apa pun soal Midscene; bagi modul ini sidecar adalah proses opaque.

### `src/` — React

- `connection/acp-connection.ts` — menerjemahkan event Tauri menjadi event AG-UI
  untuk `useChat`
- Antarmuka chat dengan shadcn (`message`, `message-scroller`, `marker`, `typeset`)
- Panel progres langkah dengan screenshot live
- Preview walkthrough

Tidak tahu apa pun soal ACP maupun MCP; modul ini hanya melihat pesan dan event langkah.

Catatan transport: `createChat()` dari `@shadcn/helpers` adalah pemutar percakapan
skrip untuk pengembangan UI, bukan transport produksi. Namun helper itu
membuktikan `useChat({ connection })` dapat sepenuhnya berjalan client-side dengan
mengemisi event AG-UI langsung ke stream processor. Jalur produksi memakai
connection adapter sendiri yang mendengarkan event Tauri. Tidak diperlukan server
HTTP lokal.

### `build-demo.js` — sudah ada

723 baris, empat bagian: `extractReport` → `buildSteps` →
`loadOverrides`/`applyOverrides` → `renderHtml`. Desainnya terdokumentasi di
`2026-08-04-laporan-demo-produk-design.md`.

Dipakai ulang apa adanya. Tetap murni: tidak tahu Midscene, tidak tahu MCP.
Sidecar yang membungkusnya menjadi tool. Antarmuka CLI-nya dipertahankan agar
tetap dapat diuji berdiri sendiri.

## Permukaan tool MCP

Dibagi tiga mode, mengikuti struktur biaya.

**Eksplorasi** — mahal, interaktif, agen dapat pulih dari kegagalan:

```
start_session({ target: "web" | "computer", url? })
act(instruction)
query(schema)
assert(claim)
screenshot()
end_session()
```

**Kristalisasi** — agen membekukan langkah yang terbukti berhasil:

```
save_scenario(name, yaml)
```

**Replay** — murah, sekali panggil, `MIDSCENE_CACHE` aktif:

```
run_scenario(name)   →  { reportPath, stepSummary }
```

**Dokumentasi:**

```
build_walkthrough(reportPath, stepsPath, out)
```

## Alur kerja

1. Pengguna meminta dokumentasi sebuah alur
2. Agen menjalankan sesi eksplorasi — membayar VLM, satu kali
3. Agen memanggil `save_scenario` untuk membekukan langkah yang berhasil
4. Agen memanggil `run_scenario` untuk verifikasi — cache aktif, nyaris nol biaya
5. Agen membaca report, menulis `steps.id.json` berbahasa Indonesia
6. Agen memanggil `build_walkthrough`
7. Tauri menampilkan preview

Uji regresi berikutnya cukup langkah 4.

Berkas `steps.id.json` tetap ada dan tetap dapat disunting tangan. Agen mengisi
draf; pengguna memegang kata akhir.

## Penanganan galat

**Prasyarat hilang.** Tidak ada agen yang punya mode ACP native — keduanya butuh
adapter terpisah yang mengemudikan CLI lokal. Jadi yang diperiksa ada **enam**:
`codex` CLI dan `codex-acp` untuk sisi Codex; Claude Code dan `claude-agent-acp`
untuk sisi Claude; ditambah Node dan Chrome. Diperiksa saat aplikasi start,
ditampilkan sebagai panel prasyarat dengan instruksi install, bukan crash.

Konsekuensi yang menguntungkan: karena keduanya adapter atas CLI milik pengguna,
argumen kepatuhan ToS di atas berlaku seragam untuk kedua agen.

**Agen belum login.** Method `authenticate` pada ACP di-surface sebagai prompt,
bukan error mentah. Aplikasi tidak pernah menyimpan kredensial; login terjadi di
CLI masing-masing.

**Budget guard.** Sesi eksplorasi memiliki batas jumlah panggilan VLM. Hitungannya
terlihat di UI. Saat batas tercapai sesi berhenti dan bertanya, tidak melanjutkan
diam-diam. Tanpa ini, agen yang meraba pada web app besar dapat membakar tagihan
tanpa disadari.

**Sidecar mati di tengah run.** Prosesnya milik Tauri sehingga exit terdeteksi.
Sesi ditandai gagal dan tool call yang menggantung dibalas error agar agen tidak
menunggu tanpa batas.

**VLM gagal, API key salah, kuota habis.** Tool MCP membalas error terstruktur
dengan sebab yang jelas, agar agen menyampaikannya kepada pengguna alih-alih
mencoba ulang berulang kali dan menggandakan tagihan.

**Cache tercemar.** Midscene sudah menandai entri cache yang mencurigakan ketika
sebuah batch gagal. Yang ditambahkan hanya tombol "bersihkan cache skenario ini"
di UI, karena tanpa itu tidak ada jalan keluar ketika UI target berubah.

**Report hilang atau rusak.** Sudah ditangani `build-demo.js`.

## Testing

| Lapisan | Cara uji |
|---|---|
| `build-demo.js` | Golden test memakai report yang sudah ada di `midscene_run/report/` |
| MCP server | Device adapter palsu — kontrak tool diuji tanpa browser dan tanpa VLM |
| ACP client (Rust) | Agen tiruan yang membalas dari skrip JSON |
| UI React | `createChat()` dari `@shadcn/helpers` — percakapan skrip tanpa model |
| Integrasi | Satu skenario nyata, dijalankan manual, tidak di CI |

Hanya baris terakhir yang membutuhkan API key dan langganan. Sisanya berjalan di
CI tanpa biaya.

## Lingkup v1

**Masuk:** chat satu sesi dengan satu agen aktif (Codex atau Claude, dipilih di
settings) · target web dan desktop macOS · sembilan tool MCP di atas · panel
progres langkah dan preview walkthrough · deteksi prasyarat · budget guard.

**Ditunda ke versi berikutnya:** bundling Node runtime dan installer · multi-sesi
atau tab · riwayat percakapan persisten · dukungan Windows dan Linux · editor YAML
visual · dua agen berjalan paralel · manajemen kredensial di dalam aplikasi.

Yang menahan v1 pada status "dipakai sendiri" adalah tidak adanya bundling dan
onboarding. Batas modul, `.env.example`, dan test suite sudah disiapkan untuk open
source sejak awal, sehingga pelepasannya nanti bukan penulisan ulang.

## Urutan pengerjaan

Desain ini mencakup tiga subsistem: sidecar Node, klien ACP Rust, dan antarmuka
React. Keduanya-tiganya dikerjakan bertahap, dan tiap tahap menghasilkan sesuatu
yang sudah berguna sendiri.

**Tahap 0 — verifikasi.** Empat asumsi di bawah dibuktikan lebih dulu. Hasilnya
dapat mengubah tahap berikutnya.

**Tahap 1 — sidecar MCP.** Dibangun dan diuji berdiri sendiri, dipakai langsung
dari Zed atau Claude Code. Tanpa Tauri sama sekali. Tahap ini sudah memberi nilai
penuh: skenario dapat dijalankan dan walkthrough dapat dibangun lewat agen mana pun.

**Tahap 2 — klien ACP dan chat minimal.** Tauri menjalankan agen, menampilkan
pesan, meneruskan permintaan izin. Belum ada panel progres.

**Tahap 3 — panel progres dan preview walkthrough.** Melengkapi antarmuka dengan
event langkah, screenshot live, budget guard, dan deteksi prasyarat.

Jika ruang lingkupnya terasa terlalu besar untuk satu rencana implementasi, Tahap 1
dapat dipisahkan menjadi proyek tersendiri dengan spec dan rencananya sendiri.

## Verifikasi yang wajib dilakukan sebelum menulis kode

Empat asumsi yang belum terbukti pada mesin pengembangan saat ini. Keempatnya
menjadi langkah pertama rencana implementasi.

1. Versi Codex mana yang memiliki mode ACP native, dan bagaimana cara memanggilnya
2. Apakah `claude-agent-acp` mendukung parameter `mcpServers` pada `session/new`
3. Bentuk API connection kustom TanStack AI di luar helper mock-nya
4. Apakah `@midscene/computer` v1.10.8 mengekspos `ScriptPlayer`/`runYaml` sebagai
   API publik atau hanya internal

Jika nomor 2 gagal, sidecar harus dipanggil melalui jalur lain untuk agen tersebut.
Jika nomor 4 gagal, mode replay harus dibangun di atas API agent biasa dengan
`cacheId` alih-alih YAML.

## Status perkakas mesin pengembangan

Terpasang: Node v26.5.1, Chrome (lewat `PUPPETEER_EXECUTABLE_PATH`).

Belum terpasang: `cargo`, `tauri`, `codex`, `claude-agent-acp`, `pnpm`.

Direktori proyek belum berupa repositori git.
