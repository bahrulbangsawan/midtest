import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from '../session.ts';
import type { ScenarioStore } from '../scenarios.ts';
import { hitungLangkahSkenario } from '../scenarios.ts';
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
        'Freeze a sequence of steps that worked during exploration into a reusable Midscene YAML scenario. Run this once the flow is proven. Write the flow as explicit steps (ai, aiAssert, aiWaitFor, ...), one per action — that is what run_scenario can count and charge, and what the Midscene cache can make cheap on replay. Do not use runGherkinScenario: run_scenario refuses it with SCENARIO_UNSUPPORTED because its cost cannot be bounded ahead of the run and Midscene disables caching for it.',
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
        'Replay a saved scenario end to end with the Midscene cache enabled. Cached steps skip the vision model entirely, but a replay is still charged against the session budget up front: one AI operation per flow step in the scenario YAML. A scenario with more steps than the budget is refused with BUDGET_EXCEEDED and never runs, and one containing runGherkinScenario is refused with SCENARIO_UNSUPPORTED because its cost cannot be bounded ahead of the run. Use this for regression runs.',
      inputSchema: {
        name: z.string(),
        target: z.enum(['web', 'computer']),
      },
    },
    async ({ name, target }) => {
      try {
        const yaml = await store.load(name);
        const langkah = hitungLangkahSkenario(yaml);
        // Refuse before `start`: an oversized scenario must not open a browser or grab
        // the desktop just to be rejected a moment later. `spend` below is still the
        // authoritative reservation.
        if (langkah > sessions.limit) {
          throw new ToolError(
            'BUDGET_EXCEEDED',
            `scenario "${name}" has ${langkah} steps but the AI operation budget is ${sessions.limit}; ` +
              'split the scenario or raise MIDSCENE_MCP_BUDGET',
          );
        }
        await sessions.start(target);
        try {
          sessions.spend(langkah);
          const device = sessions.current();
          await device.runYaml(yaml).catch((err: unknown) => {
            throw new ToolError(
              'DEVICE_FAILED',
              err instanceof Error ? err.message : String(err),
            );
          });
          const report = device.reportPath();
          const biaya = `Charged ${langkah} of ${sessions.limit} AI operations.`;
          const teks = report
            ? `Scenario "${name}" finished. ${biaya} Report: ${report}`
            : `Scenario "${name}" finished. ${biaya} No report was written.`;
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
