import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/session.ts';
import { FakeDevice } from '../src/devices/fake.ts';
import { ToolError } from '../src/errors.ts';

function buatManager(limit = 3) {
  const dibuat: FakeDevice[] = [];
  const optsDiterima: Array<{ url?: string }> = [];
  const manager = new SessionManager(async (target, opts) => {
    const device = new FakeDevice(target);
    dibuat.push(device);
    optsDiterima.push(opts);
    return device;
  }, limit);
  return { manager, dibuat, optsDiterima };
}

test('current melempar NO_SESSION sebelum sesi dimulai', () => {
  const { manager } = buatManager();
  assert.throws(() => manager.current(), (err: ToolError) => err.code === 'NO_SESSION');
});

test('start membuat device dan current mengembalikannya', async () => {
  const { manager, dibuat } = buatManager();
  await manager.start('web');
  assert.equal(manager.current(), dibuat[0]);
  assert.equal(dibuat[0].target, 'web');
});

test('start meneruskan opsi url ke pabrik device', async () => {
  const { manager, optsDiterima } = buatManager();
  await manager.start('web', { url: 'https://rekamedika.com' });
  assert.deepEqual(optsDiterima, [{ url: 'https://rekamedika.com' }]);
});

test('start tanpa opsi tetap memanggil pabrik dengan objek opsi kosong', async () => {
  const { manager, optsDiterima } = buatManager();
  await manager.start('computer');
  assert.deepEqual(optsDiterima, [{}]);
});

test('start kedua tanpa end melempar SESSION_ACTIVE', async () => {
  const { manager } = buatManager();
  await manager.start('web');
  await assert.rejects(
    () => manager.start('computer'),
    (err: ToolError) => err.code === 'SESSION_ACTIVE',
  );
});

test('spend mengurangi sisa budget', async () => {
  const { manager } = buatManager(3);
  await manager.start('web');
  manager.spend();
  assert.deepEqual(manager.budgetStatus(), {
    target: 'web',
    used: 1,
    limit: 3,
    remaining: 2,
  });
});

test('spend melampaui batas melempar BUDGET_EXCEEDED', async () => {
  const { manager } = buatManager(2);
  await manager.start('web');
  manager.spend();
  manager.spend();
  assert.throws(() => manager.spend(), (err: ToolError) => err.code === 'BUDGET_EXCEEDED');
});

test('end menutup device dan mereset budget', async () => {
  const { manager, dibuat } = buatManager(2);
  await manager.start('web');
  manager.spend();
  await manager.end();
  assert.equal(dibuat[0].ended, true);
  assert.throws(() => manager.current(), (err: ToolError) => err.code === 'NO_SESSION');
  await manager.start('computer');
  assert.equal(manager.budgetStatus().used, 0);
});

test('end tanpa sesi aktif tidak melempar', async () => {
  const { manager } = buatManager();
  await manager.end();
});
