# Residu Terbuka: Aplikasi Tauri (Rencana 2a)

Tanggal: 2026-08-04
Sumber: final whole-branch review dan dua ronde perbaikan pada branch `feat/tauri-acp-chat`.

Semua butir di bawah sudah diadjudikasi **tidak memblokir merge**. Dokumen ini ada supaya
temuan tidak hilang bersama workspace perencanaan yang bersifat sementara.

## Yang harus dikerjakan sebelum orang lain memakainya

**1. Handler defensif untuk `fs/*` dan `terminal/*`.**
Keamanan saat ini bersifat *perilaku*, bukan *struktural*. Aplikasi hanya menangani
`session/request_permission`, dan itu aman semata karena `ClientCapabilities::default()`
mengiklankan `fs` dan `terminal` mati, sehingga agen yang patuh tidak akan mengirimnya.

Agen yang mengabaikan iklan kapabilitas dan mengirim `fs/read_text_file` — yang selalu
membawa `sessionId` — akan **membekukan sesi selamanya tanpa pesan apa pun**. Mendaftarkan
tujuh handler tiga-baris yang membalas galat terstruktur menghapus seluruh kelas hang itu.
`_ext/*` (`ExtMethodRequest`) juga tidak digerbangi kapabilitas mana pun.

Ada test penjaga (`kapabilitas_dan_handler_harus_berubah_bersama`) yang gagal keras bila
kapabilitas dinyalakan tanpa handler pendamping — itu menutup kasus *drift*, bukan kasus
agen yang tidak patuh.

**2. Hook keluar yang memanggil `AppState::close`.**
`tauri::App::run` tidak pernah kembali; ia berakhir lewat `std::process::exit`. Managed state
karena itu **tidak pernah di-drop**, sehingga `ChildGuard` milik crate — yang mengirim SIGKILL
ke process group anak — tidak pernah jalan saat aplikasi ditutup.

Diuji langsung: `claude-agent-acp` ternyata keluar saat stdin EOF dan ikut menuntaskan sidecar
MCP-nya, jadi **tidak ada yang bocor hari ini**. Tetapi itu keberuntungan, bukan desain —
komentar crate sendiri memperingatkan bahwa agen yang diluncurkan lewat wrapper "re-parent ke
pid 1 dan tidak andal keluar saat stdin EOF". Dan `codex-acp`, yang sudah ada di registry,
**adalah** peluncur wrapper (`codex app-server`) — persis kasus yang disebut tidak tercakup.

## Kualitas yang terlihat pengguna

**3. `TOOL_CALL_RESULT` tidak pernah dipancarkan.**
`Chat.tsx` merender "Menjalankan alat X" secara permanen, tanpa keadaan selesai atau gagal —
padahal `to_agui` sudah tahu bedanya (`events.rs`, cabang `Completed | Failed`).

**4. `toolCallName` diisi dari `title` ACP**, yang berupa kalimat manusiawi ("Reading file X"),
bukan identifier stabil. Tampil sebagai "Menjalankan alat *Reading file X*". Digabung dengan
butir 3 saat panel progres dikerjakan.

**5. Judul jendela masih bawaan scaffold.** `index.html` berjudul
"Tauri + React + Typescript"; `tauri.conf.json` memakai `productName: "app"` dan window
`title: "app"`. Title bar akan terbaca "app".

**6. Perintah `greet` bawaan scaffold masih ada di permukaan IPC** (`lib.rs`). Hapus.

## Diagnostik

**7. `agents::probe()` ada tapi tidak pernah dipanggil `connect_agent`.**
Biner yang benar-benar hilang muncul sebagai `AcpError::Protocol` → "Agen menolak permintaan
protokol: …", yang menyesatkan. `App.tsx` menutupinya dengan menempelkan nama biner dari
duplikat hardcoded milik `agents.rs` — dan duplikat itu akan diam-diam berbohong bila spec
Rust berubah.

**8. Galat runner pasca-handshake masih dibuang** oleh `AcpHandle::shutdown`, sehingga banner
putus hanya bisa berbunyi "transport agen tertutup". Menyurfacekan ekor stderr adapter akan
jadi peningkatan diagnostik yang nyata.

## Struktural

**9. `SessionSlot` ditawarkan, tidak dibangun.**
Invarian pelepasan lock saat ini bertumpu pada konvensi di satu call site: `send_prompt` harus
memakai `turn_target()` yang mengembalikan nilai ter-owned, bukan memegang `MutexGuard`.
Mengembalikan guard ke dalam `send_prompt` tidak tertangkap test apa pun — hanya clippy secara
kebetulan, lewat "method `turn_target` is never used". Pembungkus `SessionSlot` yang tidak
pernah menyerahkan `MutexGuard` (hanya `snapshot()` dan `reconnect()`) akan menjadikannya
jaminan tipe. Sekitar 30 baris.

**10. Peta izin membocorkan satu entri** bila koneksi mati saat gerbang menunggu: task
ter-spawn ikut mati, jadi timeout maupun pembersihan tidak pernah jalan, dan entri itu
bertahan melewati reconnect karena `ClientContext` hidup di `AppState`. Dampak terbatas —
id monoton sehingga tidak mungkin salah jawab, `answer_permission` pada id basi mengembalikan
galat yang keras, dan `ResponderDropGuard` crate tetap membalas agen.

## Pelajaran yang layak dibawa ke Rencana 2b

Rencana 2a ditulis dengan aturan "turunkan API dari sumber, jangan dari ingatan", dan aturan
itu menangkap **lima** kesalahan berturut-turut soal crate `agent-client-protocol`.

Tetapi kesalahan **keenam** lolos sampai final review, dan bentuknya berbeda: rencana
menyatakan `StreamChunk` TanStack sama dengan `AGUIEvent` dari `@ag-ui/core`, lalu memakai
daftar nama event dari paket itu. Alias tipenya memang benar. Yang tidak diperiksa adalah
**apa yang benar-benar ditangani konsumennya** — `StreamProcessor` hanya mengimplementasikan
sebagian nama itu, dan `@ag-ui/core` bahkan tidak terpasang.

Akibatnya dua nama event teks jatuh tanpa `case`, dan setiap kata asisten dibuang diam-diam.
Tujuh puluh dua test Rust dan tiga belas test frontend semuanya hijau dengan bug itu di
dalamnya, karena sisi Rust menguji string terhadap dirinya sendiri dan sisi frontend hanya
menguji bahwa adapter meneruskan apa pun yang diberikan.

**Aturan yang seharusnya:** memverifikasi sebuah tipe tidak sama dengan memverifikasi
perilaku konsumennya. Untuk tiap kontrak yang melintasi batas bahasa, tulis satu test yang
benar-benar menyeberanginya — dan bangun fixture-nya dari sisi produsen, jangan disalin
tangan, supaya rename tanpa refresh langsung memerahkan test.
