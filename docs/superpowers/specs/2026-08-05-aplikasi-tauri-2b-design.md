# Desain: Aplikasi Tauri 2b — Kontrol Harian, Hasil, dan Tampilan

Tanggal: 2026-08-05

Kelanjutan dari `2026-08-04-midtest-design.md`. Rencana 2a menghasilkan
aplikasi yang berfungsi: tersambung ke agen ACP, mengalirkan balasan, dan menjalankan
tool Midscene lewat gerbang izin. Dokumen ini merancang apa yang membuatnya layak
dipakai sehari-hari.

## Celah yang ditemukan saat memakainya

Dua hal terungkap ketika aplikasinya benar-benar dijalankan, dan keduanya kelalaian
desain sebelumnya, bukan bug implementasi.

**Hasilnya tidak bisa dilihat.** Sidecar menulis report Midscene dan walkthrough HTML
ke `midscene_run/report/`. Path-nya dikembalikan sebagai teks hasil tool, dibaca agen,
lalu berakhir sebagai teks di gelembung tool call. Tidak ada satu baris pun di `app/`
yang membuka, mendaftar, atau mem-preview artefak itu. Aplikasi menghasilkan dokumentasi
yang tidak bisa dilihat pemakainya.

**Tidak ada kelanjutan.** Kedua agen mendukung `session/list`, `session/load`, dan
`session/resume` secara native — diverifikasi di Tahap 0 dan bahkan dicatat di spec
sebelumnya sebagai "fitur yang ternyata tidak perlu dibangun sendiri". Lalu tidak
dipakai sama sekali. Setiap peluncuran mulai dari nol.

Ditambah tiga permintaan dari pemakaian nyata: tombol stop, mode izin penuh, dan
pemilih agen. Serta satu pengamatan: tampilannya mentah.

## Pemecahan dan urutan

Digabung, semuanya terlalu besar untuk satu rencana. Urutannya juga tidak netral —
tombol stop, toggle izin, pemilih agen, panel artefak, dan daftar sesi semuanya butuh
tempat di chrome jendela. Menata visual lebih dulu berarti menatanya dua kali.

**2b-1 — Kontrol harian.** Tombol stop, Full Permissions tersimpan, switcher agen.
Berat di Rust, UI minimal. Memuat kontrol keselamatan biaya, jadi didahulukan.

**2b-2 — Hasil dan kelanjutan.** Panel artefak, daftar skenario, daftar dan
kelanjutan sesi. Bagian terpenting bagi alur kerja pengguna.

**2b-3 — Visual.** Render markdown, tipografi prosa, tata letak percakapan, mode
gelap-terang. Terakhir, supaya menata seluruh kontrol dari 2b-1 dan 2b-2 sekaligus.

**Penempatan visual adalah keputusan 2b-3, bukan 2b-1 atau 2b-2.** Kedua rencana awal
menaruh kontrolnya seadanya asal berfungsi dan terjangkau keyboard — tombol stop, toggle
izin, pemilih agen, panel artefak, daftar sesi. Menatanya rapi satu kali di 2b-3 lebih
murah daripada memperdebatkan tata letak tiga kali. Satu-satunya batasan yang mengikat
sejak 2b-1: keadaan Full Permissions harus terlihat tanpa membuka menu, karena ia
bertahan lintas peluncuran.

---

## 2b-1 — Kontrol harian

### Tombol stop

ACP menyediakan `session/cancel` sebagai metode client→agent, terverifikasi ada di
crate. Pembatalan dilakukan lewat protokol, **bukan** dengan membunuh proses adapter —
membunuhnya akan menutup sesi dan sidecar sekaligus, dan browser yang sedang terbuka
ikut hilang.

Perintah Tauri baru `cancel_turn()`. Ia memakai `ConnectionTo<Agent>` dan `session_id`
dari `turn_target()`. Ini mungkin karena sejak Task 6 `send_prompt` tidak lagi memegang
lock sesi sepanjang giliran; jalur itu dibuat untuk agen yang membisu dan sudah
dibuktikan reviewer dengan test yang menjalankan prelude pemulihan sungguhan.

**Wajib diturunkan dari sumber sebelum menulis kode:** apa yang dikembalikan
`session/prompt` yang sedang berjalan ketika dibatalkan — galat, atau hasil dengan
penanda cancelled. Itu menentukan apakah UI menerima `RUN_ERROR` atau `RUN_FINISHED`.
Prosa rencana tentang crate ini sudah terbukti salah enam kali; jangan menebak yang
ketujuh.

Test: agen palsu yang tidak pernah menjawab `session/prompt`; `cancel_turn` harus
mengakhiri giliran dan mengirim event terminal ke webview.

### Full Permissions

Disimpan ke berkas JSON di direktori config aplikasi. Tidak menambah plugin bila
sebuah berkas sudah cukup.

`ClientContext` mendapat flag. `permission_gate` memeriksanya dan menyetujui otomatis
**tanpa** memancarkan `permission-request`.

**Detail yang menentukan keamanannya:** opsi mana yang dipilih otomatis. Gerbang saat
ini memvalidasi `option_id` terhadap opsi yang benar-benar ditawarkan agen. Untuk mode
ini, pilih opsi yang memang berarti *izinkan* — bukan `options[0]` membabi buta. Bila
agen tidak menawarkan opsi izin yang jelas, **jatuh kembali ke bertanya**. Menyetujui
sesuatu yang bukan persetujuan lebih buruk daripada bertanya.

Karena pilihannya tersimpan lintas peluncuran, keadaannya **selalu terlihat di UI**,
bukan terkubur di menu. Pengguna tidak boleh membuka aplikasi besok dalam keadaan
menyetujui segalanya tanpa sadar.

Test: menyetujui tanpa memancarkan event; memilih opsi izin yang sungguhan; jatuh ke
bertanya bila tidak ada opsi izin; bertahan setelah aplikasi ditutup.

### Switcher agen

Registry `AGENTS` sudah memuat `claude` dan `codex`. Beralih berarti reconnect penuh:
tutup sesi lama, sambung yang baru. Jalur penutupan sudah terbukti bekerja.

**Auth Codex mengandalkan `codex login` di terminal.** Aplikasi tidak pernah menyentuh
kredensial — prinsip yang sama yang membuat argumen kepatuhan ToS berlaku.

Desainnya berbasis perilaku, bukan tebakan atas arti `authMethods`: coba sambung dan
buat sesi; bila gagal, petakan galatnya ke pesan Indonesia yang menyebut `codex login`.
Membuat sesi tidak memanggil model, jadi percobaan ini tidak berbiaya. Alasan tidak
menebak: saat handshake Tahap 0, Codex mengembalikan dua metode auth padahal belum
login, dan tidak diketahui apakah isinya kosong setelah login.

Sekalian menutup residu terbuka: `agents::probe()` sudah ada tapi tidak pernah
dipanggil, sehingga biner yang benar-benar hilang muncul sebagai galat protokol yang
menyesatkan. Panggil `probe()` sebelum menyambung, dan hentikan `App.tsx` menduplikasi
nama biner dari `agents.rs`.

Test: beralih menutup sesi lama tanpa proses bocor; biner hilang memberi galat yang
berbeda dari agen yang menolak.

---

## 2b-2 — Hasil dan kelanjutan

### Panel artefak

Rust mendaftar `midscene_run/report/`, mengurutkan menurut waktu modifikasi, dan
membedakan report mentah dari walkthrough (`.demo.html`).

Membukanya lewat `tauri-plugin-opener`, yang **sudah menjadi dependensi** sejak
scaffold, ke browser sistem.

Alasan tidak mem-preview di dalam aplikasi: report berukuran 2–6 MB, HTML mandiri
dengan screenshot base64 tertanam. Iframe akan berat, sementara browser sistem memberi
zoom, cetak, dan simpan tanpa kode tambahan. Preview in-app dapat menyusul bila
berpindah jendela ternyata mengganggu.

Test: daftar mengurutkan menurut waktu; walkthrough dan report dibedakan; direktori
yang tidak ada menghasilkan daftar kosong, bukan galat.

### Daftar skenario

Aplikasi membaca `scenarios/` langsung, hanya untuk menampilkan.

**Menjalankannya tetap lewat agen**, bukan panggilan MCP langsung dari aplikasi. Bila
aplikasi memanggil sidecar sendiri, giliran itu tidak muncul di chat dan tidak dihitung
budget. Lewat agen, keduanya berlaku.

Test: daftar kosong bila direktori belum ada; hanya `.yaml` yang muncul.

### Kelanjutan percakapan

**Tidak ada penyimpanan yang kita bangun.** `session/list` memberi daftar, dan
`SessionInfo` membawa `session_id`, `cwd`, dan **judul yang bisa dibaca manusia**.
`session/resume` memulihkan sesi. Agen yang memiliki riwayatnya; aplikasi hanya
menampilkan dan memilih.

`ListSessionsResponse` berpaginasi lewat `next_cursor` — tangani, jangan asumsikan satu
halaman.

`ResumeSessionRequest` menuntut `cwd` absolut. Aplikasi sudah meng-canonicalize `cwd`
di batas `connect()`, jadi invarian itu sudah dipenuhi.

**Batas yang harus dinyatakan di UI, bukan hanya di dokumen:** melanjutkan sesi
memulihkan konteks percakapan, **bukan keadaan browser**. Sidecar Midscene didaftarkan
ulang segar, jadi Chrome dari sesi sebelumnya sudah tidak ada. Untuk alur tutorial ini
wajar — pengguna melanjutkan dengan `run_scenario` yang membuka halamannya lagi, dan
cache Midscene membuatnya murah.

Test: paginasi diikuti sampai `next_cursor` habis; melanjutkan sesi memulihkan
`session_id` yang benar; daftar kosong ditangani.

---

## 2b-3 — Visual

Akar masalah tampilan mentah: agen memancarkan markdown — daftar, blok kode, penekanan —
dan aplikasi merendernya sebagai `<p>` polos. Komponen shadcn `typeset`, yang dimaksudkan
untuk ini, tidak ada di registry saat 2a dikerjakan (404 di tiga jalur, diverifikasi
lewat probe langsung) dan sengaja tidak dibuatkan tiruannya.

Lingkupnya:

- Renderer markdown **dengan sanitasi** — isinya berasal dari model, jadi HTML mentah
  tidak boleh lewat begitu saja.
- Tipografi prosa sebagai pengganti `typeset`.
- Tata letak percakapan: bedakan giliran pengguna dan agen, spasi antar-giliran, blok
  pemikiran yang bisa dilipat.
- Tool call dengan keadaan selesai dan gagal.
- Header, indikator status, mode gelap dan terang.
- Menata kontrol dari 2b-1 dan 2b-2: stop, toggle izin, pemilih agen, panel artefak,
  daftar sesi.

**Satu perbaikan Rust wajib ikut di sini:** `TOOL_CALL_RESULT` tidak pernah dipancarkan,
sehingga tool call selamanya berbunyi "Menjalankan alat X" tanpa keadaan akhir —
padahal `to_agui` sudah membedakan `Completed` dari `Failed`. Tanpa perbaikan itu,
tampilan tool call tetap salah betapa pun rapinya CSS-nya.

Terkait: `toolCallName` diisi dari `title` ACP, yang berupa kalimat manusiawi
("Reading file X"), bukan identifier stabil. Putuskan saat menata tampilan tool call
apakah kalimat itu dipakai apa adanya atau dipetakan.

---

## Yang tidak termasuk

Ditangani rencana berikutnya:

- Panel progres langkah dengan screenshot live
- Preview walkthrough di dalam aplikasi
- Deteksi keenam prasyarat dengan panduan install
- Konversi npm workspaces (menunggu perubahan tak ter-commit di root)
- Handler defensif `fs/*` dan `terminal/*`, dan hook keluar yang memanggil
  `AppState::close` — keduanya tercatat di `2026-08-04-residu-tauri-acp.md`

## Aturan yang berlaku untuk ketiga rencana

Dari `2026-08-04-residu-tauri-acp.md`, dan ditulis ulang di sini karena berlaku
langsung:

**Memverifikasi sebuah tipe tidak sama dengan memverifikasi perilaku konsumennya.**
Rencana 2a menyatakan `StreamChunk` TanStack sama dengan `AGUIEvent` dari `@ag-ui/core`.
Alias tipenya benar. Yang tidak diperiksa adalah nama event mana yang benar-benar punya
`case` di `StreamProcessor` — ternyata hanya sebagian, dan `@ag-ui/core` bahkan tidak
terpasang. Akibatnya setiap kata asisten dibuang diam-diam, dan 72 test Rust serta 13
test frontend semuanya hijau dengan bug itu di dalamnya.

Untuk tiap kontrak yang melintasi batas bahasa, tulis satu test yang benar-benar
menyeberanginya, dan bangun fixture-nya dari sisi produsen — jangan disalin tangan,
supaya rename tanpa refresh langsung memerahkan test.
