/// <reference types="@cloudflare/workers-types" />

export interface AppEnv {
  /**
   * Worker version metadata (wrangler.json `version_metadata` binding).
   * Namespaces the segment cache so every deploy starts clean — the PPR
   * shells cache for hours (see src/urls.tsx) and must not survive a deploy
   * whose client chunk hashes changed.
   */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /**
   * Absolute origin for the machine-readable routes (llms.txt, sitemap, RSS).
   * Set as a wrangler var on the deployed worker; unset locally, where
   * lib/site.ts falls back to localhost.
   */
  SITE_URL?: string;
}
