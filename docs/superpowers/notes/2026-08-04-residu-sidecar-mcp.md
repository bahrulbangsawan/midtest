# Residu Terbuka: Sidecar MCP Midscene

Tanggal: 2026-08-04
Sumber: final whole-branch review dan dua ronde re-review pada branch `feat/sidecar-mcp`.

Semua temuan di bawah **sudah ada sejak awal** — bukan regresi dari pekerjaan ini — dan
sudah diadjudikasi sebagai tidak memblokir merge. Dokumen ini ada supaya temuan itu tidak
hilang bersama workspace perencanaan yang bersifat sementara.

Setiap butir diverifikasi dengan menjalankan kode, bukan membacanya.

## 1. Satuan budget meleset sampai ~21× untuk langkah `ai`

`ai`, `aiAct`, dan `aiAction` semuanya dirutekan ke `agent.aiAct()`, yang bukan satu panggilan
model melainkan **loop replanning agentik** (`tasks.mjs`, `while (true)`, keluar saat
`replanCount > replanningCycleLimit`). Default `replanningCycleLimit` adalah **20** — 100 untuk
keluarga `auto-glm`. Jadi satu flow item yang ditagih 1 unit dapat memicu sampai 21 panggilan
planning VLM, dan tiap ronde replanning menambah panggilan `Locate` per aksi yang dilokasikan.

Skenario 40 langkah yang ditagih 40 dapat mendorong beberapa ratus panggilan berbayar.

Ini konsisten dengan satuan yang README nyatakan ("satu operasi AI per langkah") dan README
sudah menyebut hitungan ini **batas bawah, bukan angka tagihan**. Yang tidak akurat adalah
kalimat yang lebih spesifik:

- Pesan galat `SCENARIO_UNSUPPORTED` dan bagian budget di README menyuruh agen menulis ulang
  alur tak terbatas sebagai langkah `ai` **"karena tiap langkah dihitung dan ditagih satu per
  satu"**. Untuk `ai` klaim itu meleset sampai ~21×.

**Tindakan:** koreksi kedua teks itu. Sebutkan pengalinya secara terbuka, atau tagih langkah
`ai` sebesar `replanningCycleLimit` bila kepastian biaya lebih penting daripada throughput.

## 2. `aiDragAndDrop` ditagih 1, sebenarnya 2

`paramSchema` untuk `DragAndDrop` punya dua field lokator (`from`, `to`), keduanya wajib, jadi
tiap pemakaian menghasilkan dua panggilan `Planning/Locate`. Dibuktikan lewat `TaskBuilder`
sungguhan:

```
DragAndDrop : [ 'Planning/Locate', 'Planning/Locate', 'Action Space/DragAndDrop' ]
Tap         : [ 'Planning/Locate', 'Action Space/Tap' ]
Navigate    : [ 'Action Space/Navigate' ]
```

Terbatas, konstan, satu key. `Swipe` juga punya dua lokator tetapi tidak terjangkau di sini:
target web menggerbangnya di balik `enableTouchEventsInActionSpace` (default `false`, dan
`src/devices/web.ts` tidak pernah menyetelnya), target computer di balik `options.size` yang
tidak dioper `ComputerDevice.actionSpace()`.

**Tindakan:** tagih `aiDragAndDrop` sebagai 2, atau tolak.

## 3. Canary buta terhadap rute dispatch kedua

Canary di `test/scenarios.test.ts` memaku daftar cabang `'X' in flowItem` yang dibaca dari
`player.mjs` terpasang. Tetapi `playFlowItem` punya rute keempat, `simpleAIKey`, yang dihitung
sebagai `Object.keys(aiTaskHandlerMap).find(...)` — bukan ekspresi `in`. Rute itu mencakup
`aiQuery`, `aiNumber`, `aiString`, `aiBoolean`, `aiAsk`, `aiLocate`.

Dibuktikan: menyuntikkan key baru ke `aiTaskHandlerMap` **tidak** menggagalkan canary.

Konsekuensinya, rilis Midscene yang menambahkan key di peta itu dapat membuka kembali kelas
lubang yang sama tanpa terdeteksi — dan dependensi memakai rentang caret (`^1.10.8`), yang
menerima kenaikan minor secara diam-diam.

**Tindakan:** perluas canary agar juga memaku key `aiTaskHandlerMap`.

## 4. Canary membaca salinan paket yang salah

Canary membaca `midscene-mcp/node_modules/@midscene/core/.../player.mjs`, sedangkan target web
sebenarnya mengeksekusi salinan di `node_modules` root. Hari ini keduanya 1.10.8 dan
byte-identik, jadi canary kebetulan memaku berkas yang benar — tetapi install yang menyimpang
akan membuatnya diam-diam memaku berkas yang salah.

**Tindakan:** hilang sendiri setelah konversi npm workspaces yang sudah diputuskan.

## Yang hanya bisa dijawab oleh run berbayar

Kedua adapter device tidak punya cakupan test otomatis — suite memakai `FakeDevice`. Hal-hal
berikut belum pernah terbukti pada perangkat sungguhan:

1. Screenshot pertama setelah `start_session` dengan URL tidak blank pada SPA. Adapter memakai
   `waitUntil: 'domcontentloaded'` dengan timeout default 30 detik, sedangkan skrip yang sudah
   terbukti (`demo-registrasi.mjs`) memakai `networkidle2` dengan timeout 60 detik.
2. `run_scenario` benar-benar mengembalikan path report, bukan "No report was written."
   Pembacaan statis `Agent.writeOutActionDumps` mengatakan `reportFile` diisi selama eksekusi,
   tetapi jalur `runYaml` secara spesifik belum diverifikasi.
3. Dengan cache aktif, `run_scenario` kedua terukur lebih murah daripada yang pertama. Itu
   satu-satunya bukti nyata bahwa perbaikan cache benar-benar mendarat.
4. `agentForComputer` membutuhkan izin macOS **Accessibility** dan **Screen Recording** —
   dua pemberian TCC yang terpisah. Tidak ada yang memeriksanya saat startup.

## Bentuk YAML yang sudah diuji dan aman

Reviewer menjalankan 11 bentuk tambahan lewat guard **dan** lewat `ScriptPlayer` sungguhan.
Tidak ditemukan undercount baru. Satu temuan struktural layak dicatat:

Interpolasi env var terjadi **di dalam** `parseYamlScript` (level teks, sebelum parse), dan
guard maupun runner memanggilnya atas string yang sama di proses yang sama. Jadi key yang
disuntikkan lewat env var terlihat oleh keduanya. Aman karena alasan struktural, bukan
kebetulan.

Merge key YAML (`<<`) tidak mengembang karena js-yaml berjalan di bawah `JSON_SCHEMA`.
