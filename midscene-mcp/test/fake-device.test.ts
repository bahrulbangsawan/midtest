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

test('panggilan yang gagal tidak tercatat di calls dan failNext direset', async () => {
  // test/exploration.test.ts membuktikan budget lewat `calls.length`. Jaminan itu
  // hanya berlaku bila record() melempar SEBELUM push — kalau urutannya dibalik,
  // panggilan gagal ikut tercatat dan tes budget di sana kehilangan artinya.
  const device = new FakeDevice('web');
  device.failNext = 'elemen tidak ditemukan';
  await assert.rejects(() => device.act('klik hantu'), /elemen tidak ditemukan/);
  assert.deepEqual(device.calls, [], 'panggilan yang gagal tidak boleh tercatat');
  assert.equal(device.failNext, null, 'failNext harus direset setelah sekali gagal');

  // Dan hanya sekali gagal: panggilan berikutnya berhasil dan tercatat.
  await device.act('klik nyata');
  assert.deepEqual(device.calls, ['act:klik nyata']);
});
