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

/**
 * A `SubscribeConnectionAdapter` for `useChat`, plus a `whenReady()` escape
 * hatch that the plain adapter interface has no room for — see its doc
 * comment for why it exists and how a caller should use it.
 */
export interface TauriAcpConnection extends SubscribeConnectionAdapter {
  /**
   * Resolves once the Tauri event listener registered by the most recent
   * `subscribe()` call is live.
   *
   * Registering a Tauri listener is a real IPC round-trip in production
   * (unlike the synchronous test double used here), so there is a window
   * between calling `subscribe()` and the listener actually being able to
   * receive events. The Rust side emits `RUN_STARTED` as soon as
   * `send_prompt` runs — if that lands before the listener is registered,
   * it is lost upstream of this module's buffer, and `useChat` never sees
   * the turn start.
   *
   * `subscribe()` registers the listener eagerly (not lazily on first
   * `next()`) to narrow this window, but narrowing is not closing it: a
   * caller that calls `sendMessage()` immediately after mounting `useChat`
   * can still race ahead of registration. The caller (Task 8) should mount
   * `useChat` with `live: true` (so `subscribe()` runs on mount) and
   * `await whenReady()` before issuing the first `sendMessage()`.
   */
  whenReady: () => Promise<void>;
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
 * Extracts the text of the most recent message. `UIMessage` carries text as
 * `parts[].content` on a `{ type: 'text' }` part (verified against
 * `@tanstack/ai`'s installed `TextPart` type — there is no `text` field);
 * `ModelMessage` carries it directly as a string `content`.
 */
function extractLatestText(messages: ReadonlyArray<unknown>): string {
  const last = messages[messages.length - 1];
  if (last === null || typeof last !== 'object') return '';

  const withParts = last as { parts?: unknown };
  if (Array.isArray(withParts.parts)) {
    for (const part of withParts.parts) {
      if (part === null || typeof part !== 'object') continue;
      if ((part as { type?: unknown }).type !== 'text') continue;
      const textPart = part as { content?: unknown };
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
export function createTauriAcpConnection(deps: Deps): TauriAcpConnection {
  // Tracks the listener-registration promise of the most recent
  // `subscribe()` call, for `whenReady()` below.
  let currentListenerReady: Promise<void> = Promise.resolve();

  function subscribe(abortSignal?: AbortSignal): AsyncIterable<StreamChunk> {
    const queue = new AsyncQueue<StreamChunk>();
    let unlisten: (() => void) | undefined;
    let aborted = false;

    // Single place that actually calls the Tauri-provided `stop` function.
    // Both abort timings below — abort while `listen()` is still in flight,
    // and abort after it has already resolved — funnel through this one
    // function, so there is exactly one line that can regress into a leak.
    const releaseListener = (): void => {
      if (unlisten) {
        unlisten();
        unlisten = undefined;
      }
    };

    // Registered eagerly, right here at `subscribe()` time, exactly once —
    // not deferred into `next()`, and not re-issued on later `next()`
    // calls. This is both correctness (no per-iteration re-registration,
    // which would leak listeners and duplicate every later event) and a
    // best-effort narrowing of the registration-race window described on
    // `TauriAcpConnection.whenReady`.
    const listenerReady: Promise<void> = deps
      .listen(AGUI_EVENT, (event) => {
        queue.push(event.payload as StreamChunk);
      })
      .then((stop) => {
        unlisten = stop;
        // If we were aborted while the listener registration was still in
        // flight, release it immediately instead of leaking.
        if (aborted) {
          releaseListener();
        }
      });
    currentListenerReady = listenerReady;
    // Fire-and-forget from this scope's perspective: don't let a
    // registration failure become an "unhandled rejection" before any
    // consumer calls `next()`. `next()` below awaits the same promise
    // object and will still see (and can surface) the rejection.
    listenerReady.catch(() => {});

    const cleanup = (): void => {
      if (aborted) return;
      aborted = true;
      queue.close();
      releaseListener();
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
            await listenerReady;
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
  }

  return {
    subscribe,
    async send(messages) {
      const text = extractLatestText(messages);
      await deps.invoke('send_prompt', { text });
    },
    whenReady(): Promise<void> {
      return currentListenerReady;
    },
  };
}
