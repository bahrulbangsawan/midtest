import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScenarioStore } from '../src/scenarios.ts';
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
  }, 40);
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

test('list_scenarios mengembalikan nama tersimpan', async () => {
  const { client, store } = await hubungkanDenganStore();
  await store.save('alpha', 'tasks: []\n');
  const hasil = await client.callTool({ name: 'list_scenarios', arguments: {} });
  assert.match((hasil.content as any)[0].text, /alpha/);
});
