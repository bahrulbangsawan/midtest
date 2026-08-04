import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager, DEFAULT_BUDGET } from '../src/session.ts';
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

/**
 * Cek alamat duduk di `start`, bukan di masing-masing handler tool, supaya
 * `start_session` dan `run_scenario` tidak bisa saling melenceng. Tesnya juga di sini:
 * pabrik device tidak boleh dipanggil sama sekali — di produksi, pabrik itulah yang
 * meluncurkan Chrome sebelum `page.goto` sempat mengeluh.
 */
test('start menolak url yang tidak sah tanpa pernah memanggil pabrik device', async () => {
  for (const rusak of ['contoh.test', 'not-a-url', 'mailto:a@b.test', '   ']) {
    const { manager, dibuat } = buatManager();
    await assert.rejects(
      () => manager.start('web', { url: rusak }),
      (err: ToolError) => err.code === 'INVALID_URL' && err.retryable === true,
      `${JSON.stringify(rusak)} harus ditolak`,
    );
    assert.equal(dibuat.length, 0, 'tidak boleh ada device yang dibuat');
  }
});

test('start yang ditolak karena url tidak meninggalkan sesi setengah jadi', async () => {
  const { manager } = buatManager();
  await assert.rejects(() => manager.start('web', { url: 'contoh.test' }));
  assert.throws(() => manager.current(), (err: ToolError) => err.code === 'NO_SESSION');
  // Dan sesi berikutnya yang benar tetap bisa dimulai.
  await manager.start('web', { url: 'https://contoh.test' });
  assert.equal(manager.current().target, 'web');
});

test('start meneruskan url yang sudah dipangkas ke pabrik device', async () => {
  const { manager, optsDiterima } = buatManager();
  await manager.start('web', { url: '  https://contoh.test  ' });
  assert.deepEqual(optsDiterima, [{ url: 'https://contoh.test' }]);
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

test('spend bisa memesan beberapa operasi sekaligus', async () => {
  const { manager } = buatManager(10);
  await manager.start('web');
  manager.spend(4);
  assert.equal(manager.budgetStatus().used, 4);
  assert.equal(manager.budgetStatus().remaining, 6);
});

test('spend banyak yang tidak muat ditolak tanpa memotong budget sebagian', async () => {
  const { manager } = buatManager(3);
  await manager.start('web');
  assert.throws(() => manager.spend(4), (err: ToolError) => err.code === 'BUDGET_EXCEEDED');
  assert.equal(manager.budgetStatus().used, 0, 'penolakan tidak boleh memotong sebagian');
});

test('spend menolak jumlah yang bukan bilangan bulat non-negatif', async () => {
  const { manager } = buatManager(10);
  await manager.start('web');
  assert.throws(() => manager.spend(1.5), (err: ToolError) => err.code === 'INTERNAL');
  assert.throws(() => manager.spend(-1), (err: ToolError) => err.code === 'INTERNAL');
  assert.throws(() => manager.spend(Number.NaN), (err: ToolError) => err.code === 'INTERNAL');
});

// --- Batas budget divalidasi di dalam SessionManager, bukan hanya di src/index.ts ---

test('limit NaN jatuh ke DEFAULT_BUDGET, bukan berjalan tanpa batas', async () => {
  const { manager } = buatManager(Number('bogus'));
  await manager.start('web');
  assert.equal(manager.limit, DEFAULT_BUDGET);
  manager.spend(DEFAULT_BUDGET);
  assert.equal(manager.budgetStatus().limit, DEFAULT_BUDGET);
  assert.throws(() => manager.spend(), (err: ToolError) => err.code === 'BUDGET_EXCEEDED');
});

test('limit pecahan, nol, negatif dan tak hingga jatuh ke DEFAULT_BUDGET', async () => {
  for (const buruk of [2.5, 0, -3, Number.POSITIVE_INFINITY]) {
    const { manager } = buatManager(buruk);
    assert.equal(manager.limit, DEFAULT_BUDGET, `limit ${buruk} harus ditolak`);
  }
});

test('limit bilangan bulat positif dipakai apa adanya', () => {
  const { manager } = buatManager(7);
  assert.equal(manager.limit, 7);
});

test('batasSah menerima hanya bilangan bulat positif', () => {
  assert.equal(SessionManager.batasSah(1), true);
  assert.equal(SessionManager.batasSah(40), true);
  assert.equal(SessionManager.batasSah(0), false);
  assert.equal(SessionManager.batasSah(2.5), false);
  assert.equal(SessionManager.batasSah(Number.NaN), false);
  assert.equal(SessionManager.batasSah(Number.POSITIVE_INFINITY), false);
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
