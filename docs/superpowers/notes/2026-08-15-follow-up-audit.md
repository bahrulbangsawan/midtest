# Audit Lanjutan Implementasi

Tanggal: 2026-08-15  
Lingkup: seluruh temuan terbuka pada catatan Sidecar MCP, ACP/Tauri, kontrol
harian, serta jalur build dan paket aplikasi saat ini.

Catatan residu yang lebih lama tetap merupakan sejarah investigasi. Status
berikut mencerminkan source tree saat audit ini dilakukan.

## Temuan yang telah ditutup

- **Sidecar tanpa .env dan runtime paket.** sidecar.rs hanya memberi
  --env-file bila file itu ada, meneruskan akar data writable terpisah, dan
  bundle Tauri membawa entry point MCP, dependensi Node, serta build-demo.js.
  Runtime di dalam .app telah dijalankan langsung dengan stdin EOF dan keluar
  bersih.
- **Request ACP yang tidak didukung tidak lagi menggantung.** Fallback
  UntypedMessage di acp/client.rs membalas -32601 Method not found, termasuk
  request ber-sessionId; peta permission juga dibersihkan saat koneksi
  ditutup.
- **Siklus hidup agen.** disconnect_agent, penggantian workspace, dan event
  keluar Tauri kini memakai shutdown idempoten yang menutup adapter aktif dan
  membangunkan permission waiter.
- **Race penyimpanan pengaturan.** File sementara settings memiliki nama unik;
  backend men-serialisasi read-modify-write, dan frontend mengantre snapshot
  agar respons lama tidak mengembalikan state baru ke nilai lama.
- **Penjaga skenario Midscene.** runGherkinScenario dan bentuk flow
  non-sequence tetap ditolak sebelum sesi dibuka. Canary sekarang memaku
  cabang playFlowItem *dan* kunci aiTaskHandlerMap, dengan resolusi paket
  melalui Node sehingga membaca copy dependensi yang benar.
- **Perintah verifikasi root.** npm test dan npm run typecheck kini
  menggabungkan suite MCP dan frontend.

## Verifikasi yang lulus

- npm test: 112 test MCP dan 55 test frontend lulus.
- npm run typecheck dan npm run build: lulus.
- cargo fmt --check, cargo test (118 unit + 7 integration), dan cargo clippy
  --all-targets -- -D warnings: lulus.
- npm run tauri --prefix app -- build --bundles app: lulus; bundle macOS
  berisi runtime MCP dan entry point-nya dapat start bersih.
- git diff --check: lulus.

## Batas yang masih perlu dipahami

- MIDSCENE_MCP_BUDGET membatasi operasi aplikasi, bukan jumlah mentah panggilan
  VLM. Satu operasi Midscene dapat melakukan replanning internal. Dokumentasi
  dan pesan tool kini menyatakannya dengan tepat; ini bukan jaminan plafon
  tagihan provider.
- Audit produksi frontend menemukan 0 vulnerability. Audit produksi MCP masih
  melaporkan 21 advisory transitif (11 high, 10 moderate) dari rantai
  Midscene/Puppeteer. npm audit fix --dry-run yang non-breaking masih
  menyisakannya; solusi yang ditawarkan audit memerlukan upgrade breaking.
  Tidak diterapkan otomatis agar tidak menukar runtime otomasi yang telah
  diverifikasi tanpa review kompatibilitas.
- Uji langsung target desktop, login adapter, dan VLM berbayar tetap
  bergantung pada TCC macOS, Chrome, Node >=24, adapter ACP, serta kredensial
  mesin pengguna. Tidak ada credential atau izin eksternal yang dipakai audit
  ini.
- Build frontend memberi peringatan ukuran satu chunk JavaScript 681.89 kB;
  itu bukan error build, tetapi layak dijadikan pekerjaan optimasi pemuatan
  berikutnya.
