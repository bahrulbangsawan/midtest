import type { ToolCallState } from '@tanstack/ai';
import {
  BanIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  LoaderCircleIcon,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

export type ToolDisplayStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

export interface ToolCallEventPart {
  id: string;
  name: string;
  arguments: string;
  input?: unknown;
  output?: unknown;
  state: ToolCallState;
}

function parseInput(part: ToolCallEventPart): unknown {
  if (part.input !== undefined) return part.input;
  if (!part.arguments.trim()) return undefined;
  try {
    return JSON.parse(part.arguments);
  } catch {
    return part.arguments;
  }
}

function usefulContext(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const preferredKeys = ['instruction', 'query', 'claim', 'path', 'url', 'command', 'name'];
  for (const key of preferredKeys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }

  const firstString = Object.values(record).find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
  );
  return firstString?.trim() ?? null;
}

function errorDetail(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (!output || typeof output !== 'object') return null;
  const error = (output as { error?: unknown }).error;
  return typeof error === 'string' ? error : null;
}

export function toolDisplayStatus(
  state: ToolCallState,
  cancelled = false,
): ToolDisplayStatus {
  if (state === 'complete') return 'success';
  if (state === 'error') return 'failed';
  if (cancelled) return 'cancelled';
  if (state === 'input-complete' || state === 'approval-requested' || state === 'approval-responded') {
    return 'running';
  }
  return 'queued';
}

function toolLabel(name: string): string {
  return name
    .replace(/^mcp__[^_]+__/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

const STATUS_LABELS: Record<ToolDisplayStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function StatusIcon({ status }: { status: ToolDisplayStatus }) {
  if (status === 'running') return <LoaderCircleIcon className="tool-event-spinner" />;
  if (status === 'success') return <CheckCircle2Icon />;
  if (status === 'failed') return <XCircleIcon />;
  if (status === 'cancelled') return <BanIcon />;
  return <CircleDashedIcon />;
}

export function ToolCallEvent({
  part,
  cancelled = false,
}: {
  part: ToolCallEventPart;
  cancelled?: boolean;
}) {
  const status = toolDisplayStatus(part.state, cancelled);
  const context = usefulContext(parseInput(part));
  const failure = status === 'failed' ? errorDetail(part.output) : null;

  return (
    <div
      className={cn('tool-event', `tool-event-${status}`)}
      data-tool-call-id={part.id}
      data-tool-status={status}
      role="status"
      aria-label={`${part.name}: ${STATUS_LABELS[status]}`}
    >
      {status === 'running' ? <span className="tool-event-shimmer" aria-hidden="true" /> : null}
      <span className="tool-event-kind" aria-hidden="true"><WrenchIcon /></span>
      <span className="tool-event-copy">
        <span className="tool-event-name" title={part.name}>{toolLabel(part.name)}</span>
        {context ? <span className="tool-event-context" title={context}>{context}</span> : null}
        {failure ? <span className="tool-event-error" title={failure}>{failure}</span> : null}
      </span>
      <span className="tool-event-status" aria-live="polite">
        <StatusIcon status={status} />
        <span>{STATUS_LABELS[status]}</span>
      </span>
    </div>
  );
}
