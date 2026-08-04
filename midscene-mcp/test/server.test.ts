import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';
import { SessionManager } from '../src/session.ts';
import { FakeDevice } from '../src/devices/fake.ts';

test('createServer mengembalikan instance server', () => {
  const sessions = new SessionManager(async (target) => new FakeDevice(target));
  assert.ok(createServer({ sessions }));
});
