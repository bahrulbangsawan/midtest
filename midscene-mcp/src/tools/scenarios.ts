import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from '../session.ts';
import type { ScenarioStore } from '../scenarios.ts';
import { analisaSkenario } from '../scenarios.ts';
import { bersihkanUrl } from '../url.ts';
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
        'Freeze a sequence of steps that worked during exploration into a reusable Midscene YAML scenario. Run this once the flow is proven. Write the flow as explicit steps (ai, aiAssert, aiWaitFor, ...), one per action — that lets run_scenario reserve one bounded session-budget operation per flow item, while eligible work can use the Midscene cache on replay. This is a budget guard, not a count of raw model calls: one Midscene operation may re-plan internally. Do not use runGherkinScenario: run_scenario refuses it with SCENARIO_UNSUPPORTED because its cost cannot be bounded ahead of the run and Midscene disables caching for it.',
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
        'Replay a saved scenario end to end with the Midscene cache enabled. For a web target the session first opens the address the scenario declares in its own YAML (page:, browser:, web: or target: — Midscene accepts exactly one of them, each with a url:), so a saved scenario is self-contained; pass url to replay the same flow somewhere else. A web scenario that names no address anywhere is refused with SCENARIO_NO_URL rather than replayed against a blank page. Cache hits can skip vision work, while the server reserves one session-budget operation per YAML flow item up front. That budget is a bounded-work guard rather than a count of raw model calls: an uncached Midscene operation may re-plan internally. A scenario with more steps than the budget is refused with BUDGET_EXCEEDED and never runs, and one containing runGherkinScenario is refused with SCENARIO_UNSUPPORTED because its cost cannot be bounded ahead of the run. Use this for regression runs.',
      inputSchema: {
        name: z.string(),
        target: z.enum(['web', 'computer']),
        url: z
          .string()
          .optional()
          .describe(
            'Replay against this address instead of the one saved in the scenario YAML. Must be absolute and include its scheme ("https://example.com", not "example.com"); http, https and file are accepted. Anything else is refused with INVALID_URL before a browser opens, and you may call again with a corrected value. Web target only; ignored for "computer", which has no address to open.',
          ),
      },
    },
    async ({ name, target, url }) => {
      try {
        const yaml = await store.load(name);
        // One parse serves both the cost guard and the navigation: see `analisaSkenario`.
        const { langkah, url: urlYaml } = analisaSkenario(yaml);
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
        // `Agent.runYaml` replays the flow on the agent it is already bound to and never
        // navigates, so the address in the YAML only takes effect if the session opens it.
        // Same convention as `start_session`: a url is a web-only notion, and the computer
        // adapter ignores it, so it is dropped here and the caller is told.
        const urlDipakai =
          target === 'web' ? (bersihkanUrl(url) ?? urlYaml) : undefined;
        if (target === 'web' && urlDipakai === undefined) {
          throw new ToolError(
            'SCENARIO_NO_URL',
            `scenario "${name}" is being replayed on the web but names no address, so it ` +
              'would run against a blank page and every step would fail. Give the scenario ' +
              'a target block of its own — "web:\\n  url: https://example.com\\n" above ' +
              '"tasks:" (page:, browser: and target: are the other accepted spellings; use ' +
              'exactly one) — or pass the url argument to replay it elsewhere.',
          );
        }
        await sessions.start(target, { url: urlDipakai });
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
          const dibuka = urlDipakai ? ` at ${urlDipakai}` : '';
          // Worded exactly as `start_session` words it, for the same reason: a url handed
          // to a desktop session is a caller mistake worth naming, not worth failing over.
          const diabaikan =
            url && urlDipakai === undefined
              ? ' Note: url was ignored — it applies to the web target only.'
              : '';
          const teks = report
            ? `Scenario "${name}" finished${dibuka}. ${biaya} Report: ${report}${diabaikan}`
            : `Scenario "${name}" finished${dibuka}. ${biaya} No report was written.${diabaikan}`;
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
