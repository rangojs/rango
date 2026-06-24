/**
 * Cache profile resolution.
 *
 * Named cache profiles for the "use cache" directive define TTL, SWR, and
 * optional default tags. createRouter() resolves the user's profiles once via
 * resolveCacheProfiles() and threads the resulting map onto each request
 * context; the "use cache: <profile>" runtime path reads it from there
 * (request-scoped) — there is no global registry.
 */

export interface CacheProfile {
  /** Time-to-live in seconds */
  ttl: number;
  /** Stale-while-revalidate window in seconds */
  swr?: number;
  /** Default cache tags for invalidation */
  tags?: string[];
  /**
   * When true, a stale entry encountered during a server action's revalidation
   * render is re-executed in the FOREGROUND (the action response reflects the
   * refreshed value) instead of being served stale + revalidated in the
   * background. Only the store write is deferred. Use this for mutation-related
   * cached data that an action should refresh immediately; ordinary navigations
   * always keep SWR. Default false: incidental TTL staleness must not turn an
   * unrelated action into a synchronous cache-refresh barrier — for strong
   * read-your-own-writes after a mutation, prefer updateTag() (a hard purge, so
   * the action's own re-render is a fresh foreground miss).
   *
   * Honored only by `"use cache"` functions; route-level `cache()` and cached
   * loaders ignore it (use updateTag() there).
   */
  foregroundOnAction?: boolean;
}

const DEFAULT_PROFILE: CacheProfile = { ttl: 900, swr: 1800 };

const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate and merge user profiles with the default profile.
 * Returns a new object suitable for both DSL-time and request-scoped use.
 *
 * Used by createRouter() to compute the resolved profile map once,
 * stored on the router instance and passed to every request context.
 */
export function resolveCacheProfiles(
  profiles?: Record<string, CacheProfile>,
): Record<string, CacheProfile> {
  const merged: Record<string, CacheProfile> = {
    default: DEFAULT_PROFILE,
  };
  if (profiles) {
    for (const name of Object.keys(profiles)) {
      if (!PROFILE_NAME_RE.test(name)) {
        throw new Error(
          `Invalid cache profile name "${name}". ` +
            `Profile names must match [a-zA-Z0-9_-]+.`,
        );
      }
      const profile = profiles[name];
      // Validate ttl/swr VALUES, not just the name. An unvalidated NaN/Infinity
      // ttl flows into computeExpiration -> staleAt/expiresAt = NaN, and every
      // expiry check (`now > NaN`) is false, so the entry never evicts and never
      // revalidates: it is served fresh forever and accumulates unbounded. A
      // negative ttl makes every read a guaranteed miss. This guard's policy is
      // to FAIL FAST at config time on any non-finite/negative ttl — distinct
      // from prefetch-cache-ttl.ts (falls back to the default) and defer.ts
      // (treats Infinity as an intentional disable). Do not conflate them.
      if (!Number.isFinite(profile.ttl) || profile.ttl < 0) {
        throw new Error(
          `Invalid cache profile "${name}": ttl must be a finite non-negative ` +
            `number (got ${profile.ttl}).`,
        );
      }
      if (
        profile.swr !== undefined &&
        (!Number.isFinite(profile.swr) || profile.swr < 0)
      ) {
        throw new Error(
          `Invalid cache profile "${name}": swr must be a finite non-negative ` +
            `number (got ${profile.swr}).`,
        );
      }
      merged[name] = profile;
    }
  }
  return merged;
}
