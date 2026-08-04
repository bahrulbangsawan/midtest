import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from './session.ts';
import type { ScenarioStore } from './scenarios.ts';
import { registerExplorationTools } from './tools/exploration.ts';
import { registerScenarioTools } from './tools/scenarios.ts';
import { registerWalkthroughTool } from './tools/walkthrough.ts';

export interface ServerDeps {
  sessions: SessionManager;
  store: ScenarioStore;
  buildDemoPath: string;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'midscene-mcp', version: '0.1.0' });
  registerExplorationTools(server, deps.sessions);
  registerScenarioTools(server, deps.sessions, deps.store);
  registerWalkthroughTool(server, { buildDemoPath: deps.buildDemoPath });
  return server;
}
