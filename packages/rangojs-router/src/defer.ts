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
 *   const resolve = breadcrumb.defer({ within: 5000, else: null });
 *   // deep async component, far from ctx:
 *   resolve({ label, href, content });          // identical call, just deferred
 *
 * Under the hood the reserved slot is a Promise the renderer `use()`s; RSC Flight
 * streams it as a late row. The hazard that guards against bugs: a deferred slot
 * whose resolver is never called would keep the Flight stream — and the HTTP
 * response — open forever. So a deferred auto-resolves to `else` after `within`
 * ms (default {@link DEFAULT_DEFER_TIMEOUT_MS}) if the resolver is never called,
 * degrading gracefully (and warning in dev) instead of hanging the request.
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
   */
  within?: number;
  /**
   * Value the slot resolves to if the timeout fires before the resolver is
   * called. Defaults to `undefined` (the deferred item is skipped/empty). For
   * renderable handle content, `null` is the usual graceful fallback.
   */
  else?: TData;
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
   * thunk) and behaves identically. The one added behavior is the timeout: if the
   * resolver is never called, the slot auto-resolves to `options.else` after
   * `options.within` ms. Calling the resolver cancels the timeout.
   */
  defer(options?: DeferOptions<TData>): HandlePushFn<TData>;
};

interface InternalDeferred<T> {
  promise: Promise<T | undefined>;
  resolve: (value: T | undefined) => void;
}

// Internal: a timeout-bounded { promise, resolve }. Not part of the public API
// (the public surface is `ctx.use(Handle).defer()`); exported for `withDefer`
// and unit tests only.
export function createDeferred<T>(options?: {
  timeoutMs?: number;
  fallback?: T;
}): InternalDeferred<T> {
  let resolveInner!: (value: T | undefined) => void;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<T | undefined>((resolve) => {
    resolveInner = resolve;
  });

  const finish = (value: T | undefined): void => {
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
            `resolver from the component that produces the value, or raise within.`,
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
  handlePush.defer = (options) => {
    const deferred = createDeferred<TData>({
      timeoutMs: options?.within,
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
      resolveSlot(
        typeof data === "function" ? (data as () => Promise<TData>)() : data,
      );
    };
  };
  return handlePush;
}
