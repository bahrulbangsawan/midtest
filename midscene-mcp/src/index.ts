#!/usr/bin/env node
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';
import { SessionManager } from './session.ts';
import { FakeDevice } from './devices/fake.ts';
import { ScenarioStore } from './scenarios.ts';

// TODO(Task 9): swap FakeDevice for real web/computer device adapters.
console.error(
  '[midscene-mcp] WARNING: no real device adapters wired yet (Task 9 pending) — all automation is simulated.',
);
const root = process.env.MIDSCENE_MCP_ROOT ?? process.cwd();
const sessions = new SessionManager(async (target) => new FakeDevice(target));
const store = new ScenarioStore(join(root, 'scenarios'));
const buildDemoPath = join(root, '..', 'build-demo.js');

const server = createServer({ sessions, store, buildDemoPath });
await server.connect(new StdioServerTransport());
