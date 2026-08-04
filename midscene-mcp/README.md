# midscene-mcp

Server MCP standalone yang membungkus [Midscene](https://midscenejs.com/) —
library otomasi UI berbasis vision-language model (VLM). Server ini bisa
dipakai oleh agen ACP/MCP apa pun (Codex, Claude Code, Zed, atau aplikasi
Midscene Desktop di repo ini) untuk menjalankan skenario QA dan menyusun
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
| `MIDSCENE_CACHE` | Set ke `1` untuk mengaktifkan cache Midscene |
| `PUPPETEER_EXECUTABLE_PATH` | Path ke binary Chrome (perlu di Apple Silicon karena Chrome bawaan Puppeteer tidak ter-sign dengan benar) |
| `MIDSCENE_MCP_BUDGET` | Batas operasi AI per sesi eksplorasi (default 40) |
| `MIDSCENE_MCP_ROOT` | Root repo — dipakai server untuk menentukan lokasi `scenarios/` dan `build-demo.js`, lihat catatan di bawah |

## Menjalankan dari Zed atau Claude Code

Daftarkan sebagai MCP server dengan `MIDSCENE_MCP_ROOT` diisi **path absolut
ke root repo `midscene-desktop`** — bukan ke folder `midscene-mcp/` itu
sendiri. `ScenarioStore` menyimpan skenario di `<root>/scenarios/`, dan tool
`build_walkthrough` memanggil `<root>/build-demo.js`; keduanya diturunkan
dari `MIDSCENE_MCP_ROOT`.

```json
{
  "mcpServers": {
    "midscene": {
      "command": "node",
      "args": ["/absolute/path/to/midscene-desktop/midscene-mcp/src/index.ts"],
      "env": {
        "MIDSCENE_MCP_ROOT": "/absolute/path/to/midscene-desktop"
      }
    }
  }
}
```

Variabel model (`MIDSCENE_MODEL_*`) dan `MIDSCENE_CACHE` juga perlu
tersedia di environment tempat proses `node` ini berjalan — isi lewat blok
`env` yang sama atau lewat `.env` yang sudah di-load shell induknya.

## Sepuluh tool

| Tool | Fungsi |
|---|---|
| `start_session` | Membuka sesi otomasi ke target `web` (browser) atau `computer` (desktop macOS). Hanya satu sesi boleh berjalan sekaligus. |
| `act` | Menjalankan satu aksi UI dalam bahasa natural (mis. "klik tombol masuk"). Memakai satu operasi AI dari budget. |
| `query` | Mengekstrak data terstruktur dari layar saat ini sesuai skema yang diminta. Memakai satu operasi AI. |
| `assert` | Memverifikasi klaim tentang layar saat ini; tool call gagal bila klaim salah. Memakai satu operasi AI. |
| `screenshot` | Mengambil tangkapan layar saat ini. Gratis — tidak memakai budget operasi AI. |
| `end_session` | Menutup sesi yang berjalan dan melepas koneksi browser/desktop. |
| `save_scenario` | Membekukan urutan langkah yang terbukti berhasil saat eksplorasi menjadi berkas YAML Midscene yang bisa dipakai ulang. |
| `list_scenarios` | Menampilkan daftar nama skenario yang sudah tersimpan. |
| `run_scenario` | Memutar ulang skenario tersimpan dari awal sampai akhir dengan cache Midscene aktif — murah karena langkah yang sudah di-cache melewati model vision sepenuhnya. |
| `build_walkthrough` | Mengubah report Midscene menjadi halaman walkthrough berbahasa Indonesia yang berdiri sendiri. |

## Alur kerja

1. **Eksplorasi sekali** — `start_session`, lalu campuran `act` / `query` /
   `assert` / `screenshot` sampai alurnya terbukti benar. Ini tahap yang
   membayar VLM secara penuh.
2. **`save_scenario`** — bekukan langkah yang berhasil jadi YAML.
3. **`run_scenario` berulang** — jalankan skenario tersimpan sesering
   dibutuhkan untuk regresi. Dengan `MIDSCENE_CACHE=1`, replay ini nyaris
   gratis karena cache Midscene melewati panggilan VLM.
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
gratis.

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

Default-nya 40 operasi per sesi. Ubah lewat `MIDSCENE_MCP_BUDGET` di
environment. Nilai yang tidak valid (bukan angka positif) diabaikan — server
kembali ke default 40 dan mencetak peringatan ke stderr, bukan gagal diam-diam.

Ketika budget habis, `spend()` melempar galat `BUDGET_EXCEEDED` dan sesi
harus ditutup dengan `end_session` sebelum sesi baru dibuka.

## Keterbatasan dependensi yang diketahui

Saat ini `@midscene/web` dan `puppeteer` hanya ter-resolve lewat hoisting
dari `node_modules` di root repo, bukan dari `midscene-mcp/node_modules`
sendiri. Akibatnya `npm ls` yang dijalankan di dalam `midscene-mcp/`
melaporkan `UNMET DEPENDENCY` untuk keduanya walau di runtime keduanya
tetap ter-resolve dengan benar via hoisting. Ini **bukan berarti paket ini
terpasang bersih secara standalone** — install-nya masih bergantung pada
`npm install` yang dijalankan di root repo. Konversi ke npm workspaces
sudah direncanakan untuk membereskan ini — pending semata karena root repo
punya perubahan uncommitted (`package.json`, `package-lock.json`, dan lain-
lain) yang harus landing dulu sebelum konversi itu bisa dikerjakan tanpa
menabrak pekerjaan yang belum di-commit.

## Menjalankan tes

```bash
npm test --prefix midscene-mcp
```

Tes ini memakai `FakeDevice` dan tidak memanggil model VLM sungguhan atau
membuka browser — aman dijalankan kapan saja tanpa biaya. Verifikasi
integrasi nyata (sesi browser sungguhan + panggilan VLM berbayar) adalah
langkah terpisah yang sengaja tidak diotomasi di sini; jalankan manual
sesuai kebutuhan.
