# Desain: Laporan Demo Produk dari Report Midscene

Tanggal: 2026-08-04

## Tujuan

Mengubah report HTML bawaan Midscene (debugging tool untuk engineer) menjadi
**panduan walkthrough berbahasa Indonesia** yang bisa dibaca pengguna awam —
semacam demo produk / penjelasan fitur.

## Yang dihilangkan

- Logo dan penyebutan Midscene, favicon eksternal
- Tab "Human view" / "Markdown view"
- Nama model AI, token usage, biaya, `rawResponse`
- Detail script, `yamlFlow`, timing internal per fase
- Task internal: `Planning/Plan` tanpa aksi (siklus replanning) dan `Planning/Locate`

## Sumber data

Report Midscene adalah HTML self-contained berisi:

- `<script type="midscene_web_dump" data-group-id="...">` — JSON berisi
  `executions[].tasks[]`. Ada beberapa blok (append per langkah); execution dengan
  `id` sama harus di-dedupe dengan mengambil yang **terakhir** (paling lengkap).
- `<script type="midscene-image" data-id="...">data:image/jpeg;base64,...</script>` —
  screenshot, dirujuk dari `task.uiContext.screenshot.id`.

Teks di dalam JSON di-escape: `<` → `__midscene_lt__`, `>` → `__midscene_gt__`.

### Field yang dipakai

| Field | Kegunaan |
|---|---|
| `execution.name` | Pengelompokan langkah |
| `task.type` / `subType` | Jenis langkah (`Action Space/*`, `Insight/Query`, `Insight/Assert`) |
| `task.output.log` (Planning/Plan) | Narasi manusiawi, jadi teks default |
| `task.thought` (Insight) | Penjelasan hasil pemeriksaan |
| `task.output` (Insight) | Nilai data / hasil verifikasi |
| `task.param.locate.rect` + `center` | Posisi penanda |
| `task.uiContext.screenshot.id` | Screenshot langkah |
| `task.uiContext.shotSize` | Ukuran screenshot, untuk konversi ke persentase |
| `task.timing.cost` | Durasi langkah |

### Sistem koordinat penanda

`param.locate.rect` berada di ruang piksel screenshot tersimpan — ditegaskan oleh
`param.locatedPixelBbox` pada task `Planning/Locate` yang bernilai identik, dan oleh
`parseActionParam` di `@midscene/core/dist/lib/common.js` yang membagi nilai itu dengan
`shrunkShotToLogicalRatio` untuk mendapat koordinat layar logis saat eksekusi.

Penanda diposisikan sebagai persentase: `left = rect.left / shotSize.width`.
Nilai di luar batas gambar di-clamp.

## Bentuk keluaran

Script CLI `build-demo.js`. Input report Midscene apa pun, output satu file HTML
berdiri sendiri (screenshot ter-embed base64, tanpa aset eksternal).

```
node build-demo.js <report.html> [opsi]
  --out <file>      berkas keluaran            (default: <report>.demo.html)
  --steps <file>    berkas teks bahasa Indonesia (default: <report>.steps.id.json)
  --title <teks>    judul panduan
  --subtitle <teks> subjudul
  --init-steps      tulis berkas teks lalu berhenti
```

## Alur teks bahasa Indonesia

Narasi asli ditulis model AI dalam bahasa Inggris, jadi tidak dipakai langsung.

1. `--init-steps` menghasilkan `steps.id.json`: satu entri per langkah, berisi
   `judul` dan `penjelasan` yang sudah diisi label Indonesia default, plus
   `_asli` (narasi Inggris, read-only) sebagai rujukan penulis.
2. Pengguna menyunting berkas itu.
3. Build berikutnya memakai teks tersebut; langkah tanpa entri jatuh ke default.

Pencocokan berdasarkan nomor langkah (`no`). Jika jumlah langkah berubah karena
skenario diubah, berkas di-regenerate dan entri lama yang nomornya cocok dipertahankan.

## Antarmuka

```
┌──────────────────┬────────────────────────────────────┐
│ Judul demo       │                                    │
│ progress bar     │   screenshot + lingkaran berdenyut │
│                  │   (auto-zoom ke area penanda)      │
│ ● 1 Langkah satu │                                    │
│ ● 2 Langkah dua  │  ────────────────────────────────  │
│ ○ 3 Langkah tiga │  Langkah 3 dari 4 · 1,5 detik      │
│                  │  Judul langkah                     │
│ [◀] [▶]          │  Penjelasan                        │
└──────────────────┴────────────────────────────────────┘
```

- Sidebar: daftar bernomor, klik untuk lompat, penanda langkah aktif
- Navigasi: tombol prev/next, panah kiri/kanan, Home/End
- Panel kendali di atas panggung: Putar/Jeda, garis waktu, pengatur kecepatan
  (0,5× / 1× / 1,5× / 2×), tombol perbesar area
- Penanda: lingkaran berdenyut di titik interaksi; tampilan auto-zoom ke sekitar
  penanda dengan tombol "Lihat layar penuh"
- Langkah tanpa penanda (ambil data / verifikasi) tampil layar penuh
- Responsif: sidebar pindah ke atas pada layar sempit
- Mendukung mode terang dan gelap

## Gerak

Midscene tidak pernah merekam layar — tidak ada `MediaRecorder`, `ffmpeg`, atau
perekam layar di `@midscene/computer`. Yang tersedia hanya tangkapan layar diskret
(8 gambar unik untuk run contoh). Fitur "Replay" di report bawaan pun bukan rekaman:
ia menganimasikan gambar-gambar itu di atas canvas lalu merekamnya dengan
`MediaRecorder` + `canvas.captureStream()`.

Gerak di panduan ini dibangun dengan cara serupa, tetapi langsung sebagai animasi DOM.
Urutan satu langkah:

| Waktu | Kejadian |
|---|---|
| 100 ms | Kursor sintetis mulai meluncur dari posisi langkah sebelumnya (800 ms) |
| 900 ms | Penanda lingkaran memudar masuk lalu berdenyut |
| 1200 ms | Layar "sebelum" menyilang ke layar "sesudah" (600 ms) |
| 3000 ms | Langkah berikutnya (2000 ms untuk langkah tanpa penanda) |

Tangkapan layar tidak digerakkan sama sekali — tidak ada zoom perlahan. Perbesaran
hanya terjadi bila pengguna menekan tombol "Perbesar area".

Semua durasi dibagi faktor kecepatan yang dipilih pengguna.

Dipakai **Web Animations API**, bukan transisi CSS: waktunya eksplisit, `transform`
dan `opacity` dijalankan di compositor, dan animasi bisa dibatalkan satu per satu
saat pengguna berpindah langkah atau menyalakan zoom manual.

Kursor digerakkan lewat `transform: translate()`, bukan perubahan `left`/`top`,
supaya tidak memicu layout tiap frame. Posisi akhirnya dipaku di `left`/`top`
sasaran, dan simpangan dari titik sebelumnya dihitung dalam piksel saat animasi mulai.

`prefers-reduced-motion: reduce` dihormati: seluruh gerak dilewati, langsung ke
keadaan akhir.

### Catatan pengujian

Gerakan **tidak dapat diverifikasi** dengan `chrome-headless-shell
--virtual-time-budget`: jam animasi dibekukan di sana, sehingga seluruh animasi
melapor `currentTime: 0` walau `playState: running`. Verifikasi harus memakai
browser berjam nyata (mis. playwright-core) dan membaca posisi terhitung pada
beberapa titik waktu.

## Struktur kode

`build-demo.js` — satu berkas, empat bagian berbatas jelas:

1. `extractReport(html)` → `{ executions, images }`
2. `buildSteps(executions)` → `Step[]` (penyaringan + normalisasi)
3. `loadOverrides(path, steps)` / `writeOverrides(path, steps)` → teks Indonesia
4. `renderHtml(steps, images, meta)` → string HTML

Batasnya: bagian 1–3 tidak tahu soal HTML, bagian 4 tidak tahu soal Midscene.

## Penanganan galat

- Report tanpa blok dump → keluar dengan pesan jelas, exit 1
- Blok dump tidak valid JSON → dilewati (bundel JS berisi string yang mirip tag)
- Screenshot hilang → langkah tetap tampil, area gambar diganti placeholder
- Berkas steps tidak valid JSON → peringatan, lanjut dengan teks default
