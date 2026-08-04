import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError, toToolResult } from '../src/errors.ts';

test('ToolError membawa kode dan status retryable', () => {
  const err = new ToolError('NO_SESSION', 'belum ada sesi aktif');
  assert.equal(err.code, 'NO_SESSION');
  assert.equal(err.retryable, false);
});

test('galat kuota ditandai tidak boleh diulang', () => {
  const err = new ToolError('BUDGET_EXCEEDED', 'batas 40 operasi tercapai');
  assert.equal(err.retryable, false);
});

test('galat device ditandai boleh diulang', () => {
  const err = new ToolError('DEVICE_FAILED', 'elemen tidak ditemukan');
  assert.equal(err.retryable, true);
});

test('toToolResult memformat ToolError dengan kode dan saran', () => {
  const hasil = toToolResult(new ToolError('NO_SESSION', 'belum ada sesi aktif'));
  assert.equal(hasil.isError, true);
  assert.match(hasil.content[0].text, /NO_SESSION/);
  assert.match(hasil.content[0].text, /belum ada sesi aktif/);
  assert.match(hasil.content[0].text, /do not retry/i);
});

test('toToolResult membungkus galat tak dikenal sebagai INTERNAL', () => {
  const hasil = toToolResult(new Error('sesuatu meledak'));
  assert.match(hasil.content[0].text, /INTERNAL/);
  assert.match(hasil.content[0].text, /sesuatu meledak/);
});
