# midscene-mcp

Server MCP standalone yang membungkus [Midscene](https://midscenejs.com/) —
library otomasi UI berbasis vision-language model (VLM). Server ini bisa
dipakai oleh agen ACP/MCP apa pun (Codex, Claude Code, Zed, atau aplikasi
MidTest di repo ini) untuk menjalankan skenario QA dan menyusun
dokumentasi walkthrough berbahasa Indonesia.

Server tidak terikat pada aplikasi desktop ini. Ia hanya bicara MCP lewat
stdio, jadi bisa didaftarkan sebagai MCP server di klien mana pun yang
mendukung protokolnya.

## Prasyarat

- **Node.js >= 24** (memakai type stripping bawaan Node untuk menjalankan
  `.ts` langsung — tidak ada langkah build).
- **Google Chrome** terpasang (dipakai lewat Puppeteer untuk target `web`).
- **API key model VLM berbayar** dari salah satu family yang didukung
  Midscene (`MODEL_FAMILY_VALUES` di `@midscene/shared@1.10.8`, versi yang
  dipakai `midscene-mcp` — daftar ini bisa berubah di versi lain, cek
  `node_modules/@midscene/shared/dist/lib/env/types.js`): `doubao-vision`,
  `doubao-seed`, `gemini`, `qwen2.5-vl`, `qwen3-vl`, `qwen3`, `qwen3.5`,
  `qwen3.6`, `vlm-ui-tars`, `vlm-ui-tars-doubao`, `vlm-ui-tars-doubao-1.5`,
  `glm-v`, `auto-glm`, `auto-glm-multilingual`, `gpt-5`, `kimi`, `kimi3`,
  `xiaomi-mimo`. Ini kunci milikmu sendiri, terpisah dari langganan Codex
  CLI atau Claude Code — baca bagian [Biaya](#biaya) di bawah untuk
  alasannya.

## Konfigurasi

Salin `.env.example` di root repo menjadi `.env` dan isi kunci model:

```bash
cp .env.example .env
```

Variabel yang tersedia:

| Variabel | Keterangan |
|---|---|
| `MIDSCENE_MODEL_BASE_URL` | Endpoint API model VLM |
| `MIDSCENE_MODEL_API_KEY` | API key model VLM |
| `MIDSCENE_MODEL_NAME` | Nama model spesifik dari provider |
| `MIDSCENE_MODEL_FAMILY` | Salah satu family yang didukung — lihat daftar di [Prasyarat](#prasyarat) |
| `MIDSCENE_CACHE` | Jalur lama untuk mengaktifkan cache Midscene. **Tidak lagi diperlukan** — adapter `midscene-mcp` selalu mengirim opsi `cache` modern ke Agent, jadi cache aktif tanpa variabel ini |
| `PUPPETEER_EXECUTABLE_PATH` | Path ke binary Chrome (perlu di Apple Silicon karena Chrome bawaan Puppeteer tidak ter-sign dengan benar) |
| `MIDSCENE_MCP_BUDGET` | Batas operasi AI per sesi eksplorasi (default 40) |
| `MIDSCENE_MCP_ROOT` | Root kode MCP — dipakai server untuk menentukan `build-demo.js` dan default lokasi skenario, lihat catatan di bawah |
| `MIDSCENE_MCP_DATA_DIR` | Root writable opsional untuk `scenarios/`; aplikasi desktop mengisinya agar bundle aplikasi tidak ditulisi |

## Menjalankan dari Zed atau Claude Code

Daftarkan sebagai MCP server dengan `MIDSCENE_MCP_ROOT` diisi **path absolut
ke root repo `midtest`** — bukan ke folder `midscene-mcp/` itu
sendiri. Secara default `ScenarioStore` menyimpan skenario di
`<root>/scenarios/`, dan tool `build_walkthrough` memanggil
`<root>/build-demo.js`; keduanya diturunkan dari `MIDSCENE_MCP_ROOT`. Setel
`MIDSCENE_MCP_DATA_DIR` bila lokasi skenario harus dipisahkan dari kode.

**`--env-file` wajib ada.** Server ini tidak memakai `dotenv` dan tidak
membaca `.env` sendiri; klien MCP juga menjalankannya sebagai proses anak
yang tidak mewarisi environment shell-mu. Tanpa flag ini, server tetap
start dan `tools/list` tetap jalan, tapi `act` pertama langsung gagal
karena tidak ada kunci model. Arahkan flag ke `.env` di **root repo** —
berkas yang sama yang kamu buat dengan `cp .env.example .env` di atas.

```json
{
  "mcpServers": {
    "midscene": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/midtest/.env",
        "/absolute/path/to/midtest/midscene-mcp/src/index.ts"
      ],
      "env": {
        "MIDSCENE_MCP_ROOT": "/absolute/path/to/midtest"
      }
    }
  }
}
```

Semua variabel di tabel di atas — `MIDSCENE_MODEL_*`, `MIDSCENE_CACHE`,
`PUPPETEER_EXECUTABLE_PATH`, `MIDSCENE_MCP_BUDGET` — dibaca dari berkas itu.
`MIDSCENE_MCP_ROOT` sengaja tetap di blok `env` karena ia menunjuk ke lokasi
repo, bukan konfigurasi model; menaruhnya di `.env` juga boleh.

Kalau `.env` belum tentu ada (misalnya konfigurasi yang dibagikan ke mesin
lain), pakai `--env-file-if-exists=` dengan path yang sama: `--env-file`
membuat `node` gagal start bila berkasnya tidak ditemukan.

## Sepuluh tool

| Tool | Fungsi |
|---|---|
| `start_session` | Membuka sesi otomasi ke target `web` (browser) atau `computer` (desktop macOS). Hanya satu sesi boleh berjalan sekaligus. `url` harus absolut dan berskema (`https://…`); yang tidak sah ditolak `INVALID_URL` sebelum browser diluncurkan. |
| `act` | Menjalankan satu aksi UI dalam bahasa natural (mis. "klik tombol masuk"). Memakai satu operasi AI dari budget. |
| `query` | Mengekstrak data terstruktur dari layar saat ini sesuai skema yang diminta. Memakai satu operasi AI. |
| `assert` | Memverifikasi klaim tentang layar saat ini; tool call gagal bila klaim salah. Memakai satu operasi AI. |
| `screenshot` | Mengambil tangkapan layar saat ini. Gratis — tidak memakai budget operasi AI. |
| `end_session` | Menutup sesi yang berjalan dan melepas koneksi browser/desktop. |
| `save_scenario` | Membekukan urutan langkah yang terbukti berhasil saat eksplorasi menjadi berkas YAML Midscene yang bisa dipakai ulang. |
| `list_scenarios` | Menampilkan daftar nama skenario yang sudah tersimpan. |
| `run_scenario` | Memutar ulang skenario tersimpan dari awal sampai akhir dengan cache Midscene aktif — cache hit dapat melewati kerja vision. Untuk target `web`, sesi lebih dulu membuka alamat yang ditulis skenario itu sendiri (`page:` / `browser:` / `web:` / `target:`), atau alamat dari argumen `url` bila diberikan. Server memesan satu operasi *budget sesi* per langkah `flow` di muka; itu penjaga kerja terbatas, bukan hitungan mentah panggilan model karena satu operasi Midscene yang belum tercache dapat melakukan re-planning internal. Skenario yang lebih panjang dari budget ditolak `BUDGET_EXCEEDED` dan tidak dijalankan sama sekali. |
| `build_walkthrough` | Mengubah report Midscene menjadi halaman walkthrough berbahasa Indonesia yang berdiri sendiri. |

## Alur kerja

1. **Eksplorasi sekali** — `start_session`, lalu campuran `act` / `query` /
   `assert` / `screenshot` sampai alurnya terbukti benar. Ini tahap yang
   membayar VLM secara penuh.
2. **`save_scenario`** — bekukan langkah yang berhasil jadi YAML.
3. **`run_scenario` berulang** — jalankan skenario tersimpan sesering
   dibutuhkan untuk regresi. Replay ini nyaris gratis karena cache Midscene
   melewati panggilan VLM; cache-nya aktif otomatis, tidak perlu
   `MIDSCENE_CACHE=1`. Tapi replay tetap dibatasi budget — lihat
   [Batas budget](#batas-budget).
4. **`build_walkthrough`** — ambil report dari salah satu run dan susun jadi
   dokumentasi walkthrough Indonesia yang bisa dibagikan.

## Biaya

**Memakai langganan Codex atau Claude Code tidak menghilangkan kebutuhan
API key model vision berbayar.** Agen ACP-nya merencanakan dan menulis
skenario/narasi — itu bagian yang tercakup langganan. Tapi grounding visual
Midscene (screenshot → koordinat elemen) dikerjakan VLM terpisah, dan itu
ditagih terpisah lewat API key sendiri.

Yang benar-benar menghemat biaya adalah **cache Midscene**: run eksplorasi
pertama membayar penuh, tapi run replay berikutnya lewat cache nyaris
gratis. Adapter di sini mengirim opsi `cache` modern ke Agent Midscene
(bukan cuma `cacheId`, yang hanya berlaku kalau `MIDSCENE_CACHE` di-set),
jadi `TaskCache` benar-benar terbentuk tanpa bergantung pada variabel
environment.

| Lapisan | Pelaksana | Biaya |
|---|---|---|
| Rencanakan skenario, tulis script | Agen ACP | langganan |
| Run pertama: eksplorasi & grounding | VLM Midscene | API, sekali |
| Run ulang / regresi | Cache Midscene | ~nol |
| Tulis narasi dokumentasi Indonesia | Agen ACP | langganan |

## Batas budget

Server membatasi jumlah **operasi berbasis AI** per sesi — yaitu panggilan
ke `act`, `query`, dan `assert`. `screenshot` gratis dan tidak dihitung.
Batas ini adalah **hitungan operasi, bukan hitungan panggilan model
mentah**: satu `act` bisa memicu lebih dari satu panggilan model di
internal Midscene, jadi angka budget adalah batas bawah yang bisa
diprediksi, bukan angka tagihan.

Budget dipesan **sebelum** operasinya dijalankan, bukan setelah berhasil.
Operasi yang gagal tetap memotong budget: kegagalan tetap membayar model.

`run_scenario` juga ikut dibatasi, bukan pengecualian. Saat replay
dijalankan, server mengurai YAML skenario dengan parser Midscene sendiri
(`parseYamlScript` — parser yang sama yang dipakai `runYaml`), menghitung
seluruh langkah `flow` di semua task, lalu memotong sebanyak itu di muka:

- Skenario dengan langkah lebih banyak daripada budget ditolak
  `BUDGET_EXCEEDED` **sebelum** sesi dibuka — tidak ada browser yang
  diluncurkan dan tidak ada satu pun langkah yang dijalankan.
- Semua langkah dihitung, termasuk yang sebenarnya gratis (`sleep`,
  `javascript`, `logScreenshot`). Ini penjaga biaya, jadi ia sengaja
  membulatkan ke arah menagih lebih — kosakata `flow` Midscene bertambah
  antar-rilis, dan kunci yang belum dikenal berkas ini tidak boleh otomatis
  gratis.
- Skenario yang YAML-nya tidak bisa diurai ditolak (`INTERNAL`), bukan
  diloloskan tanpa batas. Kalau biayanya tidak bisa dihitung, ia tidak
  dijalankan.
- Langkah `runGherkinScenario` ditolak (`SCENARIO_UNSUPPORTED`), juga
  sebelum sesi dibuka. Satu langkah itu mengembang jadi sejumlah operasi AI
  yang tidak terbatas saat runtime — tidak ada batas langkah di
  `run-gherkin-scenario.mjs` — jadi menghitungnya sebagai satu langkah
  membuat skenario bisa membayar berapa pun dengan plafon satu. Lebih buruk
  lagi, `yaml/player.mjs` menjalankannya dengan `cacheable: false`, jadi
  cache Midscene tidak pernah berlaku dan setiap replay membayar VLM penuh —
  ini merusak premis "replay nyaris gratis", bukan cuma plafon budget.
  Tulis alurnya sebagai langkah eksplisit (`ai`, `aiAssert`, `aiWaitFor`)
  seperti yang memang dihasilkan tool eksplorasi; penjaga ini memesan satu unit
  budget sesi per item eksplisit dan operasi yang memenuhi syarat dapat memakai
  cache. Ini bukan hitungan mentah VLM: satu operasi Midscene dapat melakukan
  beberapa panggilan internal saat re-planning.
- `flow` yang ditulis sebagai **mapping** (atau string, atau dibiarkan
  kosong) ditolak juga (`SCENARIO_UNSUPPORTED`), sebelum sesi dibuka.
  `parseYamlScript` memvalidasi `tasks` harus array tapi tidak pernah
  memeriksa `flow`, sementara Midscene menelusurinya dengan
  `for (const flowItemIndex in flow)` — jadi mapping tetap dijalankan
  seperti sequence biasa. Menganggap bentuk non-array sebagai "nol langkah"
  berarti seluruh isinya lolos tanpa dihitung dan tanpa diperiksa. `flow`
  harus berupa sequence: satu entri `- ` per langkah.
- Hasil yang sukses melaporkan potongannya: `Charged N of LIMIT AI
  operations.`

### Alamat replay

Skenario harus berdiri sendiri: alamat yang dibuka ikut tersimpan di YAML-nya.
`Agent.runYaml` memainkan flow pada agent yang **sudah** terikat ke satu halaman
dan tidak pernah melakukan navigasi, jadi `url:` di dalam YAML tidak berarti apa-apa
kecuali sesi yang membukanya. Karena itu `run_scenario` membaca alamat itu dari YAML
(pada parse yang sama dengan penghitung langkah, bukan parse kedua) lalu meneruskannya
ke `start`.

- Empat kunci Midscene untuk lingkungan web — `page`, `browser`, `web`, `target` —
  semuanya diterima. Midscene **tidak** menetapkan presedensi antar-alias:
  `resolveWebTarget` menolak dokumen yang memakai lebih dari satu ("Only one web
  target can be specified"), dan `parseYamlScript` sudah memanggilnya. Server ini
  memakai fungsi Midscene itu juga, bukan daftar alias sendiri.
- Argumen `url` pada `run_scenario` menimpa nilai YAML — untuk memutar alur yang sama
  di staging, misalnya.
- Target `web` tanpa alamat di mana pun ditolak `SCENARIO_NO_URL` **sebelum** browser
  dibuka, lengkap dengan blok yang harus ditambahkan. Dulu kasus ini berjalan diam-diam
  di halaman kosong dan setiap `aiAssert` gagal.
- Target `computer` tidak punya alamat: `url` diabaikan dan disebutkan di hasilnya,
  persis seperti `start_session`.
- Alamat yang tidak bisa dibuka — tanpa skema (`contoh.test`), tidak terurai sama
  sekali, atau berskema yang tidak masuk akal untuk sesi (`mailto:`, `javascript:`) —
  ditolak `INVALID_URL` **sebelum** browser diluncurkan. Yang diterima: `http`,
  `https`, `file`. Kodenya ditandai *retryable*: nilainya datang dari pemanggil dan
  bisa diperbaiki lalu dicoba lagi, jadi hasilnya berbunyi "You may retry", bukan
  "Do not retry".
- Pemeriksaan itu duduk di `SessionManager.start`, bukan di masing-masing handler tool,
  karena `start_session` dan `run_scenario` sama-sama membuka sesi lewat sana — satu cek
  untuk dua pintu, sehingga keduanya tidak bisa saling melenceng.

Cache tidak mengurangi potongan ini. Cache memangkas **tagihan sungguhan**
(langkah yang kena cache tidak memanggil VLM), sementara budget adalah
plafon atas yang dihitung tanpa menebak-nebak isi cache.

Default-nya 40 operasi per sesi. Ubah lewat `MIDSCENE_MCP_BUDGET` di
environment. Nilai yang tidak valid (bukan bilangan bulat positif —
termasuk `2.5`, `0`, `-1`, dan `bogus`) diabaikan: server kembali ke default
40 dan mencetak peringatan ke stderr, bukan gagal diam-diam. Validasi ini
ada di dalam `SessionManager` sendiri, bukan cuma di `src/index.ts`, jadi
tidak ada jalur konstruksi yang bisa membuat sesi berjalan tanpa batas.

Ketika budget habis, `spend()` melempar galat `BUDGET_EXCEEDED` dan sesi
harus ditutup dengan `end_session` sebelum sesi baru dibuka.

## Dependensi dan npm workspaces

Paket ini adalah anggota npm workspace dari repo induknya. Jalankan
`npm install` **di root repo**, bukan di direktori ini:

```bash
cd ..          # akar repo
npm install
npm ls -w midscene-mcp    # memeriksa dependensi paket ini
```

Menjalankan `npm ls` dari dalam `midscene-mcp/` akan melaporkan
`UNMET DEPENDENCY` secara keliru, karena npm memperlakukannya sebagai proyek
berdiri sendiri alih-alih anggota workspace. Pakai `-w` dari root.

Satu lock tunggal ada di root. Konfigurasi ini yang membuat pin versi di
`package.json` paket ini benar-benar ditegakkan: bila suatu dependensi bentrok
dengan versi milik paket lain di repo, npm menyarangkannya di
`midscene-mcp/node_modules` alih-alih diam-diam memberikan versi milik paket
tetangga. `zod` saat ini persis begitu — versi 4 dipakai paket ini dan MCP SDK,
sementara `@midscene/*` memakai versi 3 yang tersarang di bawahnya.

Karena dependensi bisa ter-*hoist* ke root, **jangan pernah menulis jalur
`node_modules` secara literal** — beberapa test sengaja membaca berkas internal
Midscene, dan semuanya melewati `test/lokasi-paket.ts` yang me-resolve lewat
Node. Jalur literal akan pecah saat hoisting berubah, atau lebih buruk, diam-diam
memeriksa salinan yang berbeda dari yang benar-benar dimuat kode produksi.

## Menjalankan tes

```bash
npm test --prefix midscene-mcp
```

Tes ini memakai `FakeDevice` dan tidak memanggil model VLM sungguhan atau
membuka browser — aman dijalankan kapan saja tanpa biaya. Verifikasi
integrasi nyata (sesi browser sungguhan + panggilan VLM berbayar) adalah
langkah terpisah yang sengaja tidak diotomasi di sini; jalankan manual
sesuai kebutuhan.
