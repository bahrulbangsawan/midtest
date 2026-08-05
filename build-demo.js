#!/usr/bin/env node
/**
 * Mengubah report Midscene menjadi panduan walkthrough berbahasa Indonesia.
 *
 *   node build-demo.js <report.html> [opsi]
 *
 *     --out <file>       berkas keluaran               (default: <report>.demo.html)
 *     --steps <file>     berkas teks bahasa Indonesia  (default: <report>.steps.id.json)
 *     --title <teks>     judul panduan
 *     --subtitle <teks>  subjudul
 *     --init-steps       tulis berkas teks lalu berhenti
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

// ---------------------------------------------------------------- 1. ekstraksi

const DUMP_TAG = /<script[^>]*type="midscene_web_dump"[^>]*>([\s\S]*?)<\/script>/g;
const IMAGE_TAG = /<script[^>]*type="midscene-image"[^>]*data-id="([^"]+)"[^>]*>([\s\S]*?)<\/script>/g;

/** Membalik escape yang dipakai Midscene agar isi dump aman di dalam tag script. */
function unescapeText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replaceAll('__midscene_lt__', '<')
    .replaceAll('__midscene_gt__', '>')
    .trim();
}

/**
 * Report ditulis dengan cara append: satu execution bisa muncul berkali-kali,
 * makin lengkap tiap kali. Yang terakhir menang.
 */
function extractReport(html) {
  const byId = new Map();
  const order = [];

  for (const match of html.matchAll(DUMP_TAG)) {
    // Bundel JS di dalam report ikut mengandung string yang menyerupai tag ini.
    let dump;
    try {
      dump = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    if (!Array.isArray(dump?.executions)) continue;
    for (const execution of dump.executions) {
      const key = execution.id ?? `anon-${order.length}`;
      if (!byId.has(key)) order.push(key);
      byId.set(key, execution);
    }
  }

  const images = new Map();
  for (const match of html.matchAll(IMAGE_TAG)) {
    images.set(match[1], match[2].trim());
  }

  return { executions: order.map((key) => byId.get(key)), images };
}

// ------------------------------------------------------------ 2. bentuk langkah

const LABEL_AKSI = {
  Tap: 'Klik',
  Click: 'Klik',
  RightClick: 'Klik kanan',
  DoubleClick: 'Klik dua kali',
  Hover: 'Arahkan kursor',
  Input: 'Ketik teks',
  KeyboardPress: 'Tekan tombol',
  Scroll: 'Gulir layar',
  Drag: 'Seret',
  DragAndDrop: 'Seret dan lepas',
  Sleep: 'Jeda sejenak',
  Navigate: 'Buka halaman',
  Launch: 'Buka aplikasi',
  Screenshot: 'Ambil tangkapan layar',
  Query: 'Ambil data',
  Assert: 'Verifikasi',
  Boolean: 'Periksa kondisi',
  String: 'Ambil teks',
  Number: 'Ambil angka',
};

const KIND_AKSI = 'aksi';
const KIND_DATA = 'data';
const KIND_VERIFIKASI = 'verifikasi';

function labelAksi(subType) {
  return LABEL_AKSI[subType] ?? subType ?? 'Langkah';
}

/** Narasi manusiawi yang ditulis model saat merencanakan aksi. */
function narasiRencana(task) {
  const dariOutput = unescapeText(task.output?.log);
  if (dariOutput) return dariOutput;
  const raw = unescapeText(task.log?.rawResponse);
  const cocok = raw.match(/<log>([\s\S]*?)<\/log>/);
  return cocok ? cocok[1].trim() : '';
}

/** Nilai mentah dari task Insight diubah jadi kalimat yang enak dibaca. */
function ringkasNilai(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Sesuai harapan' : 'Tidak sesuai harapan';
  if (Array.isArray(value)) return value.map(ringkasNilai).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([kunci, isi]) => `${kunci}: ${ringkasNilai(isi)}`)
      .join(' · ');
  }
  return String(value);
}

function normalisasiRect(rect, shotSize) {
  if (!rect || !shotSize?.width || !shotSize?.height) return null;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const left = clamp(rect.left / shotSize.width);
  const top = clamp(rect.top / shotSize.height);
  return {
    left,
    top,
    width: clamp((rect.width ?? 0) / shotSize.width),
    height: clamp((rect.height ?? 0) / shotSize.height),
    centerX: clamp((rect.left + (rect.width ?? 0) / 2) / shotSize.width),
    centerY: clamp((rect.top + (rect.height ?? 0) / 2) / shotSize.height),
  };
}

/**
 * Menyaring task internal menjadi daftar langkah yang bermakna bagi pembaca.
 * Planning/Plan hanya dipanen narasinya; Planning/Locate hanya dipanen koordinatnya.
 */
function buildSteps(executions) {
  const steps = [];

  for (const execution of executions ?? []) {
    let narasi = '';
    let lokasiTertunda = null;

    for (const task of execution.tasks ?? []) {
      const { type, subType } = task;

      if (type === 'Planning' && subType === 'Plan') {
        const teks = narasiRencana(task);
        if (teks) narasi = teks;
        continue;
      }
      if (type === 'Planning' && subType === 'Locate') {
        lokasiTertunda = task.output?.element?.rect ?? null;
        continue;
      }
      if (type !== 'Action Space' && type !== 'Insight') continue;

      const shotSize = task.uiContext?.shotSize;
      const rect = task.param?.locate?.rect ?? lokasiTertunda;
      const isInsight = type === 'Insight';
      // Frame "sesudah" dipakai untuk silang-pudar agar perubahan layar terlihat.
      const sesudah = (task.recorder ?? []).filter((entri) => entri?.screenshot).pop();

      steps.push({
        no: steps.length + 1,
        kind: isInsight ? (subType === 'Assert' ? KIND_VERIFIKASI : KIND_DATA) : KIND_AKSI,
        label: labelAksi(subType),
        target: unescapeText(task.param?.locate?.description),
        narasi: isInsight ? unescapeText(task.thought) : narasi,
        hasil: isInsight ? ringkasNilai(task.output) : '',
        instruksi: unescapeText(execution.name),
        penanda: isInsight ? null : normalisasiRect(rect, shotSize),
        rasio: shotSize?.width && shotSize?.height ? shotSize.width / shotSize.height : null,
        shotId: task.uiContext?.screenshot?.id ?? null,
        shotSesudahId: sesudah?.screenshot?.id ?? null,
        durasiMs: task.timing?.cost ?? null,
        gagal: task.status !== 'finished',
      });

      narasi = '';
      lokasiTertunda = null;
    }
  }

  return steps;
}

// ------------------------------------------------------- 3. teks bahasa Indonesia

function judulDefault(step) {
  if (step.kind === KIND_VERIFIKASI) return 'Memastikan hasil sesuai';
  if (step.kind === KIND_DATA) return 'Membaca informasi di layar';
  return step.target ? `${step.label} ${step.target}` : step.label;
}

function writeOverrides(path, steps) {
  const isi = steps.map((step) => ({
    no: step.no,
    judul: judulDefault(step),
    penjelasan: '',
    _asli: step.narasi || step.instruksi || '',
  }));
  writeFileSync(path, `${JSON.stringify(isi, null, 2)}\n`, 'utf-8');
}

function loadOverrides(path) {
  if (!path || !existsSync(path)) return new Map();
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(data)) throw new Error('bukan array');
    return new Map(data.filter((entri) => entri?.no).map((entri) => [entri.no, entri]));
  } catch (error) {
    console.warn(`Peringatan: ${path} tidak terbaca (${error.message}), memakai teks default.`);
    return new Map();
  }
}

function applyOverrides(steps, overrides) {
  return steps.map((step) => {
    const entri = overrides.get(step.no);
    return {
      ...step,
      judul: entri?.judul?.trim() || judulDefault(step),
      penjelasan: entri?.penjelasan?.trim() || step.narasi || '',
    };
  });
}

// ---------------------------------------------------------------- 4. render HTML

const escapeHtml = (teks) =>
  String(teks ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const formatDurasi = (ms) => {
  if (!ms && ms !== 0) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} detik`;
};

function renderHtml(steps, images, meta) {
  const dipakai = new Set(
    steps.flatMap((step) => [step.shotId, step.shotSesudahId]).filter(Boolean),
  );
  const gambar = Object.fromEntries([...dipakai].map((id) => [id, images.get(id) ?? null]));

  const data = {
    judul: meta.title,
    subjudul: meta.subtitle,
    langkah: steps.map((step) => ({
      no: step.no,
      judul: step.judul,
      penjelasan: step.penjelasan,
      label: step.label,
      kind: step.kind,
      hasil: step.hasil,
      durasi: formatDurasi(step.durasiMs),
      gagal: step.gagal,
      penanda: step.penanda,
      rasio: step.rasio,
      shotId: step.shotId,
      shotSesudahId: step.shotSesudahId,
    })),
    gambar,
  };

  // "<" di-escape agar payload tidak bisa menutup tag script lebih awal.
  const payload = JSON.stringify(data).replaceAll('<', '\\u003c');

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<style>
  :root {
    --bg: #f4f5f7;
    --panel: #ffffff;
    --ink: #16181d;
    --ink-lembut: #5c6270;
    --garis: #e3e5ea;
    --aksen: #2f6df6;
    --aksen-lembut: #eaf0ff;
    --radius: 14px;
    --sidebar: 320px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101216;
      --panel: #181b21;
      --ink: #eef0f4;
      --ink-lembut: #9aa1b1;
      --garis: #262a33;
      --aksen: #6c9bff;
      --aksen-lembut: #1e2740;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .layar { display: flex; min-height: 100vh; gap: 20px; padding: 20px; }

  /* ---- sidebar ---- */
  .sisi {
    width: var(--sidebar);
    flex: 0 0 var(--sidebar);
    background: var(--panel);
    border: 1px solid var(--garis);
    border-radius: var(--radius);
    padding: 22px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    position: sticky;
    top: 20px;
    max-height: calc(100vh - 40px);
  }
  .judul-demo { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
  .subjudul { margin: 4px 0 0; font-size: 13px; color: var(--ink-lembut); }
  .bar { height: 4px; border-radius: 99px; background: var(--garis); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--aksen); transition: width .25s ease; }

  .daftar { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
  .daftar li { margin-bottom: 2px; }
  .daftar button {
    width: 100%;
    display: flex;
    gap: 11px;
    align-items: flex-start;
    text-align: left;
    background: none;
    border: 0;
    border-radius: 9px;
    padding: 9px 10px;
    cursor: pointer;
    color: var(--ink-lembut);
    font: inherit;
    font-size: 13.5px;
    line-height: 1.45;
  }
  .daftar button:hover { background: var(--aksen-lembut); }
  .daftar li.aktif button { background: var(--aksen-lembut); color: var(--ink); font-weight: 600; }
  .nomor {
    flex: 0 0 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--garis);
    color: var(--ink-lembut);
    font-size: 11.5px;
    font-weight: 650;
    display: grid;
    place-items: center;
    margin-top: 1px;
  }
  .daftar li.aktif .nomor, .daftar li.lewat .nomor { background: var(--aksen); color: #fff; }
  .daftar li.lewat button { color: var(--ink); }

  .navigasi { display: flex; gap: 8px; }
  .navigasi button {
    flex: 1;
    padding: 10px;
    border-radius: 9px;
    border: 1px solid var(--garis);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-weight: 600;
    font-size: 13.5px;
    cursor: pointer;
  }
  .navigasi button:hover:not(:disabled) { border-color: var(--aksen); color: var(--aksen); }
  .navigasi button:disabled { opacity: .4; cursor: default; }

  /* ---- panggung ---- */
  .utama { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
  .panggung {
    position: relative;
    background: var(--panel);
    border: 1px solid var(--garis);
    border-radius: var(--radius);
    overflow: hidden;
    flex: 1;
    min-height: 380px;
    display: grid;
    place-items: center;
  }
  .bingkai {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    display: grid;
    place-items: center;
  }
  /* Kotak disamakan persis dengan rasio tangkapan layar supaya penanda dan
     kursor yang diposisikan dalam persen jatuh tepat di atas piksel sasaran. */
  .bingkai .geser {
    position: relative;
    width: 100%;
    max-width: 100%;
    max-height: 100%;
    aspect-ratio: var(--rasio, 16 / 10);
    transition: transform .45s cubic-bezier(.22,.61,.36,1);
  }
  .lapis {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: fill;
    opacity: 0;
  }
  .lapis.tampak { opacity: 1; }

  /* Kursor sintetis: Midscene tidak merekam kursor asli, jadi digambar ulang. */
  .kursor {
    position: absolute;
    width: 24px;
    height: 24px;
    margin: -3px 0 0 -2px;
    pointer-events: none;
    opacity: 0;
    filter: drop-shadow(0 2px 5px rgba(0,0,0,.55));
    transition: opacity .3s ease;
  }
  .kursor.tampak { opacity: 1; }

  /* Titik dibuat kecil dan berongga agar sasaran di bawahnya tetap terlihat. */
  .titik {
    position: absolute;
    width: 14px;
    height: 14px;
    margin: -7px 0 0 -7px;
    border-radius: 50%;
    background: rgba(47,109,246,.95);
    box-shadow: 0 0 0 2.5px #fff, 0 2px 8px rgba(0,0,0,.4);
    opacity: 0;
  }
  .titik.tampak { opacity: 1; }
  .titik::after {
    content: "";
    position: absolute;
    inset: -13px;
    border-radius: 50%;
    border: 3px solid rgba(47,109,246,.8);
    animation: denyut 1.8s ease-out infinite;
  }
  @keyframes denyut {
    0%   { transform: scale(.55); opacity: 1; }
    100% { transform: scale(2.1); opacity: 0; }
  }

  .kosong { color: var(--ink-lembut); font-size: 14px; padding: 40px; text-align: center; }

  .kendali {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 12px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 12px;
    border: 1px solid var(--garis);
    background: var(--panel);
    opacity: .95;
  }
  .kendali button {
    padding: 6px 13px;
    border-radius: 99px;
    border: 1px solid var(--garis);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .kendali button:hover { border-color: var(--aksen); color: var(--aksen); }
  .kendali .putar { background: var(--aksen); border-color: var(--aksen); color: #fff; min-width: 92px; }
  .kendali .putar:hover { opacity: .9; color: #fff; }
  .lini { flex: 1; height: 4px; border-radius: 99px; background: var(--garis); overflow: hidden; }
  .lini i { display: block; height: 100%; width: 0; background: var(--aksen); }
  .kendali select {
    border: 1px solid var(--garis);
    background: var(--panel);
    color: var(--ink);
    border-radius: 99px;
    padding: 6px 8px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  }

  /* ---- keterangan ---- */
  .keterangan {
    background: var(--panel);
    border: 1px solid var(--garis);
    border-radius: var(--radius);
    padding: 20px 22px;
  }
  .meta { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .meta span { font-size: 12px; color: var(--ink-lembut); }
  .lencana {
    padding: 3px 9px;
    border-radius: 99px;
    background: var(--aksen-lembut);
    color: var(--aksen);
    font-size: 11.5px;
    font-weight: 650;
  }
  .lencana.gagal { background: #fdecec; color: #c0362c; }
  @media (prefers-color-scheme: dark) { .lencana.gagal { background: #3a1f1e; color: #ff8b80; } }
  .keterangan h2 { margin: 0 0 6px; font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
  .keterangan p { margin: 0; color: var(--ink-lembut); max-width: 68ch; }
  .hasil {
    margin-top: 12px;
    padding: 10px 13px;
    border-left: 3px solid var(--aksen);
    background: var(--aksen-lembut);
    border-radius: 0 8px 8px 0;
    font-size: 13.5px;
  }
  .petunjuk { margin-top: 14px; font-size: 12px; color: var(--ink-lembut); }

  @media (max-width: 900px) {
    .layar { flex-direction: column; padding: 14px; gap: 14px; }
    .sisi { width: auto; flex: none; position: static; max-height: none; }
    .daftar { max-height: 220px; }
  }
</style>
</head>
<body>
<div class="layar">
  <aside class="sisi">
    <div>
      <h1 class="judul-demo" id="judul"></h1>
      <p class="subjudul" id="subjudul"></p>
    </div>
    <div class="bar"><i id="bar"></i></div>
    <ul class="daftar" id="daftar"></ul>
    <div class="navigasi">
      <button id="mundur" type="button">&#9664; Sebelumnya</button>
      <button id="maju" type="button">Berikutnya &#9654;</button>
    </div>
  </aside>

  <main class="utama">
    <div class="panggung">
      <div class="bingkai" id="bingkai"></div>
      <div class="kendali">
        <button class="putar" id="putar" type="button">&#9654; Putar</button>
        <div class="lini"><i id="lini"></i></div>
        <select id="kecepatan" aria-label="Kecepatan">
          <option value="0.5">0,5&times;</option>
          <option value="1" selected>1&times;</option>
          <option value="1.5">1,5&times;</option>
          <option value="2">2&times;</option>
        </select>
        <button id="zoom" type="button" hidden>Perbesar area</button>
      </div>
    </div>
    <section class="keterangan">
      <div class="meta" id="meta"></div>
      <h2 id="langkah-judul"></h2>
      <p id="langkah-penjelasan"></p>
      <div class="hasil" id="hasil" hidden></div>
      <p class="petunjuk">Gunakan tombol panah kiri dan kanan pada papan ketik untuk berpindah langkah.</p>
    </section>
  </main>
</div>

<script type="application/json" id="data">${payload}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  var langkah = data.langkah;
  var posisi = 0;
  var zoomManual = false;
  var sedangPutar = false;
  var kecepatan = 1;
  var timer = [];
  var kursorTerakhir = { x: 0.5, y: 0.5 };
  var hematGerak = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var KURSOR = '<svg viewBox="0 0 20 20" width="24" height="24">' +
    '<path d="M4 2 L4 17 L8 13.2 L10.8 19 L13.6 17.6 L10.9 12 L16.2 12 Z" ' +
    'fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';

  var el = {
    judul: document.getElementById('judul'),
    subjudul: document.getElementById('subjudul'),
    bar: document.getElementById('bar'),
    daftar: document.getElementById('daftar'),
    bingkai: document.getElementById('bingkai'),
    zoom: document.getElementById('zoom'),
    putar: document.getElementById('putar'),
    lini: document.getElementById('lini'),
    kecepatan: document.getElementById('kecepatan'),
    meta: document.getElementById('meta'),
    langkahJudul: document.getElementById('langkah-judul'),
    penjelasan: document.getElementById('langkah-penjelasan'),
    hasil: document.getElementById('hasil'),
    mundur: document.getElementById('mundur'),
    maju: document.getElementById('maju')
  };

  var animasiAktif = [];
  var animKursor = null;

  function skala(ms) { return Math.round(ms / kecepatan); }
  function jadwal(fn, ms) { timer.push(setTimeout(fn, skala(ms))); }
  function bersihkanTimer() {
    for (var i = 0; i < timer.length; i++) clearTimeout(timer[i]);
    timer = [];
  }

  // Web Animations API dipakai, bukan transisi CSS: waktunya eksplisit dan
  // transform/opacity dijalankan di compositor sehingga gerakannya halus.
  function gerak(sasaran, bingkai, opsi) {
    if (!sasaran || !sasaran.animate) return null;
    var anim = sasaran.animate(bingkai, opsi);
    animasiAktif.push(anim);
    return anim;
  }

  function batalAnimasi() {
    for (var i = 0; i < animasiAktif.length; i++) {
      try { animasiAktif[i].cancel(); } catch (e) { /* sudah selesai */ }
    }
    animasiAktif = [];
    animKursor = null;
  }

  el.judul.textContent = data.judul;
  el.subjudul.textContent = data.subjudul || (langkah.length + ' langkah');

  langkah.forEach(function (item, i) {
    var li = document.createElement('li');
    var tombol = document.createElement('button');
    tombol.type = 'button';
    var nomor = document.createElement('span');
    nomor.className = 'nomor';
    nomor.textContent = item.no;
    var teks = document.createElement('span');
    teks.textContent = item.judul;
    tombol.appendChild(nomor);
    tombol.appendChild(teks);
    tombol.addEventListener('click', function () { keLangkah(i); });
    li.appendChild(tombol);
    el.daftar.appendChild(li);
  });

  function buatLapis(sumber, kelas, alt) {
    var img = document.createElement('img');
    img.className = 'lapis ' + kelas;
    img.src = sumber;
    img.alt = alt || '';
    return img;
  }

  function gambarPanggung(item) {
    el.bingkai.innerHTML = '';
    var sebelum = item.shotId ? data.gambar[item.shotId] : null;
    var sesudah = item.shotSesudahId ? data.gambar[item.shotSesudahId] : null;

    if (!sebelum && !sesudah) {
      var kosong = document.createElement('div');
      kosong.className = 'kosong';
      kosong.textContent = 'Tangkapan layar tidak tersedia untuk langkah ini.';
      el.bingkai.appendChild(kosong);
      el.zoom.hidden = true;
      return;
    }

    var geser = document.createElement('div');
    geser.className = 'geser';
    if (item.rasio) geser.style.setProperty('--rasio', String(item.rasio));
    geser.style.transitionDuration = '0ms';
    geser.style.transform = 'scale(1)';

    if (sebelum) geser.appendChild(buatLapis(sebelum, 'sebelum tampak', item.judul));
    if (sesudah) geser.appendChild(buatLapis(sesudah, 'sesudah' + (sebelum ? '' : ' tampak'), ''));

    if (item.penanda) {
      var titik = document.createElement('div');
      titik.className = 'titik';
      titik.style.left = (item.penanda.centerX * 100) + '%';
      titik.style.top = (item.penanda.centerY * 100) + '%';
      geser.appendChild(titik);

      // Kursor dipaku di titik sasaran; perpindahan dari posisi langkah
      // sebelumnya dikerjakan sebagai translate, bukan perubahan left/top.
      var kursor = document.createElement('div');
      kursor.className = 'kursor';
      kursor.innerHTML = KURSOR;
      kursor.style.left = (item.penanda.centerX * 100) + '%';
      kursor.style.top = (item.penanda.centerY * 100) + '%';
      geser.appendChild(kursor);
    }

    el.bingkai.appendChild(geser);
    el.zoom.hidden = !item.penanda;
    terapkanZoom(geser, item.penanda);
  }

  // Zoom manual memakai transform-origin di penanda. Penanda dan kursor
  // dikecilkan balik supaya ukurannya di layar tidak ikut berubah.
  function terapkanZoom(geser, penanda) {
    geser.style.transformOrigin = penanda
      ? (penanda.centerX * 100) + '% ' + (penanda.centerY * 100) + '%'
      : '50% 50%';
    if (zoomManual) geser.style.transform = 'scale(1.8)';
    var balik = zoomManual ? 1 / 1.8 : 1;
    var titik = geser.querySelector('.titik');
    var kursor = geser.querySelector('.kursor');
    if (titik) titik.style.transform = 'scale(' + balik + ')';
    if (kursor) kursor.style.transform = 'scale(' + balik + ')';
    el.zoom.textContent = zoomManual ? 'Lihat layar penuh' : 'Perbesar area';
  }

  /**
   * Urutan gerak satu langkah: kursor meluncur ke sasaran, penanda berdenyut,
   * lalu layar sebelum menyilang ke layar sesudah. Zoom perlahan berjalan
   * sepanjang langkah kecuali pengguna sedang memakai zoom manual.
   */
  function animasi(item) {
    var geser = el.bingkai.querySelector('.geser');
    if (!geser) return;

    var sesudah = geser.querySelector('.lapis.sesudah');
    var titik = geser.querySelector('.titik');
    var kursor = geser.querySelector('.kursor');
    var adaPenanda = Boolean(item.penanda);
    var total = adaPenanda ? 3000 : 2000;
    var balik = zoomManual ? 1 / 1.8 : 1;

    if (hematGerak) {
      if (sesudah) sesudah.classList.add('tampak');
      if (titik) titik.classList.add('tampak');
      if (kursor) kursor.classList.add('tampak');
      el.lini.style.width = '100%';
      if (sedangPutar) jadwal(lanjut, total);
      return;
    }

    el.lini.style.width = '0';
    gerak(el.lini, [{ width: '0%' }, { width: '100%' }],
      { duration: skala(total), fill: 'forwards', easing: 'linear' });

    if (adaPenanda && kursor) {
      var dx = (kursorTerakhir.x - item.penanda.centerX) * geser.offsetWidth;
      var dy = (kursorTerakhir.y - item.penanda.centerY) * geser.offsetHeight;
      kursor.classList.add('tampak');
      animKursor = gerak(kursor, [
        { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(' + balik + ')' },
        { transform: 'translate(0px, 0px) scale(' + balik + ')' }
      ], {
        duration: skala(800),
        delay: skala(100),
        fill: 'both',
        easing: 'cubic-bezier(.33,.72,.3,1)'
      });
      kursorTerakhir = { x: item.penanda.centerX, y: item.penanda.centerY };

      gerak(titik, [{ opacity: 0 }, { opacity: 1 }],
        { duration: skala(250), delay: skala(900), fill: 'forwards' });
    }

    gerak(sesudah, [{ opacity: 0 }, { opacity: 1 }], {
      duration: skala(600),
      delay: skala(adaPenanda ? 1200 : 300),
      fill: 'forwards'
    });

    jadwal(lanjut, total);
  }

  function lanjut() {
    if (!sedangPutar) return;
    if (posisi < langkah.length - 1) {
      keLangkah(posisi + 1);
    } else {
      sedangPutar = false;
      perbaruiPutar();
    }
  }

  function perbaruiPutar() {
    var diAkhir = posisi === langkah.length - 1;
    el.putar.innerHTML = sedangPutar
      ? '\\u23F8 Jeda'
      : (diAkhir ? '\\u21BA Putar ulang' : '\\u25B6 Putar');
  }

  function keLangkah(i) {
    bersihkanTimer();
    batalAnimasi();
    posisi = Math.max(0, Math.min(langkah.length - 1, i));
    var item = langkah[posisi];

    Array.prototype.forEach.call(el.daftar.children, function (li, n) {
      li.className = n === posisi ? 'aktif' : (n < posisi ? 'lewat' : '');
    });
    if (el.daftar.children[posisi]) {
      el.daftar.children[posisi].scrollIntoView({ block: 'nearest' });
    }

    el.bar.style.width = ((posisi + 1) / langkah.length * 100) + '%';

    el.meta.innerHTML = '';
    var lencana = document.createElement('span');
    lencana.className = 'lencana' + (item.gagal ? ' gagal' : '');
    lencana.textContent = item.gagal ? item.label + ' \\u00b7 gagal' : item.label;
    el.meta.appendChild(lencana);
    var urutan = document.createElement('span');
    urutan.textContent = 'Langkah ' + item.no + ' dari ' + langkah.length +
      (item.durasi ? ' \\u00b7 ' + item.durasi : '');
    el.meta.appendChild(urutan);

    el.langkahJudul.textContent = item.judul;
    el.penjelasan.textContent = item.penjelasan;
    el.hasil.hidden = !item.hasil;
    if (item.hasil) el.hasil.textContent = 'Hasil: ' + item.hasil;

    el.mundur.disabled = posisi === 0;
    el.maju.disabled = posisi === langkah.length - 1;

    gambarPanggung(item);
    animasi(item);
    perbaruiPutar();
  }

  el.mundur.addEventListener('click', function () { keLangkah(posisi - 1); });
  el.maju.addEventListener('click', function () { keLangkah(posisi + 1); });

  el.putar.addEventListener('click', function () {
    if (sedangPutar) {
      sedangPutar = false;
      bersihkanTimer();
      el.lini.style.transition = 'none';
      perbaruiPutar();
      return;
    }
    sedangPutar = true;
    keLangkah(posisi === langkah.length - 1 ? 0 : posisi);
  });

  el.kecepatan.addEventListener('change', function () {
    kecepatan = parseFloat(el.kecepatan.value) || 1;
    keLangkah(posisi);
  });

  el.zoom.addEventListener('click', function () {
    zoomManual = !zoomManual;
    var geser = el.bingkai.querySelector('.geser');
    if (!geser) return;

    // Zoom manual mengambil alih transform, jadi gerak kursor dihentikan dulu.
    if (animKursor) { animKursor.cancel(); animKursor = null; }

    var kursor = geser.querySelector('.kursor');
    if (kursor) kursor.style.transform = 'scale(' + (zoomManual ? 1 / 1.8 : 1) + ')';
    if (!zoomManual) geser.style.transform = 'scale(1)';
    terapkanZoom(geser, langkah[posisi].penanda);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') keLangkah(posisi + 1);
    else if (e.key === 'ArrowLeft') keLangkah(posisi - 1);
    else if (e.key === 'Home') keLangkah(0);
    else if (e.key === 'End') keLangkah(langkah.length - 1);
  });

  keLangkah(0);
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------- 5. CLI

function parseArgs(argv) {
  const opts = { input: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--init-steps') opts.initSteps = true;
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--steps') opts.steps = argv[++i];
    else if (arg === '--title') opts.title = argv[++i];
    else if (arg === '--subtitle') opts.subtitle = argv[++i];
    else if (!arg.startsWith('--')) opts.input = arg;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.input) {
    console.error('Pemakaian: node build-demo.js <report.html> [--out ...] [--steps ...] [--title ...] [--init-steps]');
    process.exit(1);
  }
  if (!existsSync(opts.input)) {
    console.error(`Berkas tidak ditemukan: ${opts.input}`);
    process.exit(1);
  }

  const dasar = opts.input.replace(/\.html?$/i, '');
  const berkasSteps = opts.steps ?? `${dasar}.steps.id.json`;
  const berkasKeluaran = opts.out ?? `${dasar}.demo.html`;

  const html = readFileSync(opts.input, 'utf-8');
  const { executions, images } = extractReport(html);

  if (executions.length === 0) {
    console.error(`Tidak ada data langkah di ${basename(opts.input)}. Pastikan berkas ini report Midscene.`);
    process.exit(1);
  }

  const steps = buildSteps(executions);
  if (steps.length === 0) {
    console.error('Report terbaca, tetapi tidak ada langkah yang bisa ditampilkan.');
    process.exit(1);
  }

  if (opts.initSteps) {
    writeOverrides(berkasSteps, steps);
    console.log(`Berkas teks dibuat: ${berkasSteps} (${steps.length} langkah)`);
    console.log('Sunting kolom "judul" dan "penjelasan", lalu jalankan lagi tanpa --init-steps.');
    return;
  }

  const overrides = loadOverrides(berkasSteps);
  const siap = applyOverrides(steps, overrides);

  const keluaran = renderHtml(siap, images, {
    title: opts.title ?? 'Panduan Penggunaan',
    subtitle: opts.subtitle ?? `${steps.length} langkah`,
  });
  writeFileSync(berkasKeluaran, keluaran, 'utf-8');

  const hilang = siap.filter((step) => step.shotId && !images.has(step.shotId)).length;
  console.log(`Panduan dibuat: ${berkasKeluaran}`);
  console.log(`  ${siap.length} langkah, ${overrides.size} memakai teks dari ${basename(berkasSteps)}`);
  if (overrides.size === 0) {
    console.log(`  Jalankan dengan --init-steps untuk menulis teks bahasa Indonesia sendiri.`);
  }
  if (hilang > 0) console.log(`  Peringatan: ${hilang} langkah tanpa tangkapan layar.`);
}

main();
