import puppeteer, { type Browser, type Page } from 'puppeteer';
import { PuppeteerAgent } from '@midscene/web/puppeteer';
import type { Device, Screenshot } from './types.ts';

export class WebDeviceAdapter implements Device {
  readonly target = 'web' as const;

  readonly #browser: Browser;
  readonly #page: Page;
  readonly #agent: PuppeteerAgent;

  // Explicit fields + assignment instead of TypeScript parameter properties:
  // Node's type-stripping loader rejects parameter properties.
  private constructor(browser: Browser, page: Page, agent: PuppeteerAgent) {
    this.#browser = browser;
    this.#page = page;
    this.#agent = agent;
  }

  static async open(url?: string, cacheId?: string): Promise<WebDeviceAdapter> {
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage();
      if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
      const agent = new PuppeteerAgent(page, cacheId ? { cacheId } : {});
      return new WebDeviceAdapter(browser, page, agent);
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
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
    // Puppeteer with `encoding: 'base64'` returns a bare base64 body (no data URI),
    // and capturing from the page keeps the shot to the browser window only.
    const base64 = await this.#page.screenshot({ encoding: 'base64', type: 'png' });
    return { mimeType: 'image/png', base64 };
  }

  async runYaml(yaml: string): Promise<void> {
    await this.#agent.runYaml(yaml);
  }

  reportPath(): string | undefined {
    // `Agent.reportFile` is a public `string | null | undefined`; normalise null away.
    return this.#agent.reportFile ?? undefined;
  }

  async end(): Promise<void> {
    // `Agent.destroy()` finalises the HTML report and assigns `reportFile`.
    // PuppeteerWebPage.destroy() is a no-op, so the browser must be closed here —
    // and it must close even if report finalisation throws.
    try {
      await this.#agent.destroy();
    } finally {
      await this.#browser.close();
    }
  }
}
