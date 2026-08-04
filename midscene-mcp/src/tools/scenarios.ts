import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from '../session.ts';
import type { ScenarioStore } from '../scenarios.ts';
import { ToolError, toToolResult } from '../errors.ts';

export function registerScenarioTools(
  server: McpServer,
  sessions: SessionManager,
  store: ScenarioStore,
): void {
  server.registerTool(
    'save_scenario',
    {
      description:
        'Freeze a sequence of steps that worked during exploration into a reusable Midscene YAML scenario. Run this once the flow is proven.',
      inputSchema: {
        name: z.string().describe('Letters, digits, hyphen and underscore only'),
        yaml: z.string().describe('Midscene YAML flow'),
      },
    },
    async ({ name, yaml }) => {
      try {
        const path = await store.save(name, yaml);
        return { content: [{ type: 'text' as const, text: `Scenario saved to ${path}` }] };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'list_scenarios',
    {
      description: 'List saved scenario names.',
      inputSchema: {},
    },
    async () => {
      try {
        const nama = await store.list();
        const teks = nama.length > 0 ? nama.join('\n') : 'No scenarios saved yet.';
        return { content: [{ type: 'text' as const, text: teks }] };
      } catch (err) {
        return toToolResult(err);
      }
    },
  );

  server.registerTool(
    'run_scenario',
    {
      description:
        'Replay a saved scenario end to end with the Midscene cache enabled. Cheap: cached steps skip the vision model entirely. Use this for regression runs.',
      inputSchema: {
        name: z.string(),
        target: z.enum(['web', 'computer']),
      },
    },
    async ({ name, target }) => {
      try {
        const yaml = await store.load(name);
        await sessions.start(target);
        try {
          const device = sessions.current();
          await device.runYaml(yaml).catch((err: unknown) => {
            throw new ToolError(
              'DEVICE_FAILED',
              err instanceof Error ? err.message : String(err),
            );
          });
          const report = device.reportPath();
          const teks = report
            ? `Scenario "${name}" finished. Report: ${report}`
            : `Scenario "${name}" finished. No report was written.`;
          return { content: [{ type: 'text' as const, text: teks }] };
        } finally {
          await sessions.end();
        }
      } catch (err) {
        return toToolResult(err);
      }
    },
  );
}
