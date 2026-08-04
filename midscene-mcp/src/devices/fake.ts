import type { Device, DeviceTarget, Screenshot } from './types.ts';

const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export class FakeDevice implements Device {
  readonly target: DeviceTarget;
  readonly calls: string[] = [];
  queryResult: unknown = null;
  failNext: string | null = null;
  fakeReportPath: string | undefined = undefined;
  ended = false;

  constructor(target: DeviceTarget) {
    this.target = target;
  }

  private record(entry: string): void {
    if (this.failNext !== null) {
      const pesan = this.failNext;
      this.failNext = null;
      throw new Error(pesan);
    }
    this.calls.push(entry);
  }

  async act(instruction: string): Promise<void> {
    this.record(`act:${instruction}`);
  }

  async query(schema: string): Promise<unknown> {
    this.record(`query:${schema}`);
    return this.queryResult;
  }

  async assert(claim: string): Promise<void> {
    this.record(`assert:${claim}`);
  }

  async screenshot(): Promise<Screenshot> {
    this.record('screenshot');
    return { mimeType: 'image/png', base64: PIXEL_PNG_BASE64 };
  }

  async runYaml(yaml: string): Promise<void> {
    this.record(`runYaml:${yaml}`);
  }

  reportPath(): string | undefined {
    return this.fakeReportPath;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}
