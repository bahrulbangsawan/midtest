export type ToolErrorCode =
  | 'NO_SESSION'
  | 'SESSION_ACTIVE'
  | 'BUDGET_EXCEEDED'
  | 'DEVICE_FAILED'
  | 'SCENARIO_NOT_FOUND'
  // The scenario is well-formed but contains a construct the cost guard refuses to run.
  // Distinct from INTERNAL (nothing broke) and from BUDGET_EXCEEDED (raising the budget
  // would not help) — the agent must rewrite the YAML, and the message says how.
  | 'SCENARIO_UNSUPPORTED'
  | 'REPORT_MISSING'
  | 'INTERNAL';

// Deliberately only DEVICE_FAILED. SCENARIO_UNSUPPORTED in particular must stay out:
// replaying the identical YAML fails identically every time, so inviting a retry would
// burn a turn to reach the same refusal.
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
  [key: string]: unknown;
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
