import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from '../session.ts';
import { ToolError, toToolResult } from '../errors.ts';

function bungkusGalatDevice(err: unknown): never {
  if (err instanceof ToolError) throw err;
  throw new ToolError('DEVICE_FAILED', err instanceof Error ? err.message : String(err));
}

export function registerExplorationTools(server: McpServer, sessions: SessionManager): void {
  server.registerTool(
    'start_session',
    {
      description:
        'Open an automation session. Use target "web" for a browser, "computer" for the macOS desktop. Only one session may run at a time.',
      inputSchema: {
        target: z.enum(['web', 'computer']),
        url: z.string().optional().describe('Initial URL, web target only'),
      },
    },
    async ({ target, url }) => {
      try {
        const urlDipakai = target === 'web' ? url : undefined;
        await sessions.start(target, { url: urlDipakai });
        const { limit } = sessions.budgetStatus();
        const dibuka = urlDipakai ? ` at ${urlDipakai}` : '';
        const diabaikan =
          url && urlDipakai === undefined
            ? ' Note: url was ignored — it applies to the web target only.'
            : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `Session started on ${target}${dibuka}. AI operation budget: ${limit}.${diabaikan}`,
            },
          ],
        };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'act',
    {
      description:
        'Perform one UI action described in natural language, e.g. "click the sign in button". Consumes one AI operation from the budget.',
      inputSchema: { instruction: z.string() },
    },
    async ({ instruction }) => {
      try {
        const device = sessions.current();
        sessions.spend();
        await device.act(instruction).catch(bungkusGalatDevice);
        const { used, limit } = sessions.budgetStatus();
        return {
          content: [
            { type: 'text' as const, text: `Done. Budget used: ${used} of ${limit}.` },
          ],
        };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'query',
    {
      description:
        'Extract structured data from the current screen. Pass a shape description such as "{title: string, price: number}". Consumes one AI operation.',
      inputSchema: { schema: z.string() },
    },
    async ({ schema }) => {
      try {
        const device = sessions.current();
        sessions.spend();
        const hasil = await device.query(schema).catch(bungkusGalatDevice);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(hasil, null, 2) }],
        };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'assert',
    {
      description:
        'Verify a claim about the current screen, e.g. "the cart shows 2 items". Fails the tool call if untrue. Consumes one AI operation.',
      inputSchema: { claim: z.string() },
    },
    async ({ claim }) => {
      try {
        const device = sessions.current();
        sessions.spend();
        await device.assert(claim).catch(bungkusGalatDevice);
        const { used, limit } = sessions.budgetStatus();
        return {
          content: [
            { type: 'text' as const, text: `Assertion holds. Budget used: ${used} of ${limit}.` },
          ],
        };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'screenshot',
    {
      description:
        'Capture the current screen. Free — does not consume the AI operation budget.',
      inputSchema: {},
    },
    async () => {
      try {
        const device = sessions.current();
        const shot = await device.screenshot().catch(bungkusGalatDevice);
        return {
          content: [
            { type: 'image' as const, data: shot.base64, mimeType: shot.mimeType },
          ],
        };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'end_session',
    {
      description: 'Close the running session and release the browser or desktop connection.',
      inputSchema: {},
    },
    async () => {
      try {
        await sessions.end();
        return { content: [{ type: 'text' as const, text: 'Session closed.' }] };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );
}
