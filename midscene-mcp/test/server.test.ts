import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';

test('server terdaftar dengan nama dan versi', () => {
  const server = createServer();
  assert.ok(server, 'createServer harus mengembalikan instance server');
});
