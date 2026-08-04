import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScenarioStore, hitungLangkahSkenario } from '../src/scenarios.ts';
import { ToolError } from '../src/errors.ts';
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

/** YAML skenario dengan `jumlah` langkah `ai` di satu task. */
function yamlDenganLangkah(jumlah: number): string {
  const flow = Array.from({ length: jumlah }, (_, i) => `      - ai: langkah ${i + 1}`).join('\n');
  return `tasks:\n  - name: alur\n    flow:\n${flow}\n`;
}

async function hubungkanDenganStore(opsi: HubungkanOpsi = {}) {
  const { store, dir } = await buatStore();
  const dibuat: FakeDevice[] = [];
  const sessions = new SessionManager(async (target) => {
    const device = new FakeDevice(target);
    if (opsi.failNext !== undefined) {
      device.failNext = opsi.failNext;
    }
    dibuat.push(device);
    return device;
  }, opsi.limit ?? 40);
  const server = createServer({ sessions, store, buildDemoPath: BUILD_DEMO });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, dibuat, store, dir };
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
  await store.save('checkout', 'tasks: []\n');
  await client.callTool({
    name: 'run_scenario',
    arguments: { name: 'checkout', target: 'web' },
  });
  assert.equal(dibuat.length, 1);
  assert.deepEqual(dibuat[0].calls, ['runYaml:tasks: []\n']);
});

test('run_scenario menutup sesi meski YAML gagal', async () => {
  // Device dibuat di dalam run_scenario (lewat DeviceFactory milik SessionManager),
  // jadi kegagalan diprogram lewat pabrik itu sendiri: setiap FakeDevice yang
  // dibuat oleh hubunganDenganStore langsung diberi failNext sebelum tool call
  // apa pun menyentuhnya. Ini menghindari monkey-patch pada array `dibuat`.
  const { client, store, dibuat } = await hubungkanDenganStore({
    failNext: 'yaml ditolak device',
  });
  await store.save('rusak', 'tasks: []\n');

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
    name: 'run_scenario',
    arguments: { name: 'tanpa-gherkin', target: 'web' },
  });
  assert.notEqual(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /Charged 2 of 10 AI operations\./);
  assert.equal(dibuat.length, 1);
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
