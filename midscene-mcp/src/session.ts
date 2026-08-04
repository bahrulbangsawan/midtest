import type { Device, DeviceTarget } from './devices/types.ts';
import { ToolError } from './errors.ts';

export type DeviceFactory = (target: DeviceTarget) => Promise<Device>;

export interface SessionStatus {
  target: DeviceTarget;
  used: number;
  limit: number;
  remaining: number;
}

export const DEFAULT_BUDGET = 40;

export class SessionManager {
  #device: Device | null = null;
  #used = 0;
  #buatDevice: DeviceFactory;
  #limit: number;

  constructor(
    buatDevice: DeviceFactory,
    limit: number = DEFAULT_BUDGET,
  ) {
    this.#buatDevice = buatDevice;
    this.#limit = limit;
  }

  async start(target: DeviceTarget): Promise<void> {
    if (this.#device !== null) {
      throw new ToolError(
        'SESSION_ACTIVE',
        'a session is already running; call end_session first',
      );
    }
    this.#used = 0;
    this.#device = await this.#buatDevice(target);
  }

  current(): Device {
    if (this.#device === null) {
      throw new ToolError('NO_SESSION', 'no active session; call start_session first');
    }
    return this.#device;
  }

  spend(): void {
    const device = this.current();
    if (this.#used >= this.#limit) {
      throw new ToolError(
        'BUDGET_EXCEEDED',
        `AI operation budget of ${this.#limit} reached for this ${device.target} session`,
      );
    }
    this.#used += 1;
  }

  budgetStatus(): SessionStatus {
    const device = this.current();
    return {
      target: device.target,
      used: this.#used,
      limit: this.#limit,
      remaining: this.#limit - this.#used,
    };
  }

  async end(): Promise<void> {
    if (this.#device === null) return;
    const device = this.#device;
    this.#device = null;
    this.#used = 0;
    await device.end();
  }
}
