# Residu Terbuka: Kontrol Harian (Rencana 2b-1)

Tanggal: 2026-08-05
Sumber: final whole-branch review branch `feat/kontrol-harian`, plus adjudikasi delapan task.

Semua butir sudah diadjudikasi **tidak memblokir merge**, kecuali yang ditandai sebaliknya
dan sudah ditutup. Dokumen ini permanen; ledger perencanaan bersifat sementara.

## Keputusan yang diambil, bukan kelalaian

### Izin yang disetujui otomatis tidak meninggalkan jejak di transkrip

Ketika mode izin penuh menyala, gerbang menyetujui tanpa memancarkan apa pun: tidak ada
dialog, tidak ada event, tidak ada penanda di percakapan. Event tool call tetap menunjukkan
**apa** yang dilakukan agen, tetapi tidak pernah bahwa persetujuan diberikan atas namamu.

Contohnya: mode menyala, agen memanggil `midscene__act` untuk mengklik "Hapus akun". Di layar,
penandanya identik dengan tool call yang memang tidak butuh izin sama sekali.

**Keputusan:** indikator yang selalu terlihat di header dianggap cukup untuk risiko utamanya —
membuka aplikasi besok dalam keadaan menyetujui segalanya tanpa sadar. Sinyal per-panggilan di
transkrip menuntut perubahan sisi Rust (memancarkan event dari `permission_gate`), yang di luar
lingkup 2b-1.

**Direkomendasikan untuk 2b-3**, saat tampilan tool call ditata: pancarkan event
`permission-auto-approved` dan render penanda yang membedakan "disetujui otomatis" dari
"tidak perlu izin".

## Yang layak dikerjakan berikutnya

**1. Tombol "matikan sekarang" untuk izin penuh.**
Saat keadaan izin penuh tidak diketahui — pembacaan IPC gagal — toggle-nya dinonaktifkan,
karena "kebalikan dari tidak diketahui" tidak punya nilai yang terdefinisi untuk dikirim.
Itu benar untuk toggle relatif. Tetapi pengguna yang membaca "mode ini bisa saja masih
menyala" dan ingin segera mematikannya jadi tidak punya jalan selain menutup dan membuka
aplikasi — lewat jalur IPC yang barusan gagal.

`enabled: false` tidak ambigu apa pun keadaan sebelumnya. Aksi terpisah "matikan sekarang",
berbeda dari toggle relatif, akan mempertahankan seluruh sifat keamanan sekarang sambil
memberi tindakan defensif seketika.

**2. Promise yang tidak pernah selesai.**
Ketiga jalur *penolakan* kini mendarat di keadaan "tidak diketahui". Tetapi `invoke` yang
tidak pernah resolve maupun reject — misalnya deadlock di sisi Rust — tidak memicu handler
mana pun, sehingga keadaannya bertahan di nilai terakhir selamanya.

Ini pola pre-existing di seluruh berkas, bukan bawaan fitur ini: `connect_agent` punya sifat
yang sama. Menutupnya menuntut timeout sisi klien, yaitu mekanisme baru, bukan perbaikan bug.

**3. Toggle bisa macet nonaktif.** `sedangMengubahIzin` dibersihkan di `finally`, tetapi bila
IPC-nya menggantung, switch-nya tetap disabled tanpa batas waktu dan tanpa pesan. Pemulihannya
menutup aplikasi. Bagian dari butir 2.

**4. `settings::save` memakai nama berkas sementara tetap dan tanpa fsync.**
Dua penyimpanan bersamaan akan bertabrakan di `settings.json.tmp`, dan crash di antara `write`
dan `rename` bisa meninggalkan berkas nol-byte. Keduanya jatuh ke arah aman — `load`
mengembalikan `false` untuk masukan kosong maupun rusak, dijaga empat test — dan penjaga
`sedangMengubahIzin` sudah men-serialisasi satu-satunya pemanggil.

**5. `RestrictedPath` mengubah `PATH` global proses** (`commands.rs`). `PATH_LOCK` hanya
men-serialisasi test yang memakainya, bukan terhadap sisa suite. Aman hari ini karena
`ENV_LOCK` internal Rust. Jebakannya laten: begitu ada test lain yang me-resolve biner dari
`PATH` secara bersamaan, ia akan diam-diam melihat direktori stub. Layak diberi catatan
"JANGAN" di `real_path_lookup`.

**6. Judul header tertinggal saat berpindah agen.** Selama transisi, header masih menampilkan
label default alih-alih agen tujuan. Kosmetik; ditata di 2b-3.

## Yang diputuskan tetap seperti sekarang

- **Identifier frontend berbahasa Indonesia** (`mengirim`, `hentikan`, `membatalkan`) sementara
  sisi Rust berbahasa Inggris. Constraint rencana ini memang menyatakan frontend mengikuti
  konvensi branch, jadi branch-nya patuh pada aturannya sendiri. Putuskan sekali saat 2b-3.
- **`cargo fmt` tidak digerbangkan.** Drift impor multi-baris ada di berkas lama maupun baru;
  merapikan hanya yang baru justru menambah ketidakkonsistenan.
- **Test urutan berbasis sleep 300 ms** di `menyambung_agen_kedua_...`. Reviewer memastikan ia
  tidak bisa flaky pada kode yang benar: jalur benar menunggu reaping proses sungguhan, bukan
  timer, sehingga `kill(pid,0)` mengembalikan `ESRCH` secara deterministik betapa pun sibuknya
  mesin. Diuji 20 kali di bawah oversubscription 3×, semuanya lolos. Sleep-nya hanya menentukan
  seberapa kuat daya deteksi mutasinya, bukan apakah kode benar bisa gagal.

## Koreksi atas kalimat yang sempat salah di dokumen perencanaan

Brief sempat menyatakan "mutex sesi tidak pernah dipegang melintasi await". Itu terlalu luas.
Aturan sebenarnya, sesuai doc modul `commands.rs`, lebih sempit: lock tidak boleh dipegang
**selama giliran**, supaya `connect_agent` bisa mendahului giliran yang tersangkut.
`connect_agent_body` memang memegang lock melintasi `close()`/`connect()`/`new_session()`, dan
itu disengaja — dibatasi `HandshakeTimeout` dan `SessionTimeout`, dan justru merupakan mekanisme
serialisasinya. Jangan menandainya sebagai regresi.
