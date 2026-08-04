import type { Device, DeviceTarget } from './types.ts';

export interface DeviceOpts {
  cacheId?: string;
  url?: string;
}

export function pilihKelasDevice(target: DeviceTarget): string {
  return target === 'computer' ? 'ComputerDeviceAdapter' : 'WebDeviceAdapter';
}

export async function createDevice(
  target: DeviceTarget,
  opts: DeviceOpts = {},
): Promise<Device> {
  if (target === 'computer') {
    const { ComputerDeviceAdapter } = await import('./computer.ts');
    return ComputerDeviceAdapter.open(opts.cacheId);
  }
  const { WebDeviceAdapter } = await import('./web.ts');
  return WebDeviceAdapter.open(opts.url, opts.cacheId);
}
