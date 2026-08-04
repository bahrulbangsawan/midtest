export type ToolErrorCode =
  | 'NO_SESSION'
  | 'SESSION_ACTIVE'
  | 'BUDGET_EXCEEDED'
  | 'DEVICE_FAILED'
  | 'SCENARIO_NOT_FOUND'
  | 'REPORT_MISSING'
  | 'INTERNAL';

const RETRYABLE: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  'DEVICE_FAILED',
]);

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;

  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
    this.retryable = RETRYABLE.has(code);
  }
}

export interface ToolResult {
  content: [{ type: 'text'; text: string }];
  isError: true;
}

export function toToolResult(err: unknown): ToolResult {
  const toolError =
    err instanceof ToolError
      ? err
      : new ToolError('INTERNAL', err instanceof Error ? err.message : String(err));

  const saran = toolError.retryable
    ? 'You may retry once with a different instruction.'
    : 'Do not retry. Report this to the user and ask how to proceed.';

  return {
    content: [{ type: 'text', text: `[${toolError.code}] ${toolError.message}\n${saran}` }],
    isError: true,
  };
}
