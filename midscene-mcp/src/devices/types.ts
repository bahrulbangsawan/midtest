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

/** Options an MCP caller may supply when opening a session. */
export interface DeviceOpts {
  cacheId?: string;
  url?: string;
}

/**
 * The static shape every device adapter class must expose. `target` is a *static*
 * member (the instance carries its own `target` too) so the factory can confirm the
 * class it just loaded is the one it asked for — without constructing it, which would
 * mean launching a browser or grabbing the desktop.
 */
export interface KelasAdapter {
  readonly target: DeviceTarget;
  open(opts: DeviceOpts): Promise<Device>;
}
