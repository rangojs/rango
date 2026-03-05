/**
 * Cache Profile Registry
 *
 * Named cache profiles for "use cache" directive.
 * Profiles define TTL, SWR, and optional default tags.
 * Set by createRouter() at startup, read by registerCachedFunction() at runtime.
 */

export interface CacheProfile {
  /** Time-to-live in seconds */
  ttl: number;
  /** Stale-while-revalidate window in seconds */
  swr?: number;
  /** Default cache tags for invalidation */
  tags?: string[];
}

const DEFAULT_PROFILE: CacheProfile = { ttl: 900, swr: 1800 };

let _profiles: Record<string, CacheProfile> = {
  default: DEFAULT_PROFILE,
};

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
      merged[name] = profiles[name];
    }
  }
  return merged;
}

/**
 * Set all cache profiles in the global registry.
 * Called by createRouter() at startup for DSL-time resolution
 * (cache("profileName") reads from this during route definition).
 *
 * WARNING: This is global mutable state. It exists only for DSL-time
 * reads. Runtime resolution (registerCachedFunction) uses request-scoped
 * profiles and does NOT read from this registry.
 */
export function setCacheProfiles(profiles: Record<string, CacheProfile>): void {
  _profiles = resolveCacheProfiles(profiles);
}

/**
 * Get a cache profile by name from the global registry.
 * Used only at DSL-time (cache("profileName") inside urls() evaluation).
 * Runtime code uses request-scoped profiles instead.
 */
export function getCacheProfile(name: string): CacheProfile | undefined {
  return _profiles[name];
}
