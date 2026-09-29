// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { ToolCallEvent, toolDisplayStatus, type ToolCallEventPart } from './ToolCallEvent';

afterEach(cleanup);

function part(state: ToolCallEventPart['state'], output?: unknown): ToolCallEventPart {
  return {
    id: 'tool-1',
    name: 'mcp__midscene__act',
    arguments: '{"instruction":"click Sign in"}',
    input: { instruction: 'click Sign in' },
    output,
    state,
  };
}

test.each([
  ['awaiting-input', false, 'queued'],
  ['input-streaming', false, 'queued'],
  ['input-complete', false, 'running'],
  ['complete', false, 'success'],
  ['error', false, 'failed'],
  ['input-complete', true, 'cancelled'],
] as const)('maps %s (cancelled=%s) to %s', (state, cancelled, expected) => {
  expect(toolDisplayStatus(state, cancelled)).toBe(expected);
});

test('renders tool name, useful context, and a stable real-time status region', () => {
  const { rerender } = render(<ToolCallEvent part={part('awaiting-input')} />);

  const event = screen.getByRole('status', { name: /mcp__midscene__act: queued/i });
  expect(event.getAttribute('data-tool-call-id')).toBe('tool-1');
  expect(event.textContent).toContain('Act');
  expect(event.textContent).toContain('click Sign in');
  expect(event.getAttribute('data-tool-status')).toBe('queued');

  rerender(<ToolCallEvent part={part('input-complete')} />);
  expect(screen.getByRole('status', { name: /running/i }).getAttribute('data-tool-call-id')).toBe(
    'tool-1',
  );
  expect(document.querySelectorAll('[data-tool-call-id="tool-1"]')).toHaveLength(1);

  rerender(<ToolCallEvent part={part('complete', { ok: true })} />);
  expect(screen.getByRole('status', { name: /success/i }).getAttribute('data-tool-status')).toBe(
    'success',
  );
});

test('failed and cancelled states are explicit and do not claim success', () => {
  const { rerender } = render(
    <ToolCallEvent part={part('error', { error: 'button was not found' })} />,
  );
  expect(screen.getByRole('status', { name: /failed/i }).textContent).toContain(
    'button was not found',
  );

  rerender(<ToolCallEvent part={part('input-complete')} cancelled />);
  expect(screen.getByRole('status', { name: /cancelled/i }).textContent).not.toContain('Success');
});
