import puppeteer, { type Browser, type Page } from 'puppeteer';
import { PuppeteerAgent } from '@midscene/web/puppeteer';
import type { Device, DeviceOpts, KelasAdapter, Screenshot } from './types.ts';

/**
 * Matches the human partner's proven script (`demo-registrasi.mjs`).
 *
 * Puppeteer's own default viewport is a frozen 800x600 at deviceScaleFactor 1,
 * applied regardless of the OS window size. That is 3.6x fewer pixels than this,
 * *before* Midscene's fixed q90 JPEG re-encode — and for a product whose entire
 * output is readable visual documentation, that is not a marginal loss. Worse,
 * 800 CSS px sits below common responsive breakpoints, so a nav control that the
 * proven instruction clicks in the top-right corner may be collapsed behind a
 * hamburger, making the MCP path fail a flow that already works.
 *
 * Midscene pins JPEG quality at 90 and exposes no setting for it, so
 * deviceScaleFactor is the only sharpness lever: 2 yields 2880x1800.
 */
const VIEWPORT_BAWAAN = { width: 1440, height: 900, deviceScaleFactor: 2 } as const;
const ARGS_BAWAAN = ['--window-size=1456,1000'];

export class WebDeviceAdapter implements Device {
  /** Static twin of the instance field, read by the factory before construction. */
  static readonly target = 'web' as const;

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

  static async open(opts: DeviceOpts = {}): Promise<WebDeviceAdapter> {
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      defaultViewport: { ...VIEWPORT_BAWAAN },
      args: [...ARGS_BAWAAN],
    });
    try {
      const page = await browser.newPage();
      if (opts.url) await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
      const agent = new PuppeteerAgent(page, opts.cacheId ? { cacheId: opts.cacheId } : {});
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

// Compile-time proof that the factory's runtime lookup finds what it expects.
// Erased by type stripping.
WebDeviceAdapter satisfies KelasAdapter;
