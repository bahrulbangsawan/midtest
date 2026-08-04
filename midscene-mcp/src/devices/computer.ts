import { agentForComputer } from '@midscene/computer';
import type { Device, Screenshot } from './types.ts';
import { uraikanDataUriGambar } from './screenshot.ts';

type ComputerAgent = Awaited<ReturnType<typeof agentForComputer>>;

export class ComputerDeviceAdapter implements Device {
  readonly target = 'computer' as const;

  readonly #agent: ComputerAgent;

  // Explicit field + assignment instead of a TypeScript parameter property:
  // Node's type-stripping loader rejects parameter properties.
  private constructor(agent: ComputerAgent) {
    this.#agent = agent;
  }

  static async open(cacheId?: string): Promise<ComputerDeviceAdapter> {
    const agent = await agentForComputer({
      aiActionContext: 'You are controlling a macOS desktop computer.',
      ...(cacheId ? { cacheId } : {}),
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
