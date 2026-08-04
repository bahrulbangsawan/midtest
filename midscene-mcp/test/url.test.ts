import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bersihkanUrl, pastikanUrlSesi } from '../src/url.ts';
import { ToolError, toToolResult } from '../src/errors.ts';

test('bersihkanUrl memangkas spasi dan membaca nilai kosong sebagai tidak ada', () => {
  assert.equal(bersihkanUrl('  https://contoh.test  '), 'https://contoh.test');
  assert.equal(bersihkanUrl(undefined), undefined);
  assert.equal(bersihkanUrl(''), undefined);
  assert.equal(bersihkanUrl('   \n\t '), undefined);
});

test('pastikanUrlSesi meloloskan alamat http, https dan file apa adanya', () => {
  for (const sah of [
    'https://contoh.test',
    'http://localhost:3000/daftar',
    'https://contoh.test/jalur?a=1#b',
    'file:///Users/x/demo.html',
  ]) {
    assert.equal(pastikanUrlSesi(sah), sah, `${sah} harus lolos`);
  }
  assert.equal(
    pastikanUrlSesi('  https://contoh.test  '),
    'https://contoh.test',
    'nilai yang dikembalikan adalah yang sudah dipangkas — persis yang divalidasi',
  );
});

test('pastikanUrlSesi menolak alamat tanpa skema dengan petunjuk yang bisa dipakai', () => {
  let galat: ToolError | undefined;
  try {
    pastikanUrlSesi('contoh.test');
  } catch (err) {
    galat = err as ToolError;
  }
  assert.ok(galat, 'host telanjang harus ditolak');
  assert.equal(galat.code, 'INVALID_URL');
  assert.match(galat.message, /contoh\.test/, 'sebutkan nilai yang salah');
  assert.match(galat.message, /needs a scheme/, 'sebutkan apa yang salah');
  assert.match(galat.message, /https:\/\/example\.com/, 'sebutkan bentuk yang benar');
  assert.match(galat.message, /no browser was opened/, 'tegaskan tidak ada biaya yang keluar');
});

test('pastikanUrlSesi menolak string yang bukan URL sama sekali', () => {
  for (const rusak of ['not-a-url', 'http://', '://kosong', 'begitu saja']) {
    assert.throws(
      () => pastikanUrlSesi(rusak),
      (err: ToolError) => err.code === 'INVALID_URL',
      `${JSON.stringify(rusak)} harus ditolak`,
    );
  }
});

test('pastikanUrlSesi menolak skema yang tidak bisa dibuka sesi', () => {
  // Ini terurai dengan sukses oleh `new URL`, jadi cek skema harus terpisah dari cek parse.
  for (const rusak of ['mailto:a@b.test', 'javascript:alert(1)', 'ftp://contoh.test']) {
    const galat = ambilGalat(() => pastikanUrlSesi(rusak));
    assert.equal(galat.code, 'INVALID_URL', `${rusak} harus ditolak`);
    assert.match(galat.message, /scheme, which a session cannot open/);
  }
});

test('pastikanUrlSesi menolak nilai kosong sebagai INVALID_URL, bukan diteruskan', () => {
  const galat = ambilGalat(() => pastikanUrlSesi('   '));
  assert.equal(galat.code, 'INVALID_URL');
  assert.match(galat.message, /empty or only whitespace/);
});

test('INVALID_URL retryable — agen harus disuruh mencoba lagi, bukan menyerah', () => {
  const galat = new ToolError('INVALID_URL', 'apa saja');
  assert.equal(galat.retryable, true);
  const teks = toToolResult(galat).content[0].text;
  assert.match(teks, /You may retry/);
  assert.doesNotMatch(teks, /Do not retry/, 'salah alamat itu kesalahan yang bisa dikoreksi');
});

function ambilGalat(jalankan: () => unknown): ToolError {
  try {
    jalankan();
  } catch (err) {
    return err as ToolError;
  }
  throw new Error('diharapkan melempar, tapi tidak');
}
