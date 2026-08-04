import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uraikanDataUriGambar } from '../src/devices/screenshot.ts';

const BADAN = 'iVBORw0KGgoAAAANSUhEUg==';

test('memisahkan mime type dan badan base64 dari data URI', () => {
  assert.deepEqual(uraikanDataUriGambar(`data:image/png;base64,${BADAN}`), {
    mimeType: 'image/png',
    base64: BADAN,
  });
});

test('menormalkan mime type ke huruf kecil', () => {
  assert.equal(
    uraikanDataUriGambar(`data:image/JPEG;base64,${BADAN}`).mimeType,
    'image/jpeg',
  );
});

test('menolak base64 telanjang tanpa prefiks data URI', () => {
  assert.throws(() => uraikanDataUriGambar(BADAN), /base64 image data URI/);
});

test('menolak data URI dengan badan kosong', () => {
  assert.throws(() => uraikanDataUriGambar('data:image/png;base64,'), /empty image body/);
});
