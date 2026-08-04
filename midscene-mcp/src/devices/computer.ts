import { agentForComputer } from '@midscene/computer';
import type { Device, DeviceOpts, KelasAdapter, Screenshot } from './types.ts';
import { uraikanDataUriGambar } from './screenshot.ts';

type ComputerAgent = Awaited<ReturnType<typeof agentForComputer>>;

export class ComputerDeviceAdapter implements Device {
  /** Static twin of the instance field, read by the factory before construction. */
  static readonly target = 'computer' as const;

  readonly target = 'computer' as const;

  readonly #agent: ComputerAgent;

  // Explicit field + assignment instead of a TypeScript parameter property:
  // Node's type-stripping loader rejects parameter properties.
  private constructor(agent: ComputerAgent) {
    this.#agent = agent;
  }

  static async open(opts: DeviceOpts = {}): Promise<ComputerDeviceAdapter> {
    // `opts.url` is deliberately unused: a desktop session has no address to open.
    // The start_session handler already tells the caller the url was ignored.
    const agent = await agentForComputer({
      aiActionContext: 'You are controlling a macOS desktop computer.',
      ...(opts.cacheId ? { cacheId: opts.cacheId } : {}),
    });
    return new ComputerDeviceAdapter(agent);
  }

  async act(instruction: string): Promise<void> {
    await this.#agent.aiAct(instruction);
  }

  async query(schema: string): Promise<unknown> {
    return this.#agent.aiQuery(schema);
  }

  async assert(claim: string): Promise<void> {
    await this.#agent.aiAssert(claim);
  }

  async screenshot(): Promise<Screenshot> {
    // NOT `logScreenshot()`: that is a deprecated alias of `recordToReport()` and
    // resolves to void — it writes into the HTML report instead of returning pixels.
    // The device interface is what actually hands back an image.
    return uraikanDataUriGambar(await this.#agent.interface.screenshotBase64());
  }

  async runYaml(yaml: string): Promise<void> {
    await this.#agent.runYaml(yaml);
  }

  reportPath(): string | undefined {
    // `Agent.reportFile` is a public `string | null | undefined`; normalise null away.
    return this.#agent.reportFile ?? undefined;
  }

  async end(): Promise<void> {
    await this.#agent.destroy();
  }
}

// Compile-time proof that the factory's runtime lookup finds what it expects.
// Erased by type stripping.
ComputerDeviceAdapter satisfies KelasAdapter;
