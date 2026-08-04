import type { Device, DeviceOpts, DeviceTarget, KelasAdapter } from './types.ts';

export type { DeviceOpts } from './types.ts';

interface EntriPendaftaran {
  kelas: string;
  muat: () => Promise<unknown>;
}

/**
 * Single source of truth for "which adapter serves which target".
 *
 * `pilihKelasDevice` and `createDevice` both read this map, and `createDevice` looks
 * the class up *by the very name `pilihKelasDevice` returns* — so the unit-tested
 * helper and the executed code path cannot drift apart. Previously each function
 * carried its own `target === 'computer'` ternary: swapping the two dynamic imports
 * left all 52 tests green, and the first symptom would have been a desktop session
 * opening when the caller asked for a browser, during a paid run.
 *
 * The imports stay dynamic on purpose: a web run must not pull in
 * `@midscene/computer`, and a computer run must not pull in `puppeteer`.
 */
const PENDAFTARAN_DEVICE: Record<DeviceTarget, EntriPendaftaran> = {
  computer: {
    kelas: 'ComputerDeviceAdapter',
    muat: () => import('./computer.ts'),
  },
  web: {
    kelas: 'WebDeviceAdapter',
    muat: () => import('./web.ts'),
  },
};

/** Exposed so a test can walk every entry and pin the real loaders, not a stand-in. */
export const PENDAFTARAN_DEVICE_UNTUK_TES: Record<DeviceTarget, EntriPendaftaran> =
  PENDAFTARAN_DEVICE;

export function pilihKelasDevice(target: DeviceTarget): string {
  return PENDAFTARAN_DEVICE[target].kelas;
}

/**
 * Pull the adapter class out of a freshly imported module namespace and prove it is
 * the right one. The static `target` check is what makes a swapped registry entry
 * fail loudly instead of silently driving the wrong device.
 */
export function ambilKelasAdapter(
  modul: unknown,
  nama: string,
  target: DeviceTarget,
): KelasAdapter {
  const kandidat = (modul as Record<string, unknown>)[nama];
  if (typeof kandidat !== 'function') {
    throw new Error(`device adapter module for target "${target}" does not export ${nama}`);
  }
  const dideklarasikan = (kandidat as { target?: unknown }).target;
  if (dideklarasikan !== target) {
    throw new Error(
      `device adapter ${nama} declares target "${String(dideklarasikan)}" but was loaded for target "${target}"`,
    );
  }
  return kandidat as unknown as KelasAdapter;
}

export async function createDevice(
  target: DeviceTarget,
  opts: DeviceOpts = {},
): Promise<Device> {
  const nama = pilihKelasDevice(target);
  const modul = await PENDAFTARAN_DEVICE[target].muat();
  return ambilKelasAdapter(modul, nama, target).open(opts);
}
