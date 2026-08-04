import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from './session.ts';
import type { ScenarioStore } from './scenarios.ts';
import { registerExplorationTools } from './tools/exploration.ts';
import { registerScenarioTools } from './tools/scenarios.ts';

export interface ServerDeps {
  sessions: SessionManager;
  store: ScenarioStore;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'midscene-mcp', version: '0.1.0' });
  registerExplorationTools(server, deps.sessions);
  registerScenarioTools(server, deps.sessions, deps.store);
  return server;
}
