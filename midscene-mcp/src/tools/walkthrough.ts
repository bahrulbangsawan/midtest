import { z } from 'zod';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolError, toToolResult } from '../errors.ts';

const jalankan = promisify(execFile);

export interface WalkthroughOpts {
  buildDemoPath: string;
}

export function registerWalkthroughTool(server: McpServer, opts: WalkthroughOpts): void {
  server.registerTool(
    'build_walkthrough',
    {
      description:
        'Turn a Midscene report into a standalone Indonesian walkthrough page. Provide stepsPath to supply your own step titles and explanations; omit it to use defaults.',
      inputSchema: {
        reportPath: z.string(),
        out: z.string(),
        stepsPath: z.string().optional(),
        title: z.string().optional(),
        subtitle: z.string().optional(),
      },
    },
    async ({ reportPath, out, stepsPath, title, subtitle }) => {
      try {
        if (!existsSync(reportPath)) {
          throw new ToolError('REPORT_MISSING', `report not found at ${reportPath}`);
        }

        const argv = [opts.buildDemoPath, reportPath, '--out', out];
        if (stepsPath) argv.push('--steps', stepsPath);
        if (title) argv.push('--title', title);
        if (subtitle) argv.push('--subtitle', subtitle);

        try {
          const { stdout } = await jalankan(process.execPath, argv);
          return {
            content: [
              { type: 'text' as const, text: `Walkthrough written to ${out}\n${stdout}`.trim() },
            ],
          };
        } catch (err) {
          const pesan =
            err instanceof Error && 'stderr' in err
              ? String((err as { stderr: unknown }).stderr) || err.message
              : String(err);
          throw new ToolError('INTERNAL', `build-demo failed: ${pesan}`);
        }
      } catch (err) {
        return toToolResult(err);
      }
    },
  );
}
