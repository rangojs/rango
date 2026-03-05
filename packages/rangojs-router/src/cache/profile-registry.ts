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

const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Set all cache profiles. Called by createRouter() at startup.
 * Validates that all profile names match the grammar [a-zA-Z0-9_-]+.
 */
export function setCacheProfiles(profiles: Record<string, CacheProfile>): void {
  for (const name of Object.keys(profiles)) {
    if (!PROFILE_NAME_RE.test(name)) {
      throw new Error(
        `Invalid cache profile name "${name}". ` +
          `Profile names must match [a-zA-Z0-9_-]+.`,
      );
    }
  }
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
