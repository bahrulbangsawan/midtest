import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDevice } from '../src/devices/fake.ts';

test('FakeDevice mencatat setiap operasi yang dipanggil', async () => {
  const device = new FakeDevice('web');
  await device.act('klik tombol masuk');
  await device.assert('halaman beranda tampil');
  assert.deepEqual(device.calls, [
    'act:klik tombol masuk',
    'assert:halaman beranda tampil',
  ]);
});

test('FakeDevice mengembalikan hasil query yang sudah diprogram', async () => {
  const device = new FakeDevice('web');
  device.queryResult = { judul: 'Beranda' };
  assert.deepEqual(await device.query('{judul: string}'), { judul: 'Beranda' });
});

test('FakeDevice mengembalikan screenshot palsu', async () => {
  const device = new FakeDevice('computer');
  const shot = await device.screenshot();
  assert.equal(shot.mimeType, 'image/png');
  assert.ok(shot.base64.length > 0);
});

test('FakeDevice melempar galat bila diprogram gagal', async () => {
  const device = new FakeDevice('web');
  device.failNext = 'elemen tidak ditemukan';
  await assert.rejects(() => device.act('klik apa saja'), /elemen tidak ditemukan/);
});
