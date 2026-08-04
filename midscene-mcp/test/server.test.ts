import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.ts';
import { SessionManager } from '../src/session.ts';
import { FakeDevice } from '../src/devices/fake.ts';
import { ScenarioStore } from '../src/scenarios.ts';

const BUILD_DEMO = join(import.meta.dirname, '..', '..', 'build-demo.js');

test('createServer mengembalikan instance server', async () => {
  const sessions = new SessionManager(async (target) => new FakeDevice(target));
  const store = new ScenarioStore(await mkdtemp(join(tmpdir(), 'skenario-')));
  assert.ok(createServer({ sessions, store, buildDemoPath: BUILD_DEMO }));
});
