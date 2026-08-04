import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.ts';
import { SessionManager } from '../src/session.ts';
import { FakeDevice } from '../src/devices/fake.ts';
import { ScenarioStore } from '../src/scenarios.ts';

const BUILD_DEMO = join(import.meta.dirname, '..', '..', 'build-demo.js');

async function hubungkan(limit = 40) {
  const dibuat: FakeDevice[] = [];
  const sessions = new SessionManager(async (target) => {
    const device = new FakeDevice(target);
    dibuat.push(device);
    return device;
  }, limit);

  const store = new ScenarioStore(await mkdtemp(join(tmpdir(), 'skenario-')));
  const server = createServer({ sessions, store, buildDemoPath: BUILD_DEMO });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, dibuat, sessions };
}

test('tools/list memuat keenam tool eksplorasi', async () => {
  const { client } = await hubungkan();
  const { tools } = await client.listTools();
  const nama = tools.map((t) => t.name).sort();
  for (const wajib of ['act', 'assert', 'end_session', 'query', 'screenshot', 'start_session']) {
    assert.ok(nama.includes(wajib), `tool ${wajib} harus terdaftar`);
  }
});

test('start_session membuat device sesuai target', async () => {
  const { client, dibuat } = await hubungkan();
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  assert.equal(dibuat.length, 1);
  assert.equal(dibuat[0].target, 'web');
});

test('act meneruskan instruksi ke device', async () => {
  const { client, dibuat } = await hubungkan();
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  await client.callTool({ name: 'act', arguments: { instruction: 'klik tombol masuk' } });
  assert.deepEqual(dibuat[0].calls, ['act:klik tombol masuk']);
});

test('act tanpa sesi mengembalikan galat NO_SESSION', async () => {
  const { client } = await hubungkan();
  const hasil = await client.callTool({ name: 'act', arguments: { instruction: 'klik' } });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /NO_SESSION/);
});

test('act melaporkan pemakaian budget di hasil sukses', async () => {
  const { client } = await hubungkan(5);
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  const hasil = await client.callTool({ name: 'act', arguments: { instruction: 'klik' } });
  assert.match((hasil.content as any)[0].text, /Budget used: 1 of 5/);
});

test('act berhenti dengan BUDGET_EXCEEDED saat batas tercapai', async () => {
  const { client } = await hubungkan(1);
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  await client.callTool({ name: 'act', arguments: { instruction: 'pertama' } });
  const hasil = await client.callTool({ name: 'act', arguments: { instruction: 'kedua' } });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /BUDGET_EXCEEDED/);
});

test('act yang melampaui budget tidak meneruskan operasi ke device', async () => {
  const { client, dibuat } = await hubungkan(1);
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  await client.callTool({ name: 'act', arguments: { instruction: 'pertama' } });
  const jumlahSebelum = dibuat[0].calls.length;
  await client.callTool({ name: 'act', arguments: { instruction: 'kedua' } });
  assert.equal(dibuat[0].calls.length, jumlahSebelum, 'device tidak boleh menerima panggilan tambahan setelah budget habis');
});

test('query mengembalikan hasil sebagai JSON', async () => {
  const { client, dibuat } = await hubungkan();
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  dibuat[0].queryResult = { judul: 'Beranda' };
  const hasil = await client.callTool({ name: 'query', arguments: { schema: '{judul: string}' } });
  assert.match((hasil.content as any)[0].text, /"judul": ?"Beranda"/);
});

test('screenshot mengembalikan content block gambar dan tidak memotong budget', async () => {
  const { client } = await hubungkan(2);
  await client.callTool({ name: 'start_session', arguments: { target: 'computer' } });
  const hasil = await client.callTool({ name: 'screenshot', arguments: {} });
  const blok = (hasil.content as any)[0];
  assert.equal(blok.type, 'image');
  assert.equal(blok.mimeType, 'image/png');
  const setelah = await client.callTool({ name: 'act', arguments: { instruction: 'klik' } });
  assert.match((setelah.content as any)[0].text, /1 of 2/);
});

test('galat device dibungkus sebagai DEVICE_FAILED', async () => {
  const { client, dibuat } = await hubungkan();
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  dibuat[0].failNext = 'elemen tidak ditemukan';
  const hasil = await client.callTool({ name: 'act', arguments: { instruction: 'klik hantu' } });
  assert.equal(hasil.isError, true);
  assert.match((hasil.content as any)[0].text, /DEVICE_FAILED/);
});

test('galat device tetap memotong budget secara permanen', async () => {
  const { client, dibuat } = await hubungkan(5);
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  dibuat[0].failNext = 'elemen tidak ditemukan';
  await client.callTool({ name: 'act', arguments: { instruction: 'klik hantu' } });
  const setelah = await client.callTool({ name: 'act', arguments: { instruction: 'klik lagi' } });
  assert.match((setelah.content as any)[0].text, /Budget used: 2 of 5/);
});

test('end_session menutup device', async () => {
  const { client, dibuat } = await hubungkan();
  await client.callTool({ name: 'start_session', arguments: { target: 'web' } });
  await client.callTool({ name: 'end_session', arguments: {} });
  assert.equal(dibuat[0].ended, true);
});
