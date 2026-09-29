#!/usr/bin/env node
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';
import { SessionManager, DEFAULT_BUDGET } from './session.ts';
import { ScenarioStore } from './scenarios.ts';
import { createDevice } from './devices/factory.ts';

const root = process.env.MIDSCENE_MCP_ROOT ?? process.cwd();
// Source code in a packaged desktop app lives in its read-only application
// bundle. Keep mutable scenarios in the app data directory while preserving
// the historical source-root default for direct MCP usage and development.
const dataRoot = process.env.MIDSCENE_MCP_DATA_DIR || root;
const budgetMentah = process.env.MIDSCENE_MCP_BUDGET;
const budgetDiminta = Number(budgetMentah);
// `SessionManager` re-checks this itself; the check is repeated here only so an
// invalid env var produces a readable warning instead of a silent fallback.
const budgetSah = SessionManager.batasSah(budgetDiminta);
const budget = budgetSah ? budgetDiminta : DEFAULT_BUDGET;
if (budgetMentah !== undefined && !budgetSah) {
  // stderr only — stdout carries the JSON-RPC channel and must stay clean.
  console.error(
    `[midscene-mcp] ignoring invalid MIDSCENE_MCP_BUDGET=${JSON.stringify(budgetMentah)}; using the default of ${DEFAULT_BUDGET}. Expected a positive whole number.`,
  );
}

const sessions = new SessionManager(
  (target, opts) => createDevice(target, { ...opts, cacheId: `midscene-mcp-${target}` }),
  budget,
);
const store = new ScenarioStore(join(dataRoot, 'scenarios'));
const buildDemoPath = join(root, 'build-demo.js');

const server = createServer({ sessions, store, buildDemoPath });
await server.connect(new StdioServerTransport());
