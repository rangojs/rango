import type { DefaultEnv } from "./global-namespace.js";

/**
 * Minimal subset of Cloudflare Workers' ExecutionContext that the router
 * uses. Defined locally so the package does not depend on
 * `@cloudflare/workers-types`. Consumers that want the full type can cast.
 *
 * On non-Cloudflare runtimes (Node, dev server, tests), this is undefined
 * — portable apps should prefer `ctx.waitUntil(...)`, which degrades
 * gracefully. `ctx.executionContext` is the escape hatch for libraries
 * (MCP, Durable Object routing, etc.) that type their arguments as the
 * raw ExecutionContext.
 */
export interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

/**
 * Fallback `waitUntil` body used when no Cloudflare `ExecutionContext`
 * is available (Node, dev, tests). Runs the work fire-and-forget and
 * logs errors so they don't silently swallow.
 *
 * Exported so every `waitUntil` call site degrades identically instead
 * of inventing its own fallback policy.
 */
export function fireAndForgetWaitUntil(fn: () => Promise<void>): void {
  // Defer fn() invocation to a microtask so a SYNCHRONOUS throw in a non-async
  // callback (e.g. `() => { somethingThatThrows(); return p; }`) becomes a
  // rejected promise we catch here, not an exception that escapes into the
  // request flow. waitUntil is fire-and-forget: a background-task failure must
  // never break the response.
  Promise.resolve()
    .then(fn)
    .catch((err) => console.error("[waitUntil] Background task failed:", err));
}

/**
 * Fields present on every user-facing request context.
 *
 * @template TEnv - Platform bindings type (Cloudflare env, etc.).
 */
export interface RequestScope<TEnv = DefaultEnv> {
  /**
   * The original incoming Request object (transport URL intact).
   * Use `url` / `searchParams` for application logic — those have
   * internal `_rsc*` params stripped. `request` preserves the raw URL
   * when you need original headers, method, or body.
   */
  request: Request;

  /**
   * The request URL with internal `_rsc*` transport params stripped.
   * Use this for routing, link generation, and display.
   */
  url: URL;

  /**
   * The original request URL with all parameters intact, including
   * internal `_rsc*` transport params. Use `url` for application logic
   * — this is only needed for advanced cases like debugging or custom
   * cache keying.
   */
  originalUrl: URL;

  /** URL pathname (same as `url.pathname`). */
  pathname: string;

  /**
   * Query parameters from the URL (system params like `_rsc*` are
   * filtered). Always a standard `URLSearchParams` instance.
   */
  searchParams: URLSearchParams;

  /**
   * Platform bindings (DB, KV, secrets, etc.). On Cloudflare Workers
   * these are the `env` object passed to the Worker's `fetch()` handler.
   */
  env: TEnv;

  /**
   * Schedule work to run after the response is sent.
   * On Cloudflare Workers, delegates to `executionContext.waitUntil()`.
   * On Node / dev / tests, runs as fire-and-forget with error logging.
   *
   * @example
   * ```typescript
   * ctx.waitUntil(async () => {
   *   await cacheStore.set(key, data, ttl);
   * });
   * ```
   */
  waitUntil(fn: () => Promise<void>): void;

  /**
   * Raw Cloudflare Workers `ExecutionContext`, when running on a
   * Cloudflare-compatible runtime. Undefined elsewhere.
   *
   * Escape hatch for libraries that type their arguments as
   * `ExecutionContext` (MCP `fetch`, `routeAgentRequest`, etc.).
   * For the common "do work after the response" case, prefer
   * `ctx.waitUntil(...)` — it is platform-neutral.
   *
   * @example
   * ```typescript
   * path.any("/mcp", (ctx) =>
   *   emailMcp.fetch(ctx.request, ctx.env, ctx.executionContext!),
   * );
   * ```
   */
  executionContext?: ExecutionContext;
}
