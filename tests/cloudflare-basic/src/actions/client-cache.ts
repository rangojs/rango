"use server";

// Test-fixture server actions exercising the rango client-cache directives
// (invalidateClientCache / keepClientCache), so the consumer testing primitives
// can assert them against real action code. These are the two idiomatic shapes
// a consumer writes; test/client-cache.test.ts drives them through
// runInRequestContext.

import {
  cookies,
  invalidateClientCache,
  keepClientCache,
} from "@rangojs/router";

/**
 * Log the user out: clear the session cookie, then force this client's caches to
 * miss so any authed page it cached is refetched fresh on its next read.
 */
export async function logoutAction(): Promise<{ ok: true }> {
  cookies().delete("session", { path: "/" });
  invalidateClientCache();
  return { ok: true };
}

/**
 * Dismiss a UI banner: persist the choice in a cookie but do NOT invalidate the
 * client's caches - dismissing a banner changes nothing any route renders, so
 * the cached pages and prefetches stay valid.
 */
export async function dismissBannerAction(): Promise<{ ok: true }> {
  cookies().set("banner-dismissed", "1", { path: "/", maxAge: 31536000 });
  keepClientCache();
  return { ok: true };
}
