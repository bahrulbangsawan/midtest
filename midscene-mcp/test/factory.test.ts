import { test } from 'node:test';
import assert from 'node:assert/strict';
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
