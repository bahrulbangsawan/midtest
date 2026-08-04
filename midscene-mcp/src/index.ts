#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';
import { SessionManager } from './session.ts';
import { FakeDevice } from './devices/fake.ts';

// TODO(Task 9): swap FakeDevice for real web/computer device adapters.
const sessions = new SessionManager(async (target) => new FakeDevice(target));

const server = createServer({ sessions });
await server.connect(new StdioServerTransport());
