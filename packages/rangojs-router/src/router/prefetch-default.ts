/**
 * Resolve the router-wide default Link prefetch strategy once, at router init.
 * The resolved value ships to the client in payload metadata; the browser
 * entry applies it via `setDefaultPrefetchStrategy` (browser/prefetch/
 * default-strategy.ts) and every `<Link>` without an explicit `prefetch` prop
 * falls back to it.
 *
 * The type lives HERE (not in browser/react/Link.tsx) because both seats need
 * it: this server-side resolver and the client Link/default-strategy modules.
 * Link.tsx re-exports it so the public `PrefetchStrategy` export path is
 * unchanged.
 *
 * Policy note: unlike prefetch-limits.ts (numbers), the only invalid inputs
 * here are strings outside the union — possible via untyped JS consumers or a
 * value threaded from config/env. Falling back to the default ("viewport")
 * rather than "none" matches the numeric resolvers: a malformed value never
 * silently disables a feature the consumer nominally left enabled. Explicit
 * disable is the literal "none" (or `prefetchCacheTTL: false` for the whole
 * prefetch subsystem).
 */

/**
 * Prefetch strategy for the Link component
 * - "hover": Prefetch on mouse enter (direct, no queue)
 * - "viewport": Prefetch when link enters viewport (queued, waits for idle)
 * - "render": Prefetch on component mount regardless of visibility (queued, waits for idle)
 * - "adaptive": Hover on pointer devices, viewport on touch devices
 * - "none": No prefetching
 */
export type PrefetchStrategy =
  | "hover"
  | "viewport"
  | "render"
  | "adaptive"
  | "none";

export const DEFAULT_PREFETCH_STRATEGY: PrefetchStrategy = "viewport";

const VALID_STRATEGIES: ReadonlySet<string> = new Set([
  "hover",
  "viewport",
  "render",
  "adaptive",
  "none",
] satisfies PrefetchStrategy[]);

export function resolveDefaultPrefetch(
  raw: PrefetchStrategy | undefined,
): PrefetchStrategy {
  if (typeof raw === "string" && VALID_STRATEGIES.has(raw)) {
    return raw;
  }
  return DEFAULT_PREFETCH_STRATEGY;
}
