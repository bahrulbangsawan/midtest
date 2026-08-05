import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { akarMidsceneCore } from './lokasi-paket.ts';
import {
  ambilKelasAdapter,
  pilihKelasDevice,
  PENDAFTARAN_DEVICE_UNTUK_TES,
} from '../src/devices/factory.ts';
import type { DeviceTarget } from '../src/devices/types.ts';

const SEMUA_TARGET: DeviceTarget[] = ['web', 'computer'];

test('target computer memilih ComputerDeviceAdapter', () => {
  assert.equal(pilihKelasDevice('computer'), 'ComputerDeviceAdapter');
});

test('target web memilih WebDeviceAdapter', () => {
  assert.equal(pilihKelasDevice('web'), 'WebDeviceAdapter');
});

// Tes ini memaku jalur yang benar-benar dijalankan, bukan penggantinya: ia memuat
// modul adapter sungguhan lewat loader di registry, lalu mencocokkannya dengan nama
// yang dikembalikan pilihKelasDevice dan dengan target statis yang dideklarasikan
// kelasnya. Menukar dua dynamic import di factory.ts membuat tes ini gagal.
// Tidak ada browser yang diluncurkan dan tidak ada panggilan model — hanya impor.
test('setiap loader registry memuat kelas yang namanya dikembalikan pilihKelasDevice', async () => {
  for (const target of SEMUA_TARGET) {
    const modul = await PENDAFTARAN_DEVICE_UNTUK_TES[target].muat();
    const Kelas = ambilKelasAdapter(modul, pilihKelasDevice(target), target);
    assert.equal(
      Kelas.target,
      target,
      `loader untuk target ${target} harus menghasilkan adapter dengan target yang sama`,
    );
    assert.equal(typeof Kelas.open, 'function', `adapter ${target} harus punya open()`);
  }
});

test('ambilKelasAdapter menolak modul yang tidak mengekspor kelas yang diminta', () => {
  assert.throws(
    () => ambilKelasAdapter({}, 'WebDeviceAdapter', 'web'),
    /does not export WebDeviceAdapter/,
  );
});

test('ambilKelasAdapter menolak kelas dengan target yang tidak cocok', () => {
  class Palsu {
    static readonly target = 'computer';
  }
  assert.throws(
    () => ambilKelasAdapter({ WebDeviceAdapter: Palsu }, 'WebDeviceAdapter', 'web'),
    /declares target "computer" but was loaded for target "web"/,
  );
});

// --- Cache benar-benar aktif, bukan sekadar cacheId ---

// Tes ini memanggil fungsi Midscene yang sama persis dengan yang dipanggil Agent
// (`Agent#processCacheConfig` -> `processCacheConfig(opts.cache, opts.cacheId)`),
// dengan MIDSCENE_CACHE sengaja dihapus. Kalau opsiCache berhenti mengirim
// `cache: true`, hasilnya undefined, Agent melewati `new TaskCache(...)`, dan setiap
// replay membayar VLM penuh — persis bug yang ditemukan reviewer.
test('opsiCache menghasilkan konfigurasi yang benar-benar membangun TaskCache', async () => {
  const { processCacheConfig } = await import('@midscene/core/utils');
  // Sengaja dari modul internal (lewat file URL — subpath ini tidak ada di peta
  // `exports`): `Agent#processCacheConfig` memanggil ini LEBIH DULU, dan ia melempar
  // untuk `cache: true`. Tanpa memakukan itu di sini, bentuk opsi yang salah baru
  // ketahuan saat konstruktor Agent sungguhan meledak — yaitu saat browser sudah
  // diluncurkan dan pengguna sudah menunggu.
  const jalurCacheConfig = pathToFileURL(
    join(akarMidsceneCore(), 'dist', 'es', 'agent', 'cache-config.mjs'),
  ).href;
  const { validateAgentCacheInput } = (await import(jalurCacheConfig)) as {
    validateAgentCacheInput: (cache: unknown) => void;
  };
  const { opsiCache } = await import('../src/devices/cache.ts');

  const sebelumnya = process.env.MIDSCENE_CACHE;
  delete process.env.MIDSCENE_CACHE;
  try {
    const opts = opsiCache({ cacheId: 'midscene-mcp-web' });
    assert.deepEqual(opts, {
      cacheId: 'midscene-mcp-web',
      cache: { id: 'midscene-mcp-web' },
    });

    validateAgentCacheInput(opts.cache);
    assert.throws(
      () => validateAgentCacheInput(true as never),
      /cache: true requires an explicit cache ID/,
      'bentuk `cache: true` ditolak Midscene — opsiCache harus mengirim bentuk objek',
    );
    const cfg = processCacheConfig(opts.cache, opts.cacheId ?? 'default');
    assert.deepEqual(cfg, { id: 'midscene-mcp-web' });
    assert.ok(cfg, 'cfg truthy adalah syarat Agent memanggil new TaskCache(...)');

    // Kontrol: jalur lama (hanya cacheId, tanpa env var) menghasilkan undefined.
    assert.equal(processCacheConfig(undefined, 'midscene-mcp-web'), undefined);
  } finally {
    if (sebelumnya === undefined) delete process.env.MIDSCENE_CACHE;
    else process.env.MIDSCENE_CACHE = sebelumnya;
  }
});

test('opsiCache tanpa cacheId tidak memaksa cache', async () => {
  const { opsiCache } = await import('../src/devices/cache.ts');
  assert.deepEqual(opsiCache({}), {});
});
