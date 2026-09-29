import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    '--env-file=.env',
    'midscene-mcp/src/index.ts',
  ],
  env: {
    ...process.env,
    MIDSCENE_MCP_ROOT: process.cwd(),
  },
  stderr: 'inherit',
});

const client = new Client({ name: 'rekamedika-registration-recorder', version: '1.0.0' });
await client.connect(transport);

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content
    ?.filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  if (text) console.log(`${name}: ${text}`);
  if (result.isError) throw new Error(`${name} failed: ${text ?? 'unknown error'}`);
  return result;
}

try {
  await call('start_session', { target: 'web', url: 'https://rekamedika.com' });
  await call('act', {
    instruction: 'Dari halaman utama Rekamedika, klik tombol atau tautan untuk mendaftar/registrasi akun hingga halaman formulir registrasi terbuka.',
  });
  await call('assert', {
    claim: 'Halaman registrasi atau formulir pendaftaran akun Rekamedika sudah terlihat.',
  });
} finally {
  await call('end_session').catch((error) => console.error(error.message));
  await client.close();
}
