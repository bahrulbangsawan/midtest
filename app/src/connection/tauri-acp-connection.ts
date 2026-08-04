import type { SubscribeConnectionAdapter } from '@tanstack/ai-react';
import type { StreamChunk } from '@tanstack/ai/client';

/**
 * Dependencies injected into the connection adapter so it can be tested
 * without a real Tauri runtime. The call site (Task 8) wires these to
 * `@tauri-apps/api/core#invoke` and `@tauri-apps/api/event#listen`.
 */
export interface Deps {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>;
  listen: (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
}

const AGUI_EVENT = 'agui';

/**
 * A minimal async queue ("channel") that lets a Tauri event listener push
 * values from outside any consumer's pull loop. Values that arrive with no
 * pending `next()` call are buffered; a pending `next()` call is resolved
 * immediately once a value arrives.
 */
class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      const value = this.values.shift() as T;
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }
}

/**
 * Extracts the text of the most recent message, whether it is a `UIMessage`
 * (text lives in `parts[].text` or `parts[].content`) or a `ModelMessage`
 * (text lives directly in `content` as a string). Runtime duck-typing is
 * used deliberately so this stays decoupled from the exact TanStack AI
 * message shape.
 */
function extractLatestText(messages: ReadonlyArray<unknown>): string {
  const last = messages[messages.length - 1];
  if (last === null || typeof last !== 'object') return '';

  const withParts = last as { parts?: unknown };
  if (Array.isArray(withParts.parts)) {
    for (const part of withParts.parts) {
      if (part === null || typeof part !== 'object') continue;
      if ((part as { type?: unknown }).type !== 'text') continue;
      const textPart = part as { text?: unknown; content?: unknown };
      if (typeof textPart.text === 'string') return textPart.text;
      if (typeof textPart.content === 'string') return textPart.content;
    }
    return '';
  }

  const withContent = last as { content?: unknown };
  if (typeof withContent.content === 'string') return withContent.content;

  return '';
}

/**
 * Builds a `SubscribeConnectionAdapter` on top of Tauri commands/events:
 * - `send` forwards the latest message's text to the `send_prompt` command.
 * - `subscribe` yields AG-UI events (`StreamChunk`s) delivered via the
 *   `agui` Tauri event.
 */
export function createTauriAcpConnection(deps: Deps): SubscribeConnectionAdapter {
  return {
    async send(messages) {
      const text = extractLatestText(messages);
      await deps.invoke('send_prompt', { text });
    },

    subscribe(abortSignal) {
      const queue = new AsyncQueue<StreamChunk>();
      let unlisten: (() => void) | undefined;
      let listenerPromise: Promise<void> | undefined;
      let aborted = false;

      // Registers the Tauri event listener exactly once per `subscribe()`
      // call, no matter how many times `next()` is invoked.
      const ensureListening = (): Promise<void> => {
        if (!listenerPromise) {
          listenerPromise = deps
            .listen(AGUI_EVENT, (event) => {
              queue.push(event.payload as StreamChunk);
            })
            .then((stop) => {
              // If we were aborted while the listener registration was
              // still in flight, release it immediately instead of leaking.
              if (aborted) {
                stop();
              } else {
                unlisten = stop;
              }
            });
        }
        return listenerPromise;
      };

      const cleanup = (): void => {
        if (aborted) return;
        aborted = true;
        queue.close();
        if (unlisten) {
          unlisten();
          unlisten = undefined;
        }
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          cleanup();
        } else {
          abortSignal.addEventListener('abort', cleanup, { once: true });
        }
      }

      return {
        [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
          return {
            async next(): Promise<IteratorResult<StreamChunk>> {
              await ensureListening();
              if (aborted) {
                return { value: undefined, done: true };
              }
              return queue.next();
            },
            async return(): Promise<IteratorResult<StreamChunk>> {
              cleanup();
              if (abortSignal) {
                abortSignal.removeEventListener('abort', cleanup);
              }
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
  };
}
