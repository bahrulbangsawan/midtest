import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScenarioStore, analisaSkenario, hitungLangkahSkenario } from '../src/scenarios.ts';
import { ToolError } from '../src/errors.ts';
import type { StartOpts } from '../src/session.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.ts';
import { SessionManager } from '../src/session.ts';
import { FakeDevice } from '../src/devices/fake.ts';

const BUILD_DEMO = join(import.meta.dirname, '..', '..', 'build-demo.js');

async function buatStore() {
  const dir = await mkdtemp(join(tmpdir(), 'skenario-'));
  return { store: new ScenarioStore(dir), dir };
}

test('save menulis berkas YAML dan load membacanya kembali', async () => {
  const { store, dir } = await buatStore();
  await store.save('checkout', 'tasks:\n  - name: masuk\n');
  const isi = await readFile(join(dir, 'checkout.yaml'), 'utf8');
  assert.match(isi, /tasks:/);
  assert.equal(await store.load('checkout'), 'tasks:\n  - name: masuk\n');
});

test('load skenario tak dikenal melempar SCENARIO_NOT_FOUND', async () => {
  const { store } = await buatStore();
  await assert.rejects(
    () => store.load('hantu'),
    (err: ToolError) => err.code === 'SCENARIO_NOT_FOUND',
  );
});

test('list mengembalikan nama skenario terurut tanpa ekstensi', async () => {
  const { store } = await buatStore();
  await store.save('zebra', 'tasks: []\n');
  await store.save('alpha', 'tasks: []\n');
  assert.deepEqual(await store.list(), ['alpha', 'zebra']);
});

test('nama yang mengandung pemisah path ditolak', async () => {
  const { store } = await buatStore();
  await assert.rejects(
    () => store.save('../keluar', 'tasks: []\n'),
    (err: ToolError) => err.code === 'INTERNAL',
  );
});

interface HubungkanOpsi {
  /** Diprogram pada setiap FakeDevice sebelum tool call apa pun bisa memakainya. */
  failNext?: string;
  /** Batas operasi AI per sesi; default 40 seperti server sungguhan. */
  limit?: number;
}

/** Alamat bawaan untuk skenario web di tes ini. Tidak pernah dibuka sungguhan. */
const URL_YAML = 'https://contoh.test/beranda';

/**
 * YAML skenario dengan `jumlah` langkah `ai` di satu task.
 *
 * Blok `web:` ikut ditulis karena itulah bentuk skenario yang bisa diputar ulang:
 * sejak run_scenario menolak target web tanpa alamat, skenario tanpa blok ini tidak
 * mewakili apa pun yang benar-benar dipakai.
 */
function yamlDenganLangkah(jumlah: number): string {
  const flow = Array.from({ length: jumlah }, (_, i) => `      - ai: langkah ${i + 1}`).join('\n');
  return `web:\n  url: ${URL_YAML}\ntasks:\n  - name: alur\n    flow:\n${flow}\n`;
}

/** YAML satu langkah dengan alias target web yang dipilih pemanggil. */
function yamlDenganAlias(alias: 'page' | 'browser' | 'web' | 'target', url: string): string {
  return `${alias}:\n  url: ${url}\ntasks:\n  - name: alur\n    flow:\n      - ai: satu\n`;
}

async function hubungkanDenganStore(opsi: HubungkanOpsi = {}) {
  const { store, dir } = await buatStore();
  const dibuat: FakeDevice[] = [];
  /** Opsi yang diterima SessionManager.start untuk tiap sesi, sejajar dengan `dibuat`. */
  const opsiSesi: StartOpts[] = [];
  const sessions = new SessionManager(async (target, opts) => {
    const device = new FakeDevice(target);
    if (opsi.failNext !== undefined) {
      device.failNext = opsi.failNext;
    }
    dibuat.push(device);
    opsiSesi.push(opts);
    return device;
  }, opsi.limit ?? 40);
  const server = createServer({ sessions, store, buildDemoPath: BUILD_DEMO });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, dibuat, opsiSesi, store, dir };
}

test('save_scenario menulis YAML ke disk', async () => {
  const { client, store } = await hubungkanDenganStore();
  await client.callTool({
    name: 'save_scenario',
    arguments: { name: 'checkout', yaml: 'tasks:\n  - name: masuk\n' },
  });
  assert.match(await store.load('checkout'), /tasks:/);
});

test('run_scenario memulai sesi dan meneruskan YAML ke device', async () => {
  const { client, store, dibuat } = await hubungkanDenganStore();
  const yaml = `web:\n  url: ${URL_YAML}\ntasks: []\n`;
  await store.save('checkout', yaml);
  await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'checkout', target: 'web' },
  });
  assert.equal(dibuat.length, 1);
  assert.deepEqual(dibuat[0].calls, [`runYaml:${yaml}`]);
});

test('run_scenario menutup sesi meski YAML gagal', async () => {
  // Device dibuat di dalam run_scenario (lewat DeviceFactory milik SessionManager),
  // jadi kegagalan diprogram lewat pabrik itu sendiri: setiap FakeDevice yang
  // dibuat oleh hubunganDenganStore langsung diberi failNext sebelum tool call
  // apa pun menyentuhnya. Ini menghindari monkey-patch pada array `dibuat`.
  const { client, store, dibuat } = await hubungkanDenganStore({
    failNext: 'yaml ditolak device',
  });
  await store.save('rusak', `web:\n  url: ${URL_YAML}\ntasks: []\n`);

  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'rusak', target: 'web' },
  });

  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /DEVICE_FAILED/);
  assert.equal(dibuat.length, 1);
  assert.equal(dibuat[0].ended, true, 'sesi harus tetap ditutup meski gagal');
});

test('run_scenario skenario tak dikenal mengembalikan SCENARIO_NOT_FOUND', async () => {
  const { client } = await hubungkanDenganStore();
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'hantu', target: 'web' },
  });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /SCENARIO_NOT_FOUND/);
});

// --- run_scenario tidak boleh lolos dari batas budget ---

test('hitungLangkahSkenario menjumlahkan seluruh flow di semua task', () => {
  assert.equal(hitungLangkahSkenario('tasks: []\n'), 0);
  assert.equal(hitungLangkahSkenario('tasks:\n  - name: a\n'), 0);
  assert.equal(hitungLangkahSkenario(yamlDenganLangkah(5)), 5);
  assert.equal(
    hitungLangkahSkenario(
      'tasks:\n' +
        '  - name: a\n    flow:\n      - ai: satu\n      - aiAssert: dua\n' +
        '  - name: b\n    flow:\n      - sleep: 100\n      - aiWaitFor: tiga\n',
    ),
    4,
    'langkah non-AI ikut dihitung — penjaga biaya harus membulatkan ke atas',
  );
});

test('hitungLangkahSkenario melempar INTERNAL untuk YAML yang tidak bisa diurai', () => {
  for (const rusak of ['tasks: [\n', 'halo: dunia\n', '']) {
    assert.throws(
      () => hitungLangkahSkenario(rusak),
      (err: ToolError) => err.code === 'INTERNAL',
      `YAML ${JSON.stringify(rusak)} harus ditolak, bukan diloloskan gratis`,
    );
  }
});

// --- runGherkinScenario: biayanya tidak bisa dibatasi, jadi ditolak ---

/**
 * Dua YAML yang identik kecuali satu kunci. Yang satu memakai
 * `runGherkinScenario`, yang lain `ai` — struktur, jumlah langkah, dan nama task
 * persis sama. Kalau tes penolakan lulus tapi tes pasangannya juga ikut ditolak,
 * berarti penjaganya terlalu rakus, bukan tepat sasaran.
 */
const YAML_GHERKIN =
  'tasks:\n  - name: alur\n    flow:\n      - ai: buka halaman\n      - runGherkinScenario: |\n          Given saya di beranda\n          When saya klik masuk\n          Then saya lihat dasbor\n';
const YAML_TANPA_GHERKIN =
  'tasks:\n  - name: alur\n    flow:\n      - ai: buka halaman\n      - ai: |\n          klik masuk lalu pastikan dasbor tampil\n';

test('hitungLangkahSkenario menolak runGherkinScenario, bukan menagihnya satu langkah', () => {
  let galat: ToolError | undefined;
  try {
    hitungLangkahSkenario(YAML_GHERKIN);
  } catch (err) {
    galat = err as ToolError;
  }
  assert.ok(galat, 'harus melempar, bukan mengembalikan hitungan');
  assert.equal(galat.code, 'SCENARIO_UNSUPPORTED');
  // Pesannya harus bisa ditindaklanjuti agen: kenapa ditolak dan harus menulis apa.
  assert.match(galat.message, /task 1, step 2/, 'sebutkan langkah mana yang bermasalah');
  assert.match(galat.message, /unbounded number of AI operations/);
  assert.match(galat.message, /caching disabled/);
  assert.match(galat.message, /aiAssert/, 'sebutkan bentuk pengganti yang benar');
});

test('skenario yang sama tanpa runGherkinScenario tetap lolos dan dihitung normal', () => {
  assert.equal(hitungLangkahSkenario(YAML_TANPA_GHERKIN), 2);
});

test('runGherkinScenario dengan nilai kosong tetap ditolak', () => {
  // Midscene bercabang pada `'runGherkinScenario' in flowItem` — keberadaan kunci,
  // bukan kebenaran nilainya. Penjaga ini harus mencocokkan perilaku itu persis.
  assert.throws(
    () => hitungLangkahSkenario('tasks:\n  - name: a\n    flow:\n      - runGherkinScenario:\n'),
    (err: ToolError) => err.code === 'SCENARIO_UNSUPPORTED',
  );
});

test('SCENARIO_UNSUPPORTED tidak ditandai retryable', () => {
  const galat = new ToolError('SCENARIO_UNSUPPORTED', 'apa saja');
  assert.equal(galat.retryable, false, 'mengulang YAML yang sama akan gagal identik');
});

test('run_scenario menolak runGherkinScenario tanpa pernah membuka sesi', async () => {
  const { client, store, dibuat } = await hubungkanDenganStore();
  await store.save('gherkin', YAML_GHERKIN);
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'gherkin', target: 'web' },
  });
  assert.equal(hasil.isError, true);
  const teks = (hasil.content as any)[0].text;
  assert.match(teks, /SCENARIO_UNSUPPORTED/);
  assert.match(teks, /Do not retry/, 'kode non-retryable harus menghasilkan saran itu');
  assert.equal(dibuat.length, 0, 'tidak boleh ada browser atau desktop yang dibuka');
});

test('run_scenario menjalankan skenario pasangannya yang tanpa gherkin', async () => {
  const { client, store, dibuat } = await hubungkanDenganStore({ limit: 10 });
  await store.save('tanpa-gherkin', YAML_TANPA_GHERKIN);
  const hasil = await client.callTool({
    // YAML pasangan ini sengaja tidak punya blok target — alamatnya lewat argumen.
    name: 'run_scenario',
    arguments: { name: 'tanpa-gherkin', target: 'web', url: URL_YAML },
  });
  assert.notEqual(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /Charged 2 of 10 AI operations\./);
  assert.equal(dibuat.length, 1);
});

// --- alamat replay: diambil dari YAML, boleh ditimpa argumen, tidak boleh kosong ---

/**
 * Empat kunci yang dipakai Midscene untuk lingkungan web. Diambil apa adanya dari
 * `webTargetSources` di `@midscene/core/dist/lib/yaml/utils.js`.
 */
const ALIAS_TARGET_WEB = ['page', 'browser', 'web', 'target'] as const;

test('analisaSkenario membaca url dari tiap alias target web Midscene', () => {
  for (const alias of ALIAS_TARGET_WEB) {
    const url = `https://contoh.test/${alias}`;
    const hasil = analisaSkenario(yamlDenganAlias(alias, url));
    assert.equal(hasil.url, url, `alias "${alias}" harus menghasilkan urlnya sendiri`);
    assert.equal(hasil.langkah, 1, 'hitungan langkah tidak boleh terpengaruh alias');
  }
});

test('analisaSkenario mengembalikan url undefined kalau skenario tidak menyebut alamat', () => {
  assert.equal(analisaSkenario('tasks: []\n').url, undefined);
  assert.equal(analisaSkenario('web:\n  url: "   "\ntasks: []\n').url, undefined,
    'url kosong harus dibaca sebagai tidak ada, bukan diteruskan ke goto("")');
});

/**
 * KANARI PRESEDENSI. Midscene tidak menetapkan urutan prioritas antar alias sama
 * sekali: `resolveWebTarget` mengumpulkan semua alias yang ada lalu melempar begitu
 * ketemu dua. `parseYamlScript` memanggilnya, jadi dokumen bermulti-alias tidak
 * pernah sampai ke pembaca url kita. Kalau Midscene suatu saat memilih presedensi
 * (bukan menolak), tes ini gagal dan memaksa keputusan sadar di sisi kita.
 */
test('KANARI: dua alias target web ditolak Midscene, bukan diberi presedensi', () => {
  let galat: ToolError | undefined;
  try {
    analisaSkenario(`web:\n  url: https://a.test\ntarget:\n  url: https://b.test\ntasks: []\n`);
  } catch (err) {
    galat = err as ToolError;
  }
  assert.ok(galat, 'multi-alias harus melempar');
  assert.equal(galat.code, 'INTERNAL');
  assert.match(galat.message, /Only one web target can be specified/);
});

test('run_scenario meneruskan url dari tiap alias ke sesi yang dibuka', async () => {
  for (const alias of ALIAS_TARGET_WEB) {
    const { client, store, dibuat, opsiSesi } = await hubungkanDenganStore();
    const url = `https://contoh.test/${alias}`;
    await store.save('lewat-alias', yamlDenganAlias(alias, url));
    const hasil = await client.callTool({
      name: 'run_scenario',
      arguments: { name: 'lewat-alias', target: 'web' },
    });
    assert.notEqual(hasil.isError, true, `alias "${alias}" harus bisa diputar`);
    assert.equal(dibuat.length, 1);
    assert.deepEqual(opsiSesi, [{ url }], `alias "${alias}" harus sampai ke sesi`);
    assert.match((hasil.content as any)[0].text, new RegExp(url.replace(/\//g, '\\/')));
  }
});

test('argumen url menimpa alamat yang tersimpan di YAML', async () => {
  const { client, store, opsiSesi } = await hubungkanDenganStore();
  await store.save('checkout', yamlDenganLangkah(1));
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'checkout', target: 'web', url: 'https://staging.test/beranda' },
  });
  assert.notEqual(hasil.isError, true);
  assert.deepEqual(opsiSesi, [{ url: 'https://staging.test/beranda' }]);
  assert.notEqual(opsiSesi[0].url, URL_YAML, 'nilai YAML tidak boleh menang atas argumen');
});

/**
 * Inti perbaikan ini. Sebelumnya `run_scenario` memanggil `sessions.start(target)` tanpa
 * url sama sekali, jadi browser diam di halaman kosong dan setiap aiAssert gagal —
 * persis yang terjadi di e2e sungguhan. Sekarang: ditolak sebelum ada sesi dibuka.
 */
test('target web tanpa alamat di mana pun ditolak sebelum sesi dibuka', async () => {
  const { client, store, dibuat, opsiSesi } = await hubungkanDenganStore();
  await store.save('tanpa-alamat', 'tasks:\n  - name: t\n    flow:\n      - aiAssert: apa saja\n');
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'tanpa-alamat', target: 'web' },
  });
  assert.equal(hasil.isError, true);
  const teks = (hasil.content as any)[0].text;
  assert.match(teks, /SCENARIO_NO_URL/);
  assert.match(teks, /blank page/, 'sebutkan akibatnya, bukan cuma kodenya');
  assert.match(teks, /web:\\n {2}url: https:\/\/example\.com/, 'sebutkan persis apa yang harus ditambahkan');
  assert.match(teks, /url argument/, 'sebutkan jalan keluar kedua');
  assert.match(teks, /Do not retry/);
  assert.equal(dibuat.length, 0, 'tidak boleh ada browser yang dibuka');
  assert.deepEqual(opsiSesi, []);
});

test('url kosong di YAML diperlakukan sama dengan tidak ada alamat', async () => {
  const { client, store, dibuat } = await hubungkanDenganStore();
  await store.save('kosong', 'web:\n  url: ""\ntasks: []\n');
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'kosong', target: 'web' },
  });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /SCENARIO_NO_URL/);
  assert.equal(dibuat.length, 0);
});

test('SCENARIO_NO_URL tidak ditandai retryable', () => {
  assert.equal(new ToolError('SCENARIO_NO_URL', 'apa saja').retryable, false);
});

test('target computer tetap berjalan tanpa alamat dan tidak menerima url', async () => {
  const { client, store, dibuat, opsiSesi } = await hubungkanDenganStore({ limit: 10 });
  await store.save('desktop', 'tasks:\n  - name: t\n    flow:\n      - ai: buka Finder\n');
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'desktop', target: 'computer' },
  });
  assert.notEqual(hasil.isError, true, 'desktop tidak punya alamat, jadi tidak ada yang ditolak');
  assert.equal(dibuat.length, 1);
  assert.equal(dibuat[0].target, 'computer');
  assert.deepEqual(opsiSesi, [{ url: undefined }]);
});

test('url pada target computer diabaikan dan dikatakan, seperti start_session', async () => {
  const { client, store, opsiSesi } = await hubungkanDenganStore({ limit: 10 });
  // Skenario ini bahkan menyimpan alamat sendiri; desktop tetap tidak memakainya.
  await store.save('desktop', yamlDenganLangkah(1));
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'desktop', target: 'computer', url: 'https://contoh.test/abaikan' },
  });
  assert.notEqual(hasil.isError, true);
  assert.deepEqual(opsiSesi, [{ url: undefined }], 'adapter computer tidak boleh dapat url');
  assert.match((hasil.content as any)[0].text, /url was ignored/);
});

// --- flow yang ditulis sebagai mapping, bukan sequence ---

/**
 * Bypass yang lolos dari versi pertama penjaga ini. `parseYamlScript` menerimanya
 * (ia memvalidasi `tasks` harus array, tapi `flow` tidak pernah dicek), dan Midscene
 * menjalankannya: `playTask` melakukan `assert(flow)` — objek non-kosong itu truthy —
 * lalu `for (const flowItemIndex in flow)` di `player.mjs:115`. `for…in` menelusuri
 * kunci objek, jadi setiap nilainya di-dispatch seperti entri sequence biasa.
 */
const YAML_FLOW_MAPPING =
  'tasks:\n  - name: t\n    flow:\n      s1:\n        runGherkinScenario: |\n          Given saya di beranda\n          When saya klik masuk\n';
const YAML_FLOW_MAPPING_TANPA_GHERKIN =
  'tasks:\n  - name: t\n    flow:\n      s1:\n        ai: satu\n      s2:\n        ai: dua\n';

test('flow berbentuk mapping ditolak, bukan dihitung nol langkah', () => {
  let galat: ToolError | undefined;
  try {
    hitungLangkahSkenario(YAML_FLOW_MAPPING);
  } catch (err) {
    galat = err as ToolError;
  }
  assert.ok(galat, 'harus melempar — dulu bentuk ini dihitung 0 dan tidak pernah diperiksa');
  assert.equal(galat.code, 'SCENARIO_UNSUPPORTED');
  assert.match(galat.message, /task 1/);
  assert.match(galat.message, /not a list of steps/);
  assert.match(galat.message, /YAML sequence/, 'sebutkan bentuk pengganti yang benar');
});

test('flow mapping ditolak walau isinya tidak mengandung gherkin sama sekali', () => {
  // Penolakan berlaku pada bentuknya, bukan pada isinya: kalau hanya isi yang dicek,
  // bentuk mapping tetap jadi jalur yang biayanya tidak terhitung.
  assert.throws(
    () => hitungLangkahSkenario(YAML_FLOW_MAPPING_TANPA_GHERKIN),
    (err: ToolError) => err.code === 'SCENARIO_UNSUPPORTED',
  );
});

test('flow berbentuk string atau nilai kosong juga ditolak', () => {
  for (const rusak of [
    'tasks:\n  - name: t\n    flow: halo\n',
    'tasks:\n  - name: t\n    flow:\n',
  ]) {
    assert.throws(
      () => hitungLangkahSkenario(rusak),
      (err: ToolError) => err.code === 'SCENARIO_UNSUPPORTED',
      `bentuk ${JSON.stringify(rusak)} harus ditolak`,
    );
  }
});

test('task tanpa flow sama sekali tetap dihitung nol, bukan ditolak', () => {
  // Beda dari bentuk yang salah: `playTask` membuka dengan
  // `assert(flow, 'missing flow in task')`, jadi task tanpa flow tidak bisa
  // menjalankan satu pun panggilan AI.
  assert.equal(hitungLangkahSkenario('tasks:\n  - name: a\n'), 0);
});

test('run_scenario menolak flow mapping tanpa pernah membuka sesi', async () => {
  const { client, store, dibuat } = await hubungkanDenganStore();
  await store.save('mapping', YAML_FLOW_MAPPING);
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'mapping', target: 'web' },
  });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /SCENARIO_UNSUPPORTED/);
  assert.equal(dibuat.length, 0, 'tidak boleh ada browser atau desktop yang dibuka');
});

test('flow sequence yang setara tetap lolos dan dihitung seperti sebelumnya', () => {
  // Kontrol: isi yang sama persis, hanya ditulis sebagai sequence.
  assert.equal(hitungLangkahSkenario('tasks:\n  - name: t\n    flow:\n      - ai: satu\n      - ai: dua\n'), 2);
  assert.equal(hitungLangkahSkenario(YAML_TANPA_GHERKIN), 2);
  assert.equal(hitungLangkahSkenario('tasks: []\n'), 0);
});

/**
 * Kanari upgrade. Dependensi memakai rentang caret (`@midscene/core` lewat
 * `@midscene/web@^1.10.8`), jadi bump minor bisa menambah cabang dispatch baru di
 * `playFlowItem` tanpa satu pun tes lain berubah — dan cabang baru yang biayanya tak
 * terbatas akan membuka kembali persis lubang yang baru saja ditutup, diam-diam.
 *
 * Tes ini membaca nama cabang `'X' in flowItem` langsung dari `player.mjs` terpasang dan
 * mencocokkannya dengan himpunan yang sudah dipatok. Kalau Midscene menambah atau
 * mengganti cabang, tes ini gagal dan memaksa manusia memutuskan: apakah kunci baru itu
 * bisa dihitung, atau harus masuk `LANGKAH_TAK_TERBATAS`?
 *
 * Ini SENGAJA bukan tes perilaku — ia tidak menjalankan Midscene. Ia detektor perubahan.
 */
test('KANARI: cabang dispatch playFlowItem masih sama seperti saat penjaga ini ditulis', async () => {
  const { readFile } = await import('node:fs/promises');
  const player = join(
    import.meta.dirname, '..', 'node_modules', '@midscene', 'core', 'dist', 'es', 'yaml', 'player.mjs',
  );
  const sumber = await readFile(player, 'utf8');

  // Kutipnya bisa tunggal ATAU ganda — `"javascript" in flowItem` memakai kutip ganda,
  // dan `flowItem` harus dicocokkan utuh supaya `flowItemRecord` ('Finalize') tidak ikut.
  const ditemukan = [
    ...sumber.matchAll(/['"]([A-Za-z0-9_]+)['"]\s+in\s+flowItem(?![A-Za-z0-9_])/g),
  ].map((m) => m[1]);
  const aktual = [...new Set(ditemukan)].sort();

  const DIPATOK = [
    'ai', 'aiAct', 'aiAction', 'aiAssert', 'aiInput', 'aiKeyboardPress', 'aiScroll',
    'aiTap', 'aiWaitFor', 'javascript', 'logScreenshot', 'recordToReport',
    'runGherkinScenario', 'sleep',
  ].sort();

  assert.ok(aktual.length > 0, 'regex kanari tidak cocok apa pun — kemungkinan besar tes ini yang rusak, bukan Midscene');
  assert.deepEqual(
    aktual,
    DIPATOK,
    'Cabang dispatch YAML Midscene berubah. Tinjau setiap kunci baru: bisakah biayanya ' +
      'dihitung di muka? Kalau tidak (mengembang tak terbatas, atau berjalan dengan ' +
      'cacheable: false), tambahkan ke LANGKAH_TAK_TERBATAS di src/scenarios.ts. ' +
      'Baru setelah itu perbarui daftar DIPATOK ini.',
  );
});

test('run_scenario memotong budget sebanyak langkah skenario', async () => {
  const { client, store } = await hubungkanDenganStore({ limit: 10 });
  await store.save('checkout', yamlDenganLangkah(3));
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'checkout', target: 'web' },
  });
  assert.notEqual(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /Charged 3 of 10 AI operations\./);
});

test('run_scenario lebih panjang dari budget ditolak BUDGET_EXCEEDED tanpa dijalankan', async () => {
  const { client, store, dibuat } = await hubungkanDenganStore({ limit: 2 });
  await store.save('panjang', yamlDenganLangkah(5));
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'panjang', target: 'web' },
  });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /BUDGET_EXCEEDED/);
  assert.equal(dibuat.length, 0, 'device tidak boleh dibuka untuk skenario yang ditolak');
});

test('run_scenario berulang tidak bisa memutar skenario besar berkali-kali', async () => {
  // Regresi langsung dari temuan: dengan limit 2, lima run_scenario berturut-turut
  // dulu semuanya berhasil dan budget tidak tersentuh sama sekali.
  const { client, store, dibuat } = await hubungkanDenganStore({ limit: 2 });
  await store.save('panjang', yamlDenganLangkah(5));
  for (let i = 0; i < 5; i += 1) {
    const hasil = await client.callTool({
      name: 'run_scenario',
      arguments: { name: 'panjang', target: 'web' },
    });
    assert.equal(hasil.isError, true, `run ke-${i + 1} harus ditolak`);
    assert.match((hasil.content as any)[0].text, /BUDGET_EXCEEDED/);
  }
  assert.equal(dibuat.length, 0, 'tidak satu pun sesi boleh dibuka');
});

test('run_scenario dengan YAML rusak ditolak dan tidak membuka sesi', async () => {
  const { client, store, dibuat } = await hubungkanDenganStore();
  await store.save('rusak-yaml', 'tasks: [\n');
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'rusak-yaml', target: 'web' },
  });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /INTERNAL/);
  assert.equal(dibuat.length, 0);
});

test('run_scenario tepat sebesar budget masih boleh berjalan', async () => {
  const { client, store, dibuat } = await hubungkanDenganStore({ limit: 4 });
  await store.save('pas', yamlDenganLangkah(4));
  const hasil = await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'pas', target: 'web' },
  });
  assert.notEqual(hasil.isError, true);
  assert.deepEqual(dibuat[0].calls, [`runYaml:${yamlDenganLangkah(4)}`]);
});

test('list_scenarios mengembalikan nama tersimpan', async () => {
  const { client, store } = await hubungkanDenganStore();
  await store.save('alpha', 'tasks: []\n');
  const hasil = await client.callTool({ name: 'list_scenarios', arguments: {} });
  assert.match((hasil.content as any)[0].text, /alpha/);
});
