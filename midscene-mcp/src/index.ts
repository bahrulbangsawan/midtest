#!/usr/bin/env node
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';
import { SessionManager, DEFAULT_BUDGET } from './session.ts';
import { ScenarioStore } from './scenarios.ts';
import { createDevice } from './devices/factory.ts';

const root = process.env.MIDSCENE_MCP_ROOT ?? process.cwd();
const budgetDiminta = Number(process.env.MIDSCENE_MCP_BUDGET);
const budget =
  Number.isFinite(budgetDiminta) && budgetDiminta > 0 ? budgetDiminta : DEFAULT_BUDGET;

const sessions = new SessionManager(
  (target, opts) => createDevice(target, { ...opts, cacheId: `midscene-mcp-${target}` }),
  budget,
);
const store = new ScenarioStore(join(root, 'scenarios'));
const buildDemoPath = join(root, 'build-demo.js');

const server = createServer({ sessions, store, buildDemoPath });
await server.connect(new StdioServerTransport());
