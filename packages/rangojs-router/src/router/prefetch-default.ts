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
 * Policy note: automatic prefetch stays quiet in development, matching the
 * production-only default used by Next.js. Explicit router and per-Link
 * strategies still work in every mode. Invalid untyped inputs fall back to the
 * current environment's default.
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

function defaultPrefetchForEnvironment(
  nodeEnv: string | undefined,
): PrefetchStrategy {
  return nodeEnv === "production" ? "viewport" : "none";
}

export const DEFAULT_PREFETCH_STRATEGY: PrefetchStrategy =
  defaultPrefetchForEnvironment(process.env.NODE_ENV);

const VALID_STRATEGIES: ReadonlySet<string> = new Set([
  "hover",
  "viewport",
  "render",
  "adaptive",
  "none",
] satisfies PrefetchStrategy[]);

export function resolveDefaultPrefetch(
  raw: PrefetchStrategy | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): PrefetchStrategy {
  if (typeof raw === "string" && VALID_STRATEGIES.has(raw)) {
    return raw;
  }
  return defaultPrefetchForEnvironment(nodeEnv);
}
