import type { Device, DeviceTarget } from './devices/types.ts';
import { ToolError } from './errors.ts';

/** Per-session options an MCP caller may supply to `start_session`. */
export interface StartOpts {
  url?: string;
}

export type DeviceFactory = (target: DeviceTarget, opts: StartOpts) => Promise<Device>;

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
    // The cap is the product's cost guarantee, so it is validated *here* rather than
    // trusted from the caller: an unvalidated `NaN` limit makes every `spend()`
    // comparison false and the session runs unbounded. `src/index.ts` screens the env
    // var too, but this is the invariant every construction site must obey.
    this.#limit = SessionManager.batasSah(limit) ? limit : DEFAULT_BUDGET;
  }

  /** A budget cap must be a whole, finite, positive count of AI operations. */
  static batasSah(limit: number): boolean {
    return Number.isInteger(limit) && limit > 0;
  }

  /** The cap for this manager, readable before a session exists. */
  get limit(): number {
    return this.#limit;
  }

  async start(target: DeviceTarget, opts: StartOpts = {}): Promise<void> {
    if (this.#device !== null) {
      throw new ToolError(
        'SESSION_ACTIVE',
        'a session is already running; call end_session first',
      );
    }
    this.#used = 0;
    this.#device = await this.#buatDevice(target, opts);
  }

  current(): Device {
    if (this.#device === null) {
      throw new ToolError('NO_SESSION', 'no active session; call start_session first');
    }
    return this.#device;
  }

  /**
   * Reserve `jumlah` AI operations *before* they are performed. Reserving up front is
   * deliberate: a call that is charged only on success lets a failing or long-running
   * operation spend real money the cap was supposed to prevent. `run_scenario` passes
   * the scenario's step count so a replay cannot outspend the cap either.
   */
  spend(jumlah = 1): void {
    const device = this.current();
    if (!Number.isInteger(jumlah) || jumlah < 0) {
      throw new ToolError('INTERNAL', `spend() needs a whole non-negative count, got ${jumlah}`);
    }
    if (this.#used + jumlah > this.#limit) {
      throw new ToolError(
        'BUDGET_EXCEEDED',
        `AI operation budget of ${this.#limit} reached for this ${device.target} session; ` +
          `${this.#limit - this.#used} left but ${jumlah} requested`,
      );
    }
    this.#used += jumlah;
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
