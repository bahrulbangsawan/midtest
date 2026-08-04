import type { SubscribeConnectionAdapter } from '@tanstack/ai-react';
import type { StreamChunk } from '@tanstack/ai/client';

/**
 * Dependencies injected into the connection adapter so it can be tested
 * without a real Tauri runtime. The call site (Task 8) wires these to
 * `@tauri-apps/api/core#invoke` and `@tauri-apps/api/event#listen`.
 */
export interface Deps {
  // `Record<string, unknown>` rather than `unknown`: Tauri's own `invoke`
  // narrows its second parameter to `InvokeArgs`, and under
  // `strictFunctionTypes` a wider parameter here would make the real `invoke`
  // unassignable to this field — forcing the call site to cast.
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
  /**
   * How long `whenReady()` waits for a listener registration before
   * rejecting. Defaults to `DEFAULT_READY_TIMEOUT_MS`; tests shorten it so
   * they can prove the bound exists without waiting for it.
   */
  readyTimeoutMs?: number;
}

/**
 * A `SubscribeConnectionAdapter` for `useChat`, plus a `whenReady()` escape
 * hatch that the plain adapter interface has no room for — see its doc
 * comment for why it exists and how a caller should use it.
 */
export interface TauriAcpConnection extends SubscribeConnectionAdapter {
  /**
   * Resolves once the Tauri event listener of the *currently live*
   * `subscribe()` call is registered — and rejects, loudly, whenever there
   * is no such listener to wait for.
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
   * can still race ahead of registration. The caller must mount `useChat`
   * with `live: true` (so `subscribe()` runs on mount) and `await
   * whenReady()` before issuing each `sendMessage()`.
   *
   * Three ways this guard could silently *not* guard anything, all closed
   * here rather than left to the caller:
   *
   * 1. **Called before any `subscribe()`.** There is no listener, so there
   *    is nothing to be ready. Resolving in that state would hand the
   *    caller a green light for a listener that does not exist; instead
   *    this rejects with a message naming the mistake.
   * 2. **Superseded by a later `subscribe()`.** React StrictMode
   *    double-invokes effects (mount → cleanup → mount), so the listener
   *    that was live when `whenReady()` was called can be torn down and
   *    replaced while the promise is still pending. `whenReady()` follows
   *    the replacement instead of resolving against the dead listener; if
   *    the listener is torn down and *not* replaced, it rejects.
   * 3. **A registration that never settles.** `deps.listen()` is an IPC
   *    round-trip with no delivery guarantee. Waiting on it alone means a
   *    wedged registration pins the caller forever, so the wait is bounded
   *    (`Deps.readyTimeoutMs`) and rejects when the bound is hit.
   *
   * Every path out of `whenReady()` settles: it resolves against a live
   * listener, or rejects with a reason. It never stays pending — a promise
   * that never settles is exactly the spinner-forever failure this exists
   * to prevent, and it would be the hardest version of it to diagnose.
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
 * Bookkeeping for one `subscribe()` call, so `whenReady()` can tell "the
 * listener I am waiting for" apart from "some listener, once, at some point".
 */
interface Subscription {
  /** Resolves when this call's Tauri listener is registered. */
  readonly ready: Promise<void>;
  /**
   * Resolves when a later `subscribe()` takes this one's place as `current`.
   *
   * This is what keeps `whenReady()` from hanging. Awaiting `ready` alone
   * means a caller holding a dead predecessor is chained to *that*
   * registration promise — and a registration that never settles (a wedged
   * IPC) never releases it, no matter how alive the replacement is.
   */
  readonly superseded: Promise<void>;
  /** Settles `superseded`. Called exactly once, when `current` moves on. */
  readonly markSuperseded: () => void;
  /** True once this call's listener has been torn down. */
  readonly isTornDown: () => boolean;
}

/**
 * How long `whenReady()` waits for a listener registration before giving up.
 *
 * A bound is required, not defensive garnish. `deps.listen()` is an IPC
 * round-trip; nothing in this module or in Tauri promises that it settles.
 * Without a bound, one wedged registration turns every later `whenReady()`
 * into a permanently pending promise, and the UI above it into a spinner
 * that never stops — the exact failure this whole mechanism exists to
 * prevent. Ten seconds is far beyond any healthy registration and still
 * finite.
 */
const DEFAULT_READY_TIMEOUT_MS = 10_000;

/**
 * A promise that rejects after `ms`, plus a way to cancel its timer so a
 * settled race does not leave one pending.
 */
function rejectAfter(ms: number): {
  promise: Promise<never>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Pendaftaran pendengar event agen tidak selesai dalam ${ms} ms. ` +
            'Sambungan ke proses Tauri kemungkinan tersendat.',
        ),
      );
    }, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export function createTauriAcpConnection(deps: Deps): TauriAcpConnection {
  const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  // The most recent `subscribe()` call, or `undefined` while none has run.
  //
  // `undefined` is load-bearing. The obvious initial value — an
  // already-resolved promise — makes `whenReady()` return "ready" before any
  // listener exists, which is precisely the state the guard exists to catch.
  let current: Subscription | undefined;

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
    let markSuperseded!: () => void;
    const superseded = new Promise<void>((resolve) => {
      markSuperseded = resolve;
    });
    const subscription: Subscription = {
      ready: listenerReady,
      superseded,
      markSuperseded,
      isTornDown: () => aborted,
    };
    // Publish the replacement *before* waking anyone waiting on the one it
    // replaces, so every woken waiter re-reads a `current` that is already
    // the new subscription.
    const previous = current;
    current = subscription;
    previous?.markSuperseded();
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

  /** See `TauriAcpConnection.whenReady` for the contract this implements. */
  async function whenReady(): Promise<void> {
    const active = current;
    if (!active) {
      throw new Error(
        'Langganan event agen belum dimulai: whenReady() dipanggil sebelum subscribe(). ' +
          'Pasang useChat dengan live: true, dan panggil whenReady() dari komponen yang sama.',
      );
    }

    // Three ways out of this wait, and all three must be in the race.
    //
    // Awaiting `active.ready` on its own is a hang, not a guard: it chains
    // the caller to one specific registration promise, so a subscription
    // that is replaced by a live successor — or whose registration simply
    // never settles — leaves the caller pending forever. `superseded`
    // releases the first case; the timeout releases the second.
    //
    // It also fixes a false negative: if a superseded registration *rejects*
    // while its replacement succeeds, `superseded` has already resolved by
    // then (supersession happens at `subscribe()` time, before the older
    // registration settles), so the race takes that branch and the stale
    // rejection is never surfaced against a healthy listener.
    const budget = rejectAfter(readyTimeoutMs);
    try {
      await Promise.race([active.ready, active.superseded, budget.promise]);
    } finally {
      budget.cancel();
    }

    if (current !== active) {
      // A newer `subscribe()` replaced the one we were waiting for — the
      // StrictMode mount → cleanup → mount sequence, or a plain remount.
      // Resolving now would report a listener that has already been
      // released, so wait on its replacement instead. The recursion is
      // bounded by the number of remounts, and each step awaits a real
      // registration promise rather than spinning.
      return whenReady();
    }

    if (active.isTornDown()) {
      throw new Error(
        'Langganan event agen sudah dilepas: tidak ada pendengar yang aktif untuk giliran ini.',
      );
    }
  }

  return {
    subscribe,
    async send(messages) {
      const text = extractLatestText(messages);
      await deps.invoke('send_prompt', { text });
    },
    whenReady,
  };
}
