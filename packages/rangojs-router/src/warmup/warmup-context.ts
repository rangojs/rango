"use client";

/**
 * Warmup context for connection keep-alive configuration.
 *
 * Module-level state populated during browser init (initWarmupSync)
 * and read during SSR (getSSRWarmupEnabled) by MetaTags.
 */

/**
 * SSR module-level state for warmup enabled flag.
 * Populated by initWarmupSync before React renders.
 * Used by MetaTags during SSR to conditionally render ConnectionWarmup.
 */
let ssrWarmupEnabled = true;

/**
 * Initialize warmup config synchronously for SSR.
 * Called before rendering to populate state for MetaTags.
 *
 * @param enabled - Whether connection warmup is enabled
 */
export function initWarmupSync(enabled: boolean): void {
  ssrWarmupEnabled = enabled;
}

/**
 * Get warmup enabled flag for SSR/hydration.
 * Used by MetaTags to conditionally render ConnectionWarmup.
 *
 * @returns Whether warmup is enabled
 */
export function getSSRWarmupEnabled(): boolean {
  return ssrWarmupEnabled;
}
