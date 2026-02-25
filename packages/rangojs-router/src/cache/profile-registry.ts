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

let _profiles: Record<string, CacheProfile> = {
  default: { ttl: 900, swr: 1800 },
};

/**
 * Set all cache profiles. Called by createRouter() at startup.
 */
export function setCacheProfiles(profiles: Record<string, CacheProfile>): void {
  _profiles = { ...profiles };
  // Ensure a default profile always exists
  if (!_profiles.default) {
    _profiles.default = { ttl: 900, swr: 1800 };
  }
}

/**
 * Get a cache profile by name. Returns undefined for unknown profiles.
 */
export function getCacheProfile(name: string): CacheProfile | undefined {
  return _profiles[name];
}
