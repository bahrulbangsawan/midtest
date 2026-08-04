import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from './session.ts';
import { registerExplorationTools } from './tools/exploration.ts';

export interface ServerDeps {
  sessions: SessionManager;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'midscene-mcp', version: '0.1.0' });
  registerExplorationTools(server, deps.sessions);
  return server;
}
