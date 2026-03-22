import { createLoader, createVar } from "@rangojs/router";

export const NonCacheableData = createVar<string>({ cache: false });

// Sync read — reads non-cacheable var before any await
export const NonCacheableReaderLoader = createLoader(async (ctx) => {
  "use server";
  const session = ctx.get(NonCacheableData);
  return { session: session ?? "no-session" };
});

// Async read — reads non-cacheable var AFTER an await boundary.
// Tests that the exemption survives async suspension.
export const AsyncNonCacheableReaderLoader = createLoader(async (ctx) => {
  "use server";
  // Simulate async work before reading
  await new Promise((resolve) => setTimeout(resolve, 10));
  const session = ctx.get(NonCacheableData);
  return { session: session ?? "no-session-async" };
});
