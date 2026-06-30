/**
 * Deferred handle values — "decide synchronously, resolve late".
 *
 * A handle is pushed from code that holds `ctx` (a route/layout handler), so the
 * decision to push lands before the handles stream seals. But the value often
 * isn't known there — it may come from a deep async component far from the
 * handler. `ctx.use(Handle).defer()` reserves the handle's slot now (synchronous,
 * so ordering and the pre-seal timing hold) and returns a resolver with the SAME
 * signature as the push: you call it later, anywhere in the render, with the same
 * value you would have passed to the push.
 *
 *   const breadcrumb = ctx.use(Breadcrumbs);   // (item) => void  &  .defer()
 *   const resolve = breadcrumb.defer({ timeoutMs: 5000, else: null });
 *   // deep async component, far from ctx:
 *   resolve({ label, href, content });          // identical call, just deferred
 *
 * Under the hood the reserved slot is a Promise. Handle values are resolved
 * before any consumer sees them (resolve-by-default: the full render resolves
 * server-side, navigation resolves client-side before apply), so `useHandle`
 * receives the resolved value, never the Promise. The hazard that guards against
 * bugs: a deferred slot whose resolver is never called would keep the render —
 * and the HTTP response — waiting forever. So a deferred auto-resolves to `else`
 * after `timeoutMs` (default {@link DEFAULT_DEFER_TIMEOUT_MS}) if the resolver is
 * never called, degrading gracefully (and warning in dev) instead of hanging.
 */

/** Default auto-resolve window. Long enough for genuine deep async work, short
 *  enough that a forgotten resolve does not hang the response indefinitely. */
export const DEFAULT_DEFER_TIMEOUT_MS = 10_000;

/** Options for `ctx.use(Handle).defer()`. */
export interface DeferOptions<TData> {
  /**
   * Auto-resolve to `else` after this many ms if the resolver is never called,
   * so a forgotten resolve cannot hold the Flight stream — and thus the HTTP
   * response — open. Defaults to {@link DEFAULT_DEFER_TIMEOUT_MS}. `0` or
   * `Infinity` disable the timeout intentionally (not recommended on a request
   * path). Any other non-finite or negative value is treated as a mistake and
   * falls back to the default rather than silently disabling the safety net.
   * Named `timeoutMs` to match the router's `*Ms` duration convention.
   */
  timeoutMs?: number;
  /**
   * Value the slot resolves to if the timeout fires before the resolver is
   * called. Defaults to `undefined` (the deferred item is skipped/empty). For
   * renderable handle content, `null` is the usual graceful fallback, so the
   * type admits `null` even when `TData` does not.
   */
  else?: TData | null;
}

/**
 * The call signature shared by a handle push and the resolver returned by
 * `.defer()`: a concrete value, a `Promise` of the value (Flight streams it as a
 * late row), or a thunk returning a `Promise` (called immediately).
 */
export type HandlePushFn<TData> = (
  data: TData | Promise<TData> | (() => Promise<TData>),
) => void;

/**
 * The push function returned by `ctx.use(Handle)`. Call it to push a value now,
 * or call `.defer()` to reserve the slot now and resolve the value later (e.g.
 * from a deep async component) with a timeout safety net.
 */
export type HandlePush<TData> = HandlePushFn<TData> & {
  /**
   * Reserve this handle's slot synchronously and return a resolver that is
   * push-equal: it takes the same argument shapes as the push (value, Promise, or
   * thunk) and behaves identically. Two things the resolver adds over a direct
   * push: a timeout (if the resolver is never called, the slot auto-resolves to
   * `options.else` after `options.timeoutMs`; calling the resolver cancels it),
   * and — on the action/revalidation path only — a thunk it runs does NOT
   * re-enter the deadlock-guard push-callback scope a direct push thunk gets,
   * because a deferred resolver fires after the handler phase has closed.
   *
   * The reserved slot is resolved before any consumer reads it
   * (resolve-by-default), so `useHandle` receives the resolved value (or the
   * `else` fallback on timeout), never a Promise.
   */
  defer(options?: DeferOptions<TData>): HandlePushFn<TData>;
};

// Internal: a timeout-bounded { promise, resolve }. Not part of the public API
// (the public surface is `ctx.use(Handle).defer()`); exported for `withDefer`
// and unit tests only. Resolves to `T`, the `else` fallback, or `undefined`.
export function createDeferred<T>(options?: {
  timeoutMs?: number;
  fallback?: T | null;
}): {
  promise: Promise<T | null | undefined>;
  resolve: (value: T | null | undefined) => void;
} {
  let resolveInner!: (value: T | null | undefined) => void;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<T | null | undefined>((resolve) => {
    resolveInner = resolve;
  });

  const finish = (value: T | null | undefined): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    resolveInner(value);
  };

  // 0 and Infinity are documented intentional disables. Any other non-finite or
  // negative value (NaN, -1, a bad parsed config/env) is a mistake — fall back to
  // the default rather than SILENTLY disabling the safety net, which would let a
  // forgotten resolve hang the Flight stream and the response forever.
  const requested = options?.timeoutMs ?? DEFAULT_DEFER_TIMEOUT_MS;
  let ms: number;
  if (requested === 0 || requested === Infinity) {
    ms = requested;
  } else if (Number.isFinite(requested) && requested > 0) {
    ms = requested;
  } else {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[rango] defer(): invalid timeout ${String(requested)}; using the ` +
          `${DEFAULT_DEFER_TIMEOUT_MS}ms default so the safety net stays on. ` +
          `Use 0 or Infinity to disable the timeout intentionally.`,
      );
    }
    ms = DEFAULT_DEFER_TIMEOUT_MS;
  }

  if (ms > 0 && ms !== Infinity) {
    timer = setTimeout(() => {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `[rango] A deferred handle value was not resolved within ${ms}ms; ` +
            `resolving to the fallback so the response can flush. Call the ` +
            `resolver from the component that produces the value, or raise timeoutMs.`,
        );
      }
      finish(options?.fallback);
    }, ms);
    // Don't let a pending timer alone keep a Node process alive (no-op on workerd).
    (timer as { unref?: () => void }).unref?.();
  }

  return { promise, resolve: finish };
}

/**
 * Attach `.defer()` to a handle push function. The deferred slot is reserved by
 * pushing the deferred promise through the same push (so ordering, sealing, and
 * Flight streaming all reuse the existing path); the returned resolver settles it.
 */
export function withDefer<TData>(push: HandlePushFn<TData>): HandlePush<TData> {
  const handlePush = push as HandlePush<TData>;
  // Safe to mutate push in place: each ctx.use(Handle) call (request-context.ts,
  // loader-resolution.ts) builds a fresh closure, so .defer never leaks across
  // handles or requests.
  handlePush.defer = (options) => {
    const deferred = createDeferred<TData>({
      timeoutMs: options?.timeoutMs,
      fallback: options?.else,
    });
    // Reserve the slot now by pushing the pending promise (the renderer use()s it).
    push(deferred.promise as Promise<TData>);
    // The resolver is push-equal: a thunk is invoked immediately (as push does)
    // and a Promise is adopted by the reserved slot. Calling it settles the slot
    // and cancels the timeout — the timeout only fires if it is never called.
    const resolveSlot = deferred.resolve as (
      value: TData | Promise<TData>,
    ) => void;
    return (data) => {
      // The thunk runs without re-entering the push-callback scope a direct push
      // thunk gets on the action/revalidation path (loader-resolution.ts): a
      // deferred resolver fires from a deep component after the handler phase has
      // closed, so there is no live deadlock-guard window to exempt.
      resolveSlot(
        typeof data === "function" ? (data as () => Promise<TData>)() : data,
      );
    };
  };
  return handlePush;
}
