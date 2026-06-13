"use server";

// Test-fixture server action exercising server-side cache TAG invalidation
// (updateTag) so the consumer testing primitives can assert it against real
// action code. test/cache-tags.test.ts drives it through runInRequestContext
// with a MemorySegmentCacheStore (the standard tag-capable testing store).

import { updateTag } from "@rangojs/router";

/**
 * Publish a product. After writing (the DB write is omitted in this fixture),
 * invalidate the "products" tag so the action's own re-render - and every later
 * read - sees fresh data. updateTag() resolves only once the purge has landed,
 * which is what gives read-your-own-writes inside a server action.
 */
export async function publishProductAction(): Promise<{ ok: true }> {
  await updateTag("products");
  return { ok: true };
}
