export type DeviceTarget = 'web' | 'computer';

export interface Screenshot {
  mimeType: string;
  base64: string;
}

export interface Device {
  readonly target: DeviceTarget;
  act(instruction: string): Promise<void>;
  query(schema: string): Promise<unknown>;
  assert(claim: string): Promise<void>;
  screenshot(): Promise<Screenshot>;
  runYaml(yaml: string): Promise<void>;
  reportPath(): string | undefined;
  end(): Promise<void>;
}
